import type { TicketEvent } from '../state-machine.js';

/**
 * Whether an existing open PR for a repo should be reused (and the repo skipped
 * on a dev re-trigger) given the latest review verdict on it. Reuse unless the
 * reviewer asked for changes — a flagged PR must be re-developed, which is how a
 * multi-repo changes-requested run reworks only the repo the reviewer flagged.
 *
 * Kept in its own dependency-free module so it is unit-testable without loading
 * the workflow (and its config/Inngest imports).
 */
export function shouldReuseOpenPr(reviewEvent: TicketEvent | null): boolean {
  return reviewEvent !== 'CHANGES_REQUESTED';
}
