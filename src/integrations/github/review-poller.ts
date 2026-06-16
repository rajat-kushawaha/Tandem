import { inngest } from '../../orchestrator/inngest.js';
import { runStore } from '../../orchestrator/store.js';
import { logger } from '../../shared/logger.js';
import {
  decideFromReviews,
  latestDecisiveAt,
} from '../../agents/reviewer/outcome.js';
import { listReviews } from './clients.js';
import { parsePullRequestUrl } from './pr-url.js';

/**
 * Local, no-public-URL path for learning a reviewer's verdict: poll the reviews
 * of every open PR and, when a decisive review appears, emit
 * `ticket/review.submitted` so the reviewer workflow advances the ticket.
 *
 * Production prefers the push path (CI posts the event to Inngest directly, see
 * .github/workflows/reviewer.yml); this poller is the equivalent for local runs
 * where the orchestrator has no inbound URL.
 */
export async function pollReviewsOnce(): Promise<void> {
  const records = await runStore.list();
  const openForReview = records.filter(
    (record) => record.state === 'PR_OPEN' || record.state === 'IN_REVIEW',
  );

  for (const record of openForReview) {
    for (const repo of record.repos) {
      if (!repo.prUrl) {
        continue;
      }
      const pr = parsePullRequestUrl(repo.prUrl);
      if (!pr) {
        logger.warn({ prUrl: repo.prUrl }, 'unparseable PR url; skipping');
        continue;
      }
      try {
        const reviews = await listReviews(pr);
        if (decideFromReviews(reviews) === null) {
          continue;
        }
        // Dedup on the deciding review's timestamp so a PR that keeps showing
        // the same verdict across poll cycles emits the event only once. A new
        // review (e.g. changes-requested after a re-push) has a fresh timestamp
        // and so is emitted again.
        await inngest.send({
          id: `review:${record.ticketKey}:${pr.number}:${latestDecisiveAt(reviews) ?? 'na'}`,
          name: 'ticket/review.submitted',
          data: {
            ticketKey: record.ticketKey,
            owner: pr.owner,
            repo: pr.repo,
            prNumber: pr.number,
          },
        });
      } catch (error) {
        // One unreachable PR (e.g. deleted, 404) must not starve the rest of
        // the batch this cycle.
        logger.warn(
          { ticketKey: record.ticketKey, prUrl: repo.prUrl, error },
          'review poll for PR failed; skipping',
        );
      }
    }
  }
}
