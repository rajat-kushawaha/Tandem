/**
 * Shared domain types used across the orchestrator, agents, and integrations.
 *
 * These describe our internal model of the world. External payloads (Jira,
 * Slack, GitHub) are validated with zod at their respective boundaries and
 * mapped into these types — code above the integration layer never sees a raw
 * external shape.
 */

/** The lifecycle states a ticket can occupy inside the orchestrator. */
export const TICKET_STATES = [
  'NEW',
  'REFINING',
  'READY_FOR_DEV',
  'IN_PROGRESS',
  'PR_OPEN',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'DONE',
  'BLOCKED',
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

/** Which agent acts in a given state, for logging and routing. */
export type AgentRole = 'ba' | 'dev' | 'reviewer';

/** A Jira issue mapped into our domain model. */
export interface Ticket {
  readonly key: string;
  readonly summary: string;
  readonly description: string;
  readonly status: string;
  readonly acceptanceCriteria: readonly string[];
  readonly url: string;
}

/** One affected repository for a piece of work. */
export interface AffectedRepo {
  readonly name: string;
  readonly prUrl: string | null;
}

/**
 * Durable per-ticket record persisted by the orchestrator. It is the single
 * source of truth linking a Jira key to its Slack thread and its PRs.
 */
export interface RunRecord {
  readonly ticketKey: string;
  state: TicketState;
  slackThreadTs: string | null;
  repos: AffectedRepo[];
  blockedReason: string | null;
  updatedAt: string;
}

export function createRunRecord(ticketKey: string): RunRecord {
  return {
    ticketKey,
    state: 'NEW',
    slackThreadTs: null,
    repos: [],
    blockedReason: null,
    updatedAt: new Date().toISOString(),
  };
}
