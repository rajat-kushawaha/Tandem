import { EventSchemas, Inngest } from 'inngest';
import { z } from 'zod';

/**
 * Inngest client and the typed event contract that drives the orchestrator.
 * One workflow instance runs per Jira ticket, keyed by ticket key, so a
 * duplicate event for the same ticket never double-processes.
 */

const ticketKey = z.object({ ticketKey: z.string().min(1) });

const repoLocation = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
});

export const eventSchemas = {
  /** A ticket entered "In Progress" in Jira and is ready for the dev agent. */
  'ticket/dev.requested': { data: ticketKey },
  /** The BA agent should refine a freshly ingested ticket. */
  'ticket/refine.requested': { data: ticketKey },
  /** A human answered the BA agent's clarification in Slack. */
  'slack/clarification.answered': {
    data: z.object({ ticketKey: z.string().min(1), answer: z.string() }),
  },
  /** The dev agent opened a PR for a ticket. */
  'ticket/pr.opened': { data: ticketKey.merge(repoLocation) },
  /** The reviewer (CI action) submitted a verdict on a ticket's PR. */
  'ticket/review.submitted': { data: ticketKey.merge(repoLocation) },
  /** Every PR of the ticket has been merged by a human — the work is done. */
  'ticket/pr.merged': { data: ticketKey },
} as const;

// Without explicit config the SDK guesses its mode from NODE_ENV and, in dev
// mode, sends a DUMMY event key — fine against the ephemeral `inngest dev`
// server (ignores keys) but rejected by the persistent `inngest start` server
// ("event key not recognized"). When the local keys are present, pin
// production mode and pass them explicitly so both server modes work.
const eventKey = process.env.INNGEST_EVENT_KEY;
const baseUrl = process.env.INNGEST_BASE_URL;

export const inngest = new Inngest({
  id: 'agentic-sdlc',
  schemas: new EventSchemas().fromZod(eventSchemas),
  ...(eventKey && baseUrl ? { isDev: false, eventKey, baseUrl } : {}),
});

export type OrchestratorEvents = typeof eventSchemas;
