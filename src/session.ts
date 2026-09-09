import { startWorker, WorkerError, type WorkerCall } from './worker-client.ts'
import type { Config } from './config.ts'

/**
 * Routing key for calls that carry no Harness agent identity — headless runs,
 * unit tests, or any dispatch where `exec.agent` is absent. All such calls share
 * one worker, which preserves the previous single-session behavior exactly.
 */
export const DEFAULT_SESSION_KEY = 'default'

/**
 * Ops that MUTATE the worker's authoritative state: the open draft and the
 * recorded findings. Navigation reads (list_outline / read_section /
 * read_paragraphs / find_text) do not mutate review findings or the working
 * document, but they are not state-free: the Python Worker increments
 * nav_calls before dispatch, so an aborted navigation read may still consume
 * one navigation-budget slot. That is tolerated until protocol-level
 * cancellation exists.
 *
 * Why this matters: a Harness timeout / abort only makes the JS side STOP
 * WAITING — the Python worker keeps running the op to completion (there is no
 * cancellation in the worker protocol today). A navigation read does not
 * change findings or the working document. A WRITE may still apply after we
 * have already told the model the call failed, leaving the worker's in-memory
 * state ahead of what the model believes (e.g. a finding written that the
 * model thinks was lost).
 */
const MUTATING_OPS: ReadonlySet<string> = new Set([
  'open_draft',
  'record_argument_finding',
  'confirm_history_finding',
  'commit_review',
])

/**
 * One lazily-started Python worker plus the call chain that serializes ops onto
 * its single stdio/TCP stream.
 *
 * The thesis-review-agent worker is STATEFUL and holds exactly one "current
 * draft" (the opened document, the navigation budget, the recorded findings).
 * Therefore each concurrent Harness session needs its OWN worker process, or two
 * sessions sharing one worker would clobber each other's open draft: session B's
 * `open_draft` resets the document session A is mid-review on. A WorkerChannel is
 * that per-session owner of one worker.
 */
class WorkerChannel {
  private handle: WorkerCall | null = null
  private starting: Promise<WorkerCall> | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(private readonly config: Config) {}

  /** True once this channel's worker has been started. */
  get started(): boolean {
    return this.handle !== null
  }

  /**
   * Forward one op to this channel's worker, starting it on first use. Calls are
   * serialized on a per-channel chain so sequential Harness tool calls for the
   * SAME session never interleave two ops on one stream. Distinct channels run
   * concurrently because they own distinct worker processes.
   */
  call(op: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new WorkerError('session_closed', 'worker session is closed.'))
    }
    const next = this.chain.then(async () => {
      const worker = await this.ensureStarted()
      try {
        return await worker.call(op, params, signal)
      } catch (error) {
        // If a MUTATING op was aborted, the worker may still apply it after we
        // stop waiting (no protocol-level cancellation), so its in-memory state
        // can diverge from the model's belief. Recycle this session's worker so
        // the next call starts from a clean process; the op stays rejected. See
        // the tainted-worker note in taintAfterAbortedWrite().
        if (error instanceof WorkerError && error.code === 'worker_aborted' && MUTATING_OPS.has(op)) {
          this.taintAfterAbortedWrite()
        }
        throw error
      }
    })
    // Keep the chain alive even if this call rejects.
    this.chain = next.catch(() => undefined)
    return next
  }

  /**
   * Mark this channel's worker untrustworthy after an aborted WRITE and recycle
   * it. The old process is disposed in the background (its op may still be
   * mid-flight in Python; we simply stop relying on it), and the handle is
   * dropped synchronously so the next call lazily starts a fresh worker.
   *
   * LIMITATION (documented, matches the P1/P2 assessment): this resets the
   * worker's IN-MEMORY state (open draft + uncommitted findings), which is the
   * divergence that actually bites the claim-evidence flow. An aborted
   * mutating call may leave the in-process Worker or working document in an
   * uncertain state, so the adapter recycles the Worker. External files
   * already written by a completed commit_review cannot be transactionally
   * rolled back by the adapter. confirm_history_finding itself applies a
   * finding to the working document and in-memory findings; it is not claimed
   * here to persist a new SQLite history row. A true fix needs cancellation
   * in the worker protocol itself.
   */
  private taintAfterAbortedWrite(): void {
    const stale = this.handle
    this.handle = null
    this.starting = null
    if (stale) void stale.dispose().catch(() => undefined)
  }

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
        // Empty -> startWorker creates a fresh temp home (claim-evidence mode, no
        // persisted history). Non-empty -> this exact home holds the history store;
        // worker-client refuses a home inside the checkout (unsafe_home).
        ...(this.config.workerHome ? { workerHome: this.config.workerHome } : {}),
      }).then((handle) => {
        this.handle = handle
        return handle
      })
    }
    return this.starting
  }

  /** Terminate this channel's worker and refuse further calls. Idempotent. */
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

/**
 * Routes tool calls to a per-Harness-session Python worker.
 *
 * The plugin's `apply()` runs ONCE for the whole Harness (DSH mounts the plugin
 * a single time via mountRootInclude), so this object is shared by every
 * concurrent agent/session. To stop sessions from clobbering each other's open
 * draft, each distinct session key (the Harness agent id, which equals its
 * SessionId) gets its own WorkerChannel — its own worker process. Calls that
 * carry no agent identity fall back to {@link DEFAULT_SESSION_KEY} and share one
 * worker, which is the correct behavior for a single-session run.
 *
 * The plugin disposes a session's channel on `agent/disposed`, and disposes all
 * channels when the plugin itself unloads.
 */
export class WorkerSession {
  private readonly config: Config
  private readonly channels = new Map<string, WorkerChannel>()
  private disposed = false

  constructor(config: Config) {
    this.config = config
  }

  /** True once at least one worker has been started. */
  get started(): boolean {
    for (const channel of this.channels.values()) {
      if (channel.started) return true
    }
    return false
  }

  /** Number of distinct per-session workers currently tracked. */
  get size(): number {
    return this.channels.size
  }

  /**
   * Forward one op to the worker bound to `sessionKey`, starting it on first use.
   * Resolves with the worker's `result`; rejects with WorkerError on failure.
   */
  call(
    op: string,
    params: Record<string, unknown> = {},
    sessionKey: string = DEFAULT_SESSION_KEY,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new WorkerError('session_closed', 'worker session is closed.'))
    }
    return this.channelFor(sessionKey).call(op, params, signal)
  }

  private channelFor(sessionKey: string): WorkerChannel {
    let channel = this.channels.get(sessionKey)
    if (!channel) {
      channel = new WorkerChannel(this.config)
      this.channels.set(sessionKey, channel)
    }
    return channel
  }

  /**
   * Dispose ONE session's worker (called on `agent/disposed`) so a finished
   * review session never leaks its Python process. No-op for an unknown key.
   */
  async disposeSession(sessionKey: string): Promise<void> {
    const channel = this.channels.get(sessionKey)
    if (!channel) return
    this.channels.delete(sessionKey)
    await channel.dispose()
  }

  /** Terminate every session's worker and refuse further calls. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true
    const channels = [...this.channels.values()]
    this.channels.clear()
    await Promise.all(channels.map((channel) => channel.dispose().catch(() => undefined)))
  }
}
