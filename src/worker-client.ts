import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'

/**
 * Client for the thesis-review-agent Python worker.
 *
 * This is the ONLY integration surface with the main project. It does not
 * reimplement any thesis logic: it spawns `python -m thesis_review.worker`,
 * speaks the worker's existing line-delimited JSON protocol
 * (`{ id, op, params }` -> `{ id, result } | { id, error }`), and forwards
 * operations verbatim. All domain rules (DOCX parsing, quote validation,
 * history recall, evidence gate, Word output) stay in Python.
 *
 * The protocol mirrors thesis-review-agent/agent/review.mjs and
 * python/thesis_review/worker.py; it is intentionally a thin passthrough so a
 * worker protocol change needs no adapter change beyond new op names.
 */

export type WorkerTransport = 'stdio' | 'tcp'

export interface WorkerConfig {
  /** Absolute path to a local thesis-review-agent checkout. */
  thesisReviewAgentPath: string
  /** Python executable used to launch the worker. */
  python: string
  /** teacher_id passed to the worker (scopes the history store). */
  teacherId: string
  /** student_id passed to the worker (scopes the history store). */
  studentId: string
  /** major passed to the worker. */
  major?: string
  /**
   * The worker's `--home`: where its SQLite history store lives. This MUST NOT
   * be the thesis-review-agent checkout, or running the plugin would write
   * thesis-review.sqlite into the main repo. When omitted, a fresh temp dir is
   * created so the plugin never touches the main project's files.
   */
  workerHome?: string
  /** Where the worker writes its TCP portfile (tcp transport only). */
  runtimeDir?: string
  /** Transport selection. Default stdio. */
  transport?: WorkerTransport
  /** Startup timeout in ms while waiting for the worker to become ready. */
  startupTimeoutMs?: number
}

export interface WorkerCall {
  /**
   * Send one op and resolve with the worker's `result` payload.
   *
   * `signal` is the Harness tool-run cancellation signal (`exec.signal`). DSH's
   * tool-call timeout policy arms it from the tool's `timeoutMs` but only
   * NOTIFIES — "the signal only notifies, so callers must stop their own work"
   * (dsh-timeout). Honoring it here rejects THIS pending call promptly when the
   * deadline fires, so a slow or hung worker op cannot keep the tool body (and
   * the whole dispatch) pending past the Harness budget. This layer drops the
   * late reply. The session layer decides process lifetime: a non-mutating
   * read abort may retain the Worker; a mutating-op abort treats it as
   * tainted and recycles it.
   */
  call(op: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  /** Terminate the worker and release the transport. Idempotent. */
  dispose(): Promise<void>
}

/**
 * Error carrying the worker's own error code so callers can branch on it.
 *
 * `domain` distinguishes the two failure classes the adapter must treat
 * differently:
 *  - domain = true: the Python worker deliberately returned a structured
 *    `{ error: { code, message } }` for a rule it enforces (quote_not_in_draft,
 *    argument_limit, repeat_wording, nav_budget, not_open, issue_mismatch,
 *    open_failed, ...). These are expected outcomes of a review the model can act
 *    on, so the tool layer surfaces them as a structured result (carrying `code`)
 *    rather than a bare throw that DSH would flatten to `Error: <message>`.
 *  - domain = false: the adapter itself failed to reach or talk to the worker
 *    (config_missing, agent_not_found, unsafe_home, worker_startup, worker_exit,
 *    worker_connect, session_closed). These are infrastructure failures and still
 *    throw, so the Harness marks the call as an error.
 */
export class WorkerError extends Error {
  readonly code: string
  readonly domain: boolean
  constructor(code: string, message: string, domain = false) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.domain = domain
  }
}

function pythonPathFor(root: string): string {
  // The worker package lives under <root>/python; add it to PYTHONPATH below.
  return path.join(root, 'python')
}

function requireAgentRoot(root: string): void {
  if (!root) {
    throw new WorkerError('config_missing', 'thesisReviewAgentPath is empty; set it to a local thesis-review-agent checkout.')
  }
  const marker = path.join(root, 'python', 'thesis_review', 'worker.py')
  if (!existsSync(marker)) {
    throw new WorkerError(
      'agent_not_found',
      `thesis-review-agent worker not found at ${marker}. Check thesisReviewAgentPath.`,
    )
  }
}

/**
 * Start the worker and return a call/dispose handle.
 *
 * Both transports run the identical Python worker; stdio is the default
 * because it needs no portfile and closes with the child's stdin. The tcp
 * transport matches review.mjs exactly and is provided for parity with the
 * existing Pi runtime and for deployments that prefer a socket.
 */
export async function startWorker(config: WorkerConfig): Promise<WorkerCall> {
  const root = path.resolve(config.thesisReviewAgentPath)
  requireAgentRoot(root)
  const transport = config.transport ?? 'stdio'
  const startupTimeoutMs = config.startupTimeoutMs ?? 20000
  // The worker's home holds its SQLite history store. It must never be the
  // agent checkout (that would write into the main repo). Default to a fresh
  // temp dir; honor an explicit workerHome/runtimeDir when provided.
  const workerHome = resolveWorkerHome(config, root)
  const baseArgs = [
    '-m',
    'thesis_review.worker',
    '--home',
    workerHome,
    '--teacher',
    config.teacherId,
    '--student',
    config.studentId,
    '--major',
    config.major ?? '人工智能',
  ]
  const env = {
    ...process.env,
    PYTHONPATH: pythonPathFor(root),
    PYTHONIOENCODING: 'utf-8',
    THESIS_REVIEW_ROOT: root,
  }
  return transport === 'tcp'
    ? startTcpWorker(config.python, baseArgs, env, workerHome, startupTimeoutMs)
    : startStdioWorker(config.python, baseArgs, env, startupTimeoutMs)
}

/**
 * Resolve the worker `--home`, refusing to use the agent checkout root so the
 * plugin never writes its history store into the main project's files.
 */
function resolveWorkerHome(config: WorkerConfig, root: string): string {
  const explicit = config.workerHome ?? config.runtimeDir
  if (explicit) {
    const resolved = path.resolve(explicit)
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      throw new WorkerError(
        'unsafe_home',
        `workerHome must not point inside the thesis-review-agent checkout (${root}); ` +
          'it would write the history store into the main repo.',
      )
    }
    return resolved
  }
  return mkdtempSync(path.join(tmpdir(), 'thesis-review-dsh-home-'))
}

/** Line-delimited JSON request/response over a duplex stream. */
interface LineProtocol {
  /** Send one op; resolves with the worker's `result`, rejects on a domain error. */
  call(op: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  /** Feed one response line from the transport. */
  feed(line: string): void
  /**
   * Reject every pending call and refuse new ones. Called when the transport dies
   * (worker exit, socket close, EOF) so no request can hang forever waiting for a
   * reply that will never arrive. Idempotent.
   */
  failAll(error: WorkerError): void
  /** True once the transport is known dead. */
  readonly closed: boolean
}

function createLineProtocol(write: (line: string) => void): LineProtocol {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>()
  let nextId = 0
  let closed = false

  function feed(line: string): void {
    if (!line.trim()) return
    let message: { id?: string; result?: unknown; error?: { code?: string; message?: string } }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    const id = String(message.id ?? '')
    const waiter = pending.get(id)
    if (!waiter) return
    pending.delete(id)
    if (message.error) {
      // The worker deliberately returned a structured domain rejection; mark it so
      // the tool layer can surface it to the model with its `code` intact.
      waiter.reject(
        new WorkerError(
          String(message.error.code ?? 'error'),
          String(message.error.message ?? 'worker error'),
          true,
        ),
      )
    } else {
      waiter.resolve(message.result)
    }
  }

  function failAll(error: WorkerError): void {
    closed = true
    const waiters = [...pending.values()]
    pending.clear()
    for (const waiter of waiters) waiter.reject(error)
  }

  function call(op: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (closed) {
      return Promise.reject(new WorkerError('worker_closed', 'worker transport is closed; no further calls.'))
    }
    // Already past the Harness deadline before we even write: refuse immediately
    // rather than enqueuing work the caller has abandoned.
    if (signal?.aborted) {
      return Promise.reject(new WorkerError('worker_aborted', 'tool call aborted before dispatch.'))
    }
    const id = String(++nextId)
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      if (signal) {
        // When the Harness deadline (or caller cancellation) fires, drop THIS
        // pending call so the tool body stops waiting. The worker keeps running
        // and its late reply is discarded by feed() (the id is no longer pending).
        const onAbort = (): void => {
          if (!pending.delete(id)) return
          reject(new WorkerError('worker_aborted', 'tool call aborted while waiting for the worker.'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    try {
      write(`${JSON.stringify({ id, op, params })}\n`)
    } catch (err) {
      // The transport is already gone (e.g. EPIPE after the worker exited).
      // Reject this call and every pending one instead of letting the write throw
      // an unhandled 'error' event that would crash the host process.
      pending.delete(id)
      const error = new WorkerError(
        'worker_write_failed',
        `failed to write to worker: ${err instanceof Error ? err.message : String(err)}`,
      )
      failAll(error)
      return Promise.reject(error)
    }
    return result
  }

  return { call, feed, failAll, get closed() { return closed } }
}

function startStdioWorker(
  python: string,
  baseArgs: string[],
  env: NodeJS.ProcessEnv,
  startupTimeoutMs: number,
): Promise<WorkerCall> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(python, baseArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const proto = createLineProtocol((line) => child.stdin.write(line))

    // Writing to a worker whose stdin already errored/exited (e.g. a later call
    // after a crash) raises EPIPE. Two things must happen: (1) swallow the stream
    // 'error' event so Node does not turn it into an unhandled-error crash, and
    // (2) failAll() every pending call — the stream is broken, so no reply will
    // ever arrive. The synchronous write path in call() already failAll()s when
    // write() throws, but an ASYNC stream error (EPIPE surfacing on a prior
    // write, or the stream dying on its own before child 'exit' fires) only shows
    // up here, so this handler is the backstop for that edge.
    child.stdin.on('error', (err: Error) => {
      proto.failAll(
        new WorkerError('worker_write_failed', `worker stdin error: ${err.message}`),
      )
    })

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => proto.feed(line))

    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proto.failAll(err instanceof WorkerError ? err : new WorkerError('worker_error', String(err)))
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(err)
    }

    // Readiness must complete within startupTimeoutMs. A worker that spawns but
    // never answers the probe would otherwise leave startWorker() pending forever.
    const timer = setTimeout(() => {
      fail(new WorkerError('worker_startup', `worker did not become ready within ${startupTimeoutMs}ms: ${stderr.trim().slice(0, 500)}`))
    }, startupTimeoutMs)

    child.on('error', fail)
    child.on('exit', (code) => {
      if (!settled) {
        // Exited before the probe settled.
        fail(new WorkerError('worker_exit', `worker exited before ready (code ${code}): ${stderr.trim().slice(0, 500)}`))
      } else {
        // Crashed AFTER being ready: reject every pending/future call so nothing
        // hangs waiting for a reply that will never come.
        proto.failAll(new WorkerError('worker_exit', `worker exited (code ${code}) after startup: ${stderr.trim().slice(0, 500)}`))
      }
    })
    // EOF on stdout means the worker stopped replying; treat like a crash.
    rl.on('close', () => {
      if (settled) {
        proto.failAll(new WorkerError('worker_exit', 'worker stdout closed after startup.'))
      }
    })

    // Probe readiness with a no-op dispatch that does not require an open doc.
    // An unknown op is a valid round-trip proof that the worker is serving.
    const probe = proto.call('__dsh_ping__').catch((err) => err)
    void probe.then(() => {
      if (settled) return // already failed (timeout/exit) — do not resolve.
      settled = true
      clearTimeout(timer)
      resolve({
        call: (op, params, signal) => proto.call(op, params, signal),
        dispose: async () => {
          proto.failAll(new WorkerError('worker_closed', 'worker disposed.'))
          try {
            child.stdin.end()
          } catch {
            /* ignore */
          }
          try {
            child.kill()
          } catch {
            /* ignore */
          }
        },
      })
    })
  })
}

async function startTcpWorker(
  python: string,
  baseArgs: string[],
  env: NodeJS.ProcessEnv,
  workerHome: string,
  startupTimeoutMs: number,
): Promise<WorkerCall> {
  const portfile = path.join(workerHome, 'dsh-worker.port')
  const args = [...baseArgs, '--portfile', portfile]
  const child = spawn(python, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })

  const port = await waitForPortfile(portfile, startupTimeoutMs).catch((err) => {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    throw new WorkerError('worker_startup', `${String((err as Error).message)}: ${stderr.trim().slice(0, 500)}`)
  })

  const socket = net.createConnection({ host: '127.0.0.1', port })
  await new Promise<void>((res, rej) => {
    const onError = (error: Error): void => rej(error)
    socket.once('connect', () => {
      socket.off('error', onError)
      res()
    })
    socket.once('error', onError)
  }).catch((err) => {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    throw new WorkerError('worker_connect', `${String((err as Error).message)}: ${stderr.trim().slice(0, 500)}`)
  })

  const proto = createLineProtocol((line) => socket.write(line))
  const rl = readline.createInterface({ input: socket })
  rl.on('error', () => {})
  rl.on('line', (line) => proto.feed(line))

  // A TCP write to a dead socket surfaces as an async 'error' event (not a
  // synchronous throw), and a disconnect fires 'close'/'end'. Any of these — plus
  // the child exiting — must reject every pending/future call so a dropped socket
  // never leaves a request hanging forever.
  socket.on('error', (err) => {
    proto.failAll(new WorkerError('worker_socket', `worker socket error: ${err.message}`))
  })
  socket.on('close', () => {
    proto.failAll(new WorkerError('worker_closed', 'worker socket closed.'))
  })
  child.on('exit', (code) => {
    proto.failAll(new WorkerError('worker_exit', `worker exited (code ${code}): ${stderr.trim().slice(0, 500)}`))
  })

  return {
    call: (op, params, signal) => proto.call(op, params, signal),
    dispose: async () => {
      proto.failAll(new WorkerError('worker_closed', 'worker disposed.'))
      try {
        socket.end()
      } catch {
        /* ignore */
      }
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    },
  }
}

function waitForPortfile(file: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (existsSync(file)) {
        const text = readFileSync(file, 'utf8').trim()
        if (text) {
          clearInterval(timer)
          resolve(Number(text))
          return
        }
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('worker portfile timeout'))
      }
    }, 50)
  })
}
