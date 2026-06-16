import type { PullRequestRef } from './clients.js';

/** Parses `https://github.com/<owner>/<repo>/pull/<number>` into its parts. */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[/?#])/.exec(
    url,
  );
  if (!match) {
    return null;
  }
  const [, owner, repo, number] = match;
  return { owner: owner!, repo: repo!, number: Number(number) };
}
