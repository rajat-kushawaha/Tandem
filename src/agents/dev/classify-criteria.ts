import { runAgent } from '../../shared/claude.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import type { Ticket } from '../../shared/types.js';
import type { RepoConfig } from '../../integrations/github/repos.js';
import {
  selectCriteriaForRepo,
  unassignedCriteria,
} from './criteria-assignment.js';

/**
 * Splits a ticket's acceptance criteria across the repos being developed, so
 * each repo is verified only against the criteria it can satisfy. Uses a cheap,
 * tool-less classification model (the same pattern as repo triage).
 *
 * Fallback: if the model produces nothing usable, OR the union of assignments
 * would drop a criterion, EVERY repo gets ALL criteria — the original behaviour.
 * That is safe (never silently drops a criterion); it just loses the per-repo
 * benefit for that run.
 */
export async function classifyCriteriaByRepo(
  ticket: Ticket,
  repos: readonly RepoConfig[],
): Promise<Map<string, readonly string[]>> {
  const all = ticket.acceptanceCriteria;
  const fallback = new Map<string, readonly string[]>(
    repos.map((r) => [r.key, all]),
  );

  if (all.length === 0 || repos.length <= 1) {
    return fallback; // nothing to split, or a single repo owns everything
  }

  const result = await runAgent({
    role: 'dev',
    model: config.BA_MODEL, // cheap, fast classification — no tools needed
    allowedTools: [],
    systemPrompt: SYSTEM_PROMPT,
    prompt: classifyPrompt(ticket, repos),
    maxTurns: 2,
    logContext: { ticketKey: ticket.key, phase: 'classify' },
  });
  const text = `${result.transcript}\n${result.text}`;

  const perRepo = new Map<string, readonly string[]>();
  for (const repo of repos) {
    const selected = selectCriteriaForRepo(text, repo.key, all);
    if (selected === null) {
      logger.warn(
        { ticketKey: ticket.key, repo: repo.key },
        'criteria classification produced nothing for repo; using all criteria',
      );
      return fallback;
    }
    perRepo.set(repo.key, selected);
  }

  const dropped = unassignedCriteria(all, perRepo);
  if (dropped.length > 0) {
    logger.warn(
      { ticketKey: ticket.key, dropped },
      'criteria classification left some criteria unassigned; using all criteria',
    );
    return fallback;
  }

  logger.info(
    {
      ticketKey: ticket.key,
      split: Object.fromEntries(
        [...perRepo].map(([k, v]) => [k, v.length]),
      ),
    },
    'acceptance criteria split across repos',
  );
  return perRepo;
}

const SYSTEM_PROMPT = `You assign each acceptance criterion of a software ticket to the repository responsible for satisfying it.

Rules:
- A criterion belongs to a repo only if that repo's code is what makes it true. A backend (Java/Spring) cannot satisfy a UI criterion (visible elements, clicks, URL/browser behaviour, loading spinners); a frontend (React) cannot satisfy a pure data/persistence/endpoint-contract criterion.
- A criterion may belong to MORE THAN ONE repo when both must change (e.g. an end-to-end behaviour needing a new endpoint AND new UI).
- EVERY criterion must be assigned to at least one repo. Do not drop any.
- Judge by where the implementing code lives, not by where the criterion is "mentioned".`;

function classifyPrompt(ticket: Ticket, repos: readonly RepoConfig[]): string {
  const criteria = ticket.acceptanceCriteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join('\n');
  const repoList = repos
    .map((r) => `- ${r.key} (${r.repo}): handles ${r.keywords.join(', ')}`)
    .join('\n');
  return [
    `Ticket ${ticket.key}: ${ticket.summary}`,
    '',
    'Repositories:',
    repoList,
    '',
    'Acceptance criteria (1-based):',
    criteria,
    '',
    'Output ONLY a JSON code block mapping each repo key to the 1-based indexes of the criteria it owns. Every criterion index must appear under at least one repo:',
    '```json',
    `{ "assignments": { ${repos.map((r) => `"${r.key}": [1, 2]`).join(', ')} } }`,
    '```',
  ].join('\n');
}
