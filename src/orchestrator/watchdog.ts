import type { RunRecord, TicketState } from '../shared/types.js';

/**
 * Self-healing for stalled tickets: the pure decision of WHICH tickets need
 * re-triggering (the side effects live in watchdog-runner.ts, keeping this
 * unit-testable without config/Inngest).
 *
 * A crash, a lost event, or an exhausted Inngest retry can leave a ticket
 * parked in an agent-owned state with no workflow running and nothing left to
 * wake it: the Jira poller only acts on NEW and READY_FOR_DEV tickets, and
 * Inngest dedups a re-derived event id for 24 h. The watchdog closes that gap —
 * any record that has sat unchanged in an agent-owned state for longer than
 * the stale threshold gets its workflow re-triggered (the workflows are
 * idempotent: finished repos are skipped, state transitions are guarded).
 *
 * Deliberately NOT recovered:
 *  - BLOCKED — blocked means a human must act; retrying without them changes
 *    nothing. Re-run via `npm run dev:trigger -- <KEY>` once unblocked.
 *  - REFINING with a Slack thread — legitimately waiting for a human answer;
 *    the BA workflow's own timeout owns that wait.
 *  - PR_OPEN / IN_REVIEW / APPROVED — waiting on the reviewer or the human
 *    merge gate, which have no deadline.
 */

export type RecoveryEvent = 'ticket/refine.requested' | 'ticket/dev.requested';

export interface RecoveryAction {
  readonly ticketKey: string;
  readonly event: RecoveryEvent;
  /**
   * Inngest dedup id, bucketed by stale-period: re-sending within the same
   * bucket is dropped by Inngest, so a stall retries once per period instead
   * of once per poll — bounded, periodic healing.
   */
  readonly id: string;
  readonly reason: string;
}

const RECOVERY_EVENTS: Partial<Record<TicketState, RecoveryEvent>> = {
  REFINING: 'ticket/refine.requested',
  READY_FOR_DEV: 'ticket/dev.requested',
  IN_PROGRESS: 'ticket/dev.requested',
  CHANGES_REQUESTED: 'ticket/dev.requested',
};

export function decideRecoveryActions(
  records: readonly RunRecord[],
  staleMs: number,
  now: number = Date.now(),
): RecoveryAction[] {
  return records.flatMap((record) => {
    const event = RECOVERY_EVENTS[record.state];
    if (!event) {
      return [];
    }
    if (record.state === 'REFINING' && record.slackThreadTs) {
      return []; // waiting on a human in Slack — not stalled
    }
    const ageMs = now - Date.parse(record.updatedAt);
    if (!(ageMs >= staleMs)) {
      return []; // fresh enough, or an unparseable timestamp (NaN)
    }
    const bucket = Math.floor(now / staleMs);
    return [
      {
        ticketKey: record.ticketKey,
        event,
        id: `watchdog:${event}:${record.ticketKey}:${bucket}`,
        reason: `stuck in ${record.state} for ${Math.round(ageMs / 60_000)} min`,
      },
    ];
  });
}
