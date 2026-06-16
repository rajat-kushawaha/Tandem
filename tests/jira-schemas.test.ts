import { describe, expect, it } from 'vitest';
import { jiraIssueSchema, toTicket } from '../src/integrations/jira/schemas.js';

describe('jira schema mapping', () => {
  const raw = {
    key: 'AGENT-7',
    fields: {
      summary: 'Add password reset',
      description: [
        'Users forget passwords.',
        'h2. Acceptance Criteria',
        '- A reset email is sent',
        '- The link expires in 1 hour',
      ].join('\n'),
      status: { name: 'In Progress' },
    },
  };

  it('maps a valid issue into a domain Ticket with parsed criteria', () => {
    const ticket = toTicket(
      jiraIssueSchema.parse(raw),
      'https://acme.atlassian.net/',
    );
    expect(ticket.key).toBe('AGENT-7');
    expect(ticket.status).toBe('In Progress');
    expect(ticket.acceptanceCriteria).toEqual([
      'A reset email is sent',
      'The link expires in 1 hour',
    ]);
    expect(ticket.url).toBe('https://acme.atlassian.net/browse/AGENT-7');
  });

  it('defaults a missing description to an empty string', () => {
    const ticket = toTicket(
      jiraIssueSchema.parse({
        key: 'AGENT-8',
        fields: { summary: 'x', description: null, status: { name: 'New' } },
      }),
      'https://acme.atlassian.net',
    );
    expect(ticket.description).toBe('');
    expect(ticket.acceptanceCriteria).toEqual([]);
  });

  it('rejects a payload missing required fields', () => {
    expect(() => jiraIssueSchema.parse({ key: 'AGENT-9' })).toThrow();
  });
});
