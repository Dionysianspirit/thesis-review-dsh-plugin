import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WorkerSession } from '../session.ts'
import { defineWorkerTool, type WorkerToolSpec } from './common.ts'

/**
 * Argument tools: record a claim-vs-evidence finding and commit the review.
 *
 * The Python worker's evidence gate owns every hard rule:
 *  - claim_quote must be a real substring of the draft,
 *  - evidence_quote must be a real substring of the draft,
 *  - at most 3 argument findings,
 *  - "再次" / "屡次" wording is rejected,
 *  - commit exports the reviewed .docx and findings.json.
 *
 * This adapter only forwards the model's args under the exact parameter names
 * the worker already expects. If the model invents a quote, the worker rejects
 * it and the rejection surfaces to the model unchanged — the adapter never
 * loosens that gate.
 */
export const ARGUMENT_TOOL_SPECS: readonly WorkerToolSpec[] = [
  {
    name: 'thesis_record_argument',
    op: 'record_argument_finding',
    label: '记录论证缺口',
    description:
      '当关键主张明显超过实验/数据支持范围时记录一条论证 finding。claim_quote 和 evidence_quote 都必须是稿件中真实存在的原文子串，由 Python Worker 校验；不要编造原文。最多 3 条。',
    parameters: {
      claim_quote: { type: 'string', required: true, description: '主张原文，必须是稿件中的真实子串。' },
      evidence_quote: { type: 'string', required: true, description: '证据/反证原文，必须是稿件中的真实子串。' },
      problem: { type: 'string', required: true, description: '问题描述；不得使用「再次」「屡次」。' },
      rationale: { type: 'string', required: true, description: '判断理由；不得使用「再次」「屡次」。' },
      draft_id: { type: 'string', description: '可选稿件标识，默认 new。' },
    },
  },
  {
    name: 'thesis_commit',
    op: 'commit_review',
    label: '提交审改',
    description:
      '导出带批注/修订的 Word 副本（reviewed.docx）和 findings.json。完成后不要再调用其他工具。',
    parameters: {
      output_dir: { type: 'string', required: true, description: '输出目录的绝对路径。' },
      draft_id: { type: 'string', description: '可选稿件标识，默认 new。' },
    },
  },
]

/** Build the argument tools (record + commit). */
export function argumentTools(session: WorkerSession, timeoutMs?: number): ToolDefinition[] {
  return ARGUMENT_TOOL_SPECS.map((spec) => defineWorkerTool(session, { ...spec, timeoutMs }))
}
