import { describe, expect, it } from 'vitest';
import { decideIngestEvent } from '../src/integrations/jira/ingest.js';

const statuses = { backlog: 'BackLog', inProgress: 'In Progress' };

describe('decideIngestEvent', () => {
  it('requests refinement for a new ticket in the backlog column', () => {
    expect(decideIngestEvent('BackLog', 'NEW', statuses)).toBe(
      'ticket/refine.requested',
    );
  });

  it('matches the configured status name case-insensitively', () => {
    expect(decideIngestEvent('backlog', 'NEW', statuses)).toBe(
      'ticket/refine.requested',
    );
  });

  it('requests dev work for a ready ticket moved to In Progress', () => {
    expect(decideIngestEvent('In Progress', 'READY_FOR_DEV', statuses)).toBe(
      'ticket/dev.requested',
    );
  });

  it('is idempotent: no event once the ticket has left the trigger state', () => {
    expect(
      decideIngestEvent('In Progress', 'IN_PROGRESS', statuses),
    ).toBeNull();
    expect(decideIngestEvent('BackLog', 'REFINING', statuses)).toBeNull();
  });

  it('returns null for unrelated status/state combinations', () => {
    expect(decideIngestEvent('QA', 'NEW', statuses)).toBeNull();
    expect(decideIngestEvent('In Progress', 'NEW', statuses)).toBeNull();
  });
});
