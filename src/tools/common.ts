import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { WorkerSession } from '../session.ts'

/** Any lossless JSON value; the shape worker results conform to. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

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
 * dicts (outline lists, paragraph windows, finding receipts, commit paths).
 * The model-facing render is the pretty-printed JSON, matching how the Pi
 * runtime presented worker results in agent/review.mjs.
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
    async execute(args) {
      // Forward the validated args straight through as worker op params.
      // The worker owns every domain rule; the adapter adds none. Its result is
      // a lossless JSON dict, so it is the canonical value for the json schema.
      return (await session.call(spec.op, args as Record<string, unknown>)) as JsonValue
    },
  })
}
