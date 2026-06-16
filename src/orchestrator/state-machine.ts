import type { TicketState } from '../shared/types.js';

/**
 * The ticket lifecycle as an explicit, typed state machine. Only transitions
 * named in {@link TRANSITIONS} are legal; everything else throws. This is the
 * guardrail that keeps a confused agent or a duplicate event from advancing a
 * ticket into a state it has not actually earned.
 */

export const TICKET_EVENTS = [
  'START_REFINEMENT',
  'REFINEMENT_COMPLETE',
  'DEV_STARTED',
  'PR_OPENED',
  'REVIEW_STARTED',
  'CHANGES_REQUESTED',
  'REWORK_STARTED',
  'REVIEW_APPROVED',
  'MERGED',
  'BLOCK',
  // Operator-initiated retry: re-run the dev agent on a ticket that is stuck,
  // blocked, or already past dev (e.g. after fixing the repo). Returns it to
  // IN_PROGRESS so the dev workflow can run again idempotently.
  'RESTART_DEV',
] as const;

export type TicketEvent = (typeof TICKET_EVENTS)[number];

export const TERMINAL_STATES: ReadonlySet<TicketState> = new Set([
  'DONE',
  'BLOCKED',
]);

/**
 * Transition table: from-state → event → to-state. The `BLOCK` event is added
 * to every non-terminal state below, so it is intentionally absent here.
 */
const HAPPY_PATH: Readonly<
  Record<TicketState, Partial<Record<TicketEvent, TicketState>>>
> = {
  NEW: { START_REFINEMENT: 'REFINING', RESTART_DEV: 'IN_PROGRESS' },
  REFINING: { REFINEMENT_COMPLETE: 'READY_FOR_DEV' },
  READY_FOR_DEV: { DEV_STARTED: 'IN_PROGRESS', RESTART_DEV: 'IN_PROGRESS' },
  IN_PROGRESS: { PR_OPENED: 'PR_OPEN', RESTART_DEV: 'IN_PROGRESS' },
  // MERGED is legal from every state where a PR exists, not only APPROVED: the
  // human merge gate is authoritative, and a human may merge before (or in
  // spite of) the automated reviewer's verdict. The orchestrator records
  // reality rather than fighting it.
  PR_OPEN: {
    REVIEW_STARTED: 'IN_REVIEW',
    RESTART_DEV: 'IN_PROGRESS',
    MERGED: 'DONE',
  },
  IN_REVIEW: {
    CHANGES_REQUESTED: 'CHANGES_REQUESTED',
    REVIEW_APPROVED: 'APPROVED',
    RESTART_DEV: 'IN_PROGRESS',
    MERGED: 'DONE',
  },
  CHANGES_REQUESTED: {
    REWORK_STARTED: 'IN_PROGRESS',
    RESTART_DEV: 'IN_PROGRESS',
    MERGED: 'DONE',
  },
  APPROVED: { MERGED: 'DONE' },
  DONE: {},
  BLOCKED: { RESTART_DEV: 'IN_PROGRESS' },
};

function buildTransitions(): Readonly<
  Record<TicketState, Partial<Record<TicketEvent, TicketState>>>
> {
  const table = {} as Record<
    TicketState,
    Partial<Record<TicketEvent, TicketState>>
  >;
  for (const state of Object.keys(HAPPY_PATH) as TicketState[]) {
    const allowBlock: Partial<Record<TicketEvent, TicketState>> =
      TERMINAL_STATES.has(state) ? {} : { BLOCK: 'BLOCKED' };
    table[state] = { ...HAPPY_PATH[state], ...allowBlock };
  }
  return table;
}

export const TRANSITIONS = buildTransitions();

export function nextState(
  current: TicketState,
  event: TicketEvent,
): TicketState | null {
  return TRANSITIONS[current][event] ?? null;
}

export function canTransition(
  current: TicketState,
  event: TicketEvent,
): boolean {
  return nextState(current, event) !== null;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TicketState,
    readonly event: TicketEvent,
  ) {
    super(`Illegal transition: cannot apply "${event}" while in "${from}".`);
    this.name = 'IllegalTransitionError';
  }
}

/** Applies an event, returning the next state or throwing if it is illegal. */
export function transition(
  current: TicketState,
  event: TicketEvent,
): TicketState {
  const next = nextState(current, event);
  if (next === null) {
    throw new IllegalTransitionError(current, event);
  }
  return next;
}

export function isTerminal(state: TicketState): boolean {
  return TERMINAL_STATES.has(state);
}
