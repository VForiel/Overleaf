import Path from 'node:path'
import { fileURLToPath } from 'node:url'
import Settings from '@overleaf/settings'
import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import McpTokenManager from './McpTokenManager.mjs'
import { handleBody } from './McpServer.mjs'

const __dirname = Path.dirname(fileURLToPath(import.meta.url))
const VIEW = Path.resolve(__dirname, '../views/mcp')

function connectorUrl(token) {
  return `${Settings.siteUrl}/mcp/${token}`
}

async function renderPage(req, res, newLink = null) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const tokens = await McpTokenManager.listForUser(userId)
  res.render(VIEW, {
    title: 'Connecteur IA (MCP)',
    tokens,
    newLink,
    exampleUrl: `${Settings.siteUrl}/mcp/olmcp_…`,
  })
}

async function page(req, res) {
  await renderPage(req, res)
}

async function createToken(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const token = await McpTokenManager.create(userId, req.body.name)
  // The link is shown once, on this answer only
  res.setHeader('Cache-Control', 'no-store')
  await renderPage(req, res, connectorUrl(token))
}

async function revokeToken(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  await McpTokenManager.revoke(userId, req.params.tokenId)
  res.redirect('/user/mcp')
}

async function endpoint(req, res) {
  const token = req.params.token || req.token // path, or "Authorization: Bearer …"
  const userId = await McpTokenManager.findUserId(token)
  const user =
    userId &&
    (await UserGetter.promises.getUser(userId, { _id: 1, suspended: 1 }))
  if (!user || user.suspended) {
    res.setHeader('WWW-Authenticate', 'Bearer')
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Invalid or revoked connector link' },
    })
  }
  if (req.method !== 'POST') {
    // No server-initiated stream and no session to close
    res.setHeader('Allow', 'POST')
    return res.status(405).send('Method Not Allowed')
  }
  const answer = await handleBody(userId, req.body)
  if (answer === null) return res.sendStatus(202)
  res.json(answer)
}

export default {
  page: expressify(page),
  createToken: expressify(createToken),
  revokeToken: expressify(revokeToken),
  endpoint: expressify(endpoint),
}
