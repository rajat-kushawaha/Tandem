import { inngest } from '../../orchestrator/inngest.js';
import { runStore } from '../../orchestrator/store.js';
import { logger } from '../../shared/logger.js';
import type { TicketState } from '../../shared/types.js';
import { isPullRequestMerged } from './clients.js';
import { parsePullRequestUrl } from './pr-url.js';

/**
 * Detects the human acting on the merge gate. Nothing notifies the
 * orchestrator when a PR is merged (merging happens in GitHub's UI), so
 * without this poll a ticket would sit in APPROVED forever and never reach
 * DONE. Any state with an open PR is checked — a human may merge before the
 * automated reviewer has had its say.
 *
 * `ticket/pr.merged` fires only when EVERY recorded PR of the ticket is
 * merged; the dedup id pins it to once per ticket.
 */
const MERGEABLE_STATES: ReadonlySet<TicketState> = new Set([
  'PR_OPEN',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
]);

export async function pollMergesOnce(): Promise<void> {
  const records = await runStore.list();

  for (const record of records) {
    if (!MERGEABLE_STATES.has(record.state)) {
      continue;
    }
    const prs = record.repos.flatMap((repo) => {
      const parsed = repo.prUrl ? parsePullRequestUrl(repo.prUrl) : null;
      return parsed ? [parsed] : [];
    });
    if (prs.length === 0) {
      continue;
    }
    try {
      const merged = await Promise.all(prs.map(isPullRequestMerged));
      if (!merged.every(Boolean)) {
        continue;
      }
      await inngest.send({
        id: `merged:${record.ticketKey}`,
        name: 'ticket/pr.merged',
        data: { ticketKey: record.ticketKey },
      });
    } catch (error) {
      // One unreachable PR must not starve the rest of the batch this cycle.
      logger.warn(
        { ticketKey: record.ticketKey, error },
        'merge poll for ticket failed; skipping',
      );
    }
  }
}
