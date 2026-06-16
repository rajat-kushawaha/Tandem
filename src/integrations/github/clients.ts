import { Octokit } from '@octokit/rest';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

/**
 * GitHub access via personal-access-token identities:
 *
 *  - the **dev** token (`GITHUB_TOKEN`) clones, pushes the feature branch, and
 *    opens PRs. It must NOT have merge rights, and branch protection must forbid
 *    pushes to the default branch;
 *  - the **reviewer** token (`REVIEWER_GITHUB_TOKEN`, optional) approves, kept
 *    separate because GitHub forbids approving your own PR. When it is absent the
 *    reviewer falls back to posting an approval *comment* instead of a formal
 *    approval. (Not named GITHUB_*: GitHub reserves that secret-name prefix.)
 *
 * No helper here can merge — that capability is deliberately absent.
 */

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface PullRequestRef extends RepoRef {
  readonly number: number;
}

export type ReviewDecision = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

const devOctokit = new Octokit({ auth: config.GITHUB_TOKEN });
const reviewerOctokit = config.REVIEWER_GITHUB_TOKEN
  ? new Octokit({ auth: config.REVIEWER_GITHUB_TOKEN })
  : null;

/** The dev PAT, used to clone and push the feature branch inside the sandbox. */
export function getDevToken(): string {
  return config.GITHUB_TOKEN;
}

export function authenticatedCloneUrl(ref: RepoRef, token: string): string {
  return `https://x-access-token:${token}@github.com/${ref.owner}/${ref.repo}.git`;
}

export interface OpenPullRequestInput extends RepoRef {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}

/**
 * Opens a pull request as the dev identity, or reuses the existing open PR for
 * the same branch so a retry is idempotent (GitHub rejects a second PR for the
 * same head). Never merges.
 */
/**
 * Returns the open PR for a repo's branch, or null. Used both to make
 * `openPullRequest` idempotent and to let the dev workflow skip a repo whose
 * work already shipped in a prior run (the PR exists and is still open).
 */
export async function findOpenPullRequest(
  ref: RepoRef,
  branch: string,
): Promise<{ url: string; number: number } | null> {
  const existing = await devOctokit.request('GET /repos/{owner}/{repo}/pulls', {
    owner: ref.owner,
    repo: ref.repo,
    head: `${ref.owner}:${branch}`,
    state: 'open',
  });
  const open = existing.data[0];
  return open ? { url: open.html_url, number: open.number } : null;
}

export async function openPullRequest(
  input: OpenPullRequestInput,
): Promise<{ url: string; number: number }> {
  const existing = await findOpenPullRequest(
    { owner: input.owner, repo: input.repo },
    input.head,
  );
  if (existing) {
    return existing;
  }

  const { data } = await devOctokit.request(
    'POST /repos/{owner}/{repo}/pulls',
    {
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
    },
  );
  return { url: data.html_url, number: data.number };
}

/**
 * Collects the reviewer's actionable feedback on a PR as plain strings: the
 * bodies of changes-requested reviews plus every inline comment (with its file
 * and line). This is what the dev agent is given on a rework, so it fixes what
 * the reviewer actually asked for instead of re-implementing blind.
 */
export async function listReviewFeedback(
  pr: PullRequestRef,
): Promise<string[]> {
  const [reviews, comments] = await Promise.all([
    devOctokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      { owner: pr.owner, repo: pr.repo, pull_number: pr.number },
    ),
    devOctokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      { owner: pr.owner, repo: pr.repo, pull_number: pr.number, per_page: 100 },
    ),
  ]);

  const feedback: string[] = [];
  for (const review of reviews.data) {
    if (review.state === 'CHANGES_REQUESTED' && review.body?.trim()) {
      feedback.push(`Review (changes requested): ${review.body.trim()}`);
    }
  }
  for (const comment of comments.data) {
    if (comment.body.trim()) {
      const line = comment.line ?? comment.original_line;
      const location = line ? `${comment.path}:${line}` : comment.path;
      feedback.push(`Inline comment on ${location}: ${comment.body.trim()}`);
    }
  }
  return feedback;
}

/**
 * The PR's diff as concatenated per-file patches. Used to show one repo's
 * already-shipped changes to the agent working in another repo, so cross-repo
 * contracts (endpoints, payload shapes) stay consistent.
 */
export async function getPullRequestDiff(pr: PullRequestRef): Promise<string> {
  const { data } = await devOctokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
    { owner: pr.owner, repo: pr.repo, pull_number: pr.number, per_page: 100 },
  );
  return data
    .map((file) => `--- ${file.filename}\n${file.patch ?? '(no text diff)'}`)
    .join('\n');
}

/** Whether the PR has been merged (the human acted on the merge gate). */
export async function isPullRequestMerged(
  pr: PullRequestRef,
): Promise<boolean> {
  const { data } = await devOctokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    { owner: pr.owner, repo: pr.repo, pull_number: pr.number },
  );
  return data.merged;
}

/** Lists review decisions on a PR, newest first. Used to poll review outcome. */
export async function listReviews(
  pr: PullRequestRef,
): Promise<Array<{ state: string; submittedAt: string | null }>> {
  const octokit = reviewerOctokit ?? devOctokit;
  const { data } = await octokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
    { owner: pr.owner, repo: pr.repo, pull_number: pr.number },
  );
  return data.map((review) => ({
    state: review.state,
    submittedAt: review.submitted_at ?? null,
  }));
}

/** Posts a non-blocking comment on a ticket's PR. */
export async function commentOnPullRequest(
  pr: PullRequestRef,
  body: string,
): Promise<void> {
  await devOctokit.request(
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    { owner: pr.owner, repo: pr.repo, issue_number: pr.number, body },
  );
}

/**
 * Submits a review as the reviewer identity. Approval needs the separate
 * reviewer token (GitHub forbids self-approval); without it, the approval is
 * downgraded to a comment so the human gate still sees the verdict.
 */
export async function submitReview(
  pr: PullRequestRef,
  decision: ReviewDecision,
  body: string,
): Promise<void> {
  if (decision === 'APPROVE' && !reviewerOctokit) {
    // No separate reviewer identity, so we cannot submit a formal APPROVED
    // review. The comment fallback records the verdict for a human, but it
    // carries no APPROVED review state — the local review poller, which keys
    // off review state, will therefore NOT auto-advance the ticket to
    // APPROVED. Set REVIEWER_GITHUB_TOKEN to enable the automated approval path.
    logger.warn(
      { owner: pr.owner, repo: pr.repo, prNumber: pr.number },
      'REVIEWER_GITHUB_TOKEN not set: approval downgraded to a comment; ' +
        'the ticket will not auto-advance to APPROVED until a human acts',
    );
    await commentOnPullRequest(
      pr,
      `Reviewer approval (comment fallback):\n${body}`,
    );
    return;
  }
  const octokit = reviewerOctokit ?? devOctokit;
  await octokit.request(
    'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
    {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      event: decision,
      body,
    },
  );
}
