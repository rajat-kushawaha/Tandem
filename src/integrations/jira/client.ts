import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import type { Ticket } from '../../shared/types.js';
import {
  jiraIssueSchema,
  jiraSearchSchema,
  jiraTransitionsSchema,
  toTicket,
} from './schemas.js';

/**
 * Deterministic Jira operations driven by the orchestrator (read, comment,
 * update description, transition status, search by JQL). The BA agent reasons
 * over Jira through the Rovo MCP server; these REST calls are the audited,
 * non-agentic writes the orchestrator performs itself.
 *
 * Auth: HTTP Basic with `email:api-token`, the supported headless scheme.
 *
 * API versions: search uses the v3 "enhanced JQL" endpoint
 * (`/rest/api/3/search/jql`) because `/rest/api/2/search` has been removed.
 * Single-issue reads/writes stay on v2, whose `description` is plain text (v3
 * returns ADF JSON) — which keeps acceptance-criteria parsing simple.
 */

const FIELDS = 'summary,description,status';
// Search only needs status (+ summary). Requesting `description` from v3 would
// return ADF JSON and break the plain-text contract, so it is omitted here.
const SEARCH_FIELDS = 'summary,status';

function authHeader(): string {
  const token = Buffer.from(
    `${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`,
  ).toString('base64');
  return `Basic ${token}`;
}

async function jiraFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${config.JIRA_SITE_URL.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Jira ${init.method ?? 'GET'} ${path} failed: ${response.status} ${response.statusText} — ${body}`,
    );
  }
  return response;
}

export async function searchByJql(jql: string): Promise<Ticket[]> {
  const params = new URLSearchParams({
    jql,
    fields: SEARCH_FIELDS,
    maxResults: '100',
  });
  const response = await jiraFetch(
    `/rest/api/3/search/jql?${params.toString()}`,
  );
  const { issues } = jiraSearchSchema.parse(await response.json());
  return issues.map((issue) => toTicket(issue, config.JIRA_SITE_URL));
}

export async function readTicket(key: string): Promise<Ticket> {
  const response = await jiraFetch(`/rest/api/2/issue/${key}?fields=${FIELDS}`);
  const issue = jiraIssueSchema.parse(await response.json());
  return toTicket(issue, config.JIRA_SITE_URL);
}

export async function updateDescription(
  key: string,
  description: string,
): Promise<void> {
  await jiraFetch(`/rest/api/2/issue/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ fields: { description } }),
  });
}

export async function addComment(key: string, body: string): Promise<void> {
  await jiraFetch(`/rest/api/2/issue/${key}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

/**
 * Transitions an issue to the named status. Jira identifies transitions by id,
 * so we resolve the id by name first and fail loudly if the target status is
 * not reachable from the issue's current status.
 */
export async function transitionStatus(
  key: string,
  statusName: string,
): Promise<void> {
  const response = await jiraFetch(`/rest/api/2/issue/${key}/transitions`);
  const { transitions } = jiraTransitionsSchema.parse(await response.json());
  const target = transitions.find(
    (transition) => transition.name.toLowerCase() === statusName.toLowerCase(),
  );
  if (!target) {
    const available = transitions.map((t) => t.name).join(', ');
    throw new Error(
      `No transition to "${statusName}" is available for ${key}. Available: ${available || '(none)'}.`,
    );
  }
  await jiraFetch(`/rest/api/2/issue/${key}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: target.id } }),
  });
}

/**
 * Idempotently moves an issue to the named status: a no-op if it is already
 * there, and a warning (not an error) if the board offers no transition to it,
 * so a board-config quirk never blocks the pipeline.
 */
export async function ensureStatus(
  key: string,
  statusName: string,
): Promise<void> {
  const current = await readTicket(key);
  if (current.status.toLowerCase() === statusName.toLowerCase()) {
    return;
  }
  try {
    await transitionStatus(key, statusName);
  } catch (error) {
    logger.warn(
      { ticketKey: key, statusName, error },
      'could not transition Jira status; leaving it unchanged',
    );
    // The orchestrator's internal state has advanced but the board hasn't, so
    // they now diverge. Surface that on the ticket so a human sees it instead
    // of silently trusting a stale column. Best-effort: a comment failure must
    // not mask the original transition problem.
    try {
      await addComment(
        key,
        `:warning: The orchestrator expected this ticket in "${statusName}" but ` +
          `could not transition it (the board may offer no such transition from ` +
          `its current column). Internal state and the Jira board have diverged — ` +
          `please move it manually.`,
      );
    } catch (commentError) {
      logger.warn(
        { ticketKey: key, error: commentError },
        'could not post status-divergence comment',
      );
    }
  }
}
