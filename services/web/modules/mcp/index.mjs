import McpRouter from './app/src/McpRouter.mjs'

/**
 * Model Context Protocol server: lets an external AI (Claude, …) read, edit and
 * compile the projects of the user who created the connector link.
 *
 * @import { WebModule } from "../../types/web-module"
 */

/** @type {WebModule} */
const McpModule = {
  router: McpRouter,
}

export default McpModule
