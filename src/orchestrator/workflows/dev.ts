import { inngest } from '../inngest.js';
import { runStore } from '../store.js';
import { applyEvent, loadOrCreate } from '../run-store.js';
import { canTransition } from '../state-machine.js';
import { agentLogger } from '../../shared/logger.js';
import type { AffectedRepo, Ticket } from '../../shared/types.js';
import { config } from '../../shared/config.js';
import {
  readTicket,
  addComment,
  ensureStatus,
} from '../../integrations/jira/client.js';
import { postChannelMessage } from '../../integrations/slack/client.js';
import { configuredRepos } from '../../integrations/github/configured-repos.js';
import {
  findOpenPullRequest,
  getPullRequestDiff,
  listReviewFeedback,
  listReviews,
} from '../../integrations/github/clients.js';
import { decideFromReviews } from '../../agents/reviewer/outcome.js';
import { shouldReuseOpenPr } from './dev-skip.js';
import {
  planAffectedRepos,
  type PlannedRepo,
} from '../../agents/dev/select-repos.js';
import { classifyCriteriaByRepo } from '../../agents/dev/classify-criteria.js';
import type { PriorRepoWork } from '../../agents/dev/prompts.js';
import {
  developRepo,
  PRIOR_WORK_DIFF_MAX_CHARS,
  type RepoOutcome,
} from '../../agents/dev/run-repo.js';
import {
  branchName,
  disposeSandbox,
  preparePlanningCheckout,
  ticketSandboxRoot,
} from '../../agents/dev/sandbox.js';
import { startBudget } from '../../orchestrator/budget.js';

/**
 * Dev workflow. Selects the affected repos by keyword, then develops each one
 * with bounded retries. A ticket advances to PR_OPEN only when EVERY affected
 * repo produced a shippable PR. If any repo could not be finished, the workflow
 * opens no false-success state: it moves the ticket to BLOCKED and posts exactly
 * what is blocking to Jira and Slack. A truthful "stuck" beats a false "done".
 */
export const devWorkflow = inngest.createFunction(
  {
    id: 'dev-implementation',
    concurrency: { key: 'event.data.ticketKey', limit: 1 },
    retries: 2,
  },
  { event: 'ticket/dev.requested' },
  async ({ event, step }) => {
    const { ticketKey } = event.data;
    const log = agentLogger('dev', ticketKey);

    const ticket = await step.run('read-ticket', () => readTicket(ticketKey));

    await step.run('begin-dev', () => beginDev(ticketKey));

    const repos = await step.run('plan-repos', () =>
      planRepos(ticketKey, ticket),
    );
    if (repos.length === 0) {
      await step.run('block-no-repos', () =>
        escalate(ticketKey, [
          'No repositories are configured in GITHUB_REPOS.',
        ]),
      );
      return { outcome: 'blocked-no-repos' };
    }

    // Split the acceptance criteria across the repos so each repo is verified
    // only against the criteria it can satisfy (a backend isn't asked to pass
    // frontend criteria, which would loop forever on "untestable"). Returns a
    // plain object (Inngest steps must serialize) keyed by repo key.
    const criteriaByRepo = await step.run('classify-criteria', async () => {
      const map = await classifyCriteriaByRepo(
        ticket,
        repos.map((planned) => planned.config),
      );
      return Object.fromEntries(map);
    });

    try {
      // One budget for the whole ticket, carried from repo to repo so the
      // spend ceiling is genuinely per-ticket rather than reset per repo.
      let budget = startBudget();
      const outcomes: RepoOutcome[] = [];
      // Diffs of repos already handled for this ticket (shipped earlier or
      // developed just now), fed into each later repo's session so cross-repo
      // contracts come from the actual change, not a second guess. Repos run
      // in GITHUB_REPOS order — configure it backend-first so contract
      // producers run before consumers.
      const priorWork: PriorRepoWork[] = [];
      for (const planned of repos) {
        const repo = planned.config;
        // Decide what this repo needs by looking at its open PR (if any):
        //  - no PR            → develop fresh from the base branch;
        //  - PR, no rework    → already shipped; reuse it and skip the agent;
        //  - changes requested → REWORK: resume the branch and fix exactly
        //    what the reviewer asked for.
        const assessment = await step.run(`check-pr-${repo.key}`, () =>
          assessExistingPullRequest(
            repo.owner,
            repo.repo,
            branchName(ticket.key),
          ),
        );
        if (assessment.kind === 'shipped') {
          log.info(
            { repo: repo.repo, prUrl: assessment.url },
            'repo already has an open PR (no rework requested); skipping',
          );
          outcomes.push({
            repo: repo.repo,
            shippable: true,
            prUrl: assessment.url,
            problems: [],
            diff: assessment.diff,
            budget,
          });
          if (assessment.diff) {
            priorWork.push({ repo: repo.repo, diff: assessment.diff });
          }
          continue;
        }

        const repoCriteria =
          criteriaByRepo[repo.key] ?? ticket.acceptanceCriteria;
        const context = {
          reviewFeedback:
            assessment.kind === 'rework' ? assessment.feedback : [],
          priorWork: [...priorWork],
          plannedChanges: planned.changes,
          otherRepoPlans: repos
            .filter((other) => other.config.key !== repo.key)
            .map((other) => ({
              repo: other.config.repo,
              changes: other.changes,
            })),
        };
        const outcome = await step.run(`develop-${repo.key}`, () =>
          developRepo(ticket, repo, budget, repoCriteria, context),
        );
        budget = outcome.budget;
        outcomes.push(outcome);
        if (outcome.shippable && outcome.diff) {
          priorWork.push({ repo: outcome.repo, diff: outcome.diff });
        }
      }

      const failed = outcomes.filter((outcome) => !outcome.shippable);
      if (failed.length > 0) {
        // Persist the PRs that DID ship before blocking, so a re-trigger sees
        // them recorded and skips them rather than redoing the work.
        await step.run('record-partial-prs', () =>
          recordShippedRepos(ticketKey, outcomes),
        );
        await step.run('block-on-failure', () =>
          escalate(
            ticketKey,
            failed.flatMap((outcome) => outcome.problems),
          ),
        );
        // Deliberately do NOT dispose the sandbox on failure: keep the failed
        // checkout so its exact lint/build/test state can be inspected. It is
        // overwritten on the next run for this ticket, so it won't accumulate.
        log.warn(
          { ticketKey, sandboxRoot: config.SANDBOX_ROOT },
          'attempt blocked; sandbox preserved for inspection under SANDBOX_ROOT/<ticket>',
        );
        return { outcome: 'blocked-not-shippable' };
      }

      await step.run('record-prs', () =>
        recordPullRequests(ticketKey, outcomes),
      );
      // Success: the feature branch is pushed, so the local checkout is
      // disposable. Cleaning up only on success keeps SANDBOX_ROOT from growing
      // while preserving failed checkouts for debugging.
      await step.run('dispose-sandbox', () => disposeSandbox(ticketKey));
      log.info({ repos }, 'all repos shippable; ticket moved to PR_OPEN');
      return { outcome: 'pr-open', prs: outcomes.map((o) => o.prUrl) };
    } catch (error) {
      // On an unexpected throw, also preserve the sandbox for inspection.
      log.error({ ticketKey, error }, 'dev workflow threw; sandbox preserved');
      throw error;
    }
  },
);

/**
 * Plans which repos the ticket changes — once — by checking out EVERY
 * configured repo (read-only, base branch) and letting a code-aware planner
 * inspect them all before deciding which must change and what each change is.
 * The chosen repo names are persisted on the run record; every later run
 * (rework, retry after a crash) reuses that selection, so a nondeterministic
 * re-triage can never develop a different set of repos than the ones whose
 * PRs are already under review (the per-repo change notes are not persisted —
 * a rework is driven by reviewer feedback instead).
 */
async function planRepos(
  ticketKey: string,
  ticket: Ticket,
): Promise<PlannedRepo[]> {
  const all = configuredRepos();
  const record = await loadOrCreate(runStore, ticketKey);
  if (record.repos.length > 0) {
    const byName = new Map(all.map((repo) => [repo.repo, repo]));
    const planned = record.repos.flatMap((repo) => {
      const repoConfig = byName.get(repo.name);
      return repoConfig ? [{ config: repoConfig, changes: [] }] : [];
    });
    if (planned.length > 0) {
      return planned;
    }
  }

  await Promise.all(
    all.map((repo) =>
      preparePlanningCheckout(
        { owner: repo.owner, repo: repo.repo },
        ticketKey,
        config.GITHUB_BASE_BRANCH,
      ),
    ),
  );
  const chosen = await planAffectedRepos(
    ticket,
    all,
    ticketSandboxRoot(ticketKey),
  );
  if (chosen.length > 0) {
    record.repos = chosen.map((planned) => ({
      name: planned.config.repo,
      prUrl: null,
    }));
    record.updatedAt = new Date().toISOString();
    await runStore.save(record);
  }
  return chosen;
}

/** What an existing open PR (if any) means for this repo's dev run. */
type PullRequestAssessment =
  | { kind: 'none' }
  | { kind: 'shipped'; url: string; diff: string | null }
  | { kind: 'rework'; url: string; feedback: string[] };

/**
 * Inspects the repo's open PR for this ticket's branch:
 *
 *  - no open PR → develop from scratch;
 *  - open PR whose latest review did NOT request changes → "shipped": reuse it
 *    (its diff still feeds later repos' contracts);
 *  - open PR with changes requested → "rework", carrying the reviewer's
 *    written feedback for the agent to address on the existing branch.
 *
 * Network errors degrade to "none" so a transient GitHub blip re-develops
 * rather than wrongly skips.
 */
async function assessExistingPullRequest(
  owner: string,
  repo: string,
  branch: string,
): Promise<PullRequestAssessment> {
  try {
    const pr = await findOpenPullRequest({ owner, repo }, branch);
    if (!pr) {
      return { kind: 'none' };
    }
    const ref = { owner, repo, number: pr.number };
    const reviews = await listReviews(ref);
    if (shouldReuseOpenPr(decideFromReviews(reviews))) {
      return { kind: 'shipped', url: pr.url, diff: await prDiff(ref) };
    }
    const feedback = await listReviewFeedback(ref);
    return {
      kind: 'rework',
      url: pr.url,
      feedback:
        feedback.length > 0
          ? feedback
          : [
              'The reviewer requested changes but left no retrievable comments — re-verify every acceptance criterion and all gates.',
            ],
    };
  } catch {
    return { kind: 'none' };
  }
}

/** Best-effort, truncated PR diff for cross-repo context; never fatal. */
async function prDiff(ref: {
  owner: string;
  repo: string;
  number: number;
}): Promise<string | null> {
  try {
    const diff = await getPullRequestDiff(ref);
    return diff.length > PRIOR_WORK_DIFF_MAX_CHARS
      ? `${diff.slice(0, PRIOR_WORK_DIFF_MAX_CHARS)}\n…(truncated)`
      : diff;
  } catch {
    return null;
  }
}

async function beginDev(ticketKey: string): Promise<void> {
  const record = await loadOrCreate(runStore, ticketKey);
  // Normal start (DEV_STARTED / REWORK_STARTED) or an operator retry from a
  // stuck/blocked/already-past-dev state (RESTART_DEV). The first legal one wins.
  for (const event of [
    'REWORK_STARTED',
    'DEV_STARTED',
    'RESTART_DEV',
  ] as const) {
    if (canTransition(record.state, event)) {
      await applyEvent(runStore, record, event, { blockedReason: null });
      break;
    }
  }
  // Keep the board in sync (e.g. move a reworked ticket back from review).
  await ensureStatus(ticketKey, config.JIRA_STATUS_IN_PROGRESS);
}

/**
 * Persists the PR URLs of repos that shipped, WITHOUT changing ticket state.
 * Used on a partial failure: the ticket is about to be blocked, but the repos
 * that succeeded must be remembered so a re-trigger skips them. Merges with any
 * repos already recorded so an earlier run's PRs are not lost.
 */
async function recordShippedRepos(
  ticketKey: string,
  outcomes: readonly RepoOutcome[],
): Promise<void> {
  const shipped = outcomes.filter(
    (outcome) => outcome.shippable && outcome.prUrl,
  );
  if (shipped.length === 0) {
    return;
  }
  const record = await loadOrCreate(runStore, ticketKey);
  const byName = new Map<string, AffectedRepo>(
    record.repos.map((repo) => [repo.name, repo]),
  );
  for (const outcome of shipped) {
    byName.set(outcome.repo, { name: outcome.repo, prUrl: outcome.prUrl });
  }
  record.repos = [...byName.values()];
  record.updatedAt = new Date().toISOString();
  await runStore.save(record);
}

async function recordPullRequests(
  ticketKey: string,
  outcomes: readonly RepoOutcome[],
): Promise<void> {
  const repos: AffectedRepo[] = outcomes.map((outcome) => ({
    name: outcome.repo,
    prUrl: outcome.prUrl,
  }));
  const record = await loadOrCreate(runStore, ticketKey);
  await applyEvent(runStore, record, 'PR_OPENED', { repos });
  await addComment(
    ticketKey,
    `Dev agent opened PR(s):\n${outcomes.map((o) => `- ${o.prUrl}`).join('\n')}`,
  );
  await ensureStatus(ticketKey, config.JIRA_STATUS_IN_REVIEW);
}

async function escalate(
  ticketKey: string,
  problems: readonly string[],
): Promise<void> {
  const record = await loadOrCreate(runStore, ticketKey);
  const reason = problems.join('; ');
  if (canTransition(record.state, 'BLOCK')) {
    await applyEvent(runStore, record, 'BLOCK', { blockedReason: reason });
  }
  const detail = problems.map((problem) => `- ${problem}`).join('\n');
  await addComment(
    ticketKey,
    `:warning: Dev agent could not complete this ticket and did NOT open a PR implying success.\n\nBlocking issues:\n${detail}`,
  );
  await postChannelMessage(
    `:no_entry: *${ticketKey}* is blocked — the dev agent could not satisfy all acceptance criteria:\n${detail}`,
  );
}
