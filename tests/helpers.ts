import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Test helpers. These deliberately reuse the MAIN project's own fixtures to
 * build demo DOCX bytes, so this repo never reimplements DOCX generation or
 * thesis content. Integration tests skip (never fail) when a thesis-review-agent
 * checkout, a usable Python, or the vendored docxengine is unavailable, because
 * those are environment prerequisites owned by the main project.
 */

/** Resolve a thesis-review-agent checkout. Never hardcoded to one machine. */
export function resolveAgentRoot(): string | null {
  const fromEnv = process.env.THESIS_REVIEW_AGENT_PATH
  const candidates = [
    fromEnv,
    // A sibling checkout is the common local layout.
    path.resolve(process.cwd(), '..', 'thesis-review-agent'),
  ].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'python', 'thesis_review', 'worker.py'))) {
      return path.resolve(candidate)
    }
  }
  return null
}

/** Resolve a Python 3 executable. */
export function resolvePython(): string {
  return process.env.THESIS_REVIEW_PYTHON || process.env.PYTHON || 'python3'
}

/** True when the main project's vendored docxengine is present. */
export function agentEngineReady(root: string): boolean {
  const vendor = path.join(root, '.vendor', 'docxengine', 'src', 'docxengine', '__init__.py')
  return existsSync(vendor)
}

/** Skip reason when integration prerequisites are missing, else null. */
export function integrationSkipReason(): string | null {
  const root = resolveAgentRoot()
  if (!root) {
    return 'THESIS_REVIEW_AGENT_PATH not set to a thesis-review-agent checkout'
  }
  const probe = spawnSync(resolvePython(), ['-c', 'import sys; sys.exit(0)'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    return `python not runnable (${resolvePython()})`
  }
  if (!agentEngineReady(root)) {
    return 'thesis-review-agent .vendor/docxengine missing (run its scripts/fetch_docxengine.py)'
  }
  return null
}

/**
 * Build one demo DOCX by importing the MAIN project's fixtures and writing the
 * bytes to a temp file. Returns the absolute path. Fixture names are the ones
 * thesis_review.fixtures already defines (overclaim_draft, supported_claim_draft).
 */
export function makeFixtureDocx(root: string, python: string, fixture: 'overclaim_draft' | 'supported_claim_draft'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-fixture-'))
  const out = path.join(dir, `${fixture}.docx`)
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(root, 'python'))})`,
    'from thesis_review.fixtures import ' + fixture,
    `open(${JSON.stringify(out)}, "wb").write(${fixture}())`,
  ].join('\n')
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`fixture ${fixture} failed: ${result.stderr || result.stdout}`)
  }
  return out
}

/** Write arbitrary bytes to a temp file and return its path. */
export function writeTempFile(prefix: string, bytes: Uint8Array, ext = '.docx'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  const out = path.join(dir, `file${ext}`)
  writeFileSync(out, bytes)
  return out
}

/** A minimal ToolRegistry double that records registrations, like ctx.tools. */
export class RecordingToolRegistry {
  readonly registered: { name: string; definition: unknown }[] = []
  register(definition: { name: string }): () => void {
    this.registered.push({ name: definition.name, definition })
    return () => {
      const index = this.registered.findIndex((item) => item.definition === definition)
      if (index >= 0) this.registered.splice(index, 1)
    }
  }
  names(): string[] {
    return this.registered.map((item) => item.name)
  }
}
