import { describe, expect, it } from 'vitest';
import { parsePullRequestUrl } from '../src/integrations/github/pr-url.js';

describe('parsePullRequestUrl', () => {
  it('parses a standard PR url', () => {
    expect(
      parsePullRequestUrl('https://github.com/acme/backend/pull/42'),
    ).toEqual({
      owner: 'acme',
      repo: 'backend',
      number: 42,
    });
  });

  it('tolerates trailing path segments', () => {
    expect(
      parsePullRequestUrl('https://github.com/acme/frontend/pull/7/files'),
    ).toEqual({ owner: 'acme', repo: 'frontend', number: 7 });
  });

  it('returns null for non-PR urls', () => {
    expect(
      parsePullRequestUrl('https://github.com/acme/backend/issues/3'),
    ).toBeNull();
    expect(parsePullRequestUrl('not a url')).toBeNull();
  });
});
