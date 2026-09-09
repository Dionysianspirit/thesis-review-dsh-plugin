import type { Context } from '@deepseek-ai/cordis'
import type { ToolRegistry } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { Config } from './config.ts'
import { WorkerSession } from './session.ts'
import { navigationTools } from './tools/document.ts'
import { argumentTools } from './tools/argument.ts'
import { historyTools } from './tools/history.ts'
import { CLAIM_EVIDENCE_PRESET, PRESET_SECTION_NAME, PRESET_SECTION_ORDER } from './preset.ts'

/** The history store filename the main project writes under its home. */
const HISTORY_STORE = 'thesis-review.sqlite'

/**
 * Resolve a REAL thesis-review history home when `enableHistory` is on.
 *
 * Mirrors the main project's `app_home()` (python/thesis_review/paths.py): an
 * explicit config `workerHome` wins, then the `THESIS_REVIEW_HOME` env override,
 * then the platform default (`%APPDATA%/ThesisReviewAgent` on Windows,
 * `~/.thesis-review-agent` elsewhere). Returns the path ONLY if it already holds a
 * `thesis-review.sqlite` store and is not inside the agent checkout.
 *
 * Returning null means "no valid history home", so the caller fails closed: it
 * does NOT register the history tools against a fresh temp DB, which would report
 * 0 candidates and mislead the model into thinking the student has no history.
 */
function resolveHistoryHome(config: Config): string | null {
  const root = path.resolve(config.thesisReviewAgentPath)
  const platformDefault =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? homedir(), 'ThesisReviewAgent')
      : path.join(homedir(), '.thesis-review-agent')
  const candidates = [
    config.workerHome?.trim() ? path.resolve(config.workerHome.trim()) : null,
    process.env.THESIS_REVIEW_HOME?.trim() ? path.resolve(process.env.THESIS_REVIEW_HOME.trim()) : null,
    platformDefault,
  ].filter((value): value is string => value !== null)

  for (const home of candidates) {
    // Never use a home inside the checkout (would write into the main repo).
    if (home === root || home.startsWith(root + path.sep)) continue
    if (existsSync(path.join(home, HISTORY_STORE))) return home
  }
  return null
}

/**
 * The DeepSeek Harness plugin entry.
 *
 * Responsibilities are deliberately minimal:
 *  - validate config (Schemastery, via the exported `Config` schema),
 *  - fail closed when thesisReviewAgentPath is unset (register no tools),
 *  - route each Harness session to its OWN thesis-review-agent Python worker,
 *  - register adapter tools that forward Harness tool calls to worker ops,
 *  - optionally register the claim-evidence preset as a system-prompt section,
 *  - tear each worker down on `agent/disposed` and all workers on unload.
 *
 * It contains NO thesis logic: DOCX parsing, quote validation, history recall,
 * the evidence gate, and Word output all stay in the Python worker.
 *
 * SESSION ISOLATION: DSH mounts this plugin ONCE (mountRootInclude runs a single
 * time during boot), so apply() runs once and this WorkerSession is shared by
 * every concurrent agent/session. The thesis-review-agent worker is stateful and
 * holds one "current draft", so sharing a single worker across sessions would let
 * session B's open_draft clobber the document session A is mid-review on. Tools
 * therefore route by the Harness agent id (== SessionId) to a per-session worker,
 * and the `agent/disposed` listener below reaps each session's worker so a
 * finished review never leaks its Python process.
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

  // Routes each Harness session (agent id) to its own Python worker; started
  // lazily on that session's first tool call. Shared across the whole Harness.
  //
  // HISTORY (Checklist 2): the claim-evidence tools need no persisted history, so
  // by default each worker gets a fresh temp home and never touches the main repo.
  // When enableHistory is on, the history tools are only meaningful against the
  // REAL thesis-review store; resolve it and fail closed if it cannot be found,
  // rather than silently serving an empty DB that reports 0 candidates.
  let historyHome: string | null = null
  if (config.enableHistory) {
    historyHome = resolveHistoryHome(config)
    if (!historyHome) {
      ctx.logger?.warn(
        '[thesis-review-dsh-plugin] enableHistory is true but no thesis-review history home ' +
          '(thesis-review.sqlite) could be resolved. Set config.workerHome, or THESIS_REVIEW_HOME, ' +
          'to the real history home. The history tools are NOT registered (history_unavailable) ' +
          'to avoid reporting an empty store as "no history".',
      )
    }
  }

  // Effective config: when history is enabled AND resolved, pin every worker to
  // that home so the history tools read the real store. Otherwise leave workerHome
  // empty (temp home, no persisted history) exactly as before.
  const effectiveConfig: Config = historyHome ? { ...config, workerHome: historyHome } : config
  const session = new WorkerSession(effectiveConfig)

  // Register every tool. Each registration is a Cordis effect, so disposal
  // unregisters them automatically; we still dispose the workers explicitly.
  const toolDefs = [
    ...navigationTools(session, config.toolTimeoutMs),
    ...argumentTools(session, config.toolTimeoutMs),
    ...(historyHome ? historyTools(session, config.toolTimeoutMs) : []),
  ]
  for (const tool of toolDefs) {
    tools.register(tool)
  }

  // Reap a session's worker when its agent leaves the registry, so a finished
  // review never leaks its Python process. `agent/disposed` is emitted by the
  // agent loop after driver quiescence; the listener is a Cordis effect, so it is
  // removed automatically when the plugin unloads. Absent an agents service the
  // event simply never fires and the unload disposer below still reaps everything.
  ctx.on('agent/disposed', ({ agent }: { agent: { id?: unknown } }) => {
    const id = agent?.id
    if (typeof id === 'string' && id.length > 0) {
      void session.disposeSession(id)
    }
  })

  // Optional: contribute the claim-evidence guidance as a prompt section.
  // `systemPrompt` is NOT in `inject` (declaring it would make the service a
  // hard requirement and stall the plugin in a composition that omits it, e.g.
  // the `minimal` profile). Cordis's context proxy throws on an un-injected
  // property read, so probe it with `ctx.reflect.get(name, false)` — the same
  // non-strict lookup Cordis uses internally — which yields `undefined` when the
  // peer service is absent instead of throwing.
  const systemPrompt = ctx.reflect.get('systemPrompt', false) as
    | { section: (s: { name: string; order: number; text: string }) => () => void }
    | undefined
  if (config.enablePreset && systemPrompt && typeof systemPrompt.section === 'function') {
    systemPrompt.section({
      name: PRESET_SECTION_NAME,
      order: PRESET_SECTION_ORDER,
      text: CLAIM_EVIDENCE_PRESET,
    })
  }

  // Tear every session's worker down when the plugin unloads (session end / HMR
  // replace). This is the backstop for sessions whose `agent/disposed` we missed.
  ctx.effect(() => () => {
    void session.dispose()
  })
}
