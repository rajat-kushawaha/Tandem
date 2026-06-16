import { describe, expect, it } from 'vitest';
import {
  selectCriteriaForRepo,
  unassignedCriteria,
} from '../src/agents/dev/criteria-assignment.js';

const all = [
  'Backend exposes a paged endpoint at /posts?page=N', // 1 - api
  'Clicking Next updates the URL without a full reload', // 2 - ui
  'Total result count is returned and displayed', // 3 - both
];

const block = (obj: unknown) => `prose...\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

describe('selectCriteriaForRepo', () => {
  it('maps 1-based indexes back to the criteria for a repo', () => {
    const text = block({ assignments: { api: [1, 3], ui: [2, 3] } });
    expect(selectCriteriaForRepo(text, 'api', all)).toEqual([all[0], all[2]]);
    expect(selectCriteriaForRepo(text, 'ui', all)).toEqual([all[1], all[2]]);
  });

  it('ignores out-of-range indexes', () => {
    const text = block({ assignments: { api: [1, 99, 0] } });
    expect(selectCriteriaForRepo(text, 'api', all)).toEqual([all[0]]);
  });

  it('dedupes repeated indexes', () => {
    const text = block({ assignments: { api: [1, 1, 1] } });
    expect(selectCriteriaForRepo(text, 'api', all)).toEqual([all[0]]);
  });

  it('returns null when the repo has no assignment entry', () => {
    const text = block({ assignments: { ui: [2] } });
    expect(selectCriteriaForRepo(text, 'api', all)).toBeNull();
  });

  it('returns null when there is no valid json block', () => {
    expect(selectCriteriaForRepo('no json', 'api', all)).toBeNull();
  });
});

describe('unassignedCriteria', () => {
  it('is empty when every criterion is covered by some repo', () => {
    const perRepo = new Map<string, readonly string[]>([
      ['api', [all[0]!, all[2]!]],
      ['ui', [all[1]!, all[2]!]],
    ]);
    expect(unassignedCriteria(all, perRepo)).toEqual([]);
  });

  it('reports criteria no repo owns', () => {
    const perRepo = new Map<string, readonly string[]>([
      ['api', [all[0]!]],
      ['ui', [all[1]!]],
    ]);
    // criterion 3 (index 2) was dropped
    expect(unassignedCriteria(all, perRepo)).toEqual([all[2]]);
  });
});
