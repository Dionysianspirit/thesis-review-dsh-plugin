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
  startupTimeoutMs: Schema.number().default(20000),
  toolTimeoutMs: Schema.number().default(60000),
  enablePreset: Schema.boolean().default(true),
  enableHistory: Schema.boolean().default(false),
})
