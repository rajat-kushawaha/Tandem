import {
  totalCostUsd,
  totalInputTokens,
  type AgentCost,
  type RunRecord,
} from '../shared/types.js';
import type { BudgetState } from './budget.js';

/**
 * Cost helpers for per-ticket AI usage: the absolute accumulator and the
 * formatters shared by the workflows that post cost back to Jira and by the CLI
 * report. Pure (no Inngest/config imports) so it is unit-testable in isolation.
 * Reviewer cost is never included here — the reviewer runs in CI, a separate
 * process whose usage is not reported back.
 *
 * Token counts are raw counts (not thousands or millions). "Input" is the TOTAL
 * input — non-cached plus cache read plus cache creation — which is what
 * reconciles with the billed cost; the cache split is shown separately because
 * the non-cached slice alone looks misleadingly small next to the cost.
 */

/**
 * Combines the dev cost from PRIOR invocations (`baseline`) with this
 * invocation's running `budget`, producing an ABSOLUTE value. Absolute (not
 * additive) so it is idempotent: calling it repeatedly during a run to update
 * the report live, or on an Inngest step retry that re-runs the dev body, always
 * lands the same total instead of double-counting. The model carries forward
 * from the baseline when this run hasn't set one yet.
 */
export function addAgentCost(
  baseline: AgentCost,
  budget: BudgetState,
): AgentCost {
  return {
    model: budget.model || baseline.model,
    inputTokens: baseline.inputTokens + budget.inputTokens,
    outputTokens: baseline.outputTokens + budget.outputTokens,
    cacheReadInputTokens:
      baseline.cacheReadInputTokens + budget.cacheReadInputTokens,
    cacheCreationInputTokens:
      baseline.cacheCreationInputTokens + budget.cacheCreationInputTokens,
    costUsd: baseline.costUsd + budget.costUsd,
  };
}

function agentLine(label: string, cost: AgentCost): string {
  const model = cost.model || 'n/a';
  const inAll = totalInputTokens(cost).toLocaleString();
  const cacheRead = cost.cacheReadInputTokens.toLocaleString();
  const cacheWrite = cost.cacheCreationInputTokens.toLocaleString();
  return (
    `${label}: $${cost.costUsd.toFixed(4)} ` +
    `(${model}, in ${inAll} [cache read ${cacheRead}, write ${cacheWrite}] / ` +
    `out ${cost.outputTokens.toLocaleString()} tokens)`
  );
}

/** A multi-line Jira comment body summarising the ticket's AI cost. */
export function costComment(record: RunRecord): string {
  return [
    '*AI cost for this ticket* _(reviewer runs in CI, not metered here)_',
    `- ${agentLine('BA', record.ba)}`,
    `- ${agentLine('Dev', record.dev)}`,
    `- *Total: $${totalCostUsd(record).toFixed(4)}*`,
  ].join('\n');
}
