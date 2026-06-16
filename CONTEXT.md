# Session handoff / context

This file orients a fresh Claude session (or a new engineer) picking up this
project. Read `README.md` first for the architecture; this file captures the
**live state, the customisations made beyond the original brief, how to run it,
and what's still pending.**

---

## What this is

An event-driven agentic SDLC system: three Claude agents (BA → Dev → Reviewer)
take a Jira ticket from refinement to a reviewed PR, with a human approving the
final merge. TypeScript (strict, ESM), Inngest for durable orchestration, Claude
Agent SDK (`@anthropic-ai/claude-agent-sdk`) for the agents. Full design in
`README.md`.

Quality gates (all must stay green):

```bash
npm run typecheck   # strict TS
npm run lint        # ESLint, zero warnings
npm test            # Vitest — 161 tests
npm run build
```

---

## Live environment (already configured in `.env`)

`.env` holds **real, working credentials** and is git-ignored. `.env.example` is
the clean template. Never commit `.env`. (Tokens were shared in chat during
setup — rotate them when convenient.)

- **Claude:** `CLAUDE_CODE_OAUTH_TOKEN` set. Models currently all
  `claude-sonnet-4-6` (override `DEV_MODEL`/`REVIEWER_MODEL` to Opus for higher
  quality).
- **Jira:** site `agent-spike-ee.atlassian.net`, account `raj725284113@gmail.com`.
  - Real project is **`CR`** ("Team Agents 007"). `JIRA_JQL=project = CR ORDER BY updated DESC`.
    (There is **no** project `AGENT`; another project `SAM1` exists but uses
    different statuses — ignore it.)
  - Status mapping (must match the board exactly):
    `JIRA_STATUS_BACKLOG=BackLog`, `JIRA_STATUS_IN_PROGRESS=In Progress`,
    `JIRA_STATUS_IN_REVIEW=QA`, `JIRA_STATUS_READY_FOR_MERGE=In PR review`.
- **GitHub:** dev PAT identity `rajat-gitting`; reviewer PAT identity
  `rajat-tech-lead` (separate, for approvals). Repos:
  - `rajat-gitting/revelio-api` — **Gradle/Java** backend (gates: `./gradlew check`)
  - `rajat-gitting/revelio-ui` — **React/Vite** frontend (gates: `npm ci/lint/build/test`)
  - `GITHUB_REPOS` keyword map + `GITHUB_BASE_BRANCH=main`.
- **Slack:** team `rajatSlack`, bot `agent_workflow_bot`, channel `C0B2ARYUDGA`
  (`#new-channel`). ⚠️ **Two things are NOT done** (see Pending).

---

## How to run

Three processes / commands:

```bash
# 1. Orchestrator: Inngest HTTP endpoint + Jira/PR pollers + Slack socket
npm start                       # loads .env via --env-file

# 2. Inngest dev server (separate terminal), registers the workflows
npm run dev:inngest             # dashboard at http://localhost:8288

# 3. Manually re-run the dev agent on a ticket (e.g. after fixing a repo)
npm run dev:trigger -- CR-22
```

**Important:** the `RunStore` is **file-backed** (`RUN_STORE_FILE=.run-store.json`
in `.env`), so per-ticket state survives restarts; a code change still requires a
restart to take effect. Single-process only — production should swap in a
Mongo-backed `RunStore` (the interface is in `src/orchestrator/run-store.ts`).

### The normal flow

1. Move a Jira ticket to **BackLog** → poller fires the BA agent.
2. BA refines the description/AC, then moves the ticket to **In Progress**
   (autonomous handoff).
3. Poller sees In Progress + internal `READY_FOR_DEV` → fires the Dev agent.
4. Dev triages which repos are affected, implements in a sandbox, gates on green,
   and opens a PR per repo → ticket moves to **QA**.
5. Reviewer CI action reviews; approval moves the ticket to **In PR review** for
   a human to merge.

---

## Customisations made beyond the original brief (this session)

These are the deltas a fresh session must know — the code already reflects them:

1. **GitHub auth is PAT-based**, not GitHub App (`src/integrations/github/clients.ts`).
   `GITHUB_TOKEN` (dev) + optional `GITHUB_REVIEWER_TOKEN` (approvals, falls back
   to an approval comment if absent).
2. **Repo routing is a triage LLM call**, not the original plan. The dev workflow
   runs `planAffectedRepos` (`src/agents/dev/select-repos.ts`) — a cheap tool-less
   model that reads the ticket and picks only genuinely-affected repos (respects
   "UI only"). Keyword matching (`GITHUB_REPOS` keywords, in
   `src/integrations/github/repos.ts`) is the fallback only.
3. **Jira search migrated to v3.** `/rest/api/2/search` was **removed by Atlassian
   (HTTP 410)**; `searchByJql` now uses `/rest/api/3/search/jql`. Single-issue
   reads/writes stay on v2 (plain-text descriptions). See `src/integrations/jira/client.ts`.
4. **Configurable Jira statuses** wired through ingest + every workflow
   (`ensureStatus` is idempotent — no-op if already there, warns instead of
   throwing).
5. **BA auto-handoff:** BA moves a refined ticket to In Progress so the dev agent
   picks it up (no human checkpoint until merge).
6. **Dev agent is re-runnable / idempotent:**
   - `RESTART_DEV` state-machine event lets a `BLOCKED`/stuck/`NEW` ticket re-enter
     `IN_PROGRESS` (`src/orchestrator/state-machine.ts`, `beginDev` in
     `src/orchestrator/workflows/dev.ts`).
   - `openPullRequest` reuses an existing open PR; the feature branch is
     **force-updated** on push (`src/agents/dev/sandbox.ts`). So retries don't
     collide.
   - `npm run dev:trigger -- <KEY>` sends `ticket/dev.requested` on demand.
7. **Live progress logging:** `runAgent` streams every tool call / message
   (`src/shared/claude.ts`); gates and sandbox clone log too. `logger` reads
   `LOG_LEVEL` directly (decoupled from `config`) so pure modules can log.
8. **Gate feedback:** failing-gate output is now fed back into the agent's retry
   and the BLOCKED escalation (`src/agents/dev/evaluate.ts`), instead of a bare
   "Gate failed: lint."

---

## Current operational state (as of handoff)

- **CR-22** "Add Hero Section to Homepage" (a UI ticket) was being worked.
  - It wrongly routed to **revelio-api** under the old keyword matching and left a
    **stale PR #7** there. The new triage LLM should route it to **revelio-ui only**
    from now on.
  - **Action:** close the stale backend PR if unwanted:
    `gh pr close 7 --repo rajat-gitting/revelio-api`
    and delete the branch:
    `gh api -X DELETE repos/rajat-gitting/revelio-api/git/refs/heads/feature/CR-22`
  - To finish CR-22: restart `npm start`, then `npm run dev:trigger -- CR-22`.
- `revelio-ui` originally failed the lint gate because its `main` branch had
  171 pre-existing lint errors; the user fixed those manually.

---

## Hardening fixes (2026-06-10 session)

Six review findings were fixed (all gates green, 161 tests):

1. **Rework loop is real now.** A changes-requested PR re-develops on the
   EXISTING feature branch (no more wipe-and-reclone from base) and the agent
   receives the reviewer's review bodies + inline comments as its task
   (`assessExistingPullRequest` in `workflows/dev.ts`, `resumeFeatureBranch` in
   `sandbox.ts`, `listReviewFeedback` in `github/clients.ts`).
2. **Multi-PR aggregation.** A ticket advances to APPROVED only when EVERY PR is
   approved; any changes-requested wins (`aggregateTicketVerdict` in
   `reviewer/outcome.ts`; the reviewer workflow now fetches reviews for all
   recorded PRs).
3. **Reviewer scope.** `reviewer.yml` instructs the CI reviewer to verify ONLY
   the "Acceptance criteria (this repo)" list in the PR body (Jira = context
   only) — fixes "backend reviewer rejects UI criterion". Re-copy the workflow
   file into both target repos. Also fixed: the notify step's `if` now works
   (job-level env; step env is invisible to a step's own `if`).
4. **Self-healing.** `watchdog.ts` (pure) + `watchdog-runner.ts` re-trigger
   tickets stalled in REFINING/READY_FOR_DEV/IN_PROGRESS/CHANGES_REQUESTED past
   `WATCHDOG_STALE_MS` (default 90 min); `slack/reconcile.ts` recovers thread
   answers posted while the orchestrator was down (runs at startup). Slack
   events now carry dedup ids (also fixes the double-emit from the socket
   client's dual channels).
5. **Merge detection.** `github/merge-poller.ts` fires `ticket/pr.merged` when
   every PR is merged → `workflows/merged.ts` → DONE + optional
   `JIRA_STATUS_DONE` column. MERGED is legal from any PR-bearing state (human
   merge is authoritative).
6. **Cross-repo contracts.** Repos develop sequentially in `GITHUB_REPOS` order
   (put the backend first); later repos receive earlier repos' diffs
   (`priorWork` → `implementPrompt`), and the repo plan is persisted on the run
   record so reworks reuse it. `commitAndPush` now tolerates a no-op rework
   (skips the empty commit).

## Pending / TODO (not yet done)

1. **Slack app-level token** — `SLACK_APP_TOKEN` is still the placeholder
   `xapp-...`. Until a real `xapp-` token is set, Socket Mode won't connect and
   the BA "ask on Slack → resume" loop can't complete. Get it from the Slack app:
   Basic Information → App-Level Tokens (scope `connections:write`).
2. **Invite the bot to the channel** — `agent_workflow_bot` is **not a member** of
   `#new-channel` (`C0B2ARYUDGA`); it can't post clarifications until invited
   (`/invite @agent_workflow_bot`).
3. **Baseline-diff gates (decided, NOT implemented).** The whole-repo gate (`npm
run lint` etc.) punishes the agent for _pre-existing_ repo debt. The agreed
   design: run each gate on the pristine base branch first and only block on
   **regressions** (a gate that passed before but fails after the agent's change).
   The user chose this option but then fixed the repo manually instead — so it's
   still a TODO in `src/agents/dev/evaluate.ts` / `gates.ts` / `run-repo.ts`.
4. **Persistent `RunStore`** — swap the in-memory store for Mongo so state
   survives restarts (the brief's data store). Interface already abstracted.
5. **Reviewer end-to-end** — the CI workflow (`.github/workflows/reviewer.yml`)
   and the orchestrator's reaction are built but not yet exercised against a real
   PR with the reviewer identity.

---

## Gotchas

- **In-memory state**: restart `npm start` after any code change; it also clears
  ticket state, so a mid-flight ticket may re-trigger from its current Jira column.
- **Two processes**: `npm start` must be up before `npm run dev:inngest` (which
  registers the functions against the HTTP endpoint). `dev:trigger` needs both.
- **`.sandbox/`** holds the dev agent's throwaway checkouts (git-ignored, ESLint-
  ignored). Recreated per run.
- **Gates are real**: a PR opens only if build/test/lint pass in every selected
  repo; otherwise the ticket goes `BLOCKED` with the reason on Jira + Slack. This
  is intended (don't ship unfinished work), not a bug.
- **First Gradle run is slow** (downloads dependencies) — several minutes of
  apparent silence between tool-call logs is normal.
