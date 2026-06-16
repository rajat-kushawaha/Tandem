# Agentic SDLC

An event-driven system that takes a Jira story from refinement to a reviewed
pull request using three Claude-powered agents, with a human always giving the
final approval before merge. The agents never merge.

The team it serves has two repositories: a **backend** (Java + Spring Boot,
MongoDB) and a **frontend** (React + Vite).

## What problem it solves

Refining tickets, implementing small changes across repos, running the quality
gates, and reviewing PRs is repetitive, easy to get subtly wrong, and slow to
hand off. This system automates the mechanical parts while keeping two things
non-negotiable: **a human approves every merge**, and **an agent never claims a
story is done unless it objectively is**. The dev agent's output is trusted
because the orchestrator — not the agent — re-runs the gates and verifies every
acceptance criterion before a PR is opened.

## Architecture

```
Jira (JQL poll)  ──▶  Orchestrator (Inngest, one workflow per ticket)
                          │
   ┌──────────────────────┼───────────────────────────────────────────┐
   │                      │                                            │
   ▼                      ▼                                            ▼
 BA agent            Dev agent (sandboxed)                        Reviewer
 ─ read ticket       ─ select repos by keyword                    (claude-code-action
 ─ ask on Slack ◀─┐  ─ fresh checkout, feature/<KEY>               in each repo's CI)
 ─ (durable wait) │  ─ implement, write tests                     ─ review vs CLAUDE.md
 ─ refine in Jira │  ─ gate on green (mvn / npm)                  ─ + ticket criteria
 ─ → In Progress  │  ─ verify AC checklist                         ─ approve / request
                  │  ─ open PR per repo (only if green)                    │
       Slack reply┘         else → BLOCKED + escalate                      │
       resumes workflow                                                    ▼
                                                            Human gate ──▶ merge
```

Everything is durable state coordinated by **Inngest**: there is one workflow
instance per Jira ticket, keyed by ticket ID and idempotent, so a duplicate
event never double-processes a ticket. The hard part — "ask on Slack and wait
for a human" — is a durable `step.waitForEvent`, not a held-open process.

### Per-ticket state machine

States are explicit and typed; only the transitions in the table are legal and
illegal ones throw (`src/orchestrator/state-machine.ts`).

```
NEW → REFINING → READY_FOR_DEV → IN_PROGRESS → PR_OPEN → IN_REVIEW
        ┌──────────────────────────────────────────────────┘
        ▼
   CHANGES_REQUESTED ⇄ IN_PROGRESS … → APPROVED → DONE

BLOCKED  ← reachable from any non-terminal state (fail-safe)
```

Each ticket has a durable `RunRecord` (`src/shared/types.ts`) linking its Jira
key, Slack thread, and PR URLs.

### Jira board mapping

The internal states map to your board's columns (all names are configurable —
match them exactly to your board):

| Jira status (`env`)               | Meaning                          |
| --------------------------------- | -------------------------------- |
| `JIRA_STATUS_BACKLOG` (`BackLog`) | BA agent ingests and refines     |
| `JIRA_STATUS_IN_PROGRESS`         | Dev agent ingests and implements |
| `JIRA_STATUS_IN_REVIEW` (`QA`)    | PR opened, under review          |
| `JIRA_STATUS_READY_FOR_MERGE`     | Reviewer approved; human merges  |

The flow is autonomous from refinement onward: the BA agent refines a Backlog
ticket and **moves it to _In Progress_**, which the poller treats as the dev
agent's trigger. The dev agent moves the ticket to _QA_ on PR-open, and the
reviewer moves it to _In PR review_ on approval, where the human merge gate takes
over. The only human checkpoint is the final merge.

## The agents

- **BA agent** (`src/agents/ba`) — reads a ticket in the Backlog, finds
  genuinely blocking gaps, batches questions to Slack, and (after the answer)
  writes a refined description with acceptance criteria, a Definition of Ready,
  and technical notes, then **moves the ticket to _In Progress_** to hand off to
  the dev agent. Tools: **Jira + Slack only**.
- **Dev agent** (`src/agents/dev`) — picks up a ticket in _In
  Progress_, selects the affected repos by keyword (`GITHUB_REPOS`), implements
  each in a disposable sandbox on a `feature/<TICKET-KEY>` branch, runs the
  gates, verifies the acceptance-criteria checklist, and opens a PR per affected
  repo. Tools: **file/shell/git** behind a shell guard; it is **prevented from
  merging or pushing to main** — by the shell guard (a best-effort denylist),
  the disposable container, and, as the real backstop, branch protection on the
  default branch. The guard is defence in depth, not the sole boundary.
- **Reviewer** (`src/agents/reviewer` + `.github/workflows/reviewer.yml`) — runs
  as `anthropics/claude-code-action@v1` in each repo's CI, reviews the PR against
  the repo's `CLAUDE.md` and **the criteria listed in the PR body** ("Acceptance
  criteria (this repo)") — the orchestrator-authored, per-repo subset — so a
  backend reviewer never rejects a PR for a UI criterion that lives in the other
  repo. The Jira ticket is fetched for intent only. A separate GitHub identity
  is used because GitHub forbids self-approval. The orchestrator reacts to the
  COMBINED verdict across all of the ticket's PRs: _any changes requested_
  routes back to the dev agent — which **resumes the same feature branch with
  the reviewer's comments as its task**, rather than re-implementing from
  scratch; _all PRs approved_ advances to the human merge gate. Once a human
  merges every PR, the merge poller moves the ticket to DONE (and to
  `JIRA_STATUS_DONE`, if configured).

## How the Slack pause/resume works

1. The BA agent calls its `ask_clarification` tool, which posts the questions to
   a Slack thread and records the thread timestamp on the ticket's `RunRecord`.
2. The BA workflow pauses on `step.waitForEvent('slack/clarification.answered')`
   — a **durable** wait owned by Inngest, with a timeout that escalates to
   `BLOCKED` if no one answers.
3. A human replies in the thread. The Socket Mode listener maps the thread back
   to its ticket and emits `slack/clarification.answered`, which resumes the
   workflow exactly where it paused. The BA agent then refines and writes back.

## Why polling + Socket Mode (no public URL needed locally)

- **Jira ingestion polls** on a configurable interval (`JIRA_POLL_INTERVAL_MS`)
  using a JQL query — no inbound webhook to expose.
- **Slack runs in Socket Mode**, an outbound WebSocket — no public callback URL.
- **Reviewer verdicts** are learned by polling open PRs locally
  (`review-poller.ts`); in production, CI pushes the verdict straight to
  Inngest's public event endpoint (see the workflow file). Either way the
  orchestrator needs no inbound URL to run on a laptop.

## Correctness guardrails (why you can trust the dev agent)

These are enforced by the **orchestrator**, computed from objective signals, not
from the agent's say-so (`src/agents/dev`):

1. **AC → checklist → tests.** Each acceptance criterion must map to at least one
   test; an untestable criterion is flagged, not guessed (`checklist.ts`).
2. **Gate on green.** The full build/test/lint suite is re-run by the
   orchestrator in each affected repo; a PR opens only if everything passes
   (`gates.ts`).
3. **Objective shippability.** `evaluate.ts` combines gates + checklist; an
   attempt is shippable only when both are fully satisfied.
4. **Bounded retries + fail-safe.** After `DEV_MAX_FIX_ATTEMPTS` the agent does
   **not** open a PR implying success — it posts exactly what is blocking to Jira
   and Slack and moves the ticket to `BLOCKED`.
5. **Per-ticket budget.** Turn, token, and wall-clock ceilings — shared across
   every fix attempt and every affected repo of a ticket — stop a confused run
   from looping forever or burning the spend pool (`budget.ts`). A single agent
   invocation is additionally capped by `MAX_TURNS_PER_RUN`.
6. **Disposable sandbox.** A fresh shallow checkout per ticket on
   `feature/<KEY>`; never pushes main, never merges (`sandbox.ts`).
7. **Shell guard.** A PreToolUse hook blocks force-push, history rewrites,
   deletions outside the workspace, and secret exfiltration (`shell-guard.ts`).
8. **Human merge gate + branch protection** are the final backstop.
9. **Watchdog self-healing.** A ticket that sits unchanged in an agent-owned
   state past `WATCHDOG_STALE_MS` (crash, lost event, exhausted retries) has its
   workflow re-triggered automatically, with a Slack notice; the workflows are
   idempotent so a re-trigger never redoes finished work
   (`src/orchestrator/watchdog.ts`). Clarification answers posted to Slack while
   the orchestrator was down are recovered on startup
   (`src/integrations/slack/reconcile.ts`). BLOCKED stays manual by design — it
   means a human must act.
10. **Cross-repo contract feed-forward.** Repos are developed in `GITHUB_REPOS`
    order (configure backend first); each later repo's session receives the
    diffs already shipped for the ticket, so the frontend conforms to the
    endpoint the backend actually built instead of guessing. The repo plan is
    persisted on first run and reused by every retry/rework, so a re-triage can
    never switch repo sets mid-ticket.

## Prerequisites

- Node.js 20 LTS.
- A Claude subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) — or an
  `ANTHROPIC_API_KEY`.
- A Jira site with an API token, a Slack app in Socket Mode, and two GitHub Apps
  (dev + reviewer).
- The [Inngest dev server](https://www.inngest.com/docs/dev-server) for local
  durable execution (`npx inngest-cli@latest dev`).

## Local setup

> For the full process model (orchestrator vs. Inngest engine, why two
> processes, every command grouped by purpose, healthy-startup logs, and the
> reviewer-in-CI secrets), see **[RUNNING.md](RUNNING.md)**.

```bash
npm install
cp .env.example .env      # fill in tokens; see comments in the file

# Terminal 1 — the orchestrator (Inngest HTTP endpoint + pollers + Slack socket)
npm start                 # serves http://localhost:3000/api/inngest

# Terminal 2 — the Inngest dev server, pointed at the orchestrator
npm run dev:inngest
```

Then move a Jira ticket through its statuses (or reply in a Slack thread) and
watch the workflows run in the Inngest dev dashboard.

Quality commands:

```bash
npm run typecheck   # strict TypeScript, zero errors
npm run lint        # ESLint, zero warnings
npm test            # Vitest unit + state-machine tests
npm run build       # emit to dist/
```

### Reviewer in CI

Copy `.github/workflows/reviewer.yml` into **each** target repo (backend,
frontend). It needs these repo secrets: `CLAUDE_CODE_OAUTH_TOKEN`,
`ATLASSIAN_BASIC_AUTH` (base64 of `email:api-token`), and optionally
`INNGEST_EVENT_KEY` to push verdicts to the orchestrator.

## Assumptions & decisions

- **Jira REST v2 for deterministic writes; Rovo MCP for agent reasoning.** The
  orchestrator's reads/writes/transitions go through audited REST v2 calls
  (plain-text descriptions, simpler AC parsing). The BA agent and the CI reviewer
  reason over Jira through the Atlassian MCP server.
- **Headless Atlassian auth is HTTP Basic** (`email:api-token`). If your org
  mandates OAuth on the remote MCP, swap in the stdio `mcp-atlassian` server with
  the same token (one line in `integrations/jira/mcp.ts`).
- **The orchestrator opens PRs, not the agent.** This makes "open only if green"
  enforceable: the agent implements and pushes a branch, but the PR is created
  only after the orchestrator independently verifies gates + checklist.
- **Acceptance criteria are parsed from a list under an "Acceptance Criteria"
  heading** in the description (bulleted or numbered). Documented so ticket
  authors follow the convention.
- **Reviewer verdicts are polled locally; pushed in production.** Keeps local
  runs URL-free while giving production a low-latency push path.
- **The default `RunStore` is in-memory.** Correct for local/dev and tests;
  production swaps a Mongo-backed store implementing the same interface
  (`run-store.ts`). The workflows depend only on the interface.
- **Per-repo PR strategy:** if any affected repo can't be finished, the ticket is
  BLOCKED and reported truthfully even if another repo's PR already opened.

## Troubleshooting

- **401 / 403 from Claude** — check `CLAUDE_CODE_OAUTH_TOKEN` (or
  `ANTHROPIC_API_KEY`); exactly one must be set. Startup fails fast and names the
  missing variable.
- **401 / 403 from Jira** — verify `JIRA_EMAIL` + `JIRA_API_TOKEN` and that the
  account can see the project in `JIRA_JQL`. The client surfaces the HTTP status
  and Jira's error body.
- **Slack not resuming a workflow** — the app must be in Socket Mode with
  `connections:write` (app token) and be a member of `SLACK_CHANNEL_ID`; replies
  must be **in the thread** the bot posted. Check the `received clarification
answer` log line.
- **GitHub PR/clone failures** — the dev App needs contents + pull-requests write
  and must be installed on the repo; branch protection on `main` should forbid
  direct pushes. The reviewer must be a _different_ identity.
- **"Could not detect a known stack"** — the repo root needs `pom.xml`,
  `build.gradle(.kts)`, or `package.json`.
- **Sandbox issues** — checkouts live under `.sandbox/` (git-ignored) and are
  recreated per run; run the dev agent inside a disposable container in
  production so it never touches host or production secrets.
