import { z } from 'zod';

/**
 * Pure parsing for the cross-repo planning model's output. Kept separate from
 * {@link import('./select-repos.js')} so it is unit-testable without pulling in
 * environment config or the Agent SDK.
 */

/** One repo's slice of the cross-repo plan: that it changes, and what changes. */
export interface RepoPlanEntry {
  readonly key: string;
  readonly changes: readonly string[];
}

// Accept both the rich form ({ key, changes }) and a bare key string, so a
// model that ignores the changes field still yields a usable repo selection.
const entrySchema = z.union([
  z.object({
    key: z.string(),
    changes: z.array(z.string()).default([]),
  }),
  z.string().transform((key) => ({ key, changes: [] as string[] })),
]);
const planSchema = z.object({ repos: z.array(entrySchema) });
const JSON_BLOCK = /```(?:json)?\s*([\s\S]*?)```/g;

/** Extracts the planned repo entries, intersected with the known repo keys. */
export function parseRepoPlan(
  text: string,
  knownKeys: readonly string[],
): readonly RepoPlanEntry[] {
  const known = new Set(knownKeys);
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
    const parsed = planSchema.safeParse(json);
    if (!parsed.success) {
      continue;
    }
    const byKey = new Map<string, RepoPlanEntry>();
    for (const entry of parsed.data.repos) {
      if (!known.has(entry.key) || byKey.has(entry.key)) {
        continue;
      }
      byKey.set(entry.key, entry);
    }
    return [...byKey.values()];
  }
  return [];
}
