import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '../../shared/claude.js';
import type { RunStore } from '../../orchestrator/run-store.js';
import type { Ticket } from '../../shared/types.js';
import { loadOrCreate } from '../../orchestrator/run-store.js';
import { postClarification } from '../../integrations/slack/client.js';

/**
 * Builds the BA agent's `ask_clarification` tool, bound to one ticket.
 *
 * Calling it posts the questions to Slack and records the thread on the ticket,
 * then returns an instruction for the agent to STOP and wait. The durable pause
 * itself lives in the Inngest workflow (`step.waitForEvent`); this tool just
 * opens the thread the human will reply in.
 *
 * The post is idempotent: if a thread already exists for this ticket the tool
 * reuses it, so a workflow retry never spams the channel with duplicates.
 */
export function buildAskClarificationServer(deps: {
  readonly ticket: Ticket;
  readonly store: RunStore;
}): McpServerConfig {
  const askClarification = tool(
    'ask_clarification',
    'Post clarifying questions for this ticket to the team Slack channel, then ' +
      'stop and wait for a human reply. Use only for genuinely blocking gaps, ' +
      'and batch all questions into a single call.',
    { questions: z.array(z.string().min(1)).min(1).max(8) },
    async ({ questions }) => {
      const record = await loadOrCreate(deps.store, deps.ticket.key);

      const threadTs =
        record.slackThreadTs ??
        (await postClarification({
          ticketKey: deps.ticket.key,
          ticketUrl: deps.ticket.url,
          questions,
        }));

      if (!record.slackThreadTs) {
        await deps.store.save({
          ...record,
          slackThreadTs: threadTs,
          updatedAt: new Date().toISOString(),
        });
      }

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Posted ${questions.length} question(s) to Slack (thread ${threadTs}). ` +
              'Stop now and end your turn — the orchestrator will resume you ' +
              'with the human answer.',
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: 'slack',
    version: '1.0.0',
    tools: [askClarification],
  });
}
