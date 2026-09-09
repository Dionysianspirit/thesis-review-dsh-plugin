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
