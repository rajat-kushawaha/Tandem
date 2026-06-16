import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Central environment configuration. Loaded and validated exactly once at
 * module import. If a required variable is missing the process exits with a
 * clear, actionable message rather than failing deep inside an agent run.
 *
 * Auth note: we default to the subscription OAuth token
 * (`CLAUDE_CODE_OAUTH_TOKEN`). An `ANTHROPIC_API_KEY` is accepted as an
 * alternative — exactly one of the two must be present.
 */

const nonEmpty = z.string().trim().min(1);

const schema = z
  .object({
    // --- Claude auth (exactly one required; OAuth preferred) ---
    CLAUDE_CODE_OAUTH_TOKEN: nonEmpty.optional(),
    ANTHROPIC_API_KEY: nonEmpty.optional(),

    // --- Per-agent models ---
    BA_MODEL: nonEmpty.default('claude-sonnet-4-6'),
    DEV_MODEL: nonEmpty.default('claude-opus-4-8'),
    REVIEWER_MODEL: nonEmpty.default('claude-opus-4-8'),

    // --- Jira (Atlassian Rovo MCP + REST) ---
    JIRA_SITE_URL: z.string().url(),
    JIRA_EMAIL: z.string().email(),
    JIRA_API_TOKEN: nonEmpty,
    JIRA_JQL: nonEmpty.default('project = AGENT ORDER BY updated DESC'),
    JIRA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    ATLASSIAN_MCP_URL: z
      .string()
      .url()
      .default('https://mcp.atlassian.com/v1/mcp'),

    // --- Jira status names (must match the board exactly) ---
    // BA ingests from BACKLOG; Dev ingests from IN_PROGRESS. PR-open moves the
    // ticket to IN_REVIEW; reviewer approval moves it to READY_FOR_MERGE.
    JIRA_STATUS_BACKLOG: nonEmpty.default('Backlog'),
    JIRA_STATUS_IN_PROGRESS: nonEmpty.default('In Progress'),
    JIRA_STATUS_IN_REVIEW: nonEmpty.default('QA'),
    JIRA_STATUS_READY_FOR_MERGE: nonEmpty.default('In PR review'),
    // Where a ticket goes once every PR is merged. Optional: when unset, the
    // orchestrator marks the ticket DONE internally and comments, but leaves
    // the board column to the humans.
    JIRA_STATUS_DONE: nonEmpty.optional(),

    // --- Slack (Socket Mode) ---
    SLACK_BOT_TOKEN: nonEmpty,
    SLACK_APP_TOKEN: nonEmpty,
    SLACK_CHANNEL_ID: nonEmpty,

    // --- GitHub: dev identity (PAT used to clone, push, and open PRs) ---
    GITHUB_TOKEN: nonEmpty,
    // Optional second-account PAT the reviewer uses to approve (GitHub forbids
    // self-approval). If absent, the reviewer posts an approval comment instead.
    // Named without the GITHUB_ prefix because GitHub Actions reserves that
    // prefix for secret names; using the same name locally keeps it consistent.
    REVIEWER_GITHUB_TOKEN: nonEmpty.optional(),
    // Repo routing map:
    //   key:owner/repo:kw1,kw2;key2:owner/repo2:kw1,kw2
    // Keywords decide which repos a ticket affects (matched against its text).
    GITHUB_REPOS: nonEmpty,
    GITHUB_BASE_BRANCH: nonEmpty.default('main'),

    // Disposable per-ticket checkout root. MUST live OUTSIDE this project tree:
    // the dev agent runs the gates (eslint, tsc, prettier, vitest) inside the
    // checkout, and those tools traverse ancestor directories for config — a
    // sandbox nested under this repo would inherit this repo's own
    // eslint.config.js / tsconfig and break the gates with a config it never
    // chose. Defaults to a temp dir; override only with another absolute path
    // outside the project.
    SANDBOX_ROOT: nonEmpty.default(join(tmpdir(), 'agentic-sdlc-sandbox')),

    // Path for the file-backed run store. When set, the orchestrator persists
    // per-ticket state to this JSON file so a restart resumes in-flight tickets
    // instead of forgetting them. Unset → in-memory store (state lost on
    // restart; fine for tests). For production, swap in a Mongo/Redis store.
    RUN_STORE_FILE: nonEmpty.optional(),

    // --- Per-ticket budget (stops a confused run looping forever) ---
    // Two distinct turn ceilings, deliberately kept separate:
    //   MAX_TURNS_PER_RUN    — handed to the SDK as `maxTurns`; caps a SINGLE
    //                          agent invocation (one implement attempt).
    //   MAX_TURNS_PER_TICKET — the cumulative budget across every attempt and
    //                          every repo of one ticket (see budget.ts).
    // One continuous dev session does the whole job (explore + implement + test
    // + run gates + iterate), like Claude Code, so it needs a large turn budget —
    // a tight cap is what fragmented the old multi-phase design. 150 lets a big
    // multi-criterion ticket finish in one session.
    MAX_TURNS_PER_RUN: z.coerce.number().int().positive().default(150),
    MAX_TURNS_PER_TICKET: z.coerce.number().int().positive().default(500),
    MAX_TOKENS_PER_TICKET: z.coerce
      .number()
      .int()
      .positive()
      .default(3_000_000),
    MAX_WALL_CLOCK_MS: z.coerce.number().int().positive().default(2_400_000),
    DEV_MAX_FIX_ATTEMPTS: z.coerce.number().int().positive().default(4),

    // How long a ticket may sit unchanged in an agent-owned state before the
    // watchdog re-triggers its workflow (self-healing after a crash or a lost
    // event). Must comfortably exceed the longest legitimate run — default
    // 90 min vs. the 40-min dev wall clock — or the watchdog would re-trigger
    // tickets that are merely slow.
    WATCHDOG_STALE_MS: z.coerce.number().int().positive().default(5_400_000),

    // --- Logging ---
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
  })
  .refine(
    (env) => Boolean(env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_API_KEY),
    {
      message:
        'Provide CLAUDE_CODE_OAUTH_TOKEN (preferred) or ANTHROPIC_API_KEY.',
      path: ['CLAUDE_CODE_OAUTH_TOKEN'],
    },
  );

export type Config = z.infer<typeof schema>;

function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    // Intentionally bypass the logger: config must fail before anything boots.
    process.stderr.write(
      `Invalid environment configuration:\n${issues}\n` +
        'See .env.example for the full list of required variables.\n',
    );
    process.exit(1);
  }
  return parsed.data;
}

export const config: Config = loadConfig();

export type ModelConfig = Pick<
  Config,
  'BA_MODEL' | 'DEV_MODEL' | 'REVIEWER_MODEL'
>;
