import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { WorkerSession } from '../src/session.ts'
import { navigationTools } from '../src/tools/document.ts'
import {
  integrationSkipReason,
  resolveAgentRoot,
  resolvePython,
  makeFixtureDocx,
} from './helpers.ts'
import type { Config } from '../src/config.ts'

/**
 * Tool mapping test — integration.
 *
 * Builds the real Harness tools from the plugin and calls each tool's execute()
 * with a synthetic exec context (the way ToolRegistry would), against the REAL
 * Python worker. Verifies the Harness tool -> worker op mapping for the four
 * navigation tools required by the spec:
 *   thesis_open -> open_draft
 *   thesis_outline -> list_outline
 *   thesis_read_section -> read_section
 *   thesis_find_text -> find_text
 *
 * This is plumbing (tool -> worker -> result), not a model test.
 */

const skipReason = integrationSkipReason()
const root = resolveAgentRoot()
const python = resolvePython()
const describeOrSkip = skipReason ? describe.skip : describe
if (skipReason) console.warn(`[tool-mapping] skipping integration: ${skipReason}`)

/** Minimal exec context; the tools only need signal/deferContext/concludeTurn. */
function exec() {
  return {
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
    callId: 'c1',
    rootCallId: 'c1',
    token: 'tok',
    arguments: {},
    agent: null,
  } as never
}

describeOrSkip('Harness tool -> worker op mapping', () => {
  let fixtureDocx: string
  let session: WorkerSession
  let tools: Record<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>

  beforeAll(() => {
    fixtureDocx = makeFixtureDocx(root!, python, 'overclaim_draft')
    session = new WorkerSession({
      thesisReviewAgentPath: root!,
      python,
      teacherId: 'dsh-test',
      studentId: 'dsh-student',
      major: '人工智能',
      transport: 'stdio',
      startupTimeoutMs: 20000,
    } as Config)
    const defs = navigationTools(session)
    tools = Object.fromEntries(defs.map((d) => [d.name, d as never]))
  })

  afterAll(async () => {
    await session.dispose()
  })

  it('thesis_open -> open_draft returns paragraph count only (no full text)', async () => {
    const result = (await tools.thesis_open!.execute({ path: fixtureDocx }, exec())) as {
      n_paragraphs: number
      paragraphs?: unknown
    }
    expect(result.n_paragraphs).toBeGreaterThan(3)
    // The worker must not dump the full document from open_draft.
    expect(result.paragraphs).toBeUndefined()
  })

  it('thesis_outline -> list_outline returns headings, not body text', async () => {
    const result = (await tools.thesis_outline!.execute({}, exec())) as {
      outline: { ordinal: number; anchor: string; text: string }[]
    }
    const texts = result.outline.map((o) => o.text)
    expect(texts).toContain('4 结论')
    expect(texts.some((t) => t.includes('3 实验结果'))).toBe(true)
    // The overclaim sentence lives in the body, not in an outline heading.
    expect(texts.some((t) => t.includes('实验结果表明该方法显著提升'))).toBe(false)
  })

  it('thesis_read_section -> read_section is bounded by the worker', async () => {
    const outline = (await tools.thesis_outline!.execute({}, exec())) as {
      outline: { ordinal: number; text: string }[]
    }
    const conclusion = outline.outline.find((o) => o.text.includes('4 结论'))!
    const result = (await tools.thesis_read_section!.execute(
      { start_ordinal: conclusion.ordinal, limit: 20 },
      exec(),
    )) as { paragraphs: { text: string }[]; truncated: boolean }
    // Worker hard-caps at 8 paragraphs; the adapter must not raise that.
    expect(result.paragraphs.length).toBeLessThanOrEqual(8)
    expect(result.paragraphs.some((p) => p.text.includes('实验结果表明该方法显著提升'))).toBe(true)
  })

  it('thesis_find_text -> find_text returns limited hits with anchors', async () => {
    const result = (await tools.thesis_find_text!.execute({ needle: '0.81' }, exec())) as {
      hits: { ordinal: number; anchor: string; snippet: string }[]
    }
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.length).toBeLessThanOrEqual(5)
    expect(result.hits[0]!.snippet).toContain('0.81')
    expect(result.hits[0]!.anchor).toMatch(/^P/)
  })

  it('validates args before reaching the worker (Harness-side schema)', async () => {
    // thesis_read_section requires start_ordinal; defineTool rejects its absence
    // before any worker call, so the worker is never sent a malformed op.
    await expect(tools.thesis_read_section!.execute({}, exec())).rejects.toThrow()
  })
})
