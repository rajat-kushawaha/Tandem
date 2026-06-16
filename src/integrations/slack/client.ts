import { WebClient } from '@slack/web-api';
import { config } from '../../shared/config.js';
import {
  formatClarificationMessage,
  type ClarificationRequest,
} from './messages.js';

/**
 * Slack Web API client for posting the BA agent's clarification questions. The
 * returned message timestamp doubles as the thread id: the workflow records it
 * on the ticket so a threaded reply can later be routed back to the ticket.
 */
const web = new WebClient(config.SLACK_BOT_TOKEN);

export async function postClarification(
  request: ClarificationRequest,
): Promise<string> {
  const result = await web.chat.postMessage({
    channel: config.SLACK_CHANNEL_ID,
    text: formatClarificationMessage(request),
  });
  if (!result.ok || !result.ts) {
    throw new Error(
      `Slack rejected the clarification post: ${result.error ?? 'unknown error'}.`,
    );
  }
  return result.ts;
}

export async function postChannelMessage(text: string): Promise<void> {
  const result = await web.chat.postMessage({
    channel: config.SLACK_CHANNEL_ID,
    text,
  });
  if (!result.ok) {
    throw new Error(`Slack rejected the message: ${result.error}.`);
  }
}

export async function postThreadReply(
  threadTs: string,
  text: string,
): Promise<void> {
  const result = await web.chat.postMessage({
    channel: config.SLACK_CHANNEL_ID,
    thread_ts: threadTs,
    text,
  });
  if (!result.ok) {
    throw new Error(`Slack rejected the thread reply: ${result.error}.`);
  }
}

export interface ThreadReply {
  readonly ts: string;
  readonly text: string;
  readonly isBot: boolean;
}

/**
 * Reads the replies in a clarification thread (the parent message excluded).
 * Socket Mode only delivers live messages, so this is how answers posted while
 * the orchestrator was down are recovered on startup.
 */
export async function fetchThreadReplies(
  threadTs: string,
): Promise<ThreadReply[]> {
  const result = await web.conversations.replies({
    channel: config.SLACK_CHANNEL_ID,
    ts: threadTs,
  });
  if (!result.ok) {
    throw new Error(`Slack rejected the thread read: ${result.error}.`);
  }
  return (result.messages ?? [])
    .filter((message) => message.ts !== threadTs)
    .map((message) => ({
      ts: message.ts ?? '',
      text: message.text ?? '',
      isBot: Boolean(message.bot_id),
    }));
}
