import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  canTransition,
  isTerminal,
  nextState,
  transition,
  type TicketEvent,
} from '../src/orchestrator/state-machine.js';
import type { TicketState } from '../src/shared/types.js';

describe('ticket state machine', () => {
  it('walks the full happy path NEW → DONE', () => {
    const path: ReadonlyArray<[TicketEvent, TicketState]> = [
      ['START_REFINEMENT', 'REFINING'],
      ['REFINEMENT_COMPLETE', 'READY_FOR_DEV'],
      ['DEV_STARTED', 'IN_PROGRESS'],
      ['PR_OPENED', 'PR_OPEN'],
      ['REVIEW_STARTED', 'IN_REVIEW'],
      ['REVIEW_APPROVED', 'APPROVED'],
      ['MERGED', 'DONE'],
    ];
    let state: TicketState = 'NEW';
    for (const [event, expected] of path) {
      state = transition(state, event);
      expect(state).toBe(expected);
    }
    expect(isTerminal(state)).toBe(true);
  });

  it('loops CHANGES_REQUESTED ⇄ IN_PROGRESS for rework', () => {
    expect(transition('IN_REVIEW', 'CHANGES_REQUESTED')).toBe(
      'CHANGES_REQUESTED',
    );
    expect(transition('CHANGES_REQUESTED', 'REWORK_STARTED')).toBe(
      'IN_PROGRESS',
    );
  });

  it('allows BLOCK from any non-terminal state', () => {
    const nonTerminal: TicketState[] = [
      'NEW',
      'REFINING',
      'READY_FOR_DEV',
      'IN_PROGRESS',
      'PR_OPEN',
      'IN_REVIEW',
      'CHANGES_REQUESTED',
      'APPROVED',
    ];
    for (const state of nonTerminal) {
      expect(transition(state, 'BLOCK')).toBe('BLOCKED');
    }
  });

  it('forbids BLOCK from terminal states', () => {
    expect(canTransition('DONE', 'BLOCK')).toBe(false);
    expect(canTransition('BLOCKED', 'BLOCK')).toBe(false);
  });

  it('allows RESTART_DEV to re-enter IN_PROGRESS, including from BLOCKED', () => {
    expect(transition('BLOCKED', 'RESTART_DEV')).toBe('IN_PROGRESS');
    expect(transition('PR_OPEN', 'RESTART_DEV')).toBe('IN_PROGRESS');
    expect(transition('CHANGES_REQUESTED', 'RESTART_DEV')).toBe('IN_PROGRESS');
    expect(transition('IN_PROGRESS', 'RESTART_DEV')).toBe('IN_PROGRESS');
  });

  it('does not allow RESTART_DEV on a merged ticket', () => {
    expect(canTransition('DONE', 'RESTART_DEV')).toBe(false);
  });

  it('accepts a human merge from any state where a PR exists', () => {
    // The human merge gate is authoritative — a merge may land before (or in
    // spite of) the automated reviewer's verdict.
    for (const state of [
      'PR_OPEN',
      'IN_REVIEW',
      'CHANGES_REQUESTED',
      'APPROVED',
    ] as const) {
      expect(transition(state, 'MERGED')).toBe('DONE');
    }
  });

  it('rejects MERGED before any PR exists', () => {
    expect(canTransition('NEW', 'MERGED')).toBe(false);
    expect(canTransition('IN_PROGRESS', 'MERGED')).toBe(false);
  });

  it('rejects illegal transitions with a descriptive error', () => {
    expect(() => transition('NEW', 'MERGED')).toThrow(IllegalTransitionError);
    expect(() => transition('DONE', 'START_REFINEMENT')).toThrow(
      /Illegal transition/,
    );
  });

  it('reports nextState as null for illegal pairs without throwing', () => {
    expect(nextState('READY_FOR_DEV', 'PR_OPENED')).toBeNull();
    expect(canTransition('READY_FOR_DEV', 'DEV_STARTED')).toBe(true);
  });
});
