import type { Context } from '@deepseek-ai/cordis'
import type { ToolRegistry } from '@deepseek-ai/dsh-tools'
import { Config } from './config.ts'
import { WorkerSession } from './session.ts'
import { navigationTools } from './tools/document.ts'
import { argumentTools } from './tools/argument.ts'
import { historyTools } from './tools/history.ts'
import { CLAIM_EVIDENCE_PRESET, PRESET_SECTION_NAME, PRESET_SECTION_ORDER } from './preset.ts'

/**
 * The DeepSeek Harness plugin entry.
 *
 * Responsibilities are deliberately minimal:
 *  - validate config (Schemastery, via the exported `Config` schema),
 *  - fail closed when thesisReviewAgentPath is unset (register no tools),
 *  - lazily start ONE shared thesis-review-agent Python worker,
 *  - register adapter tools that forward Harness tool calls to worker ops,
 *  - optionally register the claim-evidence preset as a system-prompt section,
 *  - tear the worker down when the plugin unloads.
 *
 * It contains NO thesis logic: DOCX parsing, quote validation, history recall,
 * the evidence gate, and Word output all stay in the Python worker.
 */
export const name = 'thesis-review-dsh-plugin'

// `tools` is required (the whole point of the plugin). `systemPrompt` is an
// optional peer: read defensively so the plugin still loads in a composition
// that does not mount it.
export const inject = ['tools']

export { Config }

export function apply(ctx: Context, config: Config): void {
  const tools = ctx.tools as ToolRegistry

  // Fail closed: without a path to the main project there is nothing to adapt.
  if (!config.thesisReviewAgentPath.trim()) {
    ctx.logger?.warn(
      '[thesis-review-dsh-plugin] thesisReviewAgentPath is empty; no tools registered. ' +
        'Set it in your profile cordis.patch.yml to a local thesis-review-agent checkout.',
    )
    return
  }

  // One shared worker per plugin instance; started lazily on first tool call.
  const session = new WorkerSession(config)

  // Register every tool. Each registration is a Cordis effect, so disposal
  // unregisters them automatically; we still dispose the worker explicitly.
  const toolDefs = [
    ...navigationTools(session, config.toolTimeoutMs),
    ...argumentTools(session, config.toolTimeoutMs),
    ...(config.enableHistory ? historyTools(session, config.toolTimeoutMs) : []),
  ]
  for (const tool of toolDefs) {
    tools.register(tool)
  }

  // Optional: contribute the claim-evidence guidance as a prompt section.
  const systemPrompt = (ctx as { systemPrompt?: { section: (s: unknown) => () => void } }).systemPrompt
  if (config.enablePreset && systemPrompt && typeof systemPrompt.section === 'function') {
    systemPrompt.section({
      name: PRESET_SECTION_NAME,
      order: PRESET_SECTION_ORDER,
      text: CLAIM_EVIDENCE_PRESET,
    })
  }

  // Tear the worker down when the plugin unloads (session end / HMR replace).
  ctx.effect(() => () => {
    void session.dispose()
  })
}
