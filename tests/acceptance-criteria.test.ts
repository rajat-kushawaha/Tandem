import { describe, expect, it } from 'vitest';
import { parseAcceptanceCriteria } from '../src/integrations/jira/acceptance-criteria.js';

describe('parseAcceptanceCriteria', () => {
  it('extracts a bulleted list under the heading', () => {
    const description = [
      'Some context about the work.',
      '',
      'h2. Acceptance Criteria',
      '- User can log in with email',
      '* Invalid passwords are rejected',
      '• Sessions expire after 30 minutes',
    ].join('\n');
    expect(parseAcceptanceCriteria(description)).toEqual([
      'User can log in with email',
      'Invalid passwords are rejected',
      'Sessions expire after 30 minutes',
    ]);
  });

  it('supports numbered lists', () => {
    const description = [
      '## Acceptance Criteria',
      '1. First criterion',
      '2) Second criterion',
    ].join('\n');
    expect(parseAcceptanceCriteria(description)).toEqual([
      'First criterion',
      'Second criterion',
    ]);
  });

  it('stops at the next heading', () => {
    const description = [
      '### Acceptance Criteria',
      '- Keep this one',
      '',
      '### Technical Notes',
      '- Ignore this bullet',
    ].join('\n');
    expect(parseAcceptanceCriteria(description)).toEqual(['Keep this one']);
  });

  it('returns empty when there is no acceptance-criteria heading', () => {
    expect(parseAcceptanceCriteria('- just a stray bullet')).toEqual([]);
  });
});
