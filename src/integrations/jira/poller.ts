import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { inngest } from '../../orchestrator/inngest.js';
import { runStore } from '../../orchestrator/store.js';
import { loadOrCreate } from '../../orchestrator/run-store.js';
import { searchByJql } from './client.js';
import { decideIngestEvent } from './ingest.js';

/**
 * Polls Jira on an interval and emits orchestrator events for tickets that have
 * entered an actionable status. Polling (rather than a webhook) means the
 * orchestrator needs no public URL to ingest Jira changes.
 */
export async function pollJiraOnce(): Promise<void> {
  const tickets = await searchByJql(config.JIRA_JQL);
  for (const ticket of tickets) {
    try {
      await ingestTicket(ticket);
    } catch (error) {
      // One bad ticket must not starve the rest of this poll cycle.
      logger.warn(
        { ticketKey: ticket.key, error },
        'failed to ingest ticket; skipping',
      );
    }
  }
}

async function ingestTicket(ticket: {
  key: string;
  status: string;
}): Promise<void> {
  const record = await loadOrCreate(runStore, ticket.key);
  const eventName = decideIngestEvent(ticket.status, record.state, {
    backlog: config.JIRA_STATUS_BACKLOG,
    inProgress: config.JIRA_STATUS_IN_PROGRESS,
  });
  if (!eventName) {
    return;
  }
  logger.info({ ticketKey: ticket.key, eventName }, 'ingesting ticket');
  // Dedup key: while a workflow is in flight the ticket's run-record state has
  // not advanced yet, so a later poll re-derives the SAME actionable event.
  // Inngest drops a send whose `id` it has already seen, so the in-flight run
  // is never duplicated. The id includes the event name (not the ticket alone)
  // so the dev pickup that legitimately follows refinement is a distinct event,
  // and a RESTART after a bounced review is allowed through by tagging the
  // record's state into the id.
  await inngest.send({
    id: `${eventName}:${ticket.key}:${record.state}`,
    name: eventName,
    data: { ticketKey: ticket.key },
  });
}

export function startJiraPoller(): NodeJS.Timeout {
  logger.info(
    { intervalMs: config.JIRA_POLL_INTERVAL_MS },
    'starting Jira poller',
  );
  return setInterval(() => {
    pollJiraOnce().catch((error: unknown) => {
      logger.error({ error }, 'Jira poll failed');
    });
  }, config.JIRA_POLL_INTERVAL_MS);
}
