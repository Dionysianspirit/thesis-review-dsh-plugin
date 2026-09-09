import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startWorker, WorkerError, type WorkerCall } from '../src/worker-client.ts'
import { WorkerSession } from '../src/session.ts'
import { navigationTools } from '../src/tools/document.ts'
import { resolvePython } from './helpers.ts'
import type { Config } from '../src/config.ts'

/**
 * Worker resilience tests — Checklist 4 (timeout / abort / crash / dispose).
 *
 * These drive the REAL worker client (startWorker + WorkerSession + the real
 * tools), never a hand-rolled replica. Where a well-behaved worker cannot
 * reproduce a failure, we build a throwaway fake agent root whose
 * python/thesis_review/worker.py hangs, crashes, or stalls — exactly what
 * `python -m thesis_review.worker` would spawn — so the real client code path
 * is exercised end to end.
 *
 * The class of bug guarded here: a request that would otherwise leave a Promise
 * pending FOREVER (startup never answered, worker died mid-call, socket
 * dropped, Harness deadline fired) or crash the host with an unhandled EPIPE.
 */

const python = resolvePython()

/** Build a fake thesis-review-agent root with a custom worker.py body. */
function fakeRoot(workerPy: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-fake-agent-'))
  const pkg = path.join(root, 'python', 'thesis_review')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(path.join(pkg, '__init__.py'), '')
  writeFileSync(path.join(pkg, 'worker.py'), workerPy)
  return root
}

/**
 * A unique worker `--home` per test. The worker is spawned as
 * `python -m thesis_review.worker --home <home> ...`, so `<home>` appears in its
 * argv — that is the only reliable, collision-free handle for finding (or proving
 * the absence of) this test's Python process. It must NOT be inside the agent
 * root (the unsafe_home guard), so use a separate temp dir.
 */
function fakeHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-worker-home-'))
}

const baseConfig = (root: string, extra: Partial<Parameters<typeof startWorker>[0]> = {}) => ({
  thesisReviewAgentPath: root,
  python,
  teacherId: 't',
  studentId: 's',
  transport: 'stdio',
  workerHome: fakeHome(),
  ...extra,
}) as Parameters<typeof startWorker>[0]

/** Assert a promise rejects (does not hang) and resolves the outcome fast. */
async function expectRejectsFast(promise: Promise<unknown>, withinMs: number): Promise<WorkerError> {
  const started = Date.now()
  let outcome: { kind: 'rejected'; error: unknown } | { kind: 'resolved' } | { kind: 'hung' }
  await Promise.race([
    promise.then(
      () => (outcome = { kind: 'resolved' }),
      (error) => (outcome = { kind: 'rejected', error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve((outcome = { kind: 'hung' })), withinMs)),
  ])
  expect(outcome!.kind, `promise did not reject within ${withinMs}ms (elapsed ${Date.now() - started}ms)`).toBe(
    'rejected',
  )
  return (outcome as { kind: 'rejected'; error: WorkerError }).error
}

/**
 * Poll until no `thesis_review.worker` python process carrying `marker` remains,
 * or the budget expires. dispose() sends SIGTERM; the kernel needs a moment to
 * reap it, so a single synchronous `ps` snapshot could race the teardown.
 *
 * The marker is a unique `--student` token: the worker is spawned as
 * `python -m thesis_review.worker --home <home> --teacher <t> --student <s> ...`,
 * so `--student <marker>` appears in argv and is collision-free per test. (We
 * match on the student token rather than `--home` because WorkerChannel does not
 * yet forward an explicit workerHome — that is Checklist 2's change.)
 */
async function expectNoOrphan(marker: string, withinMs = 3000): Promise<void> {
  const deadline = Date.now() + withinMs
  let orphans: string[] = []
  do {
    const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
    orphans = (ps.stdout || '')
      .split('\n')
      .filter((line) => line.includes('thesis_review.worker') && line.includes(marker))
    if (orphans.length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  expect(orphans).toEqual([])
}

/** Count live worker processes carrying `marker` (for positive assertions). */
function orphanCount(marker: string): number {
  const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
  return (ps.stdout || '')
    .split('\n')
    .filter((line) => line.includes('thesis_review.worker') && line.includes(marker)).length
}

/** A unique student token so each test's worker is identifiable in `ps`. */
let tokenSeq = 0
function uniqueToken(): string {
  return `dsh-resilience-${process.pid}-${++tokenSeq}`
}

describe('worker resilience (real client, misbehaving fake workers)', () => {
  it('A: startup hang — a worker that never answers the readiness ping rejects with worker_startup', async () => {
    const root = fakeRoot('import time\ntime.sleep(9999)\n')
    const error = await expectRejectsFast(
      startWorker(baseConfig(root, { startupTimeoutMs: 1200 })),
      5000,
    )
    expect(error.code).toBe('worker_startup')
  })

  it('B: crash after ready — a call issued after the worker exits rejects (no EPIPE crash)', async () => {
    const stub = [
      'import sys, json, os',
      'req = json.loads(sys.stdin.readline())',
      'sys.stdout.write(json.dumps({"id": req.get("id"), "error": {"code": "unknown_op", "message": "ping"}}) + "\\n")',
      'sys.stdout.flush()',
      'os._exit(1)',
    ].join('\n')
    const root = fakeRoot(stub)
    const handle = await startWorker(baseConfig(root, { startupTimeoutMs: 3000 }))
    const error = await expectRejectsFast(handle.call('list_outline', {}), 4000)
    expect(['worker_exit', 'worker_write_failed', 'worker_closed']).toContain(error.code)
    await handle.dispose()
  })

  it('C: abort signal — a pending call rejects promptly when exec.signal fires', async () => {
    const stub = [
      'import sys, json, time',
      'first = True',
      'for line in sys.stdin:',
      '    req = json.loads(line)',
      '    if first:',
      '        first = False',
      '        sys.stdout.write(json.dumps({"id": req.get("id"), "error": {"code": "unknown_op", "message": "ping"}}) + "\\n")',
      '        sys.stdout.flush()',
      '    else:',
      '        time.sleep(9999)',
    ].join('\n')
    const root = fakeRoot(stub)
    const handle = await startWorker(baseConfig(root, { startupTimeoutMs: 3000 }))
    const controller = new AbortController()
    const pending = handle.call('list_outline', {}, controller.signal)
    setTimeout(() => controller.abort(), 150)
    const error = await expectRejectsFast(pending, 3000)
    expect(error.code).toBe('worker_aborted')
    await handle.dispose()
  })

  it('D: pre-aborted signal — a call whose signal is already aborted is refused before dispatch', async () => {
    const root = fakeRoot(
      [
        'import sys, json',
        'for line in sys.stdin:',
        '    req = json.loads(line)',
        '    sys.stdout.write(json.dumps({"id": req.get("id"), "result": {"ok": True}}) + "\\n")',
        '    sys.stdout.flush()',
      ].join('\n'),
    )
    const handle = await startWorker(baseConfig(root, { startupTimeoutMs: 3000 }))
    const controller = new AbortController()
    controller.abort()
    const error = await expectRejectsFast(handle.call('list_outline', {}, controller.signal), 2000)
    expect(error.code).toBe('worker_aborted')
    await handle.dispose()
  })

  it('E: dispose kills Python and leaves no orphan process', async () => {
    const root = fakeRoot(
      [
        'import sys, json',
        'for line in sys.stdin:',
        '    req = json.loads(line)',
        '    sys.stdout.write(json.dumps({"id": req.get("id"), "result": {"ok": True}}) + "\\n")',
        '    sys.stdout.flush()',
      ].join('\n'),
    )
    const token = uniqueToken()
    const handle = await startWorker(baseConfig(root, { startupTimeoutMs: 3000, studentId: token }))
    await handle.call('ping_probe', {})
    expect(orphanCount(token)).toBeGreaterThan(0)
    await handle.dispose()
    await expectNoOrphan(token)
  })
})

describe('WorkerSession dispose semantics', () => {
  it('a call after session.dispose() rejects with session_closed', async () => {
    const root = fakeRoot(
      [
        'import sys, json',
        'for line in sys.stdin:',
        '    req = json.loads(line)',
        '    sys.stdout.write(json.dumps({"id": req.get("id"), "result": {"ok": True}}) + "\\n")',
        '    sys.stdout.flush()',
      ].join('\n'),
    )
    const session = new WorkerSession(baseConfig(root, { startupTimeoutMs: 3000 }) as Config)
    await session.call('ping_probe', {}, 'sess-A')
    await session.dispose()
    const error = await expectRejectsFast(session.call('list_outline', {}, 'sess-A'), 2000)
    expect(error.code).toBe('session_closed')
  })

  it('disposeSession kills one session worker, leaves no orphan, and a later call lazily restarts', async () => {
    const root = fakeRoot(
      [
        'import sys, json',
        'for line in sys.stdin:',
        '    req = json.loads(line)',
        '    sys.stdout.write(json.dumps({"id": req.get("id"), "result": {"ok": True}}) + "\\n")',
        '    sys.stdout.flush()',
      ].join('\n'),
    )
    const token = uniqueToken()
    const session = new WorkerSession(
      baseConfig(root, { startupTimeoutMs: 3000, studentId: token }) as Config,
    )
    const defs = navigationTools(session)
    const findText = defs.find((d) => d.name === 'thesis_find_text') as unknown as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>
    }
    const exec = {
      signal: new AbortController().signal,
      deferContext() {},
      concludeTurn() {},
      callId: 'c',
      rootCallId: 'c',
      token: 't',
      arguments: {},
      agent: { id: 'sess-Z' },
    } as never

    await session.call('ping_probe', {}, 'sess-Z')
    expect(session.size).toBe(1)
    expect(orphanCount(token)).toBeGreaterThan(0)
    await session.disposeSession('sess-Z')
    expect(session.size).toBe(0)
    await expectNoOrphan(token)
    await expect(findText.execute({ needle: 'x' }, exec)).resolves.toBeDefined()
    expect(orphanCount(token)).toBeGreaterThan(0)
    await session.dispose()
    await expectNoOrphan(token)
  })
})
