import type { RunRecord } from '../../shared/types.js';
import {
  applyEvent,
  loadOrCreate,
  type RunStore,
} from '../../orchestrator/run-store.js';
import { canTransition } from '../../orchestrator/state-machine.js';
import { aggregateTicketVerdict, decideFromReviews } from './outcome.js';

/**
 * Advances a ticket in response to the reviewers' verdicts across ALL of its
 * PRs (one per affected repo):
 *
 *  - any changes-requested routes the ticket back to the dev agent for rework;
 *  - the ticket advances to the human merge gate only when EVERY PR is
 *    approved — one approved PR must not advance a multi-repo ticket whose
 *    other PR is still unreviewed or flagged;
 *  - anything else (non-decisive reviews, some PRs unreviewed) is a no-op.
 *
 * Side effects (commenting on Jira, pinging the dev agent) are injected as
 * ports so this routing logic can be unit-tested without live integrations.
 */

export type ReviewResolution = 'changes-requested' | 'approved' | 'no-op';

export interface ReviewOutcomePorts {
  /** Called when every PR is approved — opens the human merge gate. */
  readonly onApproved: (record: RunRecord) => Promise<void>;
  /** Called when changes were requested — re-queues the dev agent. */
  readonly onChangesRequested: (record: RunRecord) => Promise<void>;
}

export interface HandleReviewOutcomeInput {
  readonly store: RunStore;
  readonly ticketKey: string;
  /** The review history of EACH of the ticket's PRs, one entry per PR. */
  readonly reviewsByPullRequest: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly ports: ReviewOutcomePorts;
}

export async function handleReviewOutcome(
  input: HandleReviewOutcomeInput,
): Promise<ReviewResolution> {
  const { store, ticketKey, reviewsByPullRequest, ports } = input;
  let record = await loadOrCreate(store, ticketKey);

  // A review only counts once the PR is actually under review.
  if (canTransition(record.state, 'REVIEW_STARTED')) {
    record = await applyEvent(store, record, 'REVIEW_STARTED');
  }

  const event = aggregateTicketVerdict(
    reviewsByPullRequest.map(decideFromReviews),
  );
  if (event === null || !canTransition(record.state, event)) {
    return 'no-op';
  }

  record = await applyEvent(store, record, event);

  if (event === 'REVIEW_APPROVED') {
    await ports.onApproved(record);
    return 'approved';
  }
  await ports.onChangesRequested(record);
  return 'changes-requested';
}
