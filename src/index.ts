/**
 * Quota Matata — No worries, just retries.
 *
 * Package root: the supported OpenCode v2 plugin default entry
 * (`Plugin.define({ id, setup })` from `@opencode/plugin@2.3.0`) plus the
 * core/logger named exports. The host loads this default export when the
 * package is listed in `plugins` (root or `./server` subpath).
 *
 * Importing this entry loads the OpenCode SDK. For the SDK-free pure core and
 * logger, use the `quota-matata/core` subpath (identical named exports).
 * See README.md and specs/integration.md for installation and compatibility.
 */
import { Plugin } from "@opencode/plugin"
import { PLUGIN_ID, setupQuotaMatata } from "./adapter.js"

export * from "./core.js"
export { PLUGIN_ID, setupQuotaMatata } from "./adapter.js"

export default Plugin.define({
  id: PLUGIN_ID,
  setup: setupQuotaMatata,
})