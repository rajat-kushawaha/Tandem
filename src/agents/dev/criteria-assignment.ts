import { z } from 'zod';

/**
 * Assigns each acceptance criterion to the repo(s) responsible for it, so a repo
 * is verified ONLY against the criteria it can actually satisfy. A backend
 * (Spring Boot) cannot satisfy a frontend criterion like "clicking Next updates
 * the URL"; without this split it would honestly mark that criterion untestable
 * and loop forever on an impossible task.
 *
 * Pure parsing kept separate from the LLM call so it is unit-testable without
 * pulling in config or the Agent SDK.
 */

const assignmentSchema = z.object({
  /**
   * Map of repo key → indexes (1-based) of the criteria that repo owns. Any
   * integer is accepted here; out-of-range values are filtered when selecting,
   * so one bad index (e.g. 0) doesn't reject the whole assignment.
   */
  assignments: z.record(z.string(), z.array(z.number().int())),
});

const JSON_BLOCK = /```(?:json)?\s*([\s\S]*?)```/g;

/**
 * Selects the criteria assigned to one repo from the model's output. Indexes are
 * 1-based in the model output (matching the numbered list it was shown) and
 * mapped back to the criteria array. Out-of-range indexes are ignored.
 */
export function selectCriteriaForRepo(
  text: string,
  repoKey: string,
  allCriteria: readonly string[],
): readonly string[] | null {
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
    const parsed = assignmentSchema.safeParse(json);
    if (!parsed.success) {
      continue;
    }
    const indexes = parsed.data.assignments[repoKey];
    if (!indexes) {
      return null; // model produced assignments but none for this repo
    }
    const selected = indexes
      .filter((i) => i >= 1 && i <= allCriteria.length)
      .map((i) => allCriteria[i - 1]!);
    return [...new Set(selected)];
  }
  return null;
}

/**
 * Verifies the union of all repos' assigned criteria covers every criterion —
 * nothing was dropped. Returns the criteria left unassigned to ANY repo.
 */
export function unassignedCriteria(
  allCriteria: readonly string[],
  perRepo: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const covered = new Set<string>();
  for (const criteria of perRepo.values()) {
    for (const c of criteria) {
      covered.add(c);
    }
  }
  return allCriteria.filter((c) => !covered.has(c));
}
