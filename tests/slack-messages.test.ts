import { describe, expect, it } from 'vitest';
import { formatClarificationMessage } from '../src/integrations/slack/messages.js';

describe('formatClarificationMessage', () => {
  it('numbers the questions and links the ticket', () => {
    const message = formatClarificationMessage({
      ticketKey: 'AGENT-3',
      ticketUrl: 'https://acme.atlassian.net/browse/AGENT-3',
      questions: ['Which roles can export?', 'What is the file size cap?'],
    });
    expect(message).toContain(
      '<https://acme.atlassian.net/browse/AGENT-3|AGENT-3>',
    );
    expect(message).toContain('1. Which roles can export?');
    expect(message).toContain('2. What is the file size cap?');
  });

  it('refuses to format an empty question set', () => {
    expect(() =>
      formatClarificationMessage({
        ticketKey: 'AGENT-3',
        ticketUrl: 'x',
        questions: [],
      }),
    ).toThrow(/empty/);
  });
});
