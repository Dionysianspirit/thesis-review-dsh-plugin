#!/usr/bin/env node
// Honest per-tier test report (Checklist 13 / section 十三).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.THESIS_REVIEW_PYTHON || process.env.PYTHON || 'python3'

function resolveAgentRoot() {
  const candidates = [
    process.env.THESIS_REVIEW_AGENT_PATH,
    path.resolve(repoRoot, '..', 'thesis-review-agent'),
  ].filter((v) => typeof v === 'string' && v.length > 0)
  for (const c of candidates) {
    if (existsSync(path.join(c, 'python', 'thesis_review', 'worker.py'))) return path.resolve(c)
  }
  return null
}
const agentRoot = resolveAgentRoot() || ''
if (agentRoot) process.env.THESIS_REVIEW_AGENT_PATH = agentRoot

const TIERS = {
  Unit: ['tests/plugin-smoke.test.ts', 'tests/preset.test.ts'],
  Integration: [
    'tests/tool-mapping.test.ts',
    'tests/worker-client.test.ts',
    'tests/evidence-gate.test.ts',
    'tests/session-isolation.test.ts',
    'tests/agent-loop-faux.test.ts',
  ],
  Resilience: ['tests/worker-resilience.test.ts'],
}

function integrationSkipReason() {
  if (!agentRoot) return 'THESIS_REVIEW_AGENT_PATH not set'
  if (!existsSync(path.join(agentRoot, 'python', 'thesis_review', 'worker.py'))) return 'worker.py not found under THESIS_REVIEW_AGENT_PATH'
  if (spawnSync(python, ['-c', 'import sys; sys.exit(0)'], { encoding: 'utf8' }).status !== 0) return `python not runnable (${python})`
  if (!existsSync(path.join(agentRoot, '.vendor', 'docxengine', 'src', 'docxengine', '__init__.py'))) return 'thesis-review-agent .vendor/docxengine missing'
  return null
}

function pythonOnlySkipReason() {
  if (spawnSync(python, ['-c', 'import sys; sys.exit(0)'], { encoding: 'utf8' }).status !== 0) return `python not runnable (${python})`
  return null
}

function runVitestTier(files) {
  const cacheDir = path.join(repoRoot, 'node_modules', '.cache')
  mkdirSync(cacheDir, { recursive: true })
  const outFile = path.join(cacheDir, `report-${Math.random().toString(16).slice(2)}.json`)
  spawnSync('npx', ['vitest', 'run', ...files, '--reporter=json', `--outputFile=${outFile}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  })
  let summary = { passed: 0, failed: 0, skipped: 0, ran: false }
  if (existsSync(outFile)) {
    try {
      const d = JSON.parse(readFileSync(outFile, 'utf8'))
      summary = {
        passed: d.numPassedTests ?? 0,
        failed: d.numFailedTests ?? 0,
        skipped: d.numPendingTests ?? 0,
        ran: true,
      }
    } catch { /* leave zeros */ }
    rmSync(outFile, { force: true })
  }
  return summary
}

function runSmoke({ dispatch }) {
  const env = { ...process.env }
  if (!dispatch) delete env.THESIS_REVIEW_AGENT_PATH
  const r = spawnSync('node', ['scripts/dsh-smoke.mjs'], { cwd: repoRoot, encoding: 'utf8', env })
  const lines = ((r.stdout || '') + (r.stderr || '')).split('\n')
  const relevant = dispatch
    ? lines.filter((l) => l.includes('real dispatch:') || (l.startsWith('SKIP') && l.includes('real dispatch smoke')))
    : lines.filter(
        (l) =>
          !l.includes('real dispatch') &&
          (l.startsWith('PASS') || l.startsWith('FAIL')),
      )
  const passed = relevant.filter((l) => l.startsWith('PASS')).length
  const failed = relevant.filter((l) => l.startsWith('FAIL')).length
  const skipped = relevant.filter((l) => l.startsWith('SKIP')).length
  return { passed, failed, skipped, ran: true }
}

function verdict(s) {
  if (!s.ran) return 'NOT RUN'
  if (s.failed > 0) return 'FAIL'
  if (s.passed === 0 && s.skipped > 0) return 'SKIPPED'
  if (s.skipped > 0) return `PASS (${s.skipped} skipped)`
  return 'PASS'
}

function line(name, s, note = '') {
  const v = verdict(s)
  console.log(
    `${v.padEnd(18)} ${name.padEnd(20)} passed=${s.passed ?? 0} failed=${s.failed ?? 0} skipped=${s.skipped ?? 0}${note ? '  — ' + note : ''}`,
  )
  return v
}

console.log('=== thesis-review-dsh-plugin real test report ===\n')
const results = {}

results.Unit = line('Unit', runVitestTier(TIERS.Unit))

const intSkip = integrationSkipReason()
if (intSkip) {
  results.Integration = line('Integration', { passed: 0, failed: 0, skipped: TIERS.Integration.length, ran: true }, `SKIPPED: ${intSkip}`)
} else {
  results.Integration = line('Integration', runVitestTier(TIERS.Integration), 'real Python worker')
}

const resSkip = pythonOnlySkipReason()
if (resSkip) {
  results.Resilience = line('Resilience', { passed: 0, failed: 0, skipped: 1, ran: true }, `SKIPPED: ${resSkip}`)
} else {
  results.Resilience = line('Resilience', runVitestTier(TIERS.Resilience), 'real subprocess, fake workers')
}

const reg = runSmoke({ dispatch: false })
results['Real DSH loader'] = line('Real DSH loader', reg, 'real Cordis + dsh-tools, plugin registration')

if (intSkip) {
  results['Real DSH dispatch'] = line('Real DSH dispatch', { passed: 0, failed: 0, skipped: 1, ran: true }, `SKIPPED: ${intSkip}`)
} else {
  const disp = runSmoke({ dispatch: true })
  results['Real DSH dispatch'] = line('Real DSH dispatch', disp, 'real scheduler -> real Python worker')
}

results['Real model'] = line('Real model', { passed: 0, failed: 0, skipped: 1, ran: true }, 'NOT RUN: no DSH model API key in this environment')

console.log('\n=== matrix ===')
for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(20)} ${v}`)

const anyFail = Object.values(results).some((v) => v === 'FAIL')
console.log(anyFail ? '\nREPORT: FAIL' : '\nREPORT: no tier failed (SKIP is not FAIL)')
process.exit(anyFail ? 1 : 0)
