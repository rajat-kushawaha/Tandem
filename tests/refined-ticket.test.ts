import { describe, expect, it } from 'vitest';
import {
  parseRefinedTicket,
  renderJiraDescription,
} from '../src/agents/ba/refined-ticket.js';

const valid = {
  acceptanceCriteria: ['User can reset password', 'Link expires in 1 hour'],
  definitionOfReady: ['API contract agreed'],
  technicalNotes: ['Use existing mailer service'],
  refinedDescription: 'Allow users to reset a forgotten password by email.',
};

describe('parseRefinedTicket', () => {
  it('extracts a valid refined ticket from a json code block', () => {
    const text = `Here is the refinement:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
    expect(parseRefinedTicket(text)).toEqual({ ...valid });
  });

  it('returns null when the agent asked questions instead', () => {
    expect(
      parseRefinedTicket('I posted clarifying questions to Slack.'),
    ).toBeNull();
  });

  it('returns null when the block is missing required fields', () => {
    const text = '```json\n{"refinedDescription":"x"}\n```';
    expect(parseRefinedTicket(text)).toBeNull();
  });

  it('prefers the last valid block', () => {
    const first = { ...valid, refinedDescription: 'first' };
    const second = { ...valid, refinedDescription: 'second' };
    const text = `\`\`\`json\n${JSON.stringify(first)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(second)}\n\`\`\``;
    expect(parseRefinedTicket(text)?.refinedDescription).toBe('second');
  });
});

describe('renderJiraDescription', () => {
  it('renders headings for non-empty sections only', () => {
    const rendered = renderJiraDescription(
      { ...valid, technicalNotes: [] },
      '',
    );
    expect(rendered).toContain('h2. Acceptance Criteria');
    expect(rendered).toContain('- Link expires in 1 hour');
    expect(rendered).toContain('h2. Definition of Ready');
    expect(rendered).not.toContain('Technical Notes');
  });

  it('appends the original description verbatim so the write-back is lossless', () => {
    const original =
      'Add a card titled "Development in the era of AI" with tags: ai, development.';
    const rendered = renderJiraDescription(valid, original);
    expect(rendered).toContain('h2. Original Description (verbatim)');
    expect(rendered).toContain(original);
  });

  it('omits the original-description section when the original is empty', () => {
    const rendered = renderJiraDescription(valid, '  ');
    expect(rendered).not.toContain('Original Description');
  });
});
