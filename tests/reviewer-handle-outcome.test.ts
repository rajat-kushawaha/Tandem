import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunStore } from '../src/orchestrator/run-store.js';
import { handleReviewOutcome } from '../src/agents/reviewer/handle-outcome.js';
import { createRunRecord, type RunRecord } from '../src/shared/types.js';

function ports() {
  return {
    onApproved: vi.fn<(r: RunRecord) => Promise<void>>().mockResolvedValue(),
    onChangesRequested: vi
      .fn<(r: RunRecord) => Promise<void>>()
      .mockResolvedValue(),
  };
}

async function seed(state: RunRecord['state']): Promise<InMemoryRunStore> {
  const store = new InMemoryRunStore();
  await store.save({ ...createRunRecord('AGENT-1'), state });
  return store;
}

const approved = { state: 'APPROVED', submittedAt: '2026-06-04T10:00:00Z' };
const changesRequested = {
  state: 'CHANGES_REQUESTED',
  submittedAt: '2026-06-04T10:00:00Z',
};

describe('handleReviewOutcome', () => {
  it('advances a single approved PR to the human gate', async () => {
    const store = await seed('PR_OPEN');
    const p = ports();
    const resolution = await handleReviewOutcome({
      store,
      ticketKey: 'AGENT-1',
      reviewsByPullRequest: [[approved]],
      ports: p,
    });

    expect(resolution).toBe('approved');
    expect(p.onApproved).toHaveBeenCalledOnce();
    expect((await store.get('AGENT-1'))?.state).toBe('APPROVED');
  });

  it('routes a changes-requested PR back to the dev agent', async () => {
    const store = await seed('IN_REVIEW');
    const p = ports();
    const resolution = await handleReviewOutcome({
      store,
      ticketKey: 'AGENT-1',
      reviewsByPullRequest: [[changesRequested]],
      ports: p,
    });

    expect(resolution).toBe('changes-requested');
    expect(p.onChangesRequested).toHaveBeenCalledOnce();
    expect((await store.get('AGENT-1'))?.state).toBe('CHANGES_REQUESTED');
  });

  it('is a no-op for a non-decisive review', async () => {
    const store = await seed('IN_REVIEW');
    const p = ports();
    const resolution = await handleReviewOutcome({
      store,
      ticketKey: 'AGENT-1',
      reviewsByPullRequest: [[{ state: 'COMMENTED', submittedAt: null }]],
      ports: p,
    });

    expect(resolution).toBe('no-op');
    expect(p.onApproved).not.toHaveBeenCalled();
    expect(p.onChangesRequested).not.toHaveBeenCalled();
    expect((await store.get('AGENT-1'))?.state).toBe('IN_REVIEW');
  });

  it('does NOT approve a multi-PR ticket while one PR is still unreviewed', async () => {
    const store = await seed('IN_REVIEW');
    const p = ports();
    const resolution = await handleReviewOutcome({
      store,
      ticketKey: 'AGENT-1',
      reviewsByPullRequest: [[approved], []],
      ports: p,
    });

    expect(resolution).toBe('no-op');
    expect(p.onApproved).not.toHaveBeenCalled();
    expect((await store.get('AGENT-1'))?.state).toBe('IN_REVIEW');
  });

  it('requests rework when any PR of a multi-PR ticket is flagged', async () => {
    const store = await seed('IN_REVIEW');
    const p = ports();
    const resolution = await handleReviewOutcome({
      store,
      ticketKey: 'AGENT-1',
      reviewsByPullRequest: [[approved], [changesRequested]],
      ports: p,
    });

    expect(resolution).toBe('changes-requested');
    expect(p.onChangesRequested).toHaveBeenCalledOnce();
    expect((await store.get('AGENT-1'))?.state).toBe('CHANGES_REQUESTED');
  });

  it('approves only when EVERY PR is approved', async () => {
    const store = await seed('IN_REVIEW');
    const p = ports();
    const resolution = await handleReviewOutcome({
      store,
      ticketKey: 'AGENT-1',
      reviewsByPullRequest: [[approved], [approved]],
      ports: p,
    });

    expect(resolution).toBe('approved');
    expect(p.onApproved).toHaveBeenCalledOnce();
    expect((await store.get('AGENT-1'))?.state).toBe('APPROVED');
  });
});
