import { runAgent } from '../../shared/claude.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import type { Ticket } from '../../shared/types.js';
import {
  selectAffectedRepos,
  type RepoConfig,
} from '../../integrations/github/repos.js';
import { parseRepoPlan } from './repo-plan.js';

/**
 * Plans which repos a ticket requires changes in — and what each change is —
 * by INSPECTING THE CODE, not just the ticket text.
 *
 * The planner gets a read-only base-branch checkout of EVERY configured repo
 * (prepared by the dev workflow before this runs) and explores them with
 * Read/Glob/Grep before deciding. This is what catches the cases text-only
 * triage gets wrong: e.g. a "add content to the page" ticket where the page
 * turns out to render API data, so the content must land in the backend repo.
 * Keyword matching is kept only as a fallback when the model returns nothing
 * usable.
 */

/** One repo the ticket changes, with its slice of the cross-repo plan. */
export interface PlannedRepo {
  readonly config: RepoConfig;
  /** The specific changes this repo needs (empty on the keyword fallback). */
  readonly changes: readonly string[];
}

const SYSTEM_PROMPT = `You plan which repositories a software ticket requires changes in, and what each repo must change.

You have a read-only checkout of EVERY repository. INSPECT THE CODE BEFORE DECIDING: open the pages/components/endpoints the ticket touches and see how they actually work (where their data comes from, what renders what). Judge by the actual code, never by assumption.

Rules:
- Include a repository ONLY if implementing this ticket genuinely requires changing code there.
- Respect explicit scope. If the ticket says UI-only / frontend-only, choose only the frontend repo. If backend-only, choose only the backend repo.
- A passing mention of "the API" or "the backend" does NOT mean the backend repo changes — judge by the actual work required.
- If the ticket supplies literal content (titles, copy text, colors, enumerated items), the plan must carry that content through EXACTLY as given — never drop, merge, or generalize it. If the feature that displays such content is data-driven in the code (e.g. the page renders API results), plan the content into the place it must actually live (the data/source repo), and say so explicitly.
- Be conservative: fewer repos is better than dragging in an unaffected one.
- For each included repo, list its specific changes as a short, concrete todo (file or component names where you found them).`;

function planPrompt(ticket: Ticket, repos: readonly RepoConfig[]): string {
  const repoList = repos
    .map(
      (repo) =>
        `- key "${repo.key}" → ${repo.owner}/${repo.repo}, checked out at ./${repo.repo} (handles: ${repo.keywords.join(', ')})`,
    )
    .join('\n');
  return [
    `Ticket ${ticket.key}: ${ticket.summary}`,
    '',
    ticket.description || '(no description)',
    '',
    'Repository checkouts (relative to your working directory):',
    repoList,
    '',
    'Inspect the code in each checkout, then output ONLY a JSON code block:',
    '```json',
    '{ "repos": [ { "key": "<repo-key>", "changes": ["<specific change>", ...] } ] }',
    '```',
  ].join('\n');
}

export async function planAffectedRepos(
  ticket: Ticket,
  repos: readonly RepoConfig[],
  /** Directory containing one base-branch checkout per repo (./<repo-name>). */
  checkoutRoot: string,
): Promise<PlannedRepo[]> {
  const result = await runAgent({
    role: 'dev',
    model: config.BA_MODEL, // exploration is read-only; the cheaper model suffices
    allowedTools: ['Read', 'Glob', 'Grep'],
    systemPrompt: SYSTEM_PROMPT,
    prompt: planPrompt(ticket, repos),
    cwd: checkoutRoot,
    maxTurns: 30,
    logContext: { ticketKey: ticket.key, phase: 'plan' },
  });

  const entries = parseRepoPlan(
    `${result.transcript}\n${result.text}`,
    repos.map((repo) => repo.key),
  );
  const byKey = new Map(repos.map((repo) => [repo.key, repo]));
  const chosen = entries.flatMap((entry) => {
    const repoConfig = byKey.get(entry.key);
    return repoConfig ? [{ config: repoConfig, changes: entry.changes }] : [];
  });
  if (chosen.length > 0) {
    logger.info(
      {
        ticketKey: ticket.key,
        plan: chosen.map((planned) => ({
          repo: planned.config.key,
          changes: planned.changes,
        })),
      },
      'cross-repo plan produced by code-aware triage',
    );
    return chosen;
  }

  logger.warn(
    { ticketKey: ticket.key },
    'triage returned no repos; falling back to keyword match',
  );
  return selectAffectedRepos(
    `${ticket.summary}\n${ticket.description}`,
    repos,
  ).map((repoConfig) => ({ config: repoConfig, changes: [] }));
}
