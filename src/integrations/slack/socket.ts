import { SocketModeClient } from '@slack/socket-mode';
import { z } from 'zod';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { inngest } from '../../orchestrator/inngest.js';
import { runStore } from '../../orchestrator/store.js';

/**
 * Slack Socket Mode listener. It needs no public URL: Slack pushes events over
 * an outbound WebSocket. When a human replies in a clarification thread we map
 * the thread back to its ticket and emit `slack/clarification.answered`, which
 * resumes the durably-paused BA workflow.
 */

const messageEventSchema = z.object({
  type: z.literal('message'),
  channel: z.string(),
  text: z.string().default(''),
  thread_ts: z.string().optional(),
  ts: z.string(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
});

async function findTicketByThread(threadTs: string): Promise<string | null> {
  const record = await runStore.getByThreadTs(threadTs);
  return record?.ticketKey ?? null;
}

export function createSlackSocketClient(): SocketModeClient {
  const client = new SocketModeClient({ appToken: config.SLACK_APP_TOKEN });

  client.on(
    'message',
    (args: { event: unknown; ack: () => Promise<void> }): void => {
      void handleMessage(args);
    },
  );

  // Catch-all: in Socket Mode, message events may arrive on the generic
  // `slack_event` channel rather than `message`. Wiring both guarantees we see
  // the reply regardless of how the client surfaces it. Debug-logs the raw type
  // so we can confirm events are arriving at all.
  client.on(
    'slack_event',
    (args: { type?: string; event?: unknown; ack?: () => Promise<void> }) => {
      const inner = (args.event as { type?: string } | undefined)?.type;
      // Logged at INFO (not debug) on purpose: it is the single signal that
      // tells us whether Slack delivers ANY events over the socket. Silence here
      // means a Slack-app config problem (event subscriptions / bot membership),
      // not a code filter.
      logger.info(
        { envelopeType: args.type, innerType: inner },
        'slack_event received over socket',
      );
      if (inner === 'message') {
        void handleMessage({
          event: args.event,
          ack: args.ack ?? (() => Promise.resolve()),
        });
      }
    },
  );

  return client;
}

async function handleMessage(args: {
  event: unknown;
  ack: () => Promise<void>;
}): Promise<void> {
  await args.ack();

  const parsed = messageEventSchema.safeParse(args.event);
  if (!parsed.success) {
    logger.debug(
      { event: args.event, issues: parsed.error.issues },
      'slack message did not match schema; ignoring',
    );
    return;
  }
  const message = parsed.data;

  // Ignore our own posts, edits/deletes, and non-thread messages.
  const isThreadReply =
    message.thread_ts !== undefined && message.thread_ts !== message.ts;
  if (message.bot_id || message.subtype || !isThreadReply) {
    logger.debug(
      {
        bot_id: message.bot_id,
        subtype: message.subtype,
        isThreadReply,
        thread_ts: message.thread_ts,
        ts: message.ts,
      },
      'slack message ignored (bot/edit/non-thread)',
    );
    return;
  }
  if (message.channel !== config.SLACK_CHANNEL_ID) {
    logger.warn(
      { got: message.channel, expected: config.SLACK_CHANNEL_ID },
      'slack reply in a different channel than SLACK_CHANNEL_ID; ignoring',
    );
    return;
  }

  const ticketKey = await findTicketByThread(message.thread_ts as string);
  if (!ticketKey) {
    logger.warn(
      { thread_ts: message.thread_ts },
      'slack reply thread does not map to any ticket; ignoring',
    );
    return;
  }

  logger.info(
    { ticketKey },
    'received clarification answer; resuming workflow',
  );
  // The id makes the send idempotent: the client surfaces the same envelope on
  // both the `message` and `slack_event` channels, and the startup reconciler
  // may re-read the same reply — Inngest keeps only the first.
  await inngest.send({
    id: `clarification:${ticketKey}:${message.ts}`,
    name: 'slack/clarification.answered',
    data: { ticketKey, answer: message.text },
  });
}
