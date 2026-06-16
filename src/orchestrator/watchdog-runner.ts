import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { inngest } from './inngest.js';
import { runStore } from './store.js';
import { postChannelMessage } from '../integrations/slack/client.js';
import { decideRecoveryActions } from './watchdog.js';

/**
 * Executes the watchdog's recovery decisions: re-triggers the stalled
 * ticket's workflow and tells the team on Slack. The decision logic itself is
 * pure and lives in watchdog.ts.
 */

/** Action ids already handled by THIS process, so each fires once, not per poll. */
const handled = new Set<string>();

export async function runWatchdogOnce(): Promise<void> {
  const records = await runStore.list();
  const actions = decideRecoveryActions(records, config.WATCHDOG_STALE_MS);

  for (const action of actions) {
    if (handled.has(action.id)) {
      continue;
    }
    handled.add(action.id);

    logger.warn(
      {
        ticketKey: action.ticketKey,
        event: action.event,
        reason: action.reason,
      },
      'watchdog: re-triggering stalled ticket',
    );
    await inngest.send({
      id: action.id,
      name: action.event,
      data: { ticketKey: action.ticketKey },
    });

    // Visibility is best-effort: a Slack hiccup must not stop the healing.
    try {
      await postChannelMessage(
        `:adhesive_bandage: *${action.ticketKey}* looked stalled (${action.reason}) — its workflow was re-triggered automatically.`,
      );
    } catch (error) {
      logger.warn({ error }, 'watchdog: could not post Slack notice');
    }
  }
}
