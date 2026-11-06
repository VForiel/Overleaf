import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { fetchJson } from '@overleaf/fetch-utils'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'

// Read side of the snapshot API used by services/git-bridge.
//
// A git-bridge "version" is the history-v1 version of the project: it grows with
// every change, so git-bridge can tell whether its repository is up to date.
// Text files are sent inline; binary files as URLs that git-bridge downloads
// (blob route below, signed so that it needs no other credential).

/** Pending edits reach history-v1 only after a flush. */
export async function flush(projectId) {
  await HistoryManager.promises.flushProject(projectId)
}

/** { version, timestamp, authorId } of the latest change. */
export async function latestVersion(projectId) {
  const { chunk } = await HistoryManager.promises.getLatestHistory(projectId)
  const changes = chunk.history.changes || []
  const last = changes[changes.length - 1]
  return {
    version: chunk.startVersion + changes.length,
    timestamp: last ? last.timestamp : chunk.history.snapshot?.timestamp,
    authorId: last ? (last.v2Authors || [])[0] : null,
  }
}

async function userView(userId) {
  if (!userId) return null
  try {
    const user = await UserGetter.promises.getUser(userId, {
      email: 1,
      first_name: 1,
      last_name: 1,
    })
    if (!user) return null
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ')
    return { email: user.email, name: name || user.email }
  } catch (err) {
    logger.warn({ err, userId }, 'git-bridge: could not load user')
    return null
  }
}

/** Answer of GET /api/v0/docs/:id */
export async function getDoc(projectId) {
  await flush(projectId)
  const latest = await latestVersion(projectId)
  const answer = {
    latestVerId: latest.version,
    latestVerBy: await userView(latest.authorId),
  }
  if (latest.timestamp) answer.latestVerAt = latest.timestamp
  return answer
}

/**
 * Answer of GET /api/v0/docs/:id/saved_vers: the named versions (labels) of the
 * history, which become separate commits carrying the label as message.
 */
export async function getSavedVersions(projectId) {
  let labels
  try {
    labels = await fetchJson(
      `${Settings.apis.project_history.url}/project/${projectId}/labels`
    )
  } catch (err) {
    logger.warn({ err, projectId }, 'git-bridge: could not load labels')
    return []
  }
  const users = new Map()
  const answer = []
  for (const label of labels || []) {
    if (!Number.isInteger(label.version)) continue
    const userId = label.user_id ? label.user_id.toString() : null
    if (userId && !users.has(userId)) users.set(userId, await userView(userId))
    const user = (userId && users.get(userId)) || {}
    answer.push({
      versionId: label.version,
      comment: label.comment || 'Version nommée',
      user: { email: user.email || null, name: user.name || null },
      createdAt: label.created_at,
    })
  }
  return answer
}

/** A project containing a ".git" folder cannot be served as a repository. */
export function hasDotGit(paths) {
  return paths.some(path => path.split('/').includes('.git'))
}

/**
 * Answer of GET /api/v0/docs/:id/snapshots/:version:
 * { srcs: [[content, path]…], atts: [[url, path]…] }
 */
export async function getSnapshot(projectId, version, blobBaseUrl) {
  const snapshot = await HistoryManager.promises.getContentAtVersion(
    projectId,
    version
  )
  const files = snapshot.files || {}
  const srcs = []
  const atts = []
  for (const [path, file] of Object.entries(files)) {
    if (typeof file.content === 'string') {
      srcs.push([file.content, path])
    } else if (file.hash) {
      atts.push([blobUrl(blobBaseUrl, projectId, file.hash), path])
    } else {
      logger.warn({ projectId, version, path }, 'git-bridge: file without data')
    }
  }
  return { srcs, atts, paths: Object.keys(files) }
}

function blobToken(projectId, hash) {
  return crypto
    .createHmac('sha256', Settings.security.sessionSecret)
    .update(`git-bridge-blob:${projectId}:${hash}`)
    .digest('base64url')
}

export function checkBlobToken(projectId, hash, token) {
  if (typeof token !== 'string') return false
  const expected = Buffer.from(blobToken(projectId, hash))
  const given = Buffer.from(token)
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}

// git-bridge caches binary files by URL with the "token" parameter removed, so
// the hash must be in the path.
function blobUrl(baseUrl, projectId, hash) {
  return `${baseUrl}/api/v0/docs/${projectId}/blobs/${hash}?token=${blobToken(projectId, hash)}`
}
