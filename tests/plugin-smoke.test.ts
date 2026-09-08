import { describe, it, expect, vi } from 'vitest'
import { name, inject, apply, Config } from '../src/index.ts'
import { RecordingToolRegistry } from './helpers.ts'
import { CLAIM_EVIDENCE_PRESET, PRESET_SECTION_NAME } from '../src/preset.ts'

/**
 * Plugin load smoke test.
 *
 * Proves the plugin exposes the Cordis shape DSH loads (name / inject / apply /
 * Config) and that apply() registers the expected tools on ctx.tools, fails
 * closed when the agent path is missing, and registers a disposer via
 * ctx.effect. This is a PLUMBING test: it uses a recording ctx.tools double
 * (the real ToolRegistry is provided by the DSH loader) and does NOT call any
 * model. It is not evidence of real-model review quality.
 */

/** Build a minimal Context double with the fields apply() touches. */
function makeCtx(overrides: Partial<Record<string, unknown>> = {}) {
  const tools = new RecordingToolRegistry()
  const effects: (() => void)[] = []
  const sections: unknown[] = []
  const ctx = {
    tools,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    effect: (fn: () => (() => void) | void) => {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer)
      return () => {}
    },
    systemPrompt: { section: (s: unknown) => { sections.push(s); return () => {} } },
    ...overrides,
  }
  return { ctx, tools, effects, sections }
}

const EXPECTED_CORE_TOOLS = [
  'thesis_open',
  'thesis_outline',
  'thesis_read_section',
  'thesis_read_paragraphs',
  'thesis_find_text',
  'thesis_record_argument',
  'thesis_commit',
]

describe('plugin shape', () => {
  it('exports the Cordis plugin contract DSH loads', () => {
    expect(name).toBe('thesis-review-dsh-plugin')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
    // Config must be a Standard-Schema-compatible validator, not a plain object.
    expect(typeof Config).toBe('function')
  })

  it('Config validates and fills defaults', () => {
    const resolved = (Config as unknown as (input: unknown) => Record<string, unknown>)({
      thesisReviewAgentPath: '/tmp/agent',
    })
    expect(resolved.thesisReviewAgentPath).toBe('/tmp/agent')
    expect(resolved.transport).toBe('stdio')
    expect(resolved.enablePreset).toBe(true)
    expect(resolved.enableHistory).toBe(false)
  })

  it('Config rejects an invalid transport', () => {
    expect(() =>
      (Config as unknown as (input: unknown) => unknown)({ transport: 'carrier-pigeon' }),
    ).toThrow()
  })
})

describe('apply() registers tools', () => {
  it('registers all core claim-evidence tools', () => {
    const { ctx, tools } = makeCtx()
    apply(ctx as never, {
      thesisReviewAgentPath: '/tmp/agent',
      python: 'python3',
      teacherId: 'dsh',
      studentId: 'dsh',
      major: '人工智能',
      transport: 'stdio',
      startupTimeoutMs: 20000,
      toolTimeoutMs: 60000,
      enablePreset: true,
      enableHistory: false,
    } as never)
    const names = tools.names()
    for (const expected of EXPECTED_CORE_TOOLS) {
      expect(names).toContain(expected)
    }
    // History tools are NOT registered by default (phase 2 stays opt-in).
    expect(names).not.toContain('thesis_history_candidates')
    expect(names).not.toContain('thesis_confirm_history')
  })

  it('registers the claim-evidence preset as a system-prompt section', () => {
    const { ctx, sections } = makeCtx()
    apply(ctx as never, {
      thesisReviewAgentPath: '/tmp/agent',
      python: 'python3',
      teacherId: 'dsh',
      studentId: 'dsh',
      major: '人工智能',
      transport: 'stdio',
      startupTimeoutMs: 20000,
      toolTimeoutMs: 60000,
      enablePreset: true,
      enableHistory: false,
    } as never)
    expect(sections).toHaveLength(1)
    const section = sections[0] as { name: string; order: number; text: string }
    expect(section.name).toBe(PRESET_SECTION_NAME)
    expect(section.text).toBe(CLAIM_EVIDENCE_PRESET)
  })

  it('registers history tools only when enableHistory is true', () => {
    const { ctx, tools } = makeCtx()
    apply(ctx as never, {
      thesisReviewAgentPath: '/tmp/agent',
      python: 'python3',
      teacherId: 'dsh',
      studentId: 'dsh',
      major: '人工智能',
      transport: 'stdio',
      startupTimeoutMs: 20000,
      toolTimeoutMs: 60000,
      enablePreset: false,
      enableHistory: true,
    } as never)
    const names = tools.names()
    expect(names).toContain('thesis_history_candidates')
    expect(names).toContain('thesis_confirm_history')
  })

  it('fails closed (registers no tools) when thesisReviewAgentPath is empty', () => {
    const { ctx, tools } = makeCtx()
    apply(ctx as never, {
      thesisReviewAgentPath: '   ',
      python: 'python3',
      teacherId: 'dsh',
      studentId: 'dsh',
      major: '人工智能',
      transport: 'stdio',
      startupTimeoutMs: 20000,
      toolTimeoutMs: 60000,
      enablePreset: true,
      enableHistory: false,
    } as never)
    expect(tools.names()).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('registers a disposer through ctx.effect that closes the session', async () => {
    const { ctx, effects } = makeCtx()
    apply(ctx as never, {
      thesisReviewAgentPath: '/tmp/agent',
      python: 'python3',
      teacherId: 'dsh',
      studentId: 'dsh',
      major: '人工智能',
      transport: 'stdio',
      startupTimeoutMs: 20000,
      toolTimeoutMs: 60000,
      enablePreset: false,
      enableHistory: false,
    } as never)
    expect(effects).toHaveLength(1)
    // Running the disposer must not throw even though no worker was started.
    expect(() => effects[0]!()).not.toThrow()
  })
})
