import type { AgentRunResult } from '../shared/claude.js';

/**
 * Per-ticket spend guard. A confused agent must never loop forever or burn the
 * shared spend pool, so every agent run is charged against turn, token, and
 * wall-clock ceilings. When any ceiling is exceeded the ticket is escalated to
 * BLOCKED rather than retried.
 */

export interface BudgetLimits {
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly maxWallClockMs: number;
}

export interface BudgetState {
  readonly turns: number;
  /** Non-cached input tokens. The token ceiling is checked against these + output. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cache-read input tokens — accumulated for reporting, NOT counted toward the ceiling. */
  readonly cacheReadInputTokens: number;
  /** Cache-creation input tokens — accumulated for reporting, NOT counted toward the ceiling. */
  readonly cacheCreationInputTokens: number;
  readonly startedAtMs: number;
  /** Accumulated USD cost for this ticket's agent runs. */
  readonly costUsd: number;
  /** The model charged against this budget (for reporting). */
  readonly model: string;
}

/**
 * Non-cache input + output tokens — the figure the token ceiling is checked
 * against. Deliberately excludes cache tokens so a caching-heavy ticket is not
 * blocked early; cache usage is reporting-only.
 */
export function totalTokens(state: BudgetState): number {
  return state.inputTokens + state.outputTokens;
}

export interface BudgetVerdict {
  readonly withinBudget: boolean;
  readonly reason: string | null;
}

/**
 * Per-model token pricing (USD per million tokens, as of 2025-06).
 * Used as a fallback when the SDK reports totalCostUsd = 0, which happens
 * under OAuth/subscription auth where the SDK does not meter cost directly.
 */
const PRICE_PER_M: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
};

const SONNET_PRICE = { input: 3, output: 15 };

/** Estimate cost from token counts when the SDK does not report it directly. */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICE_PER_M[model] ?? SONNET_PRICE;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export function startBudget(now: number = Date.now()): BudgetState {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    startedAtMs: now,
    model: '',
  };
}

export function chargeRun(
  state: BudgetState,
  run: Pick<
    AgentRunResult,
    | 'numTurns'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadInputTokens'
    | 'cacheCreationInputTokens'
    | 'totalCostUsd'
  >,
  model?: string,
): BudgetState {
  // The SDK's totalCostUsd is authoritative (accounts for cache); fall back to a
  // token-based estimate only if it is 0.
  const runCost =
    run.totalCostUsd > 0
      ? run.totalCostUsd
      : estimateCostUsd(
          model ?? 'claude-sonnet-4-6',
          run.inputTokens,
          run.outputTokens,
        );
  return {
    turns: state.turns + run.numTurns,
    inputTokens: state.inputTokens + run.inputTokens,
    outputTokens: state.outputTokens + run.outputTokens,
    cacheReadInputTokens:
      state.cacheReadInputTokens + (run.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      state.cacheCreationInputTokens + (run.cacheCreationInputTokens ?? 0),
    costUsd: state.costUsd + runCost,
    startedAtMs: state.startedAtMs,
    model: model ?? state.model,
  };
}

export function checkBudget(
  state: BudgetState,
  limits: BudgetLimits,
  now: number = Date.now(),
): BudgetVerdict {
  if (state.turns > limits.maxTurns) {
    return reject(`turn budget exceeded (${state.turns}/${limits.maxTurns})`);
  }
  const tokens = totalTokens(state);
  if (tokens > limits.maxTokens) {
    return reject(`token budget exceeded (${tokens}/${limits.maxTokens})`);
  }
  const elapsed = now - state.startedAtMs;
  if (elapsed > limits.maxWallClockMs) {
    return reject(
      `time budget exceeded (${elapsed}ms/${limits.maxWallClockMs}ms)`,
    );
  }
  return { withinBudget: true, reason: null };
}

function reject(reason: string): BudgetVerdict {
  return { withinBudget: false, reason };
}
