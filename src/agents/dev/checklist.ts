import { z } from 'zod';

/**
 * The dev agent's acceptance-criteria checklist. Before a PR can be opened the
 * agent must map every criterion to at least one test and confirm it is
 * satisfied. {@link evaluateChecklist} re-checks that claim against the ticket's
 * criteria so the agent cannot silently drop or fabricate one: a criterion that
 * is unmapped, unsatisfied, or untestable blocks the PR and triggers escalation.
 */

export const checklistItemSchema = z.object({
  criterion: z.string().min(1),
  /** A test that exercises this criterion, e.g. `UserServiceTest#resetsPassword`. */
  testReference: z.string(),
  satisfied: z.boolean(),
  /** Set when the criterion cannot be expressed as a test as written. */
  untestable: z.boolean().default(false),
});

export const checklistSchema = z.object({
  items: z.array(checklistItemSchema),
  affectedRepos: z.array(z.string().min(1)).min(1),
});

export type Checklist = z.infer<typeof checklistSchema>;
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

const JSON_BLOCK = /```(?:json)?\s*([\s\S]*?)```/g;

/** Extracts and validates the last checklist JSON block from agent output. */
export function parseChecklist(text: string): Checklist | null {
  const blocks = [...text.matchAll(JSON_BLOCK)].map((match) => match[1]);
  for (const block of blocks.reverse()) {
    if (!block) {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(block);
    } catch {
      continue;
    }
    const result = checklistSchema.safeParse(json);
    if (result.success) {
      return result.data;
    }
  }
  return null;
}

export interface ChecklistEvaluation {
  readonly complete: boolean;
  readonly problems: readonly string[];
}

const normalize = (text: string): string =>
  text.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Verifies a checklist against the ticket's acceptance criteria. The checklist
 * is complete only when every criterion is present, mapped to a test, and
 * marked satisfied. Untestable criteria are surfaced as problems rather than
 * silently passed.
 */
export function evaluateChecklist(
  ticketCriteria: readonly string[],
  checklist: Checklist,
): ChecklistEvaluation {
  const problems: string[] = [];
  const covered = new Map(
    checklist.items.map((item) => [normalize(item.criterion), item]),
  );

  for (const criterion of ticketCriteria) {
    const item = covered.get(normalize(criterion));
    if (!item) {
      problems.push(`No checklist entry for criterion: "${criterion}".`);
      continue;
    }
    if (item.untestable) {
      problems.push(`Criterion is untestable as written: "${criterion}".`);
      continue;
    }
    if (item.testReference.trim() === '') {
      problems.push(`No test mapped to criterion: "${criterion}".`);
      continue;
    }
    if (!item.satisfied) {
      problems.push(`Criterion not yet satisfied: "${criterion}".`);
    }
  }

  return { complete: problems.length === 0, problems };
}
