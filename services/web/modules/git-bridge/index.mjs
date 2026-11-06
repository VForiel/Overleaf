import GitBridgeRouter from './app/src/GitBridgeRouter.mjs'

/**
 * Git access to projects through services/git-bridge (git clone, pull, push),
 * with personal git tokens. Server Pro has its own closed-source version of
 * this module; this one is specific to the fork.
 *
 * @import { WebModule } from "../../types/web-module"
 */

/** @type {WebModule} */
const GitBridgeModule = {
  router: GitBridgeRouter,
}

export default GitBridgeModule
