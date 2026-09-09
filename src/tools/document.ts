import { readFile } from 'node:fs/promises'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WorkerSession } from '../session.ts'
import { defineWorkerTool, runWorkerOp, sessionKeyFor, type WorkerToolSpec } from './common.ts'

/**
 * Navigation tools: open the draft and read bounded windows of it.
 *
 * Every limit here (paragraph caps, character caps, the navigation budget,
 * outline text length) is enforced by the Python worker, NOT by this adapter.
 * The tools forward reads verbatim and return the worker's bounded result so
 * the Harness agent navigates under the exact same constraints as the Pi
 * runtime. Nothing re-implements DOCX parsing.
 */

/**
 * thesis_open -> worker op "open_draft".
 *
 * Accepts an absolute `path` to a .docx. Reading the file and base64-encoding
 * it is protocol plumbing (the worker takes either a path or bytes_b64; on a
 * remote Harness host the worker cannot see the agent's filesystem, so the
 * adapter ships the bytes). It returns only basic info (paragraph count), not
 * the full text — the worker decides what to return.
 */
export function defineOpenTool(session: WorkerSession, timeoutMs?: number): ToolDefinition {
  return defineTool({
    name: 'thesis_open',
    description:
      '打开待审的 Word 稿件（.docx）。传入稿件的绝对路径。只返回基本信息（段落数量），不返回全文。',
    parameters: {
      path: { type: 'string', required: true, description: '待审 .docx 稿件的绝对路径。' },
      draft_id: { type: 'string', description: '可选的稿件标识，默认 new。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    async execute(args, exec) {
      // Reading the file and base64-encoding it is protocol plumbing; a missing or
      // unreadable path is an INFRASTRUCTURE failure, so it throws (DSH marks the
      // call as an error). The worker's own open_draft rejection (e.g. open_failed)
      // is a DOMAIN outcome, so it is returned structured with its code intact.
      // Honor the Harness deadline before doing any work so an already-aborted call
      // does not read and ship a document nobody is waiting for.
      if (exec?.signal?.aborted) throw new Error('tool call aborted before dispatch.')
      const bytes = await readFile(args.path)
      const params: Record<string, unknown> = { bytes_b64: bytes.toString('base64') }
      if (args.draft_id !== undefined) params.draft_id = args.draft_id
      return runWorkerOp(session, 'open_draft', params, sessionKeyFor(exec), exec?.signal)
    },
  })
}

/**
 * The remaining navigation/record tools are pure op forwards with the same
 * parameter names the worker already expects (start_ordinal, limit, needle,
 * max_hits). Descriptions mirror the bounded behavior the worker enforces.
 */
export const NAVIGATION_TOOL_SPECS: readonly WorkerToolSpec[] = [
  {
    name: 'thesis_outline',
    op: 'list_outline',
    label: '列出大纲',
    description:
      '列出标题性段落的序号(ordinal)、锚点(anchor)和短文本，供 Agent 决定去哪读。不是全文。',
    parameters: {},
  },
  {
    name: 'thesis_read_section',
    op: 'read_section',
    label: '阅读章节',
    description:
      '从指定 start_ordinal 读到下一个标题为止，受 Worker 限制（最多 8 段或有限字符）。',
    parameters: {
      start_ordinal: { type: 'integer', required: true, description: '起始段落序号。' },
      limit: { type: 'integer', description: '可选段落上限，Worker 会再做硬截断。' },
    },
  },
  {
    name: 'thesis_read_paragraphs',
    op: 'read_paragraphs',
    label: '阅读段落',
    description: '从指定 start_ordinal 起读取有限段落（Worker 硬上限 8 段、有限字符）。',
    parameters: {
      start_ordinal: { type: 'integer', required: true, description: '起始段落序号。' },
      limit: { type: 'integer', description: '可选段落上限，Worker 会再做硬截断。' },
    },
  },
  {
    name: 'thesis_find_text',
    op: 'find_text',
    label: '检索原文',
    description: '在正文中查找短词 needle，返回少量命中及其上下文（Worker 限制命中数）。',
    parameters: {
      needle: { type: 'string', required: true, description: '要检索的原文片段。' },
      max_hits: { type: 'integer', description: '可选命中上限，Worker 会再做硬截断。' },
    },
  },
]

/** Build all navigation tools (thesis_open + the spec-driven forwards). */
export function navigationTools(session: WorkerSession, timeoutMs?: number): ToolDefinition[] {
  return [
    defineOpenTool(session, timeoutMs),
    ...NAVIGATION_TOOL_SPECS.map((spec) => defineWorkerTool(session, { ...spec, timeoutMs })),
  ]
}
