import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  // Real Cordis ctx.on(name, listener) registers into a hook map and does NOT
  // throw for an event no service declared — it simply never fires. Mirror that:
  // record listeners by event name so a test can emit and assert cleanup wiring.
  const listeners: Record<string, ((payload: unknown) => void)[]> = {}
  const on = (name: string, listener: (payload: unknown) => void): (() => void) => {
    const list = (listeners[name] ??= [])
    list.push(listener)
    return () => {
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  }
  const emit = (name: string, payload: unknown): void => {
    for (const listener of listeners[name] ?? []) listener(payload)
  }
  // Real Cordis resolves un-injected peer services through ctx.reflect.get(name,
  // strict): strict=false returns undefined when the service is absent instead of
  // throwing. The plugin probes `systemPrompt` this way, so the double mirrors it:
  // services live in a registry the reflect.get probe reads, never as a bare
  // ctx.systemPrompt property (which real Cordis would refuse to hand out).
  const services: Record<string, unknown> = {
    systemPrompt: { section: (s: unknown) => { sections.push(s); return () => {} } },
  }
  const ctx: Record<string, unknown> = {
    tools,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    on,
    effect: (fn: () => (() => void) | void) => {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer)
      return () => {}
    },
    reflect: {
      // strict=false → non-throwing lookup, exactly like Cordis internals.
      get: (name: string, strict = true) => {
        if (name in services) return services[name]
        if (!strict) return undefined
        throw new Error(`cannot get property "${name}" without inject`)
      },
    },
    ...overrides,
  }
  return { ctx, tools, effects, sections, services, emit, listeners }
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

  it('does NOT register history tools when enableHistory is true but no real store exists (fail closed)', () => {
    const { ctx, tools } = makeCtx()
    const prevEnv = process.env.THESIS_REVIEW_HOME
    process.env.THESIS_REVIEW_HOME = path.join(tmpdir(), 'dsh-nonexistent-history-home')
    try {
      apply(ctx as never, {
        thesisReviewAgentPath: '/tmp/agent',
        python: 'python3',
        teacherId: 'dsh',
        studentId: 'dsh',
        major: '人工智能',
        transport: 'stdio',
        workerHome: path.join(tmpdir(), 'dsh-nonexistent-worker-home'),
        startupTimeoutMs: 20000,
        toolTimeoutMs: 60000,
        enablePreset: false,
        enableHistory: true,
      } as never)
    } finally {
      if (prevEnv === undefined) delete process.env.THESIS_REVIEW_HOME
      else process.env.THESIS_REVIEW_HOME = prevEnv
    }
    const names = tools.names()
    expect(names).not.toContain('thesis_history_candidates')
    expect(names).not.toContain('thesis_confirm_history')
    for (const expected of EXPECTED_CORE_TOOLS) expect(names).toContain(expected)
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('registers history tools when enableHistory is true and a real store exists', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-history-home-'))
    writeFileSync(path.join(home, 'thesis-review.sqlite'), '')
    const { ctx, tools } = makeCtx()
    const prevEnv = process.env.THESIS_REVIEW_HOME
    delete process.env.THESIS_REVIEW_HOME
    try {
      apply(ctx as never, {
        thesisReviewAgentPath: '/tmp/agent',
        python: 'python3',
        teacherId: 'dsh',
        studentId: 'dsh',
        major: '人工智能',
        transport: 'stdio',
        workerHome: home,
        startupTimeoutMs: 20000,
        toolTimeoutMs: 60000,
        enablePreset: false,
        enableHistory: true,
      } as never)
    } finally {
      if (prevEnv !== undefined) process.env.THESIS_REVIEW_HOME = prevEnv
    }
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

  it('still loads and registers tools when the systemPrompt peer is absent', () => {
    const { ctx, tools, sections, services } = makeCtx()
    delete services.systemPrompt
    expect(() =>
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
      } as never),
    ).not.toThrow()
    for (const expected of EXPECTED_CORE_TOOLS) expect(tools.names()).toContain(expected)
    expect(sections).toHaveLength(0)
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
    expect(() => effects[0]!()).not.toThrow()
  })
})
