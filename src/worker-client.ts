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
  /** Send one op and resolve with the worker's `result` payload. */
  call(op: string, params?: Record<string, unknown>): Promise<unknown>
  /** Terminate the worker and release the transport. Idempotent. */
  dispose(): Promise<void>
}

/** Error carrying the worker's own error code so callers can branch on it. */
export class WorkerError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
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
    : startStdioWorker(config.python, baseArgs, env)
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
function createLineProtocol(
  write: (line: string) => void,
  onLine: (line: string) => void,
): { call: (op: string, params?: Record<string, unknown>) => Promise<unknown>; feed: (line: string) => void } {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>()
  let nextId = 0

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
      waiter.reject(new WorkerError(String(message.error.code ?? 'error'), String(message.error.message ?? 'worker error')))
    } else {
      waiter.resolve(message.result)
    }
  }

  function call(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = String(++nextId)
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    write(`${JSON.stringify({ id, op, params })}\n`)
    return result
  }

  void onLine
  return { call, feed }
}

function startStdioWorker(
  python: string,
  baseArgs: string[],
  env: NodeJS.ProcessEnv,
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

    const proto = createLineProtocol(
      (line) => child.stdin.write(line),
      () => {},
    )
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => proto.feed(line))

    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(err)
    }
    child.on('error', fail)
    child.on('exit', (code) => {
      if (!settled) {
        fail(new WorkerError('worker_exit', `worker exited before ready (code ${code}): ${stderr.trim().slice(0, 500)}`))
      }
    })

    // Probe readiness with a no-op dispatch that does not require an open doc.
    // An unknown op is a valid round-trip proof that the worker is serving.
    const probe = proto.call('__dsh_ping__').catch((err) => err)
    void probe.then(() => {
      settled = true
      resolve({
        call: (op, params) => proto.call(op, params),
        dispose: async () => {
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

  const proto = createLineProtocol(
    (line) => socket.write(line),
    () => {},
  )
  const rl = readline.createInterface({ input: socket })
  rl.on('error', () => {})
  socket.on('error', () => {})
  rl.on('line', (line) => proto.feed(line))

  return {
    call: (op, params) => proto.call(op, params),
    dispose: async () => {
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
