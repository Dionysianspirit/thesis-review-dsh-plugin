import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { WorkerSession } from '../src/session.ts'
import { navigationTools } from '../src/tools/document.ts'
import { argumentTools } from '../src/tools/argument.ts'
import {
  integrationSkipReason,
  resolveAgentRoot,
  resolvePython,
  makeFixtureDocx,
} from './helpers.ts'
import type { Config } from '../src/config.ts'

/**
 * Faux agent-loop test — PLUMBING ONLY.
 *
 * This replays a SCRIPTED tool-call path (no model, no LLM) through the real
 * Harness tools against the real Python worker, mirroring the main project's
 * faux-provider idea (thesis-review-agent/tests/test_pi_review.py). It proves the
 * tools compose into a full open -> navigate -> record -> commit loop and that a
 * worker-driven finding lands in findings.json.
 *
 * !! THIS IS NOT A REAL-MODEL CAPABILITY TEST !!
 * The "agent" here is a hardcoded sequence written by us. It does NOT show that
 * a DeepSeek model can autonomously decide where to look, whether to seek
 * counter-evidence, or when to abandon a finding. Those behaviors are the actual
 * research question and require a real model with an API key (not run here).
 * The hardcoded path is deliberately the same shape the spec forbids baking into
 * the plugin: the plugin ships only tools; this script lives in the test.
 */

const skipReason = integrationSkipReason()
const root = resolveAgentRoot()
const python = resolvePython()
const describeOrSkip = skipReason ? describe.skip : describe
if (skipReason) console.warn(`[agent-loop-faux] skipping integration: ${skipReason}`)

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

interface Tool {
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

describeOrSkip('faux scripted agent loop (plumbing, NOT a model test)', () => {
  let overclaimDocx: string
  let outDir: string

  beforeAll(() => {
    overclaimDocx = makeFixtureDocx(root!, python, 'overclaim_draft')
    outDir = path.join(path.dirname(overclaimDocx), 'faux-out')
  })

  it('replays open -> outline -> read_section -> record -> commit', async () => {
    const session = new WorkerSession({
      thesisReviewAgentPath: root!,
      python,
      teacherId: 'dsh-test',
      studentId: 'dsh-student',
      major: '人工智能',
      transport: 'stdio',
      startupTimeoutMs: 20000,
    } as Config)
    try {
      const defs = [...navigationTools(session), ...argumentTools(session)]
      const tools = Object.fromEntries(defs.map((d) => [d.name, d as unknown as Tool]))

      // 1. open
      const opened = (await tools.thesis_open!.execute({ path: overclaimDocx }, exec())) as {
        n_paragraphs: number
      }
      expect(opened.n_paragraphs).toBeGreaterThan(3)

      // 2. outline -> pick the conclusion (a fixed choice, not a model decision)
      const outline = (await tools.thesis_outline!.execute({}, exec())) as {
        outline: { ordinal: number; text: string }[]
      }
      const conclusion = outline.outline.find((o) => o.text.includes('4 结论'))!
      expect(conclusion).toBeDefined()

      // 3. read the conclusion section (bounded by the worker)
      const section = (await tools.thesis_read_section!.execute(
        { start_ordinal: conclusion.ordinal },
        exec(),
      )) as { paragraphs: { text: string }[] }
      const claim = section.paragraphs.find((p) => p.text.includes('显著提升'))!.text

      // 4. find the evidence number (fixed needle, not a model decision)
      const evidenceHits = (await tools.thesis_find_text!.execute({ needle: '0.81' }, exec())) as {
        hits: { snippet: string }[]
      }
      expect(evidenceHits.hits.length).toBeGreaterThan(0)

      // 5. record the argument finding with real quotes from the draft
      const recorded = (await tools.thesis_record_argument!.execute(
        {
          claim_quote: claim,
          evidence_quote: '准确率由 0.81 提高到 0.83。',
          problem: '结论用词过满，实验结果仅有微弱数值变化。',
          rationale: '未见显著性检验，提升幅度与「显著提升」不符。',
        },
        exec(),
      )) as { ok: boolean }
      expect(recorded.ok).toBe(true)

      // 6. commit
      const commit = (await tools.thesis_commit!.execute(
        { draft_id: 'faux', output_dir: outDir },
        exec(),
      )) as { reviewed_path: string; findings_path: string; n_findings: number }
      expect(existsSync(commit.reviewed_path)).toBe(true)
      expect(commit.n_findings).toBe(1)

      const findings = JSON.parse(readFileSync(commit.findings_path, 'utf8')) as {
        source: string
      }[]
      expect(findings[0]!.source).toBe('argument')
    } finally {
      await session.dispose()
    }
  })
})
