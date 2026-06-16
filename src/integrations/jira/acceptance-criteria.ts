/**
 * Extracts acceptance criteria from a Jira description.
 *
 * Convention: criteria live as a bulleted or numbered list beneath a heading
 * that mentions "Acceptance Criteria". We parse only that block so unrelated
 * bullets elsewhere in the description are not mistaken for criteria. The dev
 * agent turns each returned line into a checklist item that must map to a test.
 */

const HEADING = /acceptance\s+criteria/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;
const ANY_HEADING = /^\s*(?:#{1,6}\s+|h[1-6]\.\s+|\*\*[^*]+\*\*\s*$)/i;

export function parseAcceptanceCriteria(
  description: string,
): readonly string[] {
  const lines = description.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => HEADING.test(line));
  if (headingIndex === -1) {
    return [];
  }

  const criteria: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const bullet = BULLET.exec(line);
    if (bullet?.[1]) {
      criteria.push(bullet[1].trim());
      continue;
    }
    if (line.trim() === '') {
      continue;
    }
    // A new heading ends the acceptance-criteria block.
    if (ANY_HEADING.test(line)) {
      break;
    }
  }
  return criteria;
}
