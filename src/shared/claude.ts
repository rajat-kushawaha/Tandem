import {
  query,
  type Options,
  type SDKMessage,
  type McpServerConfig,
  type HookCallbackMatcher,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';
import { config } from './config.js';
import { logger } from './logger.js';
import type { AgentRole } from './types.js';

/**
 * Factory for Agent SDK runs. Centralises auth, per-agent model selection, the
 * tool allowlist, and the per-ticket turn budget so individual agents only
 * describe *what* they need, never *how* to authenticate.
 */

export interface AgentRunRequest {
  readonly role: AgentRole;
  readonly model: string;
  /** Explicit allowlist — an agent can only use tools named here. */
  readonly allowedTools: readonly string[];
  /**
   * Our domain-specific instructions. By default these are *appended* to Claude
   * Code's built-in system prompt (see `usePresetSystemPrompt`), not used as a
   * replacement — the built-in preset is what gives the agent its coding
   * conventions, tool-use discipline, and verification habits. Passing a bare
   * string here without the preset (the SDK's default) discards all of that.
   */
  readonly systemPrompt: string;
  /**
   * When true (the default), `systemPrompt` is appended on top of Claude Code's
   * built-in `claude_code` preset. Set false only for an agent that genuinely
   * needs a from-scratch prompt with none of the coding defaults.
   */
  readonly usePresetSystemPrompt?: boolean;
  readonly prompt: string;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly hooks?: Options['hooks'];
  readonly cwd?: string;
  readonly maxTurns?: number;
  readonly permissionMode?: Options['permissionMode'];
  /** Extra fields bound to the per-run logger (e.g. ticketKey, repo). */
  readonly logContext?: Record<string, string>;
}

export interface AgentRunResult {
  readonly text: string;
  readonly isError: boolean;
  readonly numTurns: number;
  /**
   * The SDK's own billed cost for the run, summed across every model used
   * (a Dev session may fan out to subagents on a second model). This is the
   * source of truth for cost and already accounts for cached tokens — under
   * subscription/OAuth auth it has been observed non-zero and accurate.
   */
  readonly totalCostUsd: number;
  /**
   * NON-cached input tokens only (the API `usage.input_tokens` slice). This is
   * what the per-ticket budget ceiling is checked against, kept consistent with
   * its historical meaning. For a full picture of input cost, add the cache
   * fields below.
   */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from the prompt cache (billed at a discount). */
  readonly cacheReadInputTokens: number;
  /** Input tokens written to the prompt cache (billed at a premium). */
  readonly cacheCreationInputTokens: number;
  /**
   * Names of every tool the agent invoked during THIS run, in call order.
   * Scoped to the single run (unlike durable store state, which survives
   * retries), so callers can reliably tell what the agent actually did this
   * time — e.g. whether it asked for clarification.
   */
  readonly toolCalls: readonly string[];
  /**
   * Every assistant text block emitted across the run, concatenated in order.
   * Unlike `text` (only the FINAL result message), this preserves output the
   * agent produced mid-run — e.g. a checklist JSON block printed before a last
   * tool call. Callers that extract structured output should parse this, not
   * just `text`, so a trailing tool call doesn't drop the payload.
   */
  readonly transcript: string;
}

/**
 * The SDK reads `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` from the
 * environment directly. We surface the resolved env here so every run is
 * explicit about which credential it forwards and nothing leaks beyond it.
 */
function authEnv(): Record<string, string> {
  if (config.CLAUDE_CODE_OAUTH_TOKEN) {
    return { CLAUDE_CODE_OAUTH_TOKEN: config.CLAUDE_CODE_OAUTH_TOKEN };
  }
  if (config.ANTHROPIC_API_KEY) {
    return { ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY };
  }
  // Unreachable: config validation guarantees exactly one credential.
  throw new Error('No Claude credential configured.');
}

export async function runAgent(
  request: AgentRunRequest,
): Promise<AgentRunResult> {
  const usePreset = request.usePresetSystemPrompt ?? true;
  const options: Options = {
    model: request.model,
    allowedTools: [...request.allowedTools],
    // Build on Claude Code's built-in system prompt (the source of its code
    // quality) and append our domain rules, rather than replacing it with a bare
    // string. A string `systemPrompt` would discard the preset entirely.
    systemPrompt: usePreset
      ? { type: 'preset', preset: 'claude_code', append: request.systemPrompt }
      : request.systemPrompt,
    maxTurns: request.maxTurns ?? config.MAX_TURNS_PER_RUN,
    permissionMode: request.permissionMode ?? 'default',
    // Load the target repo's project settings so the agent reads its CLAUDE.md
    // (build commands, conventions) the way Claude Code does. `cwd` is the
    // sandbox checkout, so this loads the TARGET repo's settings, not this
    // orchestrator's. The `allowedTools` allowlist still gates what can run.
    settingSources: ['project'],
    env: { ...process.env, ...authEnv() },
    ...(request.mcpServers ? { mcpServers: request.mcpServers } : {}),
    ...(request.hooks ? { hooks: request.hooks } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
  };

  const log = logger.child({ agent: request.role, ...request.logContext });

  const toolCalls: string[] = [];
  const textBlocks: string[] = [];
  let result: Omit<AgentRunResult, 'toolCalls' | 'transcript'> | null = null;
  for await (const message of query({ prompt: request.prompt, options })) {
    logProgress(log, message);
    collectAssistantContent(message, toolCalls, textBlocks);
    result = reduceResult(message) ?? result;
  }

  if (!result) {
    throw new Error(
      `Agent run for role "${request.role}" produced no result message.`,
    );
  }
  return { ...result, toolCalls, transcript: textBlocks.join('\n\n') };
}

/**
 * Accumulates, across the stream, the names of every tool the agent invoked and
 * every non-empty assistant text block — so callers can see the full transcript,
 * not just the final result message.
 */
function collectAssistantContent(
  message: SDKMessage,
  toolCalls: string[],
  textBlocks: string[],
): void {
  if (message.type !== 'assistant') {
    return;
  }
  const apiMessage = message.message as { content?: unknown };
  const blocks = (
    Array.isArray(apiMessage.content) ? apiMessage.content : []
  ) as ContentBlock[];
  for (const block of blocks) {
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolCalls.push(block.name);
    } else if (
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim() !== ''
    ) {
      textBlocks.push(block.text);
    }
  }
}

/**
 * Logs the agent's live activity — each tool call and message — so a long run
 * (cloning, editing, `npm ci`, build, test) is visible instead of silent. Tool
 * calls are the most useful signal; tool *output* is left at debug to avoid
 * flooding the logs.
 */
interface ContentBlock {
  readonly type?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly text?: string;
}

function logProgress(log: Logger, message: SDKMessage): void {
  if (message.type === 'system' && message.subtype === 'init') {
    log.info({ model: message.model }, 'agent session started');
    return;
  }
  if (message.type !== 'assistant') {
    return;
  }
  const apiMessage = message.message as { content?: unknown };
  const blocks = (
    Array.isArray(apiMessage.content) ? apiMessage.content : []
  ) as ContentBlock[];

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      log.info(
        { tool: block.name ?? 'tool', input: summarizeToolInput(block.input) },
        'tool call',
      );
    } else if (
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim() !== ''
    ) {
      log.info({ text: truncate(block.text, 200) }, 'agent message');
    }
  }
}

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const key =
      obj['command'] ?? obj['file_path'] ?? obj['path'] ?? obj['pattern'];
    if (typeof key === 'string') {
      return truncate(key, 160);
    }
  }
  return truncate(JSON.stringify(input), 160);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One model's slice of a run's usage, from the SDK's `modelUsage` map. */
interface ModelUsageEntry {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

function reduceResult(
  message: SDKMessage,
): Omit<AgentRunResult, 'toolCalls' | 'transcript'> | null {
  if (message.type !== 'result') {
    return null;
  }
  // Sum `modelUsage` across every model the run touched (a Dev session can fan
  // out to subagents on a second model), so the token breakdown reconciles with
  // the billed cost. `total_cost_usd` is the SDK's authoritative figure and
  // already accounts for cached tokens — prefer it over a token-derived estimate.
  const modelUsage = (message as { modelUsage?: Record<string, ModelUsageEntry> })
    .modelUsage;
  const tokens = sumModelUsage(modelUsage);
  return {
    text: message.subtype === 'success' ? message.result : '',
    isError: message.is_error,
    numTurns: message.num_turns,
    totalCostUsd: message.total_cost_usd,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadInputTokens: tokens.cacheReadInputTokens,
    cacheCreationInputTokens: tokens.cacheCreationInputTokens,
  };
}

/**
 * Sums every model entry's token counts. Falls back to the top-level `usage`
 * only if `modelUsage` is absent (older SDK). The non-cache input/output counts
 * here are what feed the budget ceiling, kept consistent with their historical
 * meaning; cache counts are reporting-only.
 */
function sumModelUsage(
  modelUsage: Record<string, ModelUsageEntry> | undefined,
): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
} {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const entry of Object.values(modelUsage ?? {})) {
    total.inputTokens += entry.inputTokens ?? 0;
    total.outputTokens += entry.outputTokens ?? 0;
    total.cacheReadInputTokens += entry.cacheReadInputTokens ?? 0;
    total.cacheCreationInputTokens += entry.cacheCreationInputTokens ?? 0;
  }
  return total;
}

export type { HookCallbackMatcher, McpServerConfig };
