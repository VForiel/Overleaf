import logger from '@overleaf/logger'
import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import * as GitSync from './GitSync.mjs'
import { SyncError } from './GitSync.mjs'
import { getLink, decryptToken } from './GitSyncStore.mjs'

// JSON routes of the "Remote repository" card of the editor's Integrations panel.
// Linking a repository (address and token) is for the project owner; anyone who
// can edit the project can pull, push and change the branch.

function ids(req) {
  return {
    projectId: req.params.Project_id,
    userId: SessionManager.getLoggedInUserId(req.session),
  }
}

/** SyncError → 400 with a message for people; anything else → 500. */
function handled(fn) {
  return expressify(async (req, res) => {
    try {
      await fn(req, res)
    } catch (err) {
      if (err instanceof SyncError) {
        return res
          .status(400)
          .json({ message: err.message, ...err.details })
      }
      logger.error({ err, projectId: req.params.Project_id }, 'git-sync failed')
      res
        .status(500)
        .json({ message: 'Erreur inattendue, voir le journal du serveur.' })
    }
  })
}

async function status(req, res) {
  const { projectId, userId } = ids(req)
  const canAdmin = await AuthorizationManager.promises.canUserAdminProject(
    userId,
    projectId,
    null
  )
  res.json({ ...(await GitSync.status(projectId)), canAdmin })
}

/**
 * Branches of a repository: of the address given (owner, while linking), or of
 * the linked repository (to change branch).
 */
async function branches(req, res) {
  const { projectId, userId } = ids(req)
  const link = await getLink(projectId)
  let url, token
  if (req.body.url) {
    const canAdmin = await AuthorizationManager.promises.canUserAdminProject(
      userId,
      projectId,
      null
    )
    if (!canAdmin) return res.status(403).json({ message: 'Réservé au propriétaire du projet.' })
    url = GitSync.checkUrl(req.body.url)
    token = req.body.token
      ? String(req.body.token).trim()
      : link && link.url === url
        ? await decryptToken(link)
        : null
  } else {
    if (!link) throw new SyncError('Ce projet n’est relié à aucun dépôt.')
    url = link.url
    token = await decryptToken(link)
  }
  res.json(await GitSync.listBranches(url, token))
}

async function linkRepo(req, res) {
  const { projectId, userId } = ids(req)
  await GitSync.link(projectId, userId, {
    url: req.body.url,
    branch: req.body.branch,
    token: req.body.token,
  })
  res.json(await GitSync.status(projectId))
}

async function unlinkRepo(req, res) {
  const { projectId } = ids(req)
  await GitSync.unlink(projectId)
  res.json({ linked: false })
}

async function changeBranch(req, res) {
  const { projectId } = ids(req)
  await GitSync.changeBranch(projectId, req.body.branch)
  res.json(await GitSync.status(projectId))
}

async function pull(req, res) {
  const { projectId, userId } = ids(req)
  const strategy = req.body.strategy === 'replace' ? 'replace' : 'merge'
  const result = await GitSync.pull(projectId, userId, { strategy })
  res.json({ ...result, status: await GitSync.status(projectId) })
}

async function push(req, res) {
  const { projectId, userId } = ids(req)
  const result = await GitSync.push(projectId, userId, {
    message: req.body.message,
  })
  res.json({ ...result, status: await GitSync.status(projectId) })
}

export default {
  status: handled(status),
  branches: handled(branches),
  link: handled(linkRepo),
  unlink: handled(unlinkRepo),
  changeBranch: handled(changeBranch),
  pull: handled(pull),
  push: handled(push),
}
