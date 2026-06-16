import { describe, expect, it } from 'vitest';
import { shouldReuseOpenPr } from '../src/orchestrator/workflows/dev-skip.js';

describe('shouldReuseOpenPr', () => {
  it('reuses an open PR with no decisive review (fresh from a prior run)', () => {
    // The partial-failure case: api shipped a PR, ui failed; on re-trigger the
    // api PR has no review yet, so it is reused and api is skipped.
    expect(shouldReuseOpenPr(null)).toBe(true);
  });

  it('reuses an open PR that was approved', () => {
    expect(shouldReuseOpenPr('REVIEW_APPROVED')).toBe(true);
  });

  it('does NOT reuse a PR the reviewer asked to change (re-develop it)', () => {
    expect(shouldReuseOpenPr('CHANGES_REQUESTED')).toBe(false);
  });
});
