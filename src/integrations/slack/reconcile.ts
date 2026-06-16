import { logger } from '../../shared/logger.js';
import { inngest } from '../../orchestrator/inngest.js';
import { runStore } from '../../orchestrator/store.js';
import { fetchThreadReplies } from './client.js';

/**
 * Recovers clarification answers that arrived while the orchestrator was down.
 *
 * Socket Mode delivers only live messages: if a human replied in a thread
 * during a restart, the reply was never seen and the BA workflow would sit out
 * its whole timeout despite the answer existing in Slack. On startup, this
 * re-reads every thread the orchestrator is still waiting on and re-emits the
 * first human reply as `slack/clarification.answered` — the same event the
 * live listener emits, with a dedup id so a reply that WAS seen live is not
 * processed twice.
 */
export async function reconcileClarificationThreads(): Promise<void> {
  const records = await runStore.list();
  const waiting = records.filter(
    (record) => record.state === 'REFINING' && record.slackThreadTs !== null,
  );

  for (const record of waiting) {
    try {
      const replies = await fetchThreadReplies(record.slackThreadTs as string);
      const answer = replies.find(
        (reply) => !reply.isBot && reply.text.trim() !== '',
      );
      if (!answer) {
        continue; // still genuinely unanswered
      }
      logger.info(
        { ticketKey: record.ticketKey, replyTs: answer.ts },
        'reconciled a clarification answer posted while the orchestrator was down',
      );
      await inngest.send({
        id: `clarification:${record.ticketKey}:${answer.ts}`,
        name: 'slack/clarification.answered',
        data: { ticketKey: record.ticketKey, answer: answer.text },
      });
    } catch (error) {
      // One unreadable thread must not stop the rest of the reconciliation.
      logger.warn(
        { ticketKey: record.ticketKey, error },
        'could not reconcile clarification thread; skipping',
      );
    }
  }
}
