import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  authenticatedCloneUrl,
  getDevToken,
  type RepoRef,
} from '../../integrations/github/clients.js';
import { logger } from '../../shared/logger.js';
import { config } from '../../shared/config.js';
import { detectStack, type Stack } from './gates.js';

/**
 * Disposable per-ticket sandbox. Each run gets a fresh shallow checkout on a
 * `feature/<TICKET-KEY>` branch under `.sandbox/`, isolated from the host repo
 * and from other tickets. In production this whole step runs inside a throwaway
 * container with no access to production secrets; the fresh checkout here is the
 * same guarantee at the filesystem level.
 */

const exec = promisify(execFile);
// Resolved from config (default: a temp dir OUTSIDE this project) so the agent's
// gates don't inherit this repo's eslint/tsconfig via ancestor traversal.
const SANDBOX_ROOT = resolve(config.SANDBOX_ROOT);

export interface Sandbox {
  readonly repo: RepoRef;
  readonly path: string;
  readonly branch: string;
  readonly stack: Stack;
}

export function branchName(ticketKey: string): string {
  return `feature/${ticketKey}`;
}

/** The directory that holds every repo checkout for one ticket. */
export function ticketSandboxRoot(ticketKey: string): string {
  return join(SANDBOX_ROOT, ticketKey);
}

/**
 * Read-only base-branch checkout used by the cross-repo planning phase, which
 * inspects EVERY configured repo's code before deciding which ones the ticket
 * changes. Cloned to the same path the dev sandbox later uses; `prepareSandbox`
 * re-clones over it, so a planning checkout never leaks state into the build.
 */
export async function preparePlanningCheckout(
  repo: RepoRef,
  ticketKey: string,
  baseBranch: string,
): Promise<string> {
  const path = join(SANDBOX_ROOT, ticketKey, repo.repo);
  await clone(path, authenticatedCloneUrl(repo, getDevToken()), baseBranch);
  return path;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export interface PrepareSandboxOptions {
  /**
   * Resume the existing remote feature branch instead of branching afresh from
   * base. Used on a rework: the PR's code must stay in place so the agent fixes
   * the reviewer's comments rather than re-implementing from scratch (which
   * would also orphan every inline comment). Falls back to a fresh branch if
   * the remote branch no longer exists.
   */
  readonly resumeFeatureBranch?: boolean;
}

export async function prepareSandbox(
  repo: RepoRef,
  ticketKey: string,
  baseBranch: string,
  options: PrepareSandboxOptions = {},
): Promise<Sandbox> {
  const path = join(SANDBOX_ROOT, ticketKey, repo.repo);
  const url = authenticatedCloneUrl(repo, getDevToken());
  const branch = branchName(ticketKey);
  const log = logger.child({ ticketKey, repo: repo.repo });

  const resumed =
    options.resumeFeatureBranch === true &&
    (await tryClone(path, url, branch));
  if (resumed) {
    log.info({ branch }, 'sandbox resumed from the existing feature branch');
  } else {
    await clone(path, url, baseBranch);
    await git(path, ['checkout', '-b', branch]);
    log.info({ branch, baseBranch }, 'sandbox created from the base branch');
  }

  const stack = detectStack(await readdir(path));
  if (!stack) {
    throw new Error(
      `Could not detect a known stack (maven/gradle/node) in ${repo.repo}.`,
    );
  }
  return { repo, path, branch, stack };
}

export async function commitAndPush(
  sandbox: Sandbox,
  message: string,
): Promise<{ committed: boolean }> {
  await git(sandbox.path, ['add', '-A']);
  // A rework can legitimately produce no new diff (the agent judged the branch
  // already addresses the feedback); `git commit` would fail on an empty
  // commit, so skip it — but always push, so the remote ref is current. The
  // caller needs to know (see run-repo.ts): without a new commit, no
  // `synchronize` event fires and the stale review verdict is never refreshed.
  const staged = await git(sandbox.path, ['status', '--porcelain']);
  const committed = staged.trim() !== '';
  if (committed) {
    await git(sandbox.path, [
      '-c',
      'user.name=dev-agent',
      '-c',
      'user.email=dev-agent@users.noreply.github.com',
      'commit',
      '-m',
      message,
    ]);
  }
  // Force-update the per-ticket feature branch only — never main; a fresh run
  // rebuilds it from the base branch, so a retry overwrites the previous
  // attempt rather than colliding. `--force-with-lease` (not bare --force) so a
  // session whose clone went stale cannot silently erase commits pushed to the
  // branch meanwhile (e.g. an operator merging main in to fix a gate); the
  // push fails loudly instead and the workflow's retry re-clones fresh.
  await git(sandbox.path, [
    'push',
    '--force-with-lease',
    '-u',
    'origin',
    sandbox.branch,
  ]);
  return { committed };
}

/**
 * Pushes an empty commit to the feature branch. Used after a rework that
 * produced no diff: the PR's `synchronize` event is the only thing that
 * triggers a fresh CI review, so without this the stale changes-requested
 * verdict would stand forever and re-trigger rework in a loop.
 */
export async function pushEmptyCommit(
  sandbox: Sandbox,
  message: string,
): Promise<void> {
  await git(sandbox.path, [
    '-c',
    'user.name=dev-agent',
    '-c',
    'user.email=dev-agent@users.noreply.github.com',
    'commit',
    '--allow-empty',
    '-m',
    message,
  ]);
  await git(sandbox.path, ['push', '-u', 'origin', sandbox.branch]);
}

/**
 * The branch's diff against the remote base branch, truncated to `maxChars`.
 * Fed to the NEXT repo's agent session so cross-repo contracts (endpoints,
 * payload shapes) come from the actual change, not from a second guess.
 */
export async function diffAgainstBase(
  sandbox: Sandbox,
  baseBranch: string,
  maxChars: number,
): Promise<string> {
  await git(sandbox.path, ['fetch', '--depth', '1', 'origin', baseBranch]);
  const diff = await git(sandbox.path, ['diff', 'FETCH_HEAD', 'HEAD']);
  return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n…(truncated)` : diff;
}

/** Clones a single branch of the repo into a freshly-emptied directory. */
async function clone(path: string, url: string, branch: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  await exec('git', ['clone', '--depth', '1', '--branch', branch, url, path]);
}

/** Like {@link clone}, but returns false instead of throwing (branch absent). */
async function tryClone(
  path: string,
  url: string,
  branch: string,
): Promise<boolean> {
  try {
    await clone(path, url, branch);
    return true;
  } catch {
    return false;
  }
}

export async function disposeSandbox(ticketKey: string): Promise<void> {
  await rm(join(SANDBOX_ROOT, ticketKey), { recursive: true, force: true });
}
