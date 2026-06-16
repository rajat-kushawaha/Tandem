import { config } from '../../shared/config.js';
import { parseGithubRepos, type RepoConfig } from './repos.js';

/**
 * The repos configured in `GITHUB_REPOS`, parsed once and memoized. Kept apart
 * from the pure parser/router in `repos.ts` so those stay unit-testable without
 * loading environment configuration.
 */
let cached: RepoConfig[] | null = null;

export function configuredRepos(): RepoConfig[] {
  cached ??= parseGithubRepos(config.GITHUB_REPOS);
  return cached;
}
