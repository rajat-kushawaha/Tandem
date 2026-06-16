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
  readonly tokens: number;
  readonly startedAtMs: number;
}

export interface BudgetVerdict {
  readonly withinBudget: boolean;
  readonly reason: string | null;
}

export function startBudget(now: number = Date.now()): BudgetState {
  return { turns: 0, tokens: 0, startedAtMs: now };
}

export function chargeRun(
  state: BudgetState,
  run: Pick<AgentRunResult, 'numTurns' | 'inputTokens' | 'outputTokens'>,
): BudgetState {
  return {
    turns: state.turns + run.numTurns,
    tokens: state.tokens + run.inputTokens + run.outputTokens,
    startedAtMs: state.startedAtMs,
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
  if (state.tokens > limits.maxTokens) {
    return reject(
      `token budget exceeded (${state.tokens}/${limits.maxTokens})`,
    );
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
