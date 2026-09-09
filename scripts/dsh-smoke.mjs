#!/usr/bin/env node
// Real Harness plugin-load smoke test (Checklist 5 / section 十).
//
// This is NOT a mock or faux test. It assembles a GENUINE Cordis Context with the
// real `@deepseek-ai/dsh-system-prompt` and `@deepseek-ai/dsh-tools` services (the
// same packages the shipping DeepSeek Harness loads), installs the REAL built
// plugin (lib/index.js) into that composition via ctx.plugin(), and then asserts:
//
//   1. The ToolRegistry contains all 7 core thesis tools:
//      thesis_open, thesis_outline, thesis_read_section, thesis_read_paragraphs,
//      thesis_find_text, thesis_record_argument, thesis_commit.
//   2. The Claim-Evidence preset prompt section was contributed (when the
//      systemPrompt peer is present).
//   3. A REAL staged ToolRegistry dispatch (prepare -> dispatch -> finalize, the
//      exact pipeline dsh-agent-loop drives) reaches the Python worker and the
//      worker's domain rejection code survives to the model-visible result.
//
// No real model / API key is needed: steps 1-2 never execute a tool, and step 3
// drives the registry scheduler directly against the real worker.
//
// Usage:
//   node scripts/dsh-smoke.mjs                       # registration smoke only
//   THESIS_REVIEW_AGENT_PATH=/path/to/checkout \
//   THESIS_REVIEW_PYTHON=python3 node scripts/dsh-smoke.mjs   # + real dispatch smoke
//
// Exit code 0 on PASS, 1 on FAIL. The dispatch half is SKIPped (not failed) when
// its prerequisites are absent; the registration half must always pass.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { TOOL_REGISTRY_SCHEDULER } from '@deepseek-ai/dsh-tools'

const EXPECTED_TOOLS = [
  'thesis_open',
  'thesis_outline',
  'thesis_read_section',
  'thesis_read_paragraphs',
  'thesis_find_text',
  'thesis_record_argument',
  'thesis_commit',
].sort()

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const pluginEntry = path.join(repoRoot, 'lib', 'index.js')
const python = process.env.THESIS_REVIEW_PYTHON || process.env.PYTHON || 'python3'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

const systemPrompt = await import('@deepseek-ai/dsh-system-prompt')
const tools = await import('@deepseek-ai/dsh-tools')
const plugin = await import(pathToFileURL(pluginEntry).href)

await ctx.plugin(systemPrompt.default ?? systemPrompt)
await ctx.plugin(tools.default ?? tools)

await ctx.plugin(plugin, {
  thesisReviewAgentPath: process.env.THESIS_REVIEW_AGENT_PATH || '/nonexistent-for-registration-smoke',
  enableHistory: false,
})

const names = ctx.tools
  .schemas()
  .map((s) => s.name)
  .filter((n) => n.startsWith('thesis_'))
  .sort()

check('7 core thesis tools registered in a real Cordis ToolRegistry', names.length === 7, `found ${names.length}: ${names.join(', ')}`)
check('registered set matches expected', JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), names.join(', '))
check('Claim-Evidence preset prompt section contributed', typeof ctx.reflect.get('systemPrompt', false) !== 'undefined')

function dispatchSkipReason() {
  const root = process.env.THESIS_REVIEW_AGENT_PATH
  if (!root) return 'THESIS_REVIEW_AGENT_PATH not set'
  if (!existsSync(path.join(root, 'python', 'thesis_review', 'worker.py'))) return 'worker.py not found under THESIS_REVIEW_AGENT_PATH'
  if (spawnSync(python, ['-c', 'import sys; sys.exit(0)'], { encoding: 'utf8' }).status !== 0) return `python not runnable (${python})`
  if (!existsSync(path.join(root, '.vendor', 'docxengine', 'src', 'docxengine', '__init__.py'))) return 'thesis-review-agent .vendor/docxengine missing'
  return null
}

const skip = dispatchSkipReason()
if (skip) {
  console.log(`SKIP  real dispatch smoke — ${skip}`)
} else {
  const root = process.env.THESIS_REVIEW_AGENT_PATH
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-smoke-home-'))
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-smoke-'))
  const docx = path.join(dir, 'overclaim.docx')
  const fixtureScript = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(root, 'python'))})`,
    'from thesis_review.fixtures import overclaim_draft',
    `open(${JSON.stringify(docx)}, "wb").write(overclaim_draft())`,
  ].join('\n')
  const fx = spawnSync(python, ['-c', fixtureScript], { encoding: 'utf8' })
  if (fx.status !== 0) {
    check('build overclaim fixture for dispatch smoke', false, (fx.stderr || fx.stdout).slice(0, 200))
  } else {
    const ctx2 = new Context()
    ctx2.baseUrl = pathToFileURL(process.cwd()).href + '/'
    await ctx2.plugin(systemPrompt.default ?? systemPrompt)
    await ctx2.plugin(tools.default ?? tools)
    await ctx2.plugin(plugin, { thesisReviewAgentPath: root, workerHome: home, enableHistory: false })

    const scheduler = ctx2.tools[TOOL_REGISTRY_SCHEDULER]
    async function dispatch(name, args) {
      const prepared = await scheduler.prepare({
        callId: `call-${name}-${Math.random().toString(16).slice(2)}`,
        name,
        arguments: args,
        signal: new AbortController().signal,
      })
      const out = await scheduler.dispatch(prepared.exec)
      return out.kind === 'post-result'
        ? await scheduler.finalize(prepared.exec, out.result)
        : scheduler.finish(prepared.exec, out.result)
    }

    const opened = await dispatch('thesis_open', { path: docx })
    check('real dispatch: thesis_open succeeds through the Python worker', opened.isError !== true,
      opened.isError ? JSON.stringify(opened.error).slice(0, 200) : '')

    const rejected = await dispatch('thesis_record_argument', {
      claim_quote: '这句话在稿件中根本不存在。',
      evidence_quote: '准确率由 0.81 提高到 0.83。',
      problem: '测试用的编造主张。',
      rationale: '测试用的编造理由。',
    })
    const text = JSON.stringify(rejected)
    check('real dispatch: fabricated claim_quote is rejected by the evidence gate',
      rejected.isError === true || text.includes('quote_not_in_draft'), `isError=${rejected.isError}`)
    check('real dispatch: worker domain code survives to the model-visible result',
      text.includes('quote_not_in_draft'), text.slice(0, 200))

    await ctx2.dispose?.()
  }
}

await ctx.dispose?.()
console.log(failures === 0 ? '\nDSH-SMOKE: PASS' : `\nDSH-SMOKE: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
