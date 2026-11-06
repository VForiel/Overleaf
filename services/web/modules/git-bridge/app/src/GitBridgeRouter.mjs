import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import GitBridgeController from './GitBridgeController.mjs'

const manageRateLimiter = new RateLimiter('git-manage-tokens', {
  points: 20,
  duration: 60,
})

export default {
  apply(webRouter, privateApiRouter, publicApiRouter) {
    if (!Settings.enableGitBridge) {
      logger.debug({}, 'Git bridge disabled')
      return
    }
    logger.debug({}, 'Init git bridge router')

    // Token management, for the logged-in user
    webRouter.get(
      '/user/git',
      AuthenticationController.requireLogin(),
      GitBridgeController.page
    )
    webRouter.post(
      '/user/git/tokens',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(manageRateLimiter),
      GitBridgeController.createToken
    )
    webRouter.post(
      '/user/git/tokens/:tokenId/delete',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(manageRateLimiter),
      GitBridgeController.revokeToken
    )

    // Called by services/git-bridge only (Caddy keeps these routes off the internet)
    publicApiRouter.get('/oauth/token/info', GitBridgeController.tokenInfo)
    publicApiRouter.get(
      '/api/v0/docs/:project_id/blobs/:hash',
      GitBridgeController.blob
    )
    publicApiRouter.get(
      '/api/v0/docs/:project_id',
      GitBridgeController.requireToken,
      GitBridgeController.doc
    )
    publicApiRouter.get(
      '/api/v0/docs/:project_id/saved_vers',
      GitBridgeController.requireToken,
      GitBridgeController.savedVersions
    )
    publicApiRouter.get(
      '/api/v0/docs/:project_id/snapshots/:version',
      GitBridgeController.requireToken,
      GitBridgeController.snapshot
    )
    publicApiRouter.post(
      '/api/v0/docs/:project_id/snapshots',
      GitBridgeController.requireToken,
      GitBridgeController.push
    )
  },
}
