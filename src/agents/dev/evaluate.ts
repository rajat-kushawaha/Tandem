import { evaluateChecklist, type Checklist } from './checklist.js';
import type { GateResult } from './gates.js';

/**
 * Decides whether a dev attempt is shippable. An attempt succeeds only when the
 * independently-run gates are all green AND every acceptance criterion is mapped
 * to a satisfied test. Anything else returns concrete problems that are fed back
 * into the next attempt — and, once attempts are exhausted, into the escalation.
 *
 * This is what stops the agent shipping a story it didn't finish: success is
 * computed here from objective signals, never from the agent's own say-so.
 *
 * Baseline awareness: a gate that was ALREADY failing on the clean base branch
 * (passed in `baselineFailures`) is a pre-existing problem, not something this
 * change introduced — the agent can't be asked to fix unrelated red it didn't
 * cause, and the shell guard would block much of it anyway. Such gates are
 * surfaced as warnings but do NOT block the attempt. A gate that was green on
 * base and is now red IS a regression and blocks. `install`/`build` are never
 * waivable (see gates.ts) so they always block.
 */

export interface AttemptVerdict {
  readonly shippable: boolean;
  readonly problems: readonly string[];
  /** Pre-existing gate failures, reported for visibility, not blocking. */
  readonly preExisting: readonly string[];
}

export function evaluateAttempt(
  ticketCriteria: readonly string[],
  checklist: Checklist | null,
  gateResults: readonly GateResult[],
  baselineFailures: ReadonlySet<string> = new Set(),
): AttemptVerdict {
  const problems: string[] = [];
  const preExisting: string[] = [];

  if (gateResults.length === 0) {
    problems.push('No gates ran.');
  }
  for (const result of gateResults) {
    if (result.passed) {
      continue;
    }
    if (baselineFailures.has(result.name)) {
      // Already red on base — not this change's fault. Note it, don't block.
      preExisting.push(result.name);
      continue;
    }
    const detail = tail(result.output, 1200);
    problems.push(
      detail
        ? `Gate failed: ${result.name}:\n${detail}`
        : `Gate failed: ${result.name}.`,
    );
  }

  if (!checklist) {
    problems.push('Agent produced no acceptance-criteria checklist.');
  } else {
    problems.push(...evaluateChecklist(ticketCriteria, checklist).problems);
  }

  return { shippable: problems.length === 0, problems, preExisting };
}

/** Keeps the most recent (and most relevant) tail of a gate's output. */
function tail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `…${trimmed.slice(-maxChars)}` : trimmed;
}
