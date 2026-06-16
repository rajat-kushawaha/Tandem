import { inngest } from '../inngest.js';
import { runStore } from '../store.js';
import { loadOrCreate } from '../run-store.js';
import { config } from '../../shared/config.js';
import { handleReviewOutcome } from '../../agents/reviewer/handle-outcome.js';
import { listReviews } from '../../integrations/github/clients.js';
import { parsePullRequestUrl } from '../../integrations/github/pr-url.js';
import { addComment, ensureStatus } from '../../integrations/jira/client.js';
import { agentLogger } from '../../shared/logger.js';

/**
 * Reacts to a reviewer verdict on one of a ticket's PRs. The reviewer runs as
 * `anthropics/claude-code-action@v1` in each repo's CI and submits a GitHub
 * review; this workflow re-reads the reviews of EVERY PR on the ticket (a
 * multi-repo ticket has one per repo) and advances the ticket on the combined
 * verdict:
 *
 *  - any changes-requested → ticket returns to the dev agent for rework;
 *  - ALL PRs approved      → ticket moves to APPROVED and waits at the human
 *    merge gate;
 *  - otherwise (some PRs still unreviewed) → wait for the next verdict.
 *
 * Concurrency is pinned to one run per ticket so two reviews can't race.
 */
export const reviewerOutcomeWorkflow = inngest.createFunction(
  {
    id: 'reviewer-outcome',
    concurrency: { key: 'event.data.ticketKey', limit: 1 },
    retries: 3,
  },
  { event: 'ticket/review.submitted' },
  async ({ event, step }) => {
    const { ticketKey, owner, repo, prNumber } = event.data;
    const log = agentLogger('reviewer', ticketKey);

    const reviewsByPullRequest = await step.run('fetch-reviews', async () => {
      const prs = await ticketPullRequests(ticketKey);
      // Fall back to the event's PR if the record carries none (e.g. the store
      // was rebuilt) — one PR's verdict is then the whole ticket's verdict.
      const refs = prs.length > 0 ? prs : [{ owner, repo, number: prNumber }];
      return Promise.all(refs.map((ref) => listReviews(ref)));
    });

    const resolution = await step.run('apply-outcome', () =>
      handleReviewOutcome({
        store: runStore,
        ticketKey,
        reviewsByPullRequest,
        ports: {
          onApproved: async (record) => {
            await addComment(
              record.ticketKey,
              'Reviewer approved the PR. Awaiting human approval and merge.',
            );
            await ensureStatus(
              record.ticketKey,
              config.JIRA_STATUS_READY_FOR_MERGE,
            );
          },
          onChangesRequested: (record) =>
            addComment(
              record.ticketKey,
              'Reviewer requested changes. Returning the ticket to the dev agent.',
            ),
        },
      }),
    );

    log.info({ resolution }, 'reviewer outcome handled');

    if (resolution === 'changes-requested') {
      await step.sendEvent('requeue-dev', {
        name: 'ticket/dev.requested',
        data: { ticketKey },
      });
    }

    return { resolution };
  },
);

/** Every PR recorded on the ticket, parsed into owner/repo/number refs. */
async function ticketPullRequests(
  ticketKey: string,
): Promise<Array<{ owner: string; repo: string; number: number }>> {
  const record = await loadOrCreate(runStore, ticketKey);
  return record.repos.flatMap((repo) => {
    const parsed = repo.prUrl ? parsePullRequestUrl(repo.prUrl) : null;
    return parsed ? [parsed] : [];
  });
}
