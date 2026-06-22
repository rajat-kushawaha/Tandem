import { describe, expect, it } from 'vitest';
import {
  checklistSchema,
  evaluateChecklist,
  parseChecklist,
  type Checklist,
} from '../src/agents/dev/checklist.js';

const criteria = ['User can reset password', 'Link expires in 1 hour'];

function checklist(
  overrides: Partial<Checklist['items'][number]>[],
): Checklist {
  const base = [
    {
      criterion: 'User can reset password',
      testReference: 'AuthTest#resetsPassword',
      satisfied: true,
      untestable: false,
    },
    {
      criterion: 'Link expires in 1 hour',
      testReference: 'AuthTest#linkExpires',
      satisfied: true,
      untestable: false,
    },
  ];
  return checklistSchema.parse({
    items: base.map((item, index) => ({ ...item, ...overrides[index] })),
    affectedRepos: ['backend'],
  });
}

const validBlock = JSON.stringify({
  items: [
    {
      criterion: 'User can reset password',
      testReference: 'AuthTest#resetsPassword',
      satisfied: true,
    },
  ],
  affectedRepos: ['revelio-ui'],
});

describe('parseChecklist', () => {
  it('extracts the checklist from a full multi-block transcript', () => {
    // Mirrors a real run: the agent narrates, emits the checklist, then keeps
    // talking. Parsing the whole transcript (not just the final message) must
    // still find it.
    const transcript = [
      '**Step 5: Create SearchBar component**',
      `Here is the checklist:\n\`\`\`json\n${validBlock}\n\`\`\``,
      'All gates pass. Done.',
    ].join('\n\n');
    expect(parseChecklist(transcript)?.items[0]?.criterion).toBe(
      'User can reset password',
    );
  });

  it('returns the LAST valid block when several appear', () => {
    const stale = validBlock.replace('revelio-ui', 'stale-repo');
    const transcript = `\`\`\`json\n${stale}\n\`\`\`\nlater:\n\`\`\`json\n${validBlock}\n\`\`\``;
    expect(parseChecklist(transcript)?.affectedRepos).toEqual(['revelio-ui']);
  });

  it('returns null when no valid checklist block is present', () => {
    expect(parseChecklist('I implemented everything and the gates pass.')).toBeNull();
  });
});

describe('evaluateChecklist', () => {
  it('is complete when every criterion is mapped, tested, and satisfied', () => {
    const result = evaluateChecklist(criteria, checklist([{}, {}]));
    expect(result.complete).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('flags an unsatisfied criterion', () => {
    const result = evaluateChecklist(
      criteria,
      checklist([{ satisfied: false }, {}]),
    );
    expect(result.complete).toBe(false);
    expect(result.problems[0]).toMatch(/not yet satisfied/);
  });

  it('flags a criterion with no mapped test', () => {
    const result = evaluateChecklist(
      criteria,
      checklist([{ testReference: '' }, {}]),
    );
    expect(result.problems[0]).toMatch(/No test mapped/);
  });

  it('flags an untestable criterion instead of passing it', () => {
    const result = evaluateChecklist(
      criteria,
      checklist([{ untestable: true }, {}]),
    );
    expect(result.problems[0]).toMatch(/untestable/);
  });

  it('flags a criterion the agent omitted entirely', () => {
    const partial = checklistSchema.parse({
      items: [
        {
          criterion: 'User can reset password',
          testReference: 'AuthTest#resetsPassword',
          satisfied: true,
        },
      ],
      affectedRepos: ['backend'],
    });
    const result = evaluateChecklist(criteria, partial);
    expect(result.complete).toBe(false);
    expect(result.problems[0]).toMatch(/No checklist entry/);
  });

  it('flags an interaction criterion that has only a unit test (no browser test)', () => {
    // The exact CR-38 blind spot: a click/navigation AC mapped to a mocked unit
    // test that passes while the real button is broken. Without a browser test
    // reference, the interaction is unproven and must block.
    const result = evaluateChecklist(
      criteria,
      checklist([{ interaction: true, browserTestReference: '' }, {}]),
    );
    expect(result.complete).toBe(false);
    expect(result.problems[0]).toMatch(/user interaction/);
  });

  it('passes an interaction criterion that has a browser test reference', () => {
    const result = evaluateChecklist(
      criteria,
      checklist([
        {
          interaction: true,
          browserTestReference: 'smoke.spec.ts#clicking Edit opens the form',
        },
        {},
      ]),
    );
    expect(result.complete).toBe(true);
  });

  it('does not require a browser test for a non-interaction criterion', () => {
    const result = evaluateChecklist(
      criteria,
      checklist([{ interaction: false, browserTestReference: '' }, {}]),
    );
    expect(result.complete).toBe(true);
  });
});
