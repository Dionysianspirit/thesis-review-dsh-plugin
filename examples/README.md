# Examples

## demo.mjs — scripted plumbing demo (NOT a model test)

Runs the built plugin tools against the **real** `thesis-review-agent` Python
worker using a **hardcoded** tool path:

```text
thesis_open → thesis_outline → thesis_read_section → thesis_find_text
            → thesis_record_argument → thesis_commit
```

It prints the worker-produced `findings.json` and the exported `reviewed.docx`
path.

**What this proves:** the adapter chain (Harness tool → worker op → JSON result)
works end to end against the real Evidence Gate.

**What this does NOT prove:** that a DeepSeek model can autonomously decide where
to look, whether to seek counter-evidence, or when to abandon a finding. Every
navigation and record decision in the demo is written by us, not chosen by a
model. Inside DeepSeek Harness, the model makes those decisions; the plugin only
supplies tools.

### Run

```bash
npm install
npm run build
export THESIS_REVIEW_AGENT_PATH=/path/to/thesis-review-agent
node examples/demo.mjs
```

Prerequisites (owned by the main project, not this repo):

- a local `thesis-review-agent` checkout at `THESIS_REVIEW_AGENT_PATH`
- its Python dependencies installed
- its `.vendor/docxengine` fetched (`python scripts/fetch_docxengine.py`)

The demo builds its DOCX from the main project's own `thesis_review.fixtures`
(`overclaim_draft`), so no thesis content is duplicated here. It writes only to a
temp directory; the worker `--home` never points into the main repo.
