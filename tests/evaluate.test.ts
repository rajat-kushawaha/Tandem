import { describe, expect, it } from 'vitest';
import {
  evaluateAttempt,
  shouldEscalateNoDiff,
} from '../src/agents/dev/evaluate.js';
import {
  checklistSchema,
  type Checklist,
} from '../src/agents/dev/checklist.js';
import type { GateResult } from '../src/agents/dev/gates.js';

const criteria = ['User can reset password'];

const goodChecklist: Checklist = checklistSchema.parse({
  items: [
    {
      criterion: 'User can reset password',
      testReference: 'AuthTest#resetsPassword',
      satisfied: true,
    },
  ],
  affectedRepos: ['backend'],
});

const greenGates: GateResult[] = [
  { name: 'build', passed: true, output: '' },
  { name: 'test', passed: true, output: '' },
];

describe('evaluateAttempt', () => {
  it('is shippable when gates are green and the checklist is complete', () => {
    const verdict = evaluateAttempt(criteria, goodChecklist, greenGates);
    expect(verdict.shippable).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  it('is not shippable when a gate fails, and surfaces the gate output', () => {
    const redGates: GateResult[] = [
      { name: 'test', passed: false, output: 'AssertionError: expected 1' },
    ];
    const verdict = evaluateAttempt(criteria, goodChecklist, redGates);
    expect(verdict.shippable).toBe(false);
    expect(
      verdict.problems.some((p) => p.startsWith('Gate failed: test')),
    ).toBe(true);
    expect(verdict.problems.some((p) => p.includes('AssertionError'))).toBe(
      true,
    );
  });

  it('is not shippable when the agent produced no checklist', () => {
    const verdict = evaluateAttempt(criteria, null, greenGates);
    expect(verdict.shippable).toBe(false);
    expect(verdict.problems[0]).toMatch(/no acceptance-criteria checklist/);
  });

  it('is not shippable when a criterion is unsatisfied even if gates pass', () => {
    const incomplete = checklistSchema.parse({
      items: [
        {
          criterion: 'User can reset password',
          testReference: 'AuthTest#resetsPassword',
          satisfied: false,
        },
      ],
      affectedRepos: ['backend'],
    });
    const verdict = evaluateAttempt(criteria, incomplete, greenGates);
    expect(verdict.shippable).toBe(false);
    expect(verdict.problems.some((p) => /not yet satisfied/.test(p))).toBe(
      true,
    );
  });

  it('does NOT block on a gate that was already failing on the base branch', () => {
    const redLint: GateResult[] = [
      { name: 'lint', passed: false, output: 'pre-existing error in main.tsx' },
      { name: 'build', passed: true, output: '' },
      { name: 'test', passed: true, output: '' },
    ];
    // lint was red on the base checkout — waived.
    const verdict = evaluateAttempt(
      criteria,
      goodChecklist,
      redLint,
      new Set(['lint']),
    );
    expect(verdict.shippable).toBe(true);
    expect(verdict.problems).toEqual([]);
    expect(verdict.preExisting).toEqual(['lint']);
  });

  it('still blocks on a NEW gate failure even when another is pre-existing', () => {
    const gates: GateResult[] = [
      { name: 'lint', passed: false, output: 'pre-existing' }, // waived
      { name: 'test', passed: false, output: 'AssertionError: regression' }, // new
    ];
    const verdict = evaluateAttempt(
      criteria,
      goodChecklist,
      gates,
      new Set(['lint']),
    );
    expect(verdict.shippable).toBe(false);
    expect(verdict.problems.some((p) => p.startsWith('Gate failed: test'))).toBe(
      true,
    );
    expect(verdict.preExisting).toEqual(['lint']);
  });
});

describe('shouldEscalateNoDiff', () => {
  it('escalates a first run that committed nothing (already-satisfied finding)', () => {
    expect(shouldEscalateNoDiff(false, true)).toBe(true);
  });

  it('does not escalate when the agent committed a change', () => {
    expect(shouldEscalateNoDiff(true, true)).toBe(false);
  });

  it('does not escalate a no-diff rework (handled by re-requesting review)', () => {
    expect(shouldEscalateNoDiff(false, false)).toBe(false);
  });

  it('does not escalate a rework that committed changes', () => {
    expect(shouldEscalateNoDiff(true, false)).toBe(false);
  });
});
