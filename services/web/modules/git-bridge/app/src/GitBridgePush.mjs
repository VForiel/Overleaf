import fs from 'node:fs'
import Path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { fetchNothing, fetchStream } from '@overleaf/fetch-utils'
import SafePath from '../../../../app/src/Features/Project/SafePath.mjs'
import { flush, latestVersion } from './GitBridgeSnapshots.mjs'
import { currentFiles, deleteFiles, writeFile } from './ProjectFiles.mjs'

// Write side of the snapshot API: applies a "git push" to the project.
//
// git-bridge sends the complete list of files of the pushed commit. Files with a
// "url" changed and are downloaded from git-bridge; files without one are
// unchanged; project files missing from the list were deleted. The result is
// posted back to git-bridge, which is waiting for it to answer git.

const SOURCE = 'git-bridge'
const MAX_FILE_SIZE = 50 * 1024 * 1024

/** git-bridge URL as seen from web, e.g. http://git-bridge:8000/ */
function bridgeBaseUrl() {
  const url = Settings.gitBridgeInternalUrl
  return url ? url.replace(/\/?$/, '/') : null
}

/** URLs in a push request must point to git-bridge itself (no request forgery). */
export function isBridgeUrl(value) {
  const base = bridgeBaseUrl()
  return Boolean(base) && typeof value === 'string' && value.startsWith(base)
}

/** Checks the body of POST /api/v0/docs/:id/snapshots. Returns an error message or null. */
export function validatePushRequest(body) {
  if (!body || typeof body !== 'object') return 'missing body'
  if (!Number.isInteger(body.latestVerId)) return 'bad latestVerId'
  if (!isBridgeUrl(body.postbackUrl)) return 'bad postbackUrl'
  if (!Array.isArray(body.files)) return 'bad files'
  for (const file of body.files) {
    if (!file || typeof file.name !== 'string') return 'bad file name'
    if (file.url !== undefined && !isBridgeUrl(file.url)) return 'bad file url'
  }
  return null
}

/** Names git can carry but Overleaf refuses, as git-bridge expects them. */
export function invalidFiles(files) {
  const errors = []
  for (const { name } of files) {
    const elements = name.split('/')
    const clean = elements.every(
      element => element.length > 0 && element !== '.' && element !== '..'
    )
    if (clean && SafePath.isCleanPath(name)) continue
    const cleaned = elements
      .filter(element => element && element !== '.' && element !== '..')
      .map(element => SafePath.clean(element))
      .join('/')
    if (cleaned && cleaned !== name && SafePath.isCleanPath(cleaned)) {
      errors.push({ file: name, state: 'unclean_name', cleanFile: cleaned })
    } else {
      errors.push({ file: name, state: 'error' })
    }
  }
  return errors
}

async function download(url, name) {
  const dir = Settings.path.dumpFolder
  await fs.promises.mkdir(dir, { recursive: true })
  const fsPath = Path.join(
    dir,
    `git-bridge-${crypto.randomBytes(12).toString('hex')}`
  )
  const stream = await fetchStream(url, {
    signal: AbortSignal.timeout(5 * 60 * 1000),
  })
  let size = 0
  stream.on('data', chunk => {
    size += chunk.length
    if (size > MAX_FILE_SIZE) {
      stream.destroy(new Error(`file too large: ${name}`))
    }
  })
  await pipeline(stream, fs.createWriteStream(fsPath))
  return fsPath
}

async function applyFile(projectId, userId, name, url, existingType) {
  const fsPath = await download(url, name)
  try {
    await writeFile(projectId, userId, name, fsPath, existingType, SOURCE)
  } finally {
    await fs.promises.rm(fsPath, { force: true })
  }
}

async function applyPush(projectId, userId, files) {
  const existing = await currentFiles(projectId)
  const pushed = new Set(files.map(file => file.name))

  for (const { name, url } of files) {
    if (url) {
      await applyFile(projectId, userId, name, url, existing.get(name) || null)
    }
  }

  const deleted = [...existing.keys()].filter(path => !pushed.has(path))
  await deleteFiles(projectId, userId, deleted, [...pushed], SOURCE)
}

async function postback(url, body) {
  await fetchNothing(url, {
    method: 'POST',
    json: body,
    signal: AbortSignal.timeout(60 * 1000),
  })
}

/**
 * Runs after the "accepted" answer: applies the push, then tells git-bridge the
 * new version (or why the push failed).
 */
export async function processPush(projectId, userId, body) {
  let answer
  try {
    const errors = invalidFiles(body.files)
    if (errors.length > 0) {
      answer = { code: 'invalidFiles', errors }
    } else {
      await applyPush(projectId, userId, body.files)
      await flush(projectId)
      const { version } = await latestVersion(projectId)
      answer = { code: 'upToDate', latestVerId: version }
    }
  } catch (err) {
    logger.error({ err, projectId, userId }, 'git-bridge: push failed')
    const message = err.message || 'unexpected error'
    answer = /too many|limit|file too large/i.test(message)
      ? { code: 'invalidProject', message, errors: [message] }
      : { code: 'error', message: 'Unexpected Error' }
  }
  try {
    await postback(body.postbackUrl, answer)
  } catch (err) {
    logger.error({ err, projectId }, 'git-bridge: postback failed')
  }
}
