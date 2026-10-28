import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { TOOLS, ToolError, callTool } from './McpTools.mjs'

// Stateless "Streamable HTTP" transport: every POST carries one JSON-RPC message
// (or a batch) and gets a JSON answer; there is no session and no server-sent stream.
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS =
  'Overleaf projects of the user who created this connector link. ' +
  'Start with list_projects, then list_files. Prefer edit_file to write_file for small changes, ' +
  'and run compile after editing to check the LaTeX errors. Edits appear live for collaborators ' +
  'and are recorded in the project history.'

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

async function handleMessage(userId, message) {
  if (
    !message ||
    message.jsonrpc !== '2.0' ||
    typeof message.method !== 'string'
  ) {
    return rpcError(message?.id, -32600, 'Invalid Request')
  }
  const { id, method, params = {} } = message
  if (id === undefined) return null // notification: nothing to answer

  const result = value => ({ jsonrpc: '2.0', id, result: value })
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion
      return result({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'overleaf',
          title: `Overleaf (${new URL(Settings.siteUrl).host})`,
          version: '1.0.0',
        },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return result({})
    case 'tools/list':
      return result({ tools: TOOLS })
    case 'tools/call': {
      const name = params.name
      try {
        const answer = await callTool(userId, name, params.arguments)
        if (answer === null)
          return rpcError(id, -32602, `Unknown tool: ${name}`)
        return result(answer)
      } catch (error) {
        if (!(error instanceof ToolError)) {
          logger.warn({ err: error, userId, tool: name }, 'MCP tool failed')
        }
        return result({
          isError: true,
          content: [
            {
              type: 'text',
              text:
                error instanceof ToolError
                  ? error.message
                  : `Overleaf error: ${error.message}`,
            },
          ],
        })
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}

/** Answer to a POST body: a message, an array of messages, or null when only notifications were sent. */
export async function handleBody(userId, body) {
  if (Array.isArray(body)) {
    const answers = []
    for (const message of body) {
      const answer = await handleMessage(userId, message)
      if (answer) answers.push(answer)
    }
    return answers.length ? answers : null
  }
  if (body == null || typeof body !== 'object') {
    return rpcError(null, -32700, 'Parse error')
  }
  return await handleMessage(userId, body)
}
