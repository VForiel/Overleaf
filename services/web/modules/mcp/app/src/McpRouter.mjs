import logger from '@overleaf/logger'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import McpController from './McpController.mjs'

const rateLimiters = {
  manage: new RateLimiter('mcp-manage-tokens', { points: 20, duration: 60 }),
  // An AI agent chains many small calls: generous, but bounded
  endpoint: new RateLimiter('mcp-endpoint', { points: 600, duration: 60 }),
}

const endpointRateLimit = RateLimiterMiddleware.rateLimit(
  rateLimiters.endpoint,
  {
    params: ['token'],
    getUserId: () => null,
  }
)

export default {
  apply(webRouter, privateApiRouter, publicApiRouter) {
    logger.debug({}, 'Init MCP router')

    webRouter.get(
      '/user/mcp',
      AuthenticationController.requireLogin(),
      McpController.page
    )
    webRouter.post(
      '/user/mcp/tokens',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.manage),
      McpController.createToken
    )
    webRouter.post(
      '/user/mcp/tokens/:tokenId/delete',
      AuthenticationController.requireLogin(),
      RateLimiterMiddleware.rateLimit(rateLimiters.manage),
      McpController.revokeToken
    )

    // Called by the AI client: no session, no CSRF token, authenticated by the link itself
    publicApiRouter.all(
      '/mcp/:token',
      endpointRateLimit,
      McpController.endpoint
    )
    publicApiRouter.all('/mcp', endpointRateLimit, McpController.endpoint)
  },
}
