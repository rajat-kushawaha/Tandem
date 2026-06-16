import { describe, expect, it } from 'vitest';
import {
  aggregateTicketVerdict,
  decideFromReviews,
  reviewStateToEvent,
} from '../src/agents/reviewer/outcome.js';

describe('reviewer outcome mapping', () => {
  it('maps decisive review states to events', () => {
    expect(reviewStateToEvent('APPROVED')).toBe('REVIEW_APPROVED');
    expect(reviewStateToEvent('CHANGES_REQUESTED')).toBe('CHANGES_REQUESTED');
  });

  it('treats non-decisive states as no-ops', () => {
    expect(reviewStateToEvent('COMMENTED')).toBeNull();
    expect(reviewStateToEvent('DISMISSED')).toBeNull();
    expect(reviewStateToEvent('PENDING')).toBeNull();
  });

  it('uses the most recent decisive review across history', () => {
    const reviews = [
      { state: 'CHANGES_REQUESTED', submittedAt: '2026-06-01T10:00:00Z' },
      { state: 'COMMENTED', submittedAt: '2026-06-01T11:00:00Z' },
      { state: 'APPROVED', submittedAt: '2026-06-02T09:00:00Z' },
    ];
    expect(decideFromReviews(reviews)).toBe('REVIEW_APPROVED');
  });

  it('stays on changes-requested when it is the latest decisive review', () => {
    const reviews = [
      { state: 'APPROVED', submittedAt: '2026-06-01T10:00:00Z' },
      { state: 'CHANGES_REQUESTED', submittedAt: '2026-06-03T10:00:00Z' },
    ];
    expect(decideFromReviews(reviews)).toBe('CHANGES_REQUESTED');
  });

  it('returns null when there are no decisive reviews', () => {
    expect(
      decideFromReviews([{ state: 'COMMENTED', submittedAt: null }]),
    ).toBeNull();
    expect(decideFromReviews([])).toBeNull();
  });

  it('ignores malformed review payloads instead of trusting them', () => {
    const reviews = [
      { state: 'APPROVED', submittedAt: '2026-06-02T09:00:00Z' },
      { state: 'NONSENSE', submittedAt: 'whenever' },
    ];
    expect(decideFromReviews(reviews)).toBe('REVIEW_APPROVED');
  });
});

describe('aggregateTicketVerdict', () => {
  it('approves only when every PR is approved', () => {
    expect(
      aggregateTicketVerdict(['REVIEW_APPROVED', 'REVIEW_APPROVED']),
    ).toBe('REVIEW_APPROVED');
  });

  it('waits while any PR is still unreviewed', () => {
    expect(aggregateTicketVerdict(['REVIEW_APPROVED', null])).toBeNull();
  });

  it('requests rework when any PR is flagged, even if another is approved', () => {
    expect(
      aggregateTicketVerdict(['REVIEW_APPROVED', 'CHANGES_REQUESTED']),
    ).toBe('CHANGES_REQUESTED');
  });

  it('returns null for no PRs at all', () => {
    expect(aggregateTicketVerdict([])).toBeNull();
  });
});
