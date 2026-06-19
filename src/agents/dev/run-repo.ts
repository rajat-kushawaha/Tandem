import { config } from '../../shared/config.js';
import { ticketLogger } from '../../shared/logger.js';
import type { Ticket } from '../../shared/types.js';
import {
  commentOnPullRequest,
  openPullRequest,
} from '../../integrations/github/clients.js';
import type { RepoConfig } from '../../integrations/github/repos.js';
import {
  chargeRun,
  checkBudget,
  type BudgetState,
} from '../../orchestrator/budget.js';
import { extractChecklist, runDevSession } from './agent.js';
import type { Checklist } from './checklist.js';
import { evaluateAttempt } from './evaluate.js';
import {
  baselineFailures,
  gatesEffectivelyGreen,
  resolveGates,
  runBaselineGates,
  runGates,
  summarizeGates,
  type GateResult,
} from './gates.js';
import type { RepoDevContext } from './prompts.js';
import {
  commitAndPush,
  diffAgainstBase,
  prepareSandbox,
  pushEmptyCommit,
  type Sandbox,
} from './sandbox.js';

/**
 * Develops a single repo for a ticket with bounded retries. Each attempt the
 * dev agent implements in the sandbox; the orchestrator then INDEPENDENTLY runs
 * the gates and verifies the checklist. A PR is opened only when an attempt is
 * shippable. If attempts run out, no PR is opened and the unresolved problems
 * are returned so the workflow can escalate truthfully.
 */

export interface RepoOutcome {
  readonly repo: string;
  readonly shippable: boolean;
  readonly prUrl: string | null;
  readonly problems: readonly string[];
  /**
   * The shipped change as a diff against the base branch (truncated), so the
   * next repo's session can honour the contracts it introduced. Null when the
   * repo did not ship or the diff could not be computed.
   */
  readonly diff: string | null;
  /**
   * The per-ticket budget after this repo's attempts, so the caller can carry
   * it into the next repo. The budget is shared across all repos of a ticket —
   * the spend ceiling is per ticket, not per repo.
   */
  readonly budget: BudgetState;
}

/** Ceiling for a cross-repo context diff: enough for contracts, not a flood. */
export const PRIOR_WORK_DIFF_MAX_CHARS = 20_000;

export async function developRepo(
  ticket: Ticket,
  repo: RepoConfig,
  incomingBudget: BudgetState,
  /**
   * The acceptance criteria THIS repo is responsible for (a subset of the
   * ticket's, assigned by classification). The repo is implemented and verified
   * only against these — so a backend isn't asked to satisfy frontend criteria.
   */
  criteria: readonly string[],
  context: RepoDevContext,
): Promise<RepoOutcome> {
  const repoName = repo.repo;
  const log = ticketLogger(ticket.key);
  // A rework (the reviewer asked for changes on an open PR) continues on the
  // existing feature branch; anything else starts clean from base.
  const sandbox = await prepareSandbox(
    { owner: repo.owner, repo: repo.repo },
    ticket.key,
    config.GITHUB_BASE_BRANCH,
    { resumeFeatureBranch: context.reviewFeedback.length > 0 },
  );

  const limits = {
    maxTurns: config.MAX_TURNS_PER_TICKET,
    maxTokens: config.MAX_TOKENS_PER_TICKET,
    maxWallClockMs: config.MAX_WALL_CLOCK_MS,
  };
  let budget: BudgetState = incomingBudget;

  // Baseline: run the gates ONCE on the clean checkout, before the agent edits
  // anything, to learn which gates are already red on the base branch. The
  // agent is judged only on regressions it introduces — pre-existing failures
  // (e.g. a lint error in an unrelated file, a missing generated file) are
  // reported but never block, so a broken base can't trap the agent in a loop
  // it cannot win. install/build failures are never waived (see gates.ts).
  const gates = await resolveGates(sandbox.stack, sandbox.path);
  // Retry a failed baseline gate once: the cold first run can flake on a base
  // branch that is actually green, and a false "pre-existing" waiver is what
  // sends a red gate onto the PR body and traps dev↔reviewer in a loop.
  const baseline = await runBaselineGates(sandbox.path, gates);
  const waived = baselineFailures(baseline);
  if (waived.size > 0) {
    log.warn(
      { repo: repoName, preExisting: [...waived] },
      'gates already failing on the base branch; these will not block the agent',
    );
  }

  // ONE continuous agent session does the whole job (explore + implement + test
  // + run gates itself + iterate). The orchestrator then verifies INDEPENDENTLY.
  // A small number of resumes is allowed: each resume re-enters a fresh session
  // in the SAME sandbox (prior work persists on disk) but focused only on the
  // specific gaps the independent verification found — not a cold re-implement.
  let problems: readonly string[] = [];
  for (let attempt = 1; attempt <= config.DEV_MAX_FIX_ATTEMPTS; attempt++) {
    const verdict = checkBudget(budget, limits);
    if (!verdict.withinBudget) {
      return {
        repo: repoName,
        shippable: false,
        prUrl: null,
        problems: [`Per-ticket budget exhausted: ${verdict.reason}.`],
        diff: null,
        budget,
      };
    }

    log.info(
      { repo: repoName, attempt, resuming: problems.length > 0 },
      attempt === 1
        ? 'dev session started'
        : 'dev session resumed to fix verification gaps',
    );

    // A generous per-session turn budget: one session must explore, implement,
    // test, run gates, and fix — like Claude Code. Far better spent than the old
    // tight per-phase caps that each starved.
    const session = await runDevSession(
      ticket,
      sandbox,
      criteria,
      problems,
      context,
      config.MAX_TURNS_PER_RUN,
    );
    budget = chargeRun(budget, session.usage);

    // INDEPENDENT verification — the trust boundary. The orchestrator re-runs the
    // gates itself (not trusting the agent's in-session runs) and re-checks the
    // criteria checklist. continueOnFailure so a waived pre-existing failure
    // doesn't hide a real regression in a later gate.
    const gateResults = await runGates(sandbox.path, gates, {
      continueOnFailure: true,
    });

    // If the work is done (gates green) but the agent never emitted a checklist,
    // recover it cheaply rather than re-running the whole session.
    let checklist = session.checklist;
    if (!checklist && gatesEffectivelyGreen(gateResults, waived)) {
      log.info(
        { repo: repoName, attempt },
        'gates green but no checklist; attempting checklist recovery',
      );
      const recovery = await extractChecklist(ticket, sandbox, criteria);
      budget = chargeRun(budget, recovery.usage);
      checklist = recovery.checklist;
    }

    const attemptVerdict = evaluateAttempt(
      criteria,
      checklist,
      gateResults,
      waived,
    );

    if (!attemptVerdict.shippable) {
      problems = attemptVerdict.problems;
      log.warn(
        { repo: repoName, attempt, problems },
        'independent verification failed; will resume to fix if attempts remain',
      );
      continue;
    }

    const { committed } = await commitAndPush(
      sandbox,
      `${ticket.key}: ${ticket.summary}`,
    );
    const pr = await openPullRequest({
      owner: repo.owner,
      repo: repo.repo,
      title: `${ticket.key}: ${ticket.summary}`,
      body: pullRequestBody(ticket, criteria, checklist, gateResults, waived),
      head: sandbox.branch,
      base: config.GITHUB_BASE_BRANCH,
    });
    log.info({ repo: repoName, prUrl: pr.url }, 'PR opened');

    // A rework that changed nothing is a verdict disagreement: the session
    // verified the feedback and judged the branch already correct. Without a
    // new commit no `synchronize` event fires, so the stale changes-requested
    // review would stand forever and the poller would re-trigger this rework
    // in a loop. Say so on the PR, then push an empty commit to force a fresh
    // CI review of the same code.
    if (!committed && context.reviewFeedback.length > 0) {
      const ref = { owner: repo.owner, repo: repo.repo, number: pr.number };
      await commentOnPullRequest(
        ref,
        [
          'The dev agent re-verified this branch against the requested changes and found no code change needed:',
          '',
          ...context.reviewFeedback.map((item) => `- ${item}`),
          '',
          `All gates pass on the current head (${summarizeGates(gateResults, waived).split('\n').join(', ')}).`,
          'Pushing an empty commit to trigger a fresh review of the unchanged code.',
        ].join('\n'),
      );
      await pushEmptyCommit(
        sandbox,
        `${ticket.key}: re-request review (rework verified, no changes needed)`,
      );
      log.info(
        { repo: repoName, prUrl: pr.url },
        'rework produced no diff; commented and pushed empty commit to force re-review',
      );
    }
    return {
      repo: repoName,
      shippable: true,
      prUrl: pr.url,
      problems: [],
      diff: await shippedDiff(sandbox),
      budget,
    };
  }

  return {
    repo: repoName,
    shippable: false,
    prUrl: null,
    problems,
    diff: null,
    budget,
  };
}

/** Best-effort diff of the shipped change; context for later repos, never fatal. */
async function shippedDiff(sandbox: Sandbox): Promise<string | null> {
  try {
    return await diffAgainstBase(
      sandbox,
      config.GITHUB_BASE_BRANCH,
      PRIOR_WORK_DIFF_MAX_CHARS,
    );
  } catch {
    return null;
  }
}

function pullRequestBody(
  ticket: Ticket,
  criteria: readonly string[],
  checklist: Checklist | null,
  gateResults: readonly GateResult[],
  waived: ReadonlySet<string>,
): string {
  // Render the criteria THIS repo owns, checked against the agent's ACTUAL
  // checklist (not a blanket [x]). A criterion mapped to a satisfied test is
  // [x] with its test; anything else is [ ]. Honest reporting on the PR.
  const satisfied = new Map(
    (checklist?.items ?? []).map((item) => [
      item.criterion.trim().toLowerCase(),
      item,
    ]),
  );
  const lines = criteria.map((c) => {
    const item = satisfied.get(c.trim().toLowerCase());
    const done = item?.satisfied && !item.untestable;
    const test = item?.testReference ? ` _(↳ ${item.testReference})_` : '';
    return `- [${done ? 'x' : ' '}] ${c}${done ? test : ''}`;
  });
  return [
    `Implements [${ticket.key}](${ticket.url}).`,
    '',
    '## Acceptance criteria (this repo)',
    ...lines,
    '',
    '## Gates',
    '```',
    summarizeGates(gateResults, waived),
    '```',
    '',
    '_Opened by the dev agent. Requires human approval before merge._',
  ].join('\n');
}
