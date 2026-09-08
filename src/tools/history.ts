import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WorkerSession } from '../session.ts'
import { defineWorkerTool, type WorkerToolSpec } from './common.ts'

/**
 * History tools (OPTIONAL PHASE 2).
 *
 * These are gated behind `enableHistory` (default false) so the first version
 * stays a single real Agent scenario: claim-vs-evidence. They are included here
 * because the mapping is trivial once the claim-evidence PoC works, but they
 * are NOT advertised as "semantic history search".
 *
 * The candidate recall is still the main project's string matcher: the Python
 * worker's `get_history_candidates` returns string-recall candidates only, and
 * DSH does not do semantic recall. `confirm_history_finding` keeps the full
 * evidence gate in Python (issue exists, belongs to this teacher/student, is
 * confirmed, new_quote is real, quote matches the recall position). The Harness
 * agent only supplies the judgment "this is the same unresolved issue"; Python
 * still owns the final write decision.
 */
export const HISTORY_TOOL_SPECS: readonly WorkerToolSpec[] = [
  {
    name: 'thesis_history_candidates',
    op: 'get_history_candidates',
    label: '历史候选',
    description:
      '返回教师已确认历史问题的字符串召回候选（原文片段），不写任何批注。语义召回不由本插件负责。',
    parameters: {
      draft_id: { type: 'string', description: '可选稿件标识，默认 new。' },
    },
  },
  {
    name: 'thesis_confirm_history',
    op: 'confirm_history_finding',
    label: '确认复发',
    description:
      '仅当你判断这是同一条历史问题仍未解决时调用。new_quote 必须是本稿真实原文子串，并与字符串召回位置一致；由 Python Worker 校验，不确定就不要调用。',
    parameters: {
      issue_id: { type: 'string', required: true, description: '候选返回的历史问题编号。' },
      new_quote: { type: 'string', required: true, description: '本稿中真实存在的原文子串。' },
      rationale: { type: 'string', description: '判断为同一问题的理由。' },
      draft_id: { type: 'string', description: '可选稿件标识，默认 new。' },
    },
  },
]

/** Build the history tools (candidates + confirm). */
export function historyTools(session: WorkerSession, timeoutMs?: number): ToolDefinition[] {
  return HISTORY_TOOL_SPECS.map((spec) => defineWorkerTool(session, { ...spec, timeoutMs }))
}
