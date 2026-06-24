---
inclusion: always
---

# career-ops — Kiro integration

This workspace is a **career-ops** install: an AI-powered, CLI-agnostic job search
pipeline (offer evaluation, CV/PDF generation, portal scanning, application tracking,
interview prep). Kiro is a first-class supported runtime, on par with Claude Code,
OpenCode, Gemini, Codex, Qwen, Copilot, and Antigravity CLI.

The canonical agent instructions live in `AGENTS.md` (auto-loaded as a workspace rule)
and the data contract in `DATA_CONTRACT.md`. Follow them exactly — especially the
User Layer vs System Layer split: personalization goes in `modes/_profile.md` or
`config/profile.yml`, never in `modes/_shared.md`.

## Slash-style modes (the career-ops router)

career-ops exposes a single skill router. The full routing table and discovery menu
are defined here:

#[[file:.agents/skills/career-ops/SKILL.md]]

In Kiro, invoke it conversationally — the trigger phrase maps to the same modes the
other CLIs reach via `/career-ops`:

| The user... | Mode |
|-------------|------|
| Pastes a JD or URL | `auto-pipeline` (evaluate + report + PDF + tracker) |
| "evaluate this offer" | `oferta` |
| "compare these offers" | `ofertas` |
| "scan for new offers" | `scan` |
| "process my pipeline" | `pipeline` |
| "generate my CV / PDF" | `pdf` |
| "export CV to LaTeX" | `latex` |
| "write a cover letter" | `cover` |
| "prep me for the interview at X" | `interview-prep` |
| "research this company" | `deep` |
| "find a contact for outreach" | `contacto` |
| "show my application status" | `tracker` |
| "help me fill this application" | `apply` |
| "batch process these" | `batch` |
| "analyze my rejection patterns" | `patterns` |
| "any follow-ups due?" | `followup` |
| "update career-ops" | `update` |

Load `modes/_shared.md` + `modes/{mode}.md` for evaluation modes (`auto-pipeline`,
`oferta`, `ofertas`, `pdf`, `contacto`, `apply`, `pipeline`, `scan`, `batch`); load
only `modes/{mode}.md` for the standalone modes. When a sub-agent is available, use it
for `scan`, `apply` (with Playwright), and large `pipeline` runs — exactly as the
SKILL router describes.

## Kiro-specific notes

- **MCP servers** are configured in `.kiro/settings/mcp.json`:
  - `playwright` (`npx -y @playwright/mcp@latest`) — browser-driven JD fetch,
    offer verification, and liveness checks. This is the only server career-ops
    *requires*. Offer verification still goes through Playwright
    (`browser_navigate` → `browser_snapshot`) per `AGENTS.md`.
  - `fetch` (`uvx mcp-server-fetch`) — lightweight HTML→markdown fetch for JD text
    when a full browser is overkill. Optional: it needs `uv`/`uvx` on PATH. If it
    isn't installed only the `fetch` server fails to start (Playwright is
    unaffected), and Kiro's built-in `web_fetch` tool covers the same fallback.
  - Reconnect from the MCP Server view (or the command palette → "MCP") after
    editing that file. `npx`/`uvx` are used instead of `bunx` so the config works
    on any machine without Bun installed.
- **Agent Hooks (shipped):** this install ships ready-to-use hooks in `.kiro/hooks/`
  — see "Shipped Agent Hooks" below. Prefer these over the `/loop` or cron
  approaches the other CLIs use.
- **Specs for large runs:** for a big `pipeline`/`batch` run, consider driving it as
  a Kiro **Spec** (requirements → design → tasks) so the user gets a reviewable,
  resumable task list; the `postTaskExecution` hook then verifies integrity after
  each task. For one-off evaluations, a normal Vibe session is fine.
- **First run:** on the first message of a session, run `node doctor.mjs --json` and
  `node update-system.mjs check` silently, then follow the onboarding flow in
  `AGENTS.md` if `onboardingNeeded` is true.

## Shipped Agent Hooks

These hooks live in `.kiro/hooks/` and are part of the system layer (updatable, not
user data). Manage or toggle them from the Explorer "Agent Hooks" view or the command
palette → "Open Kiro Hook UI".

| Hook file | Trigger | Action | Purpose |
|-----------|---------|--------|---------|
| `career-ops-scan.kiro.hook` | `userTriggered` | `askAgent` | Run `scan` mode + the sub-agent orchestration below over any new URLs. The user's manual "scan now" button. |
| `career-ops-verify-pipeline.kiro.hook` | `postTaskExecution` | `runCommand: node verify-pipeline.mjs` | Auto-guard tracker/pipeline integrity after every completed spec task. |
| `career-ops-validate-portals.kiro.hook` | `fileEdited` (`portals.yml`) | `runCommand: node validate-portals.mjs` | Catch scanner config errors the moment `portals.yml` is saved. |

For **recurring** (time-based) scanning, trigger `career-ops-scan` on your cadence —
Kiro hooks are event-driven, so schedule it via your OS scheduler invoking Kiro, or
just press the hook button periodically. Do not use `batch-runner.sh` or cron-driven
`claude -p` workers (see below).

## Parallel pipeline & batch on Kiro (sub-agent orchestration)

**On Kiro, do NOT use `batch/batch-runner.sh`.** That script spawns headless
`claude -p` CLI workers, which don't exist (or aren't authenticated) in a Kiro
session — every worker fails with `Not logged in` and the run produces nothing.
Kiro's native equivalent is the **sub-agent system** (`invoke_sub_agent` with
`name="general-task-execution"`), which the orchestrator dispatches up to
**5 concurrently** (MAX_CONCURRENT_SUBAGENTS). Use that for any multi-offer run:
`pipeline` (3+ URLs) and `batch`.

### Why split browser work from evaluation work

Playwright MCP is a **single shared browser session** — parallel sub-agents cannot
all drive it at once. So the orchestrator (main agent) does the browser-bound steps
**serially**, then fans out the **token-heavy evaluation** to parallel sub-agents that
work only on local JD text (no browser). This keeps the browser conflict-free and
still parallelizes the expensive part.

### Orchestration procedure

1. **Collect inputs.**
   - `pipeline`: read unchecked `- [ ]` URLs from `data/pipeline.md`.
   - `batch`: read pending rows from `batch/batch-input.tsv` (skip those already
     `completed` in `batch/batch-state.tsv`).

2. **Liveness sweep (serial, zero-token).** Write the URLs to a temp file and run
   `node check-liveness.mjs --file <tmpfile>` (add `--throttle` for large sets).
   Drop every URL reported expired/closed before spending any evaluation budget.

3. **Capture JD text (serial, browser).** For each surviving URL, use Playwright
   (`browser_navigate` → `browser_snapshot`); fall back to `web_fetch`. Save each JD to
   `jds/{id}.md` (or `/tmp/batch-jd-{id}.txt`). The orchestrator does this itself so the
   sub-agents never touch the browser.

4. **Reserve report numbers up front (serial).** Parallel workers must not collide on
   numbering. For each offer, run `node reserve-report-num.mjs` to claim a `{REPORT_NUM}`,
   and release the sentinel with `node reserve-report-num.mjs --release {num}` once that
   offer's report is written.

5. **Fan out in waves of ≤5.** For each offer, call `invoke_sub_agent`
   (`name="general-task-execution"`) with the **full content of `batch/batch-prompt.md`**
   (it is self-contained) plus the resolved placeholders: `{{URL}}`, `{{JD_FILE}}` (the
   saved JD path), `{{REPORT_NUM}}`, `{{DATE}}`, `{{ID}}`. Dispatch up to 5 in the same
   turn; when more remain, wait for the wave to finish, then dispatch the next batch.
   Each sub-agent must:
   - read `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`;
   - run the full A–G evaluation on the local JD text (no browser);
   - write the report to `reports/{REPORT_NUM}-{slug}-{DATE}.md`;
   - write one TSV line to `batch/tracker-additions/{ID}.tsv`;
   - return the result JSON described in `batch-prompt.md`.
   - **Verification:** since the JD was captured by the orchestrator (not re-fetched by
     the worker), mark the report header `**Verification:** confirmed (orchestrator
     Playwright)` when step 3 used Playwright, else `unconfirmed (web_fetch)`.

6. **Collect + reconcile (serial, after all waves).**
   - `node merge-tracker.mjs` — merge all `tracker-additions/*.tsv` into
     `data/applications.md` (handles dedup + column swap).
   - `node reconcile-pipeline.mjs` — for `pipeline` runs, move processed URLs out of the
     `data/pipeline.md` inbox.
   - `node verify-pipeline.mjs` — confirm tracker integrity (expect 0 errors).
   - Update `batch/batch-state.tsv` rows to `completed`/`failed` as you go so the run is
     resumable.

7. **Report** a summary table: `| # | Company | Role | Score | PDF | Recommended action |`.

### Guardrails (unchanged on Kiro)

- Respect `auto_pdf_score_threshold` from `config/profile.yml` (default 3.0) — only
  generate a tailored PDF at/above it; otherwise report-only.
- Quality over quantity: recommend **against** applying when score < 4.0/5.
- Never submit an application without user review.
- Keep concurrency at ≤5 sub-agents; larger input sets run as sequential waves.
- Sub-agents are available only in Autopilot mode. In Supervised mode, process offers
  sequentially in the main agent.

### Recurring batch/scan

Trigger the shipped **`career-ops-scan`** Agent Hook (`.kiro/hooks/career-ops-scan.kiro.hook`)
to run the `scan` mode and then this orchestration over the new URLs. For a fixed
cadence, have your OS scheduler launch Kiro and fire that hook — not `batch-runner.sh`,
not cron-driven `claude -p` workers.
