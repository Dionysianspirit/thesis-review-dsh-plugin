import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAIM_EVIDENCE_PRESET, PRESET_SECTION_NAME, PRESET_SECTION_ORDER } from '../src/preset.ts'

/**
 * Preset consistency test.
 *
 * The model-facing preset text is a TS constant (zero-I/O at plugin load). The
 * human-readable presets/claim-evidence.md must stay byte-identical so docs and
 * behavior never drift. Also asserts the preset states the required boundaries.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const mdPath = path.join(here, '..', 'presets', 'claim-evidence.md')

describe('claim-evidence preset', () => {
  it('matches presets/claim-evidence.md byte for byte', () => {
    const md = readFileSync(mdPath, 'utf8')
    expect(CLAIM_EVIDENCE_PRESET).toBe(md)
  })

  it('declares a stable, ordered system-prompt section', () => {
    expect(PRESET_SECTION_NAME).toBe('thesis-review:claim-evidence')
    // Tool-guidance band (100-199) per the DSH ordering convention.
    expect(PRESET_SECTION_ORDER).toBeGreaterThanOrEqual(100)
    expect(PRESET_SECTION_ORDER).toBeLessThan(200)
  })

  it('states the required scenario boundaries', () => {
    const text = CLAIM_EVIDENCE_PRESET
    expect(text).toContain('关键主张')
    expect(text).toContain('不审格式')
    expect(text).toContain('不改正文')
    expect(text).toContain('thesis_outline')
    expect(text).toContain('thesis_record_argument')
    expect(text).toContain('thesis_commit')
    expect(text).toContain('最多 3 条')
    expect(text).toContain('再次')
    expect(text).toContain('不确定就放弃')
    // Must NOT script a fixed navigation path.
    expect(text).not.toMatch(/先读结论再读实验/)
  })
})
