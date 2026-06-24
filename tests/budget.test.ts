import { describe, expect, it } from 'vitest';
import {
  chargeRun,
  checkBudget,
  startBudget,
  totalTokens,
  type BudgetLimits,
} from '../src/orchestrator/budget.js';

const limits: BudgetLimits = {
  maxTurns: 10,
  maxTokens: 1_000,
  maxWallClockMs: 60_000,
};

/** A run-result shape for chargeRun, with cache token defaults filled in. */
function run(fields: {
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}) {
  return {
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    ...fields,
  };
}

describe('per-ticket budget', () => {
  it('accumulates turns and tokens across runs', () => {
    let state = startBudget(0);
    state = chargeRun(
      state,
      run({ numTurns: 3, inputTokens: 100, outputTokens: 50, totalCostUsd: 0 }),
    );
    state = chargeRun(
      state,
      run({ numTurns: 2, inputTokens: 80, outputTokens: 20, totalCostUsd: 0 }),
    );
    expect(state.turns).toBe(5);
    expect(state.inputTokens).toBe(180);
    expect(state.outputTokens).toBe(70);
    expect(totalTokens(state)).toBe(250);
  });

  it('accumulates cache tokens for reporting without counting them in the ceiling', () => {
    const state = chargeRun(
      startBudget(0),
      run({
        numTurns: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 5_000,
        cacheCreationInputTokens: 2_000,
        totalCostUsd: 0,
      }),
    );
    expect(state.cacheReadInputTokens).toBe(5_000);
    expect(state.cacheCreationInputTokens).toBe(2_000);
    // The ceiling figure excludes cache tokens.
    expect(totalTokens(state)).toBe(150);
  });

  it('accumulates cost from totalCostUsd when non-zero', () => {
    let state = startBudget(0);
    state = chargeRun(
      state,
      run({ numTurns: 1, inputTokens: 100, outputTokens: 50, totalCostUsd: 0.05 }),
    );
    state = chargeRun(
      state,
      run({ numTurns: 1, inputTokens: 80, outputTokens: 20, totalCostUsd: 0.03 }),
    );
    expect(state.costUsd).toBeCloseTo(0.08);
  });

  it('estimates cost from tokens when totalCostUsd is zero', () => {
    const state = chargeRun(
      startBudget(0),
      run({
        numTurns: 1,
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalCostUsd: 0,
      }),
      'claude-sonnet-4-6',
    );
    expect(state.costUsd).toBeCloseTo(3.0); // $3 per M input tokens for Sonnet
  });

  it('stays within budget below all ceilings', () => {
    const state = chargeRun(
      startBudget(0),
      run({ numTurns: 5, inputTokens: 400, outputTokens: 100, totalCostUsd: 0 }),
    );
    expect(checkBudget(state, limits, 1_000).withinBudget).toBe(true);
  });

  it('rejects when the turn ceiling is exceeded', () => {
    const state = chargeRun(
      startBudget(0),
      run({ numTurns: 11, inputTokens: 0, outputTokens: 0, totalCostUsd: 0 }),
    );
    const verdict = checkBudget(state, limits, 0);
    expect(verdict.withinBudget).toBe(false);
    expect(verdict.reason).toMatch(/turn budget/);
  });

  it('rejects when the token ceiling is exceeded', () => {
    const state = chargeRun(
      startBudget(0),
      run({ numTurns: 1, inputTokens: 900, outputTokens: 200, totalCostUsd: 0 }),
    );
    expect(checkBudget(state, limits, 0).reason).toMatch(/token budget/);
  });

  it('rejects when the wall-clock ceiling is exceeded', () => {
    const state = startBudget(0);
    expect(checkBudget(state, limits, 60_001).reason).toMatch(/time budget/);
  });
});
