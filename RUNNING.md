# Running the system

How the processes fit together, what each command does, and how to operate the
pipeline. For architecture and design rationale see [README.md](README.md); for
live state / handoff notes see [CONTEXT.md](CONTEXT.md).

---

## Process model

Two long-lived processes, talking over `localhost:3000`. Neither is useful
alone.

```
┌──────────────────────────────┐         ┌──────────────────────────────┐
│ npm start  (orchestrator)    │◀───────▶│ npm run dev:inngest           │
│ src/main.ts                  │  HTTP   │ (Inngest dev server / engine) │
│                              │  :3000  │                              │
│ • serves the 3 workflows     │         │ • discovers the workflows     │
│   at /api/inngest            │         │ • invokes them step-by-step   │
│ • Jira poller (30s)          │         │ • persists step results       │
│ • review poller (30s)        │         │ • owns waitForEvent pauses    │
│ • Slack Socket Mode listener │         │ • retries failed steps        │
└──────────────────────────────┘         │ • dashboard (:8288)           │
                                          └──────────────────────────────┘
```

**Control is inverted.** The orchestrator *publishes* functions and *emits*
events; it does not decide when workflows run. The Inngest engine receives
events, matches them to a workflow, and **calls back** into the orchestrator at
`:3000/api/inngest` to execute one step at a time, checkpointing after each.

### Why Inngest (not plain async code)

The BA workflow pauses on `step.waitForEvent('slack/clarification.answered')`
with a 3-day timeout ([ba.ts](src/orchestrator/workflows/ba.ts)). With ordinary
code that means a process held open for days, lost on any restart. Inngest runs
the workflow up to the wait, lets the process exit, and persists "ticket X
parked here." When the event arrives it re-invokes and resumes from that point.
Every `step.run(...)` is a persisted checkpoint; a thrown step is retried in
isolation (`retries:` per workflow), not the whole run.

### Agents are not separate processes

`ba`, `dev`, and the reviewer-handling logic are **functions inside the single
orchestrator process**, invoked by the workflows
([functions.ts](src/orchestrator/functions.ts)). There is no per-agent command,
port, or daemon. `npm start` runs all of them. The reviewer agent is the one
exception: it runs in **GitHub CI**
([.github/workflows/reviewer.yml](.github/workflows/reviewer.yml)), and the
orchestrator only *reacts* to its verdict.

### State store caveat

The default `RunStore` is in-memory ([store.ts](src/orchestrator/store.ts)).
Restarting `npm start` drops the orchestrator's in-flight bookkeeping (Slack
thread → ticket map, PR records). Inngest still remembers in-flight *workflows*,
but the orchestrator's side resets — don't restart mid-ticket in a demo.
Production swaps a Mongo/Redis store behind the same interface.

---

## Commands by purpose

### Run the app (two terminals, both required)

```bash
npm start              # orchestrator on :3000 — all agents + pollers + Slack
npm run start:inngest  # Inngest engine, PERSISTENT (recommended)
```

- `npm start` → `node --env-file=.env --import tsx src/main.ts`. `--env-file`
  loads tokens; `--import tsx` runs the TS directly. Starts the four things in
  the diagram ([main.ts](src/main.ts)).
- `npm run start:inngest` → `inngest-cli start` in self-hosted mode: run state
  and history persist to `.inngest/` (SQLite), so in-flight workflows survive a
  restart of either process — or both. Needs `INNGEST_EVENT_KEY`,
  `INNGEST_SIGNING_KEY`, and `INNGEST_BASE_URL` in `.env` (see `.env.example`).
  Dashboard at `http://localhost:8288` — the per-step run timeline lives there.
- `npm run dev:inngest` → the old ephemeral `inngest-cli dev` mode (in-memory;
  a restart loses in-flight runs and orphans their tickets until the watchdog
  or a manual `npm run dev:trigger -- <KEY>` re-fires them). Kept for quick
  experiments; if you use it, unset `INNGEST_BASE_URL`/keys or the SDK will
  try to sign against a server that ignores signatures.

Start order: orchestrator first so `:3000` is up, then the engine so discovery
succeeds on the first try (the engine retries discovery regardless, so this is
preference, not a hard requirement).

### Watch it (per-agent log views — optional)

```bash
npm run start:logged   # like `npm start`, but tees stdout to orchestrator.log
npm run watch:ba       # tail orchestrator.log | filter to agent=ba
npm run watch:dev      # …agent=dev
npm run watch:reviewer # …agent=reviewer
```

`watch:*` do **not** run anything — they are log viewers
([log-filter.mjs](scripts/log-filter.mjs)) that tail the file `start:logged`
writes and show one agent's lines, colorized. Use `start:logged` (not `start`)
when you want these, since they have nothing to tail otherwise. Workflow lines
carry the `agent` field via `agentLogger`
([logger.ts](src/shared/logger.ts)).

### Drive it (no terminal — Jira + Slack)

Once both processes are up the system is hands-free. Triggers are board moves:

| Action | Effect |
| --- | --- |
| Ticket → **Backlog** | Within 30s the BA agent picks it up (refine, or ask on Slack) |
| **Reply in the Slack thread** | Paused BA workflow resumes, writes criteria, moves ticket to **In Progress** |
| (auto) ticket **In Progress** | Dev agent: sandbox → implement → gates → PR → moves to **QA** |
| PR opened | Reviewer runs in GitHub CI; approves or requests changes |
| Reviewer approved → **In PR review** | **Human** merges. Nothing merges without a human. |

### Override (manual re-trigger)

```bash
npm run dev:trigger -- <TICKET-KEY>     # e.g. AGENT-123
```

Sends `ticket/dev.requested` straight to the running orchestrator
([trigger.ts](scripts/trigger.ts)). Re-runs the dev agent idempotently via the
`RESTART_DEV` path: feature branch force-updated, open PR reused. Use after
fixing a repo so its gates pass, without touching Jira.

### Dev hygiene (not for operating the app)

```bash
npm run typecheck   # tsc --noEmit, strict, zero errors
npm run lint        # eslint, zero warnings
npm test            # vitest — unit + state-machine suite
npm run build       # tsc --build → dist/
npm run format      # prettier --write
```

---

## Healthy startup

`npm start` should log, in order:

```
Inngest functions served at /api/inngest   (port 3000)
starting Jira poller                        (intervalMs 30000)
Slack Socket Mode client connected
```

`npm run dev:inngest` should discover three functions (`ba-refinement`,
`dev-implementation`, `reviewer-outcome`) and expose the dashboard. If the
engine logs connection-refused, the orchestrator isn't up on `:3000` yet.

Config validation fails fast: a missing/invalid env var exits the orchestrator
before anything boots, naming the variable
([config.ts](src/shared/config.ts)). See `.env.example` for the full list.

---

## Reviewer in CI

The reviewer is not part of `npm start`. Copy
[.github/workflows/reviewer.yml](.github/workflows/reviewer.yml) into each
target repo (already done for `revelio-api` / `revelio-ui`). It runs
`anthropics/claude-code-action@v1` on every PR, authenticating with
`claude_code_oauth_token` (a Claude subscription token from `claude
setup-token`, **not** an API key).

Required repo secrets (Settings → Secrets and variables → Actions):

| Secret | Required | Value |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | `claude setup-token` output |
| `ATLASSIAN_BASIC_AUTH` | yes | `base64("jira-email:api-token")` |
| `REVIEWER_GITHUB_TOKEN` | optional | second-account PAT so it can formally *approve* (GitHub forbids self-approval); else comment-only. Must NOT be named `GITHUB_*` — GitHub reserves that secret-name prefix |
| `INNGEST_EVENT_KEY` | optional | lets CI push the verdict to the orchestrator instead of the local review poller |

In production the CI step POSTs `ticket/review.submitted` to Inngest's public
endpoint; locally the review poller learns the verdict by polling open PRs, so
no public URL is needed.

---

## First-run checklist

```bash
npm install
cp .env.example .env        # fill in real tokens
npm run typecheck && npm test   # sanity

# two terminals
npm start                   # then…
npm run dev:inngest         # open the dashboard it prints

# move a Jira ticket into Backlog and watch the run appear
```
