import { describe, expect, it } from 'vitest';
import { decideRecoveryActions } from '../src/orchestrator/watchdog.js';
import { createRunRecord, type RunRecord } from '../src/shared/types.js';

const STALE_MS = 60 * 60 * 1000; // 1 h
const NOW = Date.parse('2026-06-10T12:00:00Z');

function record(
  ticketKey: string,
  state: RunRecord['state'],
  ageMs: number,
  slackThreadTs: string | null = null,
): RunRecord {
  return {
    ...createRunRecord(ticketKey),
    state,
    slackThreadTs,
    updatedAt: new Date(NOW - ageMs).toISOString(),
  };
}

describe('decideRecoveryActions', () => {
  it('re-triggers the dev agent for a ticket stuck IN_PROGRESS', () => {
    const actions = decideRecoveryActions(
      [record('CR-1', 'IN_PROGRESS', 2 * STALE_MS)],
      STALE_MS,
      NOW,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.event).toBe('ticket/dev.requested');
    expect(actions[0]?.ticketKey).toBe('CR-1');
  });

  it('re-triggers stalled READY_FOR_DEV and CHANGES_REQUESTED tickets', () => {
    const actions = decideRecoveryActions(
      [
        record('CR-1', 'READY_FOR_DEV', 2 * STALE_MS),
        record('CR-2', 'CHANGES_REQUESTED', 2 * STALE_MS),
      ],
      STALE_MS,
      NOW,
    );
    expect(actions.map((a) => a.event)).toEqual([
      'ticket/dev.requested',
      'ticket/dev.requested',
    ]);
  });

  it('re-triggers refinement for a REFINING ticket with no Slack thread', () => {
    const actions = decideRecoveryActions(
      [record('CR-1', 'REFINING', 2 * STALE_MS)],
      STALE_MS,
      NOW,
    );
    expect(actions[0]?.event).toBe('ticket/refine.requested');
  });

  it('leaves a REFINING ticket alone while it waits on a Slack answer', () => {
    const actions = decideRecoveryActions(
      [record('CR-1', 'REFINING', 2 * STALE_MS, '1717575600.000100')],
      STALE_MS,
      NOW,
    );
    expect(actions).toHaveLength(0);
  });

  it('ignores fresh records', () => {
    const actions = decideRecoveryActions(
      [record('CR-1', 'IN_PROGRESS', STALE_MS / 2)],
      STALE_MS,
      NOW,
    );
    expect(actions).toHaveLength(0);
  });

  it('never recovers BLOCKED or review/merge-gate states', () => {
    const states: RunRecord['state'][] = [
      'BLOCKED',
      'PR_OPEN',
      'IN_REVIEW',
      'APPROVED',
      'DONE',
      'NEW',
    ];
    const actions = decideRecoveryActions(
      states.map((state, i) => record(`CR-${i}`, state, 10 * STALE_MS)),
      STALE_MS,
      NOW,
    );
    expect(actions).toHaveLength(0);
  });

  it('buckets the dedup id so a stall retries once per stale period', () => {
    const first = decideRecoveryActions(
      [record('CR-1', 'IN_PROGRESS', 2 * STALE_MS)],
      STALE_MS,
      NOW,
    );
    const samePeriod = decideRecoveryActions(
      [record('CR-1', 'IN_PROGRESS', 2 * STALE_MS)],
      STALE_MS,
      NOW + 1000,
    );
    const nextPeriod = decideRecoveryActions(
      [record('CR-1', 'IN_PROGRESS', 2 * STALE_MS)],
      STALE_MS,
      NOW + STALE_MS,
    );
    expect(first[0]?.id).toBe(samePeriod[0]?.id);
    expect(first[0]?.id).not.toBe(nextPeriod[0]?.id);
  });

  it('treats an unparseable updatedAt as not stale instead of firing', () => {
    const broken = { ...record('CR-1', 'IN_PROGRESS', 0), updatedAt: 'garbage' };
    expect(decideRecoveryActions([broken], STALE_MS, NOW)).toHaveLength(0);
  });
});
