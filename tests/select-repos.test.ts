import { describe, expect, it } from 'vitest';
import { parseRepoPlan } from '../src/agents/dev/repo-plan.js';

const known = ['api', 'ui'];

describe('parseRepoPlan', () => {
  it('extracts planned repo entries with their changes', () => {
    const text =
      'Here is the plan:\n```json\n{"repos":[{"key":"ui","changes":["add 5 cards to blogs.tsx"]}]}\n```';
    expect(parseRepoPlan(text, known)).toEqual([
      { key: 'ui', changes: ['add 5 cards to blogs.tsx'] },
    ]);
  });

  it('accepts bare key strings with no changes', () => {
    const text = '```json\n{"repos":["ui"]}\n```';
    expect(parseRepoPlan(text, known)).toEqual([{ key: 'ui', changes: [] }]);
  });

  it('drops unknown keys', () => {
    const text = '```json\n{"repos":["ui","infra"]}\n```';
    expect(parseRepoPlan(text, known)).toEqual([{ key: 'ui', changes: [] }]);
  });

  it('dedupes repeated keys, keeping the first entry', () => {
    const text =
      '```json\n{"repos":[{"key":"api","changes":["seed posts"]},"api","ui"]}\n```';
    expect(parseRepoPlan(text, known)).toEqual([
      { key: 'api', changes: ['seed posts'] },
      { key: 'ui', changes: [] },
    ]);
  });

  it('returns empty when there is no valid plan block', () => {
    expect(parseRepoPlan('no json here', known)).toEqual([]);
    expect(parseRepoPlan('```json\n{"bad":true}\n```', known)).toEqual([]);
  });
});
