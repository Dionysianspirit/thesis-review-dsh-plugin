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

const python = resolvePython()

function fakeRoot(workerPy: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-fake-agent-'))
  const pkg = path.join(root, 'python', 'thesis_review')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(path.join(pkg, '__init__.py'), '')
  writeFileSync(path.join(pkg, 'worker.py'), workerPy)
  return root
}

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

function orphanCount(marker: string): number {
  const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
  return (ps.stdout || '')
    .split('\n')
    .filter((line) => line.includes('thesis_review.worker') && line.includes(marker)).length
}

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

describe('tainted worker after an aborted op', () => {
  function stallingRoot(stallOps: string[]): string {
    return fakeRoot(
      [
        'import sys, json, time',
        `STALL = ${JSON.stringify(stallOps)}`,
        'for line in sys.stdin:',
        '    req = json.loads(line)',
        '    if req.get("op") in STALL:',
        '        time.sleep(9999)',
        '    else:',
        '        sys.stdout.write(json.dumps({"id": req.get("id"), "result": {"ok": True}}) + "\\n")',
        '        sys.stdout.flush()',
      ].join('\n'),
    )
  }

  it('recycles the worker after an aborted MUTATING op (record_argument_finding)', async () => {
    const root = stallingRoot(['record_argument_finding'])
    const token = uniqueToken()
    const session = new WorkerSession(baseConfig(root, { startupTimeoutMs: 3000, studentId: token }) as Config)
    const key = 'sess-write'
    await session.call('__warmup__', {}, key)
    expect(orphanCount(token)).toBe(1)

    const controller = new AbortController()
    const pending = session.call('record_argument_finding', { claim_quote: 'x' }, key, controller.signal)
    setTimeout(() => controller.abort(), 150)
    const error = await expectRejectsFast(pending, 3000)
    expect(error.code).toBe('worker_aborted')
    await expectNoOrphan(token)

    await session.call('__probe__', {}, key)
    const deadline = Date.now() + 4000
    while (orphanCount(token) === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(orphanCount(token)).toBe(1)
    await session.dispose()
    await expectNoOrphan(token)
  })

  it('keeps the SAME worker alive after an aborted READ op (find_text)', async () => {
    const root = stallingRoot(['find_text'])
    const token = uniqueToken()
    const session = new WorkerSession(baseConfig(root, { startupTimeoutMs: 3000, studentId: token }) as Config)
    const key = 'sess-read'
    await session.call('__warmup__', {}, key)
    expect(orphanCount(token)).toBe(1)

    const controller = new AbortController()
    const pending = session.call('find_text', { needle: 'x' }, key, controller.signal)
    setTimeout(() => controller.abort(), 150)
    const error = await expectRejectsFast(pending, 3000)
    expect(error.code).toBe('worker_aborted')
    // Navigation read abort: Worker may be retained (not recycled).
    await new Promise((r) => setTimeout(r, 300))
    expect(orphanCount(token)).toBe(1)
    await session.dispose()
    await expectNoOrphan(token)
  })
})
