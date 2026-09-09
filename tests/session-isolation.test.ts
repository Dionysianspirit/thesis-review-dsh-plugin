import { describe, it, expect, beforeAll } from 'vitest'
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
 * Session isolation test — integration against the REAL Python worker.
 *
 * Reproduces and guards the cross-session state leak found by running a real
 * Harness load. DSH mounts the plugin ONCE, so a single WorkerSession is shared
 * by every concurrent agent/session; the thesis-review-agent worker is stateful
 * and holds ONE "current draft". Before the fix, two Harness sessions sharing one
 * worker meant session B's open_draft clobbered the document session A was
 * mid-review on, so session A's later reads returned B's text.
 *
 * The fix routes each Harness agent id (== SessionId) to its own worker. This
 * test drives the REAL tools with two distinct exec.agent identities on ONE
 * shared session and asserts each session only ever sees its own draft.
 *
 * PLUMBING/isolation proof, not a real-model capability test.
 */

const skipReason = integrationSkipReason()
const root = resolveAgentRoot()
const python = resolvePython()
const describeOrSkip = skipReason ? describe.skip : describe
if (skipReason) console.warn(`[session-isolation] skipping integration: ${skipReason}`)

/** A Harness tool-run context carrying a given agent identity (agent.id == SessionId). */
function execFor(sessionId: string) {
  return {
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
    callId: `c-${sessionId}`,
    rootCallId: `c-${sessionId}`,
    token: 'tok',
    arguments: {},
    agent: { id: sessionId },
  } as never
}

interface Tool {
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

// Distinguishing evidence sentences that exist in exactly one fixture each.
const OVERCLAIM_MARK = '0.81 提高到 0.83'
const SUPPORTED_MARK = '0.91，基线模型为 0.72'

describeOrSkip('session isolation (real Python worker)', () => {
  let overclaimDocx: string
  let supportedDocx: string

  beforeAll(() => {
    overclaimDocx = makeFixtureDocx(root!, python, 'overclaim_draft')
    supportedDocx = makeFixtureDocx(root!, python, 'supported_claim_draft')
  })

  it('routes two concurrent Harness sessions to separate workers (no draft clobbering)', async () => {
    // ONE shared session, exactly as DSH gives the plugin a single instance.
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
      const defs = navigationTools(session)
      const tools = Object.fromEntries(defs.map((d) => [d.name, d as unknown as Tool]))

      const execA = execFor('session-A')
      const execB = execFor('session-B')

      // Session A opens its draft (overclaim), Session B opens ITS draft (supported).
      await tools.thesis_open!.execute({ path: overclaimDocx }, execA)
      await tools.thesis_open!.execute({ path: supportedDocx }, execB)

      // Each distinct agent id must have spun up its own worker channel.
      expect(session.size).toBe(2)

      // Session A reads — it must see ONLY its own overclaim text.
      const hitsA = (await tools.thesis_find_text!.execute({ needle: '准确率', max_hits: 5 }, execA)) as {
        hits: { snippet: string }[]
      }
      const textA = hitsA.hits.map((h) => h.snippet).join(' | ')
      expect(textA).toContain(OVERCLAIM_MARK)
      expect(textA).not.toContain(SUPPORTED_MARK)

      // Session B reads — it must see ONLY its own supported text.
      const hitsB = (await tools.thesis_find_text!.execute({ needle: '准确率', max_hits: 5 }, execB)) as {
        hits: { snippet: string }[]
      }
      const textB = hitsB.hits.map((h) => h.snippet).join(' | ')
      expect(textB).toContain(SUPPORTED_MARK)
      expect(textB).not.toContain(OVERCLAIM_MARK)
    } finally {
      await session.dispose()
    }
  })

  it('reaps one session worker on disposeSession without disturbing the other', async () => {
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
      const defs = navigationTools(session)
      const tools = Object.fromEntries(defs.map((d) => [d.name, d as unknown as Tool]))
      const execA = execFor('session-A')
      const execB = execFor('session-B')

      await tools.thesis_open!.execute({ path: overclaimDocx }, execA)
      await tools.thesis_open!.execute({ path: supportedDocx }, execB)
      expect(session.size).toBe(2)

      // Reap session B (as the plugin does on agent/disposed).
      await session.disposeSession('session-B')
      expect(session.size).toBe(1)

      // Session A still works and still sees only its own draft.
      const hitsA = (await tools.thesis_find_text!.execute({ needle: '准确率', max_hits: 5 }, execA)) as {
        hits: { snippet: string }[]
      }
      const textA = hitsA.hits.map((h) => h.snippet).join(' | ')
      expect(textA).toContain(OVERCLAIM_MARK)
      expect(textA).not.toContain(SUPPORTED_MARK)

      // A fresh call for the reaped key B lazily restarts its own worker.
      await tools.thesis_open!.execute({ path: supportedDocx }, execB)
      expect(session.size).toBe(2)
    } finally {
      await session.dispose()
    }
  })
})
