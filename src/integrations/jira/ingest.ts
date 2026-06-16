import type { TicketState } from '../../shared/types.js';

/**
 * Decides which orchestrator event (if any) a polled Jira ticket should emit,
 * given the ticket's Jira status and its current orchestrator state.
 *
 *  - a ticket in the BACKLOG column is picked up by the BA agent;
 *  - a refined ticket a human has moved into IN_PROGRESS is picked up by the
 *    dev agent.
 *
 * Gating on the current state makes the poller idempotent: a ticket sitting in
 * a column across many poll cycles only triggers its agent once, because after
 * the first emit its orchestrator state has moved on.
 */

export type IngestEvent = 'ticket/refine.requested' | 'ticket/dev.requested';

export interface IngestStatuses {
  readonly backlog: string;
  readonly inProgress: string;
}

const eq = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function decideIngestEvent(
  jiraStatus: string,
  currentState: TicketState,
  statuses: IngestStatuses,
): IngestEvent | null {
  if (currentState === 'NEW' && eq(jiraStatus, statuses.backlog)) {
    return 'ticket/refine.requested';
  }
  if (currentState === 'READY_FOR_DEV' && eq(jiraStatus, statuses.inProgress)) {
    return 'ticket/dev.requested';
  }
  return null;
}
