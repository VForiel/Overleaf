import Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import GitTokenManager, { TooManyTokensError } from './GitTokenManager.mjs'
import {
  checkBlobToken,
  getDoc,
  getSavedVersions,
  getSnapshot,
  hasDotGit,
  flush,
  latestVersion,
} from './GitBridgeSnapshots.mjs'
import { processPush, validatePushRequest } from './GitBridgePush.mjs'

const __dirname = Path.dirname(fileURLToPath(import.meta.url))
const VIEW = Path.resolve(__dirname, '../views/git')

const tokenCheckLimiter = new RateLimiter('git-bridge-token-check', {
  points: 600,
  duration: 60,
})

function cloneUrl(projectId = '<id du projet>') {
  return `${Settings.gitBridgePublicBaseUrl}/${projectId}`
}

// ---------------------------------------------------------------- token pages

async function renderPage(req, res, newToken = null, error = null) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const tokens = await GitTokenManager.listForUser(userId)
  res.render(VIEW, {
    title: 'Git',
    tokens,
    newToken,
    error,
    exampleUrl: cloneUrl(),
  })
}

async function page(req, res) {
  await renderPage(req, res)
}

async function createToken(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const wantsJson = req.accepts(['html', 'json']) === 'json'
  let token
  try {
    token = await GitTokenManager.create(userId, req.body.name)
  } catch (err) {
    if (!(err instanceof TooManyTokensError)) throw err
    const message =
      'Tu as déjà 20 jetons : supprimes-en un sur la page Git du compte.'
    if (wantsJson) return res.status(400).json({ message })
    return await renderPage(req, res, null, message)
  }
  // The token is shown once, on this answer only
  res.setHeader('Cache-Control', 'no-store')
  if (wantsJson) return res.json({ token })
  await renderPage(req, res, token)
}

async function revokeToken(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  await GitTokenManager.revoke(userId, req.params.tokenId)
  res.redirect('/user/git')
}

// ------------------------------------------------- endpoints for git-bridge

/** GET /oauth/token/info: git-bridge checks the password given to git. */
async function tokenInfo(req, res) {
  const clientIp = String(req.query.client_ip || req.ip)
  try {
    await tokenCheckLimiter.consume(clientIp, 1, { method: 'ip' })
  } catch {
    return res.status(429).json({ error: 'rate_limited' })
  }
  const userId = await userForToken(req.token)
  if (!userId) {
    return res
      .status(401)
      .json({ error: 'invalid_token', error_code: 'invalid_token' })
  }
  res.json({ user_id: userId, scopes: ['git_bridge'] })
}

async function userForToken(token) {
  const userId = await GitTokenManager.findUserId(token)
  if (!userId) return null
  const user = await UserGetter.promises.getUser(userId, {
    _id: 1,
    suspended: 1,
  })
  return user && !user.suspended ? userId : null
}

/** Bearer authentication of the /api/v0 routes (the git token of the user). */
async function requireToken(req, res, next) {
  const userId = await userForToken(req.token)
  if (!userId) {
    return res.status(401).json({ message: 'Invalid git token' })
  }
  req.gitBridgeUserId = userId
  next()
}

/** 404 rather than 403: whether a project exists is not given away. */
async function checkProject(req, res, { write = false } = {}) {
  const projectId = req.params.project_id
  const userId = req.gitBridgeUserId
  if (!/^[0-9a-f]{24}$/.test(projectId)) {
    res.status(404).json({ message: 'Not Found' })
    return null
  }
  const allowed = write
    ? await AuthorizationManager.promises.canUserWriteProjectContent(
        userId,
        projectId,
        null
      )
    : await AuthorizationManager.promises.canUserReadProject(
        userId,
        projectId,
        null
      )
  if (!allowed) {
    res.status(404).json({ message: 'Not Found' })
    return null
  }
  return projectId
}

/** Base of the blob URLs, as reachable from git-bridge. */
function webBaseUrl(req) {
  return (
    Settings.gitBridgeWebInternalUrl || `${req.protocol}://${req.get('host')}`
  ).replace(/\/$/, '')
}

async function doc(req, res) {
  const projectId = await checkProject(req, res)
  if (!projectId) return
  res.json(await getDoc(projectId))
}

async function savedVersions(req, res) {
  const projectId = await checkProject(req, res)
  if (!projectId) return
  res.json(await getSavedVersions(projectId))
}

async function snapshot(req, res) {
  const projectId = await checkProject(req, res)
  if (!projectId) return
  const version = Number(req.params.version)
  if (!Number.isInteger(version) || version < 0) {
    return res.status(404).json({ message: 'Not Found' })
  }
  const { srcs, atts, paths } = await getSnapshot(
    projectId,
    version,
    webBaseUrl(req)
  )
  if (hasDotGit(paths)) {
    return res.status(409).json({ code: 'projectHasDotGit' })
  }
  res.json({ srcs, atts })
}

async function push(req, res) {
  const projectId = await checkProject(req, res, { write: true })
  if (!projectId) return
  const problem = validatePushRequest(req.body)
  if (problem) {
    logger.warn({ projectId, problem }, 'git-bridge: bad push request')
    return res.status(400).json({ message: problem })
  }
  await flush(projectId)
  const { version } = await latestVersion(projectId)
  if (version !== req.body.latestVerId) {
    // git-bridge reads this answer as "pull first"; an HTTP error would not be
    return res.json({ status: 409, code: 'outOfDate', message: 'Out of Date' })
  }
  res.status(202).json({ status: 202, code: 'accepted', message: 'Accepted' })
  processPush(projectId, req.gitBridgeUserId, req.body).catch(err =>
    logger.error({ err, projectId }, 'git-bridge: push processing crashed')
  )
}

/** Binary file of a snapshot; the signed token is the credential. */
async function blob(req, res) {
  const { project_id: projectId, hash } = req.params
  if (
    !/^[0-9a-f]{24}$/.test(projectId) ||
    !/^[0-9a-f]{40}$/.test(hash) ||
    !checkBlobToken(projectId, hash, req.query.token)
  ) {
    return res.status(404).json({ message: 'Not Found' })
  }
  const { stream, contentLength } =
    await HistoryManager.promises.requestBlobWithProjectId(projectId, hash)
  res.setHeader('Content-Type', 'application/octet-stream')
  if (Number.isFinite(contentLength)) {
    res.setHeader('Content-Length', contentLength)
  }
  await pipeline(stream, res)
}

export default {
  page: expressify(page),
  createToken: expressify(createToken),
  revokeToken: expressify(revokeToken),
  tokenInfo: expressify(tokenInfo),
  requireToken: expressify(requireToken),
  doc: expressify(doc),
  savedVersions: expressify(savedVersions),
  snapshot: expressify(snapshot),
  push: expressify(push),
  blob: expressify(blob),
}
