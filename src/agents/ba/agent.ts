import { runAgent, type McpServerConfig } from '../../shared/claude.js';
import { config } from '../../shared/config.js';
import type { Ticket } from '../../shared/types.js';
import type { RunStore } from '../../orchestrator/run-store.js';
import { atlassianMcpServer } from '../../integrations/jira/mcp.js';
import { buildAskClarificationServer } from './ask-clarification-tool.js';
import { BA_SYSTEM_PROMPT, analyzePrompt, refinePrompt } from './prompts.js';
import { parseRefinedTicket, type RefinedTicket } from './refined-ticket.js';
import { estimateCostUsd } from '../../orchestrator/budget.js';
import type { AgentRunResult } from '../../shared/claude.js';

/** Per-run usage extracted from an agent result, for cost accounting. */
export interface AgentRunUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly costUsd: number;
}

/**
 * Builds usage from a run result. The SDK's `totalCostUsd` is the source of
 * truth (it accounts for cached tokens); the token-based estimate is only a
 * fallback for the rare case the SDK reports 0.
 */
function usageOf(model: string, result: AgentRunResult): AgentRunUsage {
  return {
    model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
    cacheCreationInputTokens: result.cacheCreationInputTokens,
    costUsd:
      result.totalCostUsd > 0
        ? result.totalCostUsd
        : estimateCostUsd(model, result.inputTokens, result.outputTokens),
  };
}

/**
 * The BA agent has Jira (read, via the Atlassian MCP), Slack (the
 * ask_clarification tool), and READ-ONLY access to the repo checkouts
 * (Read/Glob/Grep) so it answers technical questions from the code instead of
 * asking the team. Still no shell, no git, no writes.
 */
const BA_ALLOWED_TOOLS = [
  'mcp__atlassian',
  'mcp__slack__ask_clarification',
  'Read',
  'Glob',
  'Grep',
];

export interface AnalysisResult {
  /** The agent asked the team blocking questions and is now waiting. */
  readonly askedClarification: boolean;
  /** A finished refinement, when the agent had enough to proceed immediately. */
  readonly draft: RefinedTicket | null;
  /** Tokens, model, and cost of this analysis run. */
  readonly usage: AgentRunUsage;
}

export interface RefineResult {
  readonly refined: RefinedTicket;
  /** Tokens, model, and cost of this refine run. */
  readonly usage: AgentRunUsage;
}

function baMcpServers(
  ticket: Ticket,
  store: RunStore,
): Record<string, McpServerConfig> {
  return {
    atlassian: atlassianMcpServer(),
    slack: buildAskClarificationServer({ ticket, store }),
  };
}

/** The clarification tool, as the SDK names it (mcp__<server>__<tool>). */
const ASK_CLARIFICATION_TOOL = 'mcp__slack__ask_clarification';

/**
 * Phase 1: analyse the ticket. The agent either posts clarifying questions or
 * returns a finished refinement immediately.
 *
 * Whether it asked is read from THIS run's tool calls, not from store state: a
 * prior attempt may already have written the Slack thread to the record, so a
 * workflow retry that re-runs analysis must still classify itself by what the
 * agent did this time — otherwise a clarification turn is mistaken for a
 * refinement and the workflow blocks spuriously.
 */
export async function analyzeTicket(
  ticket: Ticket,
  store: RunStore,
  /** Directory containing one read-only repo checkout per configured repo. */
  checkoutRoot: string,
  repoDirs: readonly string[],
): Promise<AnalysisResult> {
  const result = await runAgent({
    role: 'ba',
    model: config.BA_MODEL,
    allowedTools: BA_ALLOWED_TOOLS,
    systemPrompt: BA_SYSTEM_PROMPT,
    prompt: analyzePrompt(ticket, repoDirs),
    mcpServers: baMcpServers(ticket, store),
    cwd: checkoutRoot,
    logContext: { ticketKey: ticket.key },
  });

  const askedClarification = result.toolCalls.includes(ASK_CLARIFICATION_TOOL);

  return {
    askedClarification,
    draft: askedClarification
      ? null
      : (parseRefinedTicket(result.transcript) ??
        parseRefinedTicket(result.text)),
    usage: usageOf(config.BA_MODEL, result),
  };
}

/**
 * Phase 2: refine the ticket using the human's answers. Throws if the agent
 * fails to produce a valid refinement, so the workflow can escalate rather than
 * write a half-baked ticket.
 */
export async function refineTicket(
  ticket: Ticket,
  answers: string,
  store: RunStore,
  /** Directory containing one read-only repo checkout per configured repo. */
  checkoutRoot: string,
  repoDirs: readonly string[],
): Promise<RefineResult> {
  const result = await runAgent({
    role: 'ba',
    model: config.BA_MODEL,
    allowedTools: BA_ALLOWED_TOOLS,
    systemPrompt: BA_SYSTEM_PROMPT,
    prompt: refinePrompt(ticket, answers, repoDirs),
    mcpServers: baMcpServers(ticket, store),
    cwd: checkoutRoot,
    logContext: { ticketKey: ticket.key },
  });

  const refined =
    parseRefinedTicket(result.transcript) ?? parseRefinedTicket(result.text);
  if (!refined) {
    throw new Error(
      `BA agent did not produce a valid refined ticket for ${ticket.key}.`,
    );
  }
  return { refined, usage: usageOf(config.BA_MODEL, result) };
}
