import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin configuration, validated by Schemastery when DSH loads the plugin.
 *
 * Harness requires anything two deployments may set differently to be a config
 * field, so the thesis-review-agent path, the teacher/student identity that
 * scopes the history store, the Python executable, and the transport are all
 * configurable here and overridable from a profile's cordis.patch.yml.
 */
export interface Config {
  /**
   * Absolute path to a local thesis-review-agent checkout (the main project).
   * Required at runtime; the plugin registers no tools when it is empty.
   * Example: "C:/projects/thesis-review-agent".
   */
  thesisReviewAgentPath: string
  /** Python executable used to launch the worker. */
  python: string
  /** teacher_id that scopes the history store (must match the main project). */
  teacherId: string
  /** student_id that scopes the history store. */
  studentId: string
  /** major passed to the worker; matches the main project's default. */
  major: string
  /** Worker transport: line-delimited JSON over stdio or a TCP portfile. */
  transport: 'stdio' | 'tcp'
  /**
   * The worker's `--home`: the directory holding its `thesis-review.sqlite`
   * history store. Empty by default, in which case each worker uses a fresh temp
   * home so the plugin never writes into the main repo — correct for the
   * claim-evidence mode, which needs no persisted history.
   *
   * When `enableHistory` is true this MUST resolve to the real thesis-review
   * history home (set `workerHome` here, or export `THESIS_REVIEW_HOME`, or rely
   * on the main project's platform default that already contains a store). If no
   * valid history home can be resolved the plugin refuses to register the history
   * tools rather than silently pointing them at an empty temp DB that would report
   * 0 candidates and mislead the model. It must never point inside the
   * thesis-review-agent checkout (guarded by worker-client's `unsafe_home`).
   */
  workerHome: string
  /** Startup timeout in ms while waiting for the worker to become ready. */
  startupTimeoutMs: number
  /** Per-tool-call timeout in ms forwarded to exec.signal budgeting. */
  toolTimeoutMs: number
  /** Register the claim-evidence system-prompt section (preset). */
  enablePreset: boolean
  /**
   * OPTIONAL PHASE 2: also register the history candidate/confirm tools.
   * Default false so the first version stays a single claim-evidence scenario.
   */
  enableHistory: boolean
}

export const Config = Schema.object({
  thesisReviewAgentPath: Schema.string().default(''),
  python: Schema.string().default('python3'),
  teacherId: Schema.string().default('dsh'),
  studentId: Schema.string().default('dsh'),
  major: Schema.string().default('人工智能'),
  transport: Schema.union(['stdio', 'tcp']).default('stdio'),
  workerHome: Schema.string().default(''),
  startupTimeoutMs: Schema.number().default(20000),
  toolTimeoutMs: Schema.number().default(60000),
  enablePreset: Schema.boolean().default(true),
  enableHistory: Schema.boolean().default(false),
})
