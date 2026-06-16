import { describe, expect, it } from 'vitest';
import {
  chargeRun,
  checkBudget,
  startBudget,
  type BudgetLimits,
} from '../src/orchestrator/budget.js';

const limits: BudgetLimits = {
  maxTurns: 10,
  maxTokens: 1_000,
  maxWallClockMs: 60_000,
};

describe('per-ticket budget', () => {
  it('accumulates turns and tokens across runs', () => {
    let state = startBudget(0);
    state = chargeRun(state, {
      numTurns: 3,
      inputTokens: 100,
      outputTokens: 50,
    });
    state = chargeRun(state, {
      numTurns: 2,
      inputTokens: 80,
      outputTokens: 20,
    });
    expect(state.turns).toBe(5);
    expect(state.tokens).toBe(250);
  });

  it('stays within budget below all ceilings', () => {
    const state = chargeRun(startBudget(0), {
      numTurns: 5,
      inputTokens: 400,
      outputTokens: 100,
    });
    expect(checkBudget(state, limits, 1_000).withinBudget).toBe(true);
  });

  it('rejects when the turn ceiling is exceeded', () => {
    const state = chargeRun(startBudget(0), {
      numTurns: 11,
      inputTokens: 0,
      outputTokens: 0,
    });
    const verdict = checkBudget(state, limits, 0);
    expect(verdict.withinBudget).toBe(false);
    expect(verdict.reason).toMatch(/turn budget/);
  });

  it('rejects when the token ceiling is exceeded', () => {
    const state = chargeRun(startBudget(0), {
      numTurns: 1,
      inputTokens: 900,
      outputTokens: 200,
    });
    expect(checkBudget(state, limits, 0).reason).toMatch(/token budget/);
  });

  it('rejects when the wall-clock ceiling is exceeded', () => {
    const state = startBudget(0);
    expect(checkBudget(state, limits, 60_001).reason).toMatch(/time budget/);
  });
});
