import { startWorker, WorkerError, type WorkerCall } from './worker-client.ts'
import type { Config } from './config.ts'

/**
 * One lazily-started Python worker shared by every tool in a plugin instance.
 *
 * The worker holds per-review state (the opened document, the navigation
 * budget, the recorded findings), so all tools must talk to the SAME worker
 * process for the whole session. The worker is started on the first tool call
 * and torn down when the plugin unloads (ctx.effect disposer).
 *
 * Calls are serialized here so sequential Harness tool calls never interleave
 * two ops on one stdio/TCP stream. Harness already runs these tools in
 * sequential mode (isConcurrencySafe is intentionally not declared), and this
 * queue is a second guarantee at the protocol boundary.
 */
export class WorkerSession {
  private readonly config: Config
  private handle: WorkerCall | null = null
  private starting: Promise<WorkerCall> | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(config: Config) {
    this.config = config
  }

  /** True once a worker has been started for this session. */
  get started(): boolean {
    return this.handle !== null
  }

  /**
   * Forward one op to the worker, starting it on first use.
   * Resolves with the worker's `result`; rejects with WorkerError on failure.
   */
  call(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new WorkerError('session_closed', 'worker session is closed.'))
    }
    const next = this.chain.then(async () => {
      const worker = await this.ensureStarted()
      return worker.call(op, params)
    })
    // Keep the chain alive even if this call rejects.
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Start the worker if needed and return the shared handle. */
  private async ensureStarted(): Promise<WorkerCall> {
    if (this.handle) return this.handle
    if (!this.starting) {
      this.starting = startWorker({
        thesisReviewAgentPath: this.config.thesisReviewAgentPath,
        python: this.config.python,
        teacherId: this.config.teacherId,
        studentId: this.config.studentId,
        major: this.config.major,
        transport: this.config.transport,
        startupTimeoutMs: this.config.startupTimeoutMs,
      }).then((handle) => {
        this.handle = handle
        return handle
      })
    }
    return this.starting
  }

  /** Terminate the worker and refuse further calls. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true
    const handle = this.handle
    this.handle = null
    this.starting = null
    if (handle) {
      await handle.dispose().catch(() => undefined)
    }
  }
}
