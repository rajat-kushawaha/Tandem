import { describe, expect, it } from 'vitest';
import { addAgentCost } from '../src/orchestrator/cost.js';
import { startBudget, chargeRun } from '../src/orchestrator/budget.js';
import { emptyAgentCost } from '../src/shared/types.js';

/**
 * `addAgentCost` is the absolute (non-additive) dev-cost setter. It must be
 * idempotent: calling it twice with the same baseline + budget yields the same
 * result, so an Inngest step retry that re-runs the dev body cannot double-count.
 */
describe('addAgentCost (absolute dev-cost setter)', () => {
  const baseline = {
    model: 'claude-opus-4-8',
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadInputTokens: 5_000,
    cacheCreationInputTokens: 800,
    costUsd: 1.5,
  };

  const budget = chargeRun(
    startBudget(0),
    {
      numTurns: 3,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 2_000,
      cacheCreationInputTokens: 300,
      totalCostUsd: 0.4,
    },
    'claude-opus-4-8',
  );

  it('sums baseline and budget across all fields', () => {
    const result = addAgentCost(baseline, budget);
    expect(result.inputTokens).toBe(1_100);
    expect(result.outputTokens).toBe(250);
    expect(result.cacheReadInputTokens).toBe(7_000);
    expect(result.cacheCreationInputTokens).toBe(1_100);
    expect(result.costUsd).toBeCloseTo(1.9);
    expect(result.model).toBe('claude-opus-4-8');
  });

  it('is idempotent: same inputs yield the same result (no double-count)', () => {
    const first = addAgentCost(baseline, budget);
    const second = addAgentCost(baseline, budget);
    expect(second).toEqual(first);
  });

  it('carries the baseline model forward when the budget has none', () => {
    const noModelBudget = { ...budget, model: '' };
    expect(addAgentCost(baseline, noModelBudget).model).toBe('claude-opus-4-8');
  });

  it('treats an empty baseline as a clean first invocation', () => {
    const result = addAgentCost(emptyAgentCost(), budget);
    expect(result.inputTokens).toBe(100);
    expect(result.costUsd).toBeCloseTo(0.4);
    expect(result.model).toBe('claude-opus-4-8');
  });
});
