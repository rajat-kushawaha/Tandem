import { inngest } from '../inngest.js';
import { runStore } from '../store.js';
import { applyEvent, loadOrCreate } from '../run-store.js';
import { canTransition } from '../state-machine.js';
import { config } from '../../shared/config.js';
import { addComment, ensureStatus } from '../../integrations/jira/client.js';
import { agentLogger } from '../../shared/logger.js';
import { totalCostUsd } from '../../shared/types.js';
import { costComment } from '../cost.js';

/**
 * Closes a ticket's lifecycle once a human has merged every one of its PRs:
 * the record moves to DONE and, when `JIRA_STATUS_DONE` is configured, the
 * Jira card moves to its final column. Without this, a merged ticket would
 * sit in APPROVED forever — the merge happens in GitHub's UI and nothing else
 * reports it back.
 */
export const mergedWorkflow = inngest.createFunction(
  {
    id: 'ticket-merged',
    concurrency: { key: 'event.data.ticketKey', limit: 1 },
    retries: 3,
  },
  { event: 'ticket/pr.merged' },
  async ({ event, step }) => {
    const { ticketKey } = event.data;
    const log = agentLogger('reviewer', ticketKey);

    const marked = await step.run('mark-done', async () => {
      const record = await loadOrCreate(runStore, ticketKey);
      if (!canTransition(record.state, 'MERGED')) {
        return false; // e.g. already DONE from an earlier event
      }
      await applyEvent(runStore, record, 'MERGED');
      return true;
    });

    if (!marked) {
      return { outcome: 'already-done' };
    }

    await step.run('close-out-jira', async () => {
      const record = await loadOrCreate(runStore, ticketKey);
      const costLine =
        totalCostUsd(record) > 0 ? `\n\n${costComment(record)}` : '';
      await addComment(
        ticketKey,
        `All PRs for this ticket have been merged. The work is done.${costLine}`,
      );
      if (config.JIRA_STATUS_DONE) {
        await ensureStatus(ticketKey, config.JIRA_STATUS_DONE);
      }
    });

    log.info('ticket merged and closed out');
    return { outcome: 'done' };
  },
);
