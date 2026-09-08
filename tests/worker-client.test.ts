import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { startWorker, WorkerError, type WorkerCall } from '../src/worker-client.ts'
import {
  integrationSkipReason,
  resolveAgentRoot,
  resolvePython,
  makeFixtureDocx,
} from './helpers.ts'

/**
 * Worker client test — integration.
 *
 * Boots the REAL thesis-review-agent Python worker (stdio and tcp), sends the
 * worker's own JSON request/response protocol, asserts a response comes back,
 * and asserts a clean shutdown. This proves the adapter can actually drive the
 * main project's worker; it does not call any model.
 *
 * Skips (never fails) when a thesis-review-agent checkout, Python, or the
 * vendored docxengine is unavailable — those are the main project's
 * prerequisites, not something this repo should fake.
 */

const skipReason = integrationSkipReason()
const root = resolveAgentRoot()
const python = resolvePython()

const describeOrSkip = skipReason ? describe.skip : describe
if (skipReason) {
  // Surface the skip reason in the report.
  console.warn(`[worker-client] skipping integration: ${skipReason}`)
}

describeOrSkip('worker client (real Python worker)', () => {
  let fixtureDocx: string

  beforeAll(() => {
    fixtureDocx = makeFixtureDocx(root!, python, 'overclaim_draft')
  })

  it('starts over stdio, answers an op, and shuts down', async () => {
    const worker: WorkerCall = await startWorker({
      thesisReviewAgentPath: root!,
      python,
      teacherId: 'dsh-test',
      studentId: 'dsh-student',
      workerHome: path.dirname(fixtureDocx),
      transport: 'stdio',
    })
    // open_draft with bytes_b64 (the adapter reads the file itself in the tool;
    // here we exercise the raw protocol with the fixture bytes).
    const { readFileSync } = await import('node:fs')
    const opened = (await worker.call('open_draft', {
      bytes_b64: readFileSync(fixtureDocx).toString('base64'),
    })) as { n_paragraphs: number }
    expect(opened.n_paragraphs).toBeGreaterThan(3)

    const outline = (await worker.call('list_outline', {})) as { outline: { text: string }[] }
    expect(outline.outline.map((o) => o.text)).toContain('4 结论')

    await worker.dispose()
  })

  it('surfaces the worker error code verbatim (no adapter masking)', async () => {
    const worker = await startWorker({
      thesisReviewAgentPath: root!,
      python,
      teacherId: 'dsh-test',
      studentId: 'dsh-student',
      workerHome: path.dirname(fixtureDocx),
      transport: 'stdio',
    })
    // read_section before open_draft -> worker raises not_open; the adapter must
    // carry that exact code so the model sees the same failure Pi would.
    await expect(worker.call('read_section', { start_ordinal: 1 })).rejects.toMatchObject({
      name: 'WorkerError',
      code: 'not_open',
    })
    await worker.dispose()
  })

  it('starts over tcp (portfile), answers an op, and shuts down', async () => {
    const worker = await startWorker({
      thesisReviewAgentPath: root!,
      python,
      teacherId: 'dsh-test',
      studentId: 'dsh-student',
      workerHome: path.dirname(fixtureDocx),
      transport: 'tcp',
    })
    const { readFileSync } = await import('node:fs')
    const opened = (await worker.call('open_draft', {
      bytes_b64: readFileSync(fixtureDocx).toString('base64'),
    })) as { n_paragraphs: number }
    expect(opened.n_paragraphs).toBeGreaterThan(3)
    const outline = (await worker.call('list_outline', {})) as { outline: { text: string }[] }
    expect(outline.outline.map((o) => o.text)).toContain('4 结论')
    await worker.dispose()
  })

  it('rejects a missing agent path with a clear code', async () => {
    await expect(
      startWorker({
        thesisReviewAgentPath: '/nonexistent/thesis-review-agent',
        python,
        teacherId: 't',
        studentId: 's',
      }),
    ).rejects.toBeInstanceOf(WorkerError)
  })
})
