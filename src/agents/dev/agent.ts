import { runAgent, type AgentRunResult } from '../../shared/claude.js';
import { config } from '../../shared/config.js';
import type { Ticket } from '../../shared/types.js';
import { parseChecklist, type Checklist } from './checklist.js';
import {
  DEV_SYSTEM_PROMPT,
  checklistOnlyPrompt,
  implementPrompt,
  type RepoDevContext,
} from './prompts.js';
import { shellGuardHooks } from './shell-guard-hook.js';
import type { Sandbox } from './sandbox.js';

/**
 * The dev agent. It has file/shell/git tools (built-ins, run through the shell
 * guard hook) and works only inside its disposable sandbox checkout. It never
 * opens the PR itself — the orchestrator does that, and only after independently
 * re-running the gates and verifying the acceptance-criteria checklist.
 */
const DEV_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'TodoWrite',
  // Lets the agent fan out exploration into subagents on larger tickets, the way
  // Claude Code does, instead of reading the whole repo in its own context.
  'Task',
];

export interface DevSessionResult {
  /** Null if the agent failed to produce a valid checklist. */
  readonly checklist: Checklist | null;
  readonly usage: AgentRunResult;
}

/**
 * Runs the dev agent as ONE continuous session that explores, implements, writes
 * tests, runs the gates ITSELF, iterates until green, and emits the checklist —
 * all in a single conversation, the way Claude Code works. This replaces the old
 * explore→implement→retry split, whose separate cold sessions each re-grounded
 * (re-read the repo) and fragmented the budget. One session keeps the agent's
 * full working memory in context, so a 12-criterion ticket converges instead of
 * restarting from zero each phase.
 *
 * The orchestrator still verifies independently AFTER this returns (re-runs the
 * gates and re-checks the checklist) before any PR is opened — the agent's own
 * gate runs here are for fast in-loop feedback, not the trust boundary.
 *
 * `priorProblems` is non-empty only on a resume after the orchestrator's
 * independent verification found a gap; it focuses the session on fixing those.
 */
export async function runDevSession(
  ticket: Ticket,
  sandbox: Sandbox,
  criteria: readonly string[],
  priorProblems: readonly string[],
  context: RepoDevContext,
  maxTurns: number,
): Promise<DevSessionResult> {
  const usage = await runAgent({
    role: 'dev',
    model: config.DEV_MODEL,
    allowedTools: DEV_ALLOWED_TOOLS,
    systemPrompt: DEV_SYSTEM_PROMPT,
    prompt: implementPrompt({
      ticket,
      repoName: sandbox.repo.repo,
      stack: sandbox.stack,
      criteria,
      priorProblems,
      reviewFeedback: context.reviewFeedback,
      priorWork: context.priorWork,
      plannedChanges: context.plannedChanges,
      otherRepoPlans: context.otherRepoPlans,
    }),
    cwd: sandbox.path,
    hooks: shellGuardHooks,
    permissionMode: 'bypassPermissions',
    maxTurns,
    logContext: { ticketKey: ticket.key, repo: sandbox.repo.repo },
  });
  // Parse from the full transcript, not just the final message: the agent often
  // ends on a tool call, leaving the checklist JSON in an earlier text block
  // that `usage.text` (final result only) would miss.
  const checklist =
    parseChecklist(usage.transcript) ?? parseChecklist(usage.text);
  return { checklist, usage };
}

/**
 * Recovers JUST the checklist when an implementation run did all the work and
 * passed the gates but ended without emitting one (the agent stopped after a
 * tool call, or ran out of turns mid-narration). Far cheaper than re-running
 * the whole implementation: a focused call that inspects the already-made
 * changes and maps each criterion to its test. Returns null if it still cannot
 * produce a valid checklist.
 */
export async function extractChecklist(
  ticket: Ticket,
  sandbox: Sandbox,
  criteria: readonly string[],
): Promise<DevSessionResult> {
  const usage = await runAgent({
    role: 'dev',
    model: config.DEV_MODEL,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    systemPrompt: DEV_SYSTEM_PROMPT,
    prompt: checklistOnlyPrompt(ticket, sandbox.repo.repo, criteria),
    cwd: sandbox.path,
    hooks: shellGuardHooks,
    permissionMode: 'bypassPermissions',
    maxTurns: 8,
    logContext: {
      ticketKey: ticket.key,
      repo: sandbox.repo.repo,
      phase: 'checklist',
    },
  });
  const checklist =
    parseChecklist(usage.transcript) ?? parseChecklist(usage.text);
  return { checklist, usage };
}
