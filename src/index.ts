/**
 * Package entry.
 *
 * DeepSeek Harness resolves the bundle patch row `name: thesis-review-dsh-plugin`
 * to this module (package.json `main` -> lib/index.js) and loads it as a Cordis
 * plugin, so this file must re-export the plugin shape: `name`, `inject`,
 * `apply`, and the `Config` schema. The other re-exports exist for the test
 * suite and for advanced consumers; they are not required by the loader.
 */
export { name, inject, apply, Config } from './plugin.ts'
export type { Config as ConfigType } from './config.ts'
export { WorkerSession } from './session.ts'
export { startWorker, WorkerError } from './worker-client.ts'
export type { WorkerCall, WorkerConfig, WorkerTransport } from './worker-client.ts'
export { defineWorkerTool } from './tools/common.ts'
export { navigationTools, defineOpenTool, NAVIGATION_TOOL_SPECS } from './tools/document.ts'
export { argumentTools, ARGUMENT_TOOL_SPECS } from './tools/argument.ts'
export { historyTools, HISTORY_TOOL_SPECS } from './tools/history.ts'
export { CLAIM_EVIDENCE_PRESET, PRESET_SECTION_NAME, PRESET_SECTION_ORDER } from './preset.ts'
