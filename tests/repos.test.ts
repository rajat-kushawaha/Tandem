import { describe, expect, it } from 'vitest';
import {
  parseGithubRepos,
  selectAffectedRepos,
} from '../src/integrations/github/repos.js';

const RAW =
  'api:rajat-gitting/revelio-api:api,backend,auth,endpoint,server;ui:rajat-gitting/revelio-ui:ui,frontend,react,component';

describe('parseGithubRepos', () => {
  it('parses keyed owner/repo entries with keywords', () => {
    const repos = parseGithubRepos(RAW);
    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual({
      key: 'api',
      owner: 'rajat-gitting',
      repo: 'revelio-api',
      keywords: ['api', 'backend', 'auth', 'endpoint', 'server'],
    });
    expect(repos[1]?.repo).toBe('revelio-ui');
  });

  it('throws on a malformed entry', () => {
    expect(() => parseGithubRepos('justakey')).toThrow(/Malformed/);
    expect(() => parseGithubRepos('k:noslash:kw')).toThrow(/owner\/repo/);
  });

  it('throws when empty', () => {
    expect(() => parseGithubRepos('   ')).toThrow(/empty or malformed/);
  });
});

describe('selectAffectedRepos', () => {
  const repos = parseGithubRepos(RAW);

  it('selects repos whose keywords appear in the ticket text', () => {
    const selected = selectAffectedRepos('Add a new auth endpoint', repos);
    expect(selected.map((r) => r.key)).toEqual(['api']);
  });

  it('can select multiple repos', () => {
    const selected = selectAffectedRepos(
      'Add a React component that calls the backend API',
      repos,
    );
    expect(selected.map((r) => r.key)).toEqual(['api', 'ui']);
  });

  it('falls back to all repos when nothing matches', () => {
    const selected = selectAffectedRepos('Tweak the copyright year', repos);
    expect(selected.map((r) => r.key)).toEqual(['api', 'ui']);
  });

  it('is case-insensitive', () => {
    expect(
      selectAffectedRepos('FRONTEND work', repos).map((r) => r.key),
    ).toEqual(['ui']);
  });
});
