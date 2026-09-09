import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
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

const skipReason = integrationSkipReason()
const root = resolveAgentRoot()
const python = resolvePython()
const describeOrSkip = skipReason ? describe.skip : describe
if (skipReason) console.warn(`[evidence-gate] skipping integration: ${skipReason}`)

const OVERCLAIM_CLAIM = '实验结果表明该方法显著提升了分类准确率。'
const OVERCLAIM_EVIDENCE = '准确率由 0.81 提高到 0.83。'
const SUPPORTED_CLAIM = '实验结果表明准确率达到 0.91，显著高于基线 0.72。'
const SUPPORTED_EVIDENCE = '准确率为 0.91，基线模型为 0.72。配对检验 p<0.01。'

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

function expectDomainRejection(result: unknown, code: string): void {
  expect(result).toMatchObject({ ok: false, error: { code } })
}

function makeSession(): {
  session: WorkerSession
  tools: Record<string, Tool>
} {
  const session = new WorkerSession({
    thesisReviewAgentPath: root!,
    python,
    teacherId: 'dsh-test',
    studentId: 'dsh-student',
    major: '人工智能',
    transport: 'stdio',
    startupTimeoutMs: 20000,
  } as Config)
  const defs = [...navigationTools(session), ...argumentTools(session)]
  const tools = Object.fromEntries(defs.map((d) => [d.name, d as unknown as Tool]))
  return { session, tools }
}

describeOrSkip('evidence gate (real Python worker)', () => {
  let overclaimDocx: string
  let supportedDocx: string

  beforeAll(() => {
    overclaimDocx = makeFixtureDocx(root!, python, 'overclaim_draft')
    supportedDocx = makeFixtureDocx(root!, python, 'supported_claim_draft')
  })

  it('accepts a finding whose claim and evidence quotes both exist', async () => {
    const { session, tools } = makeSession()
    try {
      await tools.thesis_open!.execute({ path: overclaimDocx }, exec())
      const recorded = (await tools.thesis_record_argument!.execute(
        {
          claim_quote: OVERCLAIM_CLAIM,
          evidence_quote: OVERCLAIM_EVIDENCE,
          problem: '结论用词过满，实验结果仅有微弱数值变化。',
          rationale: '未见显著性检验，提升幅度与「显著提升」不符。',
        },
        exec(),
      )) as { ok: boolean; id: string }
      expect(recorded.ok).toBe(true)
      expect(recorded.id).toBe('argument-1')
    } finally {
      await session.dispose()
    }
  })

  it('rejects an invented evidence quote (worker gate, not adapter)', async () => {
    const { session, tools } = makeSession()
    try {
      await tools.thesis_open!.execute({ path: overclaimDocx }, exec())
      expectDomainRejection(
        await tools.thesis_record_argument!.execute(
          {
            claim_quote: OVERCLAIM_CLAIM,
            evidence_quote: '准确率由 0.50 提高到 0.99，且差异极显著。',
            problem: '结论过满。',
            rationale: '编造的结果句。',
          },
          exec(),
        ),
        'quote_not_in_draft',
      )
    } finally {
      await session.dispose()
    }
  })

  it('rejects a missing claim quote', async () => {
    const { session, tools } = makeSession()
    try {
      await tools.thesis_open!.execute({ path: overclaimDocx }, exec())
      expectDomainRejection(
        await tools.thesis_record_argument!.execute(
          {
            claim_quote: '',
            evidence_quote: OVERCLAIM_EVIDENCE,
            problem: '结论过满。',
            rationale: '缺少主张原文。',
          },
          exec(),
        ),
        'quote_not_in_draft',
      )
    } finally {
      await session.dispose()
    }
  })

  it('rejects 「再次」/「屡次」 wording in an argument finding', async () => {
    const { session, tools } = makeSession()
    try {
      await tools.thesis_open!.execute({ path: overclaimDocx }, exec())
      expectDomainRejection(
        await tools.thesis_record_argument!.execute(
          {
            claim_quote: OVERCLAIM_CLAIM,
            evidence_quote: OVERCLAIM_EVIDENCE,
            problem: '该问题再次出现。',
            rationale: '屡次夸大结论。',
          },
          exec(),
        ),
        'repeat_wording',
      )
    } finally {
      await session.dispose()
    }
  })

  it('enforces the 3-finding cap', async () => {
    const { session, tools } = makeSession()
    try {
      await tools.thesis_open!.execute({ path: overclaimDocx }, exec())
      const args = {
        claim_quote: OVERCLAIM_CLAIM,
        evidence_quote: OVERCLAIM_EVIDENCE,
        problem: '结论过满。',
        rationale: '缺少显著性检验。',
      }
      for (let i = 0; i < 3; i += 1) {
        const res = (await tools.thesis_record_argument!.execute(args, exec())) as { ok: boolean }
        expect(res.ok).toBe(true)
      }
      expectDomainRejection(
        await tools.thesis_record_argument!.execute(args, exec()),
        'argument_limit',
      )
    } finally {
      await session.dispose()
    }
  })

  it('commit exports reviewed.docx and findings.json', async () => {
    const { session, tools } = makeSession()
    const outDir = path.join(path.dirname(overclaimDocx), 'out')
    try {
      await tools.thesis_open!.execute({ path: overclaimDocx }, exec())
      await tools.thesis_record_argument!.execute(
        {
          claim_quote: OVERCLAIM_CLAIM,
          evidence_quote: OVERCLAIM_EVIDENCE,
          problem: '结论用词过满。',
          rationale: '未见显著性检验。',
        },
        exec(),
      )
      const commit = (await tools.thesis_commit!.execute(
        { draft_id: 'new', output_dir: outDir },
        exec(),
      )) as { reviewed_path: string; findings_path: string; n_findings: number }
      expect(existsSync(commit.reviewed_path)).toBe(true)
      expect(existsSync(commit.findings_path)).toBe(true)
      expect(commit.n_findings).toBe(1)

      const findings = JSON.parse(readFileSync(commit.findings_path, 'utf8')) as {
        source: string
        code: string
        quote: string
      }[]
      expect(findings[0]!.source).toBe('argument')
      expect(findings[0]!.code).toBe('claim_without_evidence')
      expect(findings[0]!.quote).toBe(OVERCLAIM_CLAIM)
    } finally {
      await session.dispose()
    }
  })

  it('supported claim: the agent may choose to write NO finding and still commit', async () => {
    const { session, tools } = makeSession()
    const outDir = path.join(path.dirname(supportedDocx), 'out')
    try {
      await tools.thesis_open!.execute({ path: supportedDocx }, exec())
      const find = (await tools.thesis_find_text!.execute({ needle: '0.91' }, exec())) as {
        hits: { snippet: string }[]
      }
      expect(find.hits.some((h) => h.snippet.includes('0.72'))).toBe(true)
      expect(find.hits.some((h) => h.snippet.includes('p<0.01'))).toBe(true)

      const commit = (await tools.thesis_commit!.execute(
        { draft_id: 'supported', output_dir: outDir },
        exec(),
      )) as { n_findings: number; findings_path: string }
      expect(commit.n_findings).toBe(0)
      const findings = JSON.parse(readFileSync(commit.findings_path, 'utf8')) as unknown[]
      expect(findings).toEqual([])
      expect(SUPPORTED_CLAIM).toContain('0.91')
      expect(SUPPORTED_EVIDENCE).toContain('p<0.01')
    } finally {
      await session.dispose()
    }
  })
})
