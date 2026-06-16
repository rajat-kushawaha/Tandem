import { z } from 'zod';
import type { Ticket } from '../../shared/types.js';
import { parseAcceptanceCriteria } from './acceptance-criteria.js';

/**
 * Boundary validation for Jira REST responses. We use the v2 REST API so the
 * description comes back as plain text (wiki markup) rather than ADF JSON,
 * which keeps acceptance-criteria parsing simple and auditable.
 */

export const jiraIssueSchema = z.object({
  key: z.string().min(1),
  fields: z.object({
    summary: z.string(),
    description: z.string().nullable().default(null),
    status: z.object({ name: z.string() }),
  }),
});

export type JiraIssue = z.infer<typeof jiraIssueSchema>;

export const jiraSearchSchema = z.object({
  issues: z.array(jiraIssueSchema),
});

export const jiraTransitionsSchema = z.object({
  transitions: z.array(z.object({ id: z.string(), name: z.string() })),
});

export function toTicket(issue: JiraIssue, siteUrl: string): Ticket {
  const description = issue.fields.description ?? '';
  return {
    key: issue.key,
    summary: issue.fields.summary,
    description,
    status: issue.fields.status.name,
    acceptanceCriteria: parseAcceptanceCriteria(description),
    url: `${siteUrl.replace(/\/$/, '')}/browse/${issue.key}`,
  };
}
