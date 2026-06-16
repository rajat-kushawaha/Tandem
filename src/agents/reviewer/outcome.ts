import { z } from 'zod';
import type { TicketEvent } from '../../orchestrator/state-machine.js';

/**
 * Translates a GitHub review outcome into a ticket state-machine event.
 *
 * The reviewer agent runs as `anthropics/claude-code-action@v1` in each repo's
 * CI and submits a normal GitHub review. We never trust the raw payload: it is
 * validated here before any state changes.
 */

/** GitHub's review states. Only APPROVED / CHANGES_REQUESTED move the ticket. */
export const reviewSchema = z.object({
  state: z.enum([
    'APPROVED',
    'CHANGES_REQUESTED',
    'COMMENTED',
    'DISMISSED',
    'PENDING',
  ]),
  submittedAt: z.string().nullable(),
});

export type Review = z.infer<typeof reviewSchema>;

/**
 * Maps a single review's state to an event, or null when the review does not
 * change the ticket's state (a plain comment, a dismissal, a pending draft).
 */
export function reviewStateToEvent(state: Review['state']): TicketEvent | null {
  switch (state) {
    case 'APPROVED':
      return 'REVIEW_APPROVED';
    case 'CHANGES_REQUESTED':
      return 'CHANGES_REQUESTED';
    default:
      return null;
  }
}

/**
 * Picks the deciding event from a PR's full review history: the MOST RECENT
 * decisive review wins. A later approval therefore supersedes an earlier
 * changes-requested (the author addressed the feedback and the reviewer
 * re-approved), and a later changes-requested supersedes an earlier approval.
 * This mirrors GitHub's own "latest review per reviewer decides" behaviour.
 *
 * Note: we do not have the reviewer identity in this payload, so this is
 * "latest review overall" rather than strict per-author latest. With a single
 * automated reviewer that is equivalent; multi-reviewer PRs would need the
 * author field to dedup per reviewer.
 */
export function decideFromReviews(
  reviews: ReadonlyArray<unknown>,
): TicketEvent | null {
  const latest = latestDecisive(reviews);
  return latest ? reviewStateToEvent(latest.state) : null;
}

/**
 * Combines each PR's verdict into ONE ticket-level event. A ticket may have a
 * PR per affected repo, and they are reviewed independently — so:
 *
 *  - ANY changes-requested sends the ticket back to the dev agent (that repo
 *    needs rework, whatever the others say);
 *  - the ticket is APPROVED only when EVERY PR's latest decisive review is an
 *    approval — a single approved PR must not advance a ticket whose other
 *    repo is still unreviewed or flagged;
 *  - otherwise nothing happens yet (still waiting on a reviewer).
 */
export function aggregateTicketVerdict(
  perPrEvents: ReadonlyArray<TicketEvent | null>,
): TicketEvent | null {
  if (perPrEvents.some((event) => event === 'CHANGES_REQUESTED')) {
    return 'CHANGES_REQUESTED';
  }
  if (
    perPrEvents.length > 0 &&
    perPrEvents.every((event) => event === 'REVIEW_APPROVED')
  ) {
    return 'REVIEW_APPROVED';
  }
  return null;
}

/** The most recent decisive (approve / changes-requested) review, or null. */
function latestDecisive(reviews: ReadonlyArray<unknown>): Review | null {
  const decisive = reviews
    .map((raw) => reviewSchema.safeParse(raw))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((review) => reviewStateToEvent(review.state) !== null)
    .sort((a, b) => orderKey(a) - orderKey(b));
  return decisive.at(-1) ?? null;
}

/**
 * Timestamp of the deciding review, for dedup keys. Returns null when there is
 * no decisive review or it carries no submission time.
 */
export function latestDecisiveAt(
  reviews: ReadonlyArray<unknown>,
): string | null {
  return latestDecisive(reviews)?.submittedAt ?? null;
}

function orderKey(review: Review): number {
  return review.submittedAt ? Date.parse(review.submittedAt) : 0;
}
