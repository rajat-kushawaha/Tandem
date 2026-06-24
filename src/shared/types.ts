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
 * AI usage accumulated for one agent role over a ticket: token counts, the
 * model that produced them, and the USD cost (SDK-reported when available,
 * otherwise estimated from tokens). All fields accumulate across retries and
 * rework runs.
 */
export interface AgentCost {
  /** The model used for this agent's runs (last one seen, if it ever changed). */
  model: string;
  /** Non-cached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache (billed at a discount). */
  cacheReadInputTokens: number;
  /** Input tokens written to the prompt cache (billed at a premium). */
  cacheCreationInputTokens: number;
  costUsd: number;
}

export function emptyAgentCost(): AgentCost {
  return {
    model: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
  };
}

/** Total input tokens of every kind (non-cache + cache read + cache creation). */
export function totalInputTokens(cost: AgentCost): number {
  return (
    cost.inputTokens + cost.cacheReadInputTokens + cost.cacheCreationInputTokens
  );
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
  /** AI usage by the BA agent for this ticket (zeroed until BA runs). */
  ba: AgentCost;
  /** AI usage by the Dev agent across all attempts for this ticket. */
  dev: AgentCost;
}

/** Total USD cost across all tracked agents. Reviewer runs in CI, not tracked here. */
export function totalCostUsd(record: RunRecord): number {
  return record.ba.costUsd + record.dev.costUsd;
}

export function createRunRecord(ticketKey: string): RunRecord {
  return {
    ticketKey,
    state: 'NEW',
    slackThreadTs: null,
    repos: [],
    blockedReason: null,
    updatedAt: new Date().toISOString(),
    ba: emptyAgentCost(),
    dev: emptyAgentCost(),
  };
}
