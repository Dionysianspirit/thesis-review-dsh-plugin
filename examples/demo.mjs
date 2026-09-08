// examples/demo.mjs — scripted plumbing demo (NOT a model test).
//
// Runs the built plugin tools against the REAL thesis-review-agent Python
// worker using a HARDCODED tool path (open -> outline -> read_section ->
// find_text -> record -> commit). It proves the adapter chain works end to end
// and prints the worker-produced findings.json.
//
// This is NOT evidence that a DeepSeek model can autonomously review a thesis:
// every navigation and record decision below is written by us, not chosen by a
// model. The plugin ships only tools; the model (inside DSH) makes the real
// decisions. See tests/agent-loop-faux.test.ts for the same path under vitest.
//
// Usage:
//   npm run build
//   export THESIS_REVIEW_AGENT_PATH=/path/to/thesis-review-agent
//   node examples/demo.mjs

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WorkerSession, navigationTools, argumentTools } from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const agentRoot = process.env.THESIS_REVIEW_AGENT_PATH || path.resolve(here, '..', '..', 'thesis-review-agent')
const python = process.env.THESIS_REVIEW_PYTHON || 'python3'

function require_(cond, msg) {
  if (!cond) {
    console.error(`[demo] ${msg}`)
    process.exit(1)
  }
}

require_(
  existsSync(path.join(agentRoot, 'python', 'thesis_review', 'worker.py')),
  `thesis-review-agent not found at ${agentRoot}. Set THESIS_REVIEW_AGENT_PATH.`,
)
require_(
  existsSync(path.join(agentRoot, '.vendor', 'docxengine', 'src', 'docxengine', '__init__.py')),
  'thesis-review-agent .vendor/docxengine missing. Run: python scripts/fetch_docxengine.py',
)
require_(existsSync(path.resolve(here, '..', 'lib', 'index.js')), 'plugin not built. Run: npm run build')

// Build the overclaim demo draft using the MAIN project's own fixtures.
const runtimeDir = mkdtempSync(path.join(tmpdir(), 'dsh-demo-'))
const draftPath = path.join(runtimeDir, 'overclaim.docx')
const fixtureScript = [
  'import sys',
  `sys.path.insert(0, ${JSON.stringify(path.join(agentRoot, 'python'))})`,
  'from thesis_review.fixtures import overclaim_draft',
  `open(${JSON.stringify(draftPath)}, "wb").write(overclaim_draft())`,
].join('\n')
const built = spawnSync(python, ['-c', fixtureScript], { encoding: 'utf8' })
require_(built.status === 0, `fixture build failed: ${built.stderr || built.stdout}`)

const exec = () => ({
  signal: new AbortController().signal,
  deferContext() {},
  concludeTurn() {},
  callId: 'demo',
  rootCallId: 'demo',
  token: 'tok',
  arguments: {},
  agent: null,
})

const session = new WorkerSession({
  thesisReviewAgentPath: agentRoot,
  python,
  teacherId: 'dsh-demo',
  studentId: 'dsh-demo',
  major: '人工智能',
  transport: 'stdio',
  startupTimeoutMs: 20000,
})

const tools = Object.fromEntries(
  [...navigationTools(session), ...argumentTools(session)].map((d) => [d.name, d]),
)

const outDir = path.join(runtimeDir, 'out')

try {
  console.log('== thesis_open ==')
  console.log(await tools.thesis_open.execute({ path: draftPath }, exec()))

  console.log('\n== thesis_outline ==')
  const outline = await tools.thesis_outline.execute({}, exec())
  console.log(outline.outline.map((o) => `${o.ordinal}: ${o.text}`).join('\n'))

  const conclusion = outline.outline.find((o) => o.text.includes('4 结论'))
  console.log('\n== thesis_read_section (conclusion) ==')
  const section = await tools.thesis_read_section.execute({ start_ordinal: conclusion.ordinal }, exec())
  console.log(section.paragraphs.map((p) => p.text).join('\n'))

  console.log('\n== thesis_find_text ("0.81") ==')
  const hits = await tools.thesis_find_text.execute({ needle: '0.81' }, exec())
  console.log(hits.hits.map((h) => `${h.anchor}: ${h.snippet}`).join('\n'))

  const claim = section.paragraphs.find((p) => p.text.includes('显著提升')).text
  console.log('\n== thesis_record_argument ==')
  console.log(
    await tools.thesis_record_argument.execute(
      {
        claim_quote: claim,
        evidence_quote: '准确率由 0.81 提高到 0.83。',
        problem: '结论用词过满，实验结果仅有微弱数值变化。',
        rationale: '未见显著性检验，提升幅度与「显著提升」不符。',
      },
      exec(),
    ),
  )

  console.log('\n== thesis_commit ==')
  const commit = await tools.thesis_commit.execute({ draft_id: 'demo', output_dir: outDir }, exec())
  console.log(commit)

  console.log('\n== findings.json ==')
  console.log(readFileSync(commit.findings_path, 'utf8'))

  console.log('\n[demo] NOTE: this was a scripted tool path, not a model decision.')
} finally {
  await session.dispose()
}
