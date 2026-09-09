import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { DEFAULT_SESSION_KEY, type WorkerSession } from '../session.ts'
import { WorkerError } from '../worker-client.ts'

/** Any lossless JSON value; the shape worker results conform to. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Derive the per-session routing key from a Harness tool-run context.
 *
 * `exec.agent` is populated on every real dispatch: the agent loop resolves the
 * initiating agent (`ctx.agents.requireInitiator()`) and passes it into the tool
 * run context, and `agent.id` equals the agent's SessionId. Calls that carry no
 * agent (headless runs, unit tests) fall back to the shared default key, which
 * is exactly the single-session behavior. Keeping this in one place means every
 * worker tool routes to the correct per-session worker identically.
 */
export function sessionKeyFor(exec: { agent?: { id?: unknown } | null } | undefined): string {
  const id = exec?.agent?.id
  return typeof id === 'string' && id.length > 0 ? id : DEFAULT_SESSION_KEY
}

/**
 * Forward one op to the session's worker, turning an expected DOMAIN rejection
 * into a structured tool result and re-throwing only infrastructure failures.
 *
 * Why: DSH flattens a thrown error into `Error: <message>` for the model and
 * keeps a structured `error.code` only for its own HarnessError, so a bare throw
 * of our WorkerError would drop the worker's code (observed on a real registry
 * dispatch: the model saw only "Error: 主张或证据原文不在稿件中" with
 * WORKER_CODE_VISIBLE_TO_MODEL=false). The worker's domain codes
 * (quote_not_in_draft, argument_limit, repeat_wording, nav_budget, not_open,
 * issue_mismatch, open_failed, ...) are outcomes the model should act on, so we
 * return them as a canonical JSON result `{ ok:false, error:{ code, message } }`
 * through the json output schema — the code survives to the model.
 *
 * Infrastructure failures (worker won't start, socket dies, session closed) are
 * NOT domain outcomes; they re-throw so DSH marks the call as an error.
 */
export async function runWorkerOp(
  session: WorkerSession,
  op: string,
  params: Record<string, unknown>,
  sessionKey: string,
  signal?: AbortSignal,
): Promise<JsonValue> {
  try {
    return (await session.call(op, params, sessionKey, signal)) as JsonValue
  } catch (error) {
    if (error instanceof WorkerError && error.domain) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    throw error
  }
}

/**
 * Build a Harness tool that forwards to one Python worker op.
 *
 * The tool declares a typed parameter schema (so Harness validates and infers
 * args before execute runs), forwards the args as the worker op's `params`
 * verbatim, and returns the worker's raw JSON result as the canonical value.
 * No thesis logic is applied here: parameter names, limits, and validation are
 * owned by python/thesis_review/worker.py. This factory only adapts the call.
 *
 * Output uses the `json` root schema because worker results are heterogeneous
 * dicts (outline lists, paragraph windows, finding receipts, commit paths, and
 * structured domain rejections). The model-facing render is the pretty-printed
 * JSON, matching how the Pi runtime presented worker results in agent/review.mjs.
 */
export interface WorkerToolSpec {
  /** Harness tool name shown to the model. */
  name: string
  /** The Python worker op this tool maps to (e.g. "open_draft"). */
  op: string
  /** Short model-facing label. */
  label: string
  /** Model-facing description. */
  description: string
  /** Typed parameter schema (per-property, implicit open object root). */
  parameters: ParameterSchemaSpec
  /** Optional cooperative per-call timeout in ms. */
  timeoutMs?: number
}

export function defineWorkerTool(session: WorkerSession, spec: WorkerToolSpec): ToolDefinition {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    async execute(args, exec) {
      // Forward the validated args straight through as worker op params, routed to
      // THIS Harness session's worker so concurrent sessions never share one
      // stateful "current draft". The worker owns every domain rule; the adapter
      // adds none. `exec.signal` is threaded through so the Harness tool-call
      // deadline actually stops this call instead of leaving it pending on a slow
      // worker (DSH arms the signal from `timeoutMs` but only notifies).
      return runWorkerOp(session, spec.op, args as Record<string, unknown>, sessionKeyFor(exec), exec?.signal)
    },
  })
}
