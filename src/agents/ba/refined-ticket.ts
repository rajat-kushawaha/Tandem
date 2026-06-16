import { z } from 'zod';

/**
 * The BA agent's structured output. It emits this as a single fenced JSON block
 * once the ticket is fully refined. Parsing it (rather than free text) lets the
 * workflow write a deterministic, validated description back to Jira.
 */
export const refinedTicketSchema = z.object({
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  definitionOfReady: z.array(z.string().min(1)),
  technicalNotes: z.array(z.string()).default([]),
  refinedDescription: z.string().min(1),
});

export type RefinedTicket = z.infer<typeof refinedTicketSchema>;

const JSON_BLOCK = /```(?:json)?\s*([\s\S]*?)```/g;

/**
 * Extracts and validates the last JSON code block from the agent's output.
 * Returns null when no valid refined ticket is present (e.g. the agent chose to
 * ask clarifying questions instead).
 */
export function parseRefinedTicket(text: string): RefinedTicket | null {
  const blocks = [...text.matchAll(JSON_BLOCK)].map((match) => match[1]);
  for (const block of blocks.reverse()) {
    if (!block) {
      continue;
    }
    const parsed = safeParseJson(block);
    const result = refinedTicketSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
  }
  return null;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Renders a refined ticket into the Jira description we write back. The
 * original description is appended verbatim so the write-back is never lossy:
 * even if the model's refinedDescription drops a concrete detail, the source
 * of truth stays on the ticket for the dev agent and humans.
 */
export function renderJiraDescription(
  refined: RefinedTicket,
  originalDescription: string,
): string {
  const section = (heading: string, items: readonly string[]): string =>
    items.length === 0
      ? ''
      : `\nh2. ${heading}\n${items.map((item) => `- ${item}`).join('\n')}\n`;

  const original = originalDescription.trim();
  return [
    refined.refinedDescription.trim(),
    section('Acceptance Criteria', refined.acceptanceCriteria),
    section('Definition of Ready', refined.definitionOfReady),
    section('Technical Notes', refined.technicalNotes),
    original === '' ? '' : `\nh2. Original Description (verbatim)\n${original}\n`,
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}
