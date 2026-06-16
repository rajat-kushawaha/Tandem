/**
 * Repository routing. `GITHUB_REPOS` maps short keys to repos and the keywords
 * that indicate a ticket touches them:
 *
 *   key:owner/repo:kw1,kw2;key2:owner/repo2:kw1,kw2
 *
 * Keyword matching (against the ticket's text) decides which repos the dev
 * agent works in — deterministic and cheap, instead of an extra LLM planning
 * call. A ticket that matches no keyword falls back to all repos so work is
 * never silently skipped.
 */

export interface RepoConfig {
  readonly key: string;
  readonly owner: string;
  readonly repo: string;
  readonly keywords: readonly string[];
}

export function parseGithubRepos(raw: string): RepoConfig[] {
  const repos = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseEntry);

  if (repos.length === 0) {
    throw new Error('GITHUB_REPOS is empty or malformed.');
  }
  return repos;
}

function parseEntry(entry: string): RepoConfig {
  const [key, slug, keywordList] = entry.split(':');
  if (!key || !slug) {
    throw new Error(
      `Malformed GITHUB_REPOS entry "${entry}". Expected key:owner/repo:kw1,kw2.`,
    );
  }
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    throw new Error(
      `Malformed repo slug "${slug}" in GITHUB_REPOS. Expected owner/repo.`,
    );
  }
  const keywords = (keywordList ?? '')
    .split(',')
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0);

  return { key: key.trim(), owner: owner.trim(), repo: repo.trim(), keywords };
}

/**
 * Selects the repos a ticket affects by matching keywords against its text.
 * Falls back to every configured repo when nothing matches.
 */
export function selectAffectedRepos(
  ticketText: string,
  repos: readonly RepoConfig[],
): RepoConfig[] {
  const haystack = ticketText.toLowerCase();
  const matched = repos.filter((repo) =>
    repo.keywords.some((keyword) => haystack.includes(keyword)),
  );
  return matched.length > 0 ? matched : [...repos];
}
