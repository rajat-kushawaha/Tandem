import type { Ticket } from '../../shared/types.js';
import type { Stack } from './gates.js';

/**
 * Prompts for the dev agent. Scope discipline and the gate-on-green / checklist
 * contract are stated up front so the agent's own behaviour reinforces the
 * orchestrator's guardrails rather than fighting them.
 */

export const DEV_SYSTEM_PROMPT = `You are implementing a single Jira ticket in a disposable sandbox checkout. The repo's CLAUDE.md (if present) carries its conventions and build commands — follow it.

Tandem-specific rules (these are the constraints this workflow adds; your general engineering judgement and the project's own conventions still apply):
- Stay strictly in scope. Touch only what the ticket requires; do not refactor unrelated code. Keep the diff small and focused.
- Use the ticket's literal content EXACTLY as given. When it specifies concrete values — titles, copy text, colors, names, counts, enumerated items — implement every one verbatim. Never substitute placeholders, drop or merge enumerated items, or re-architect inline content into a data source (API, database) the ticket doesn't ask for.
- Do not modify build, lint, test, or formatter configuration or their scripts (e.g. .eslintrc*, eslint.config.*, tsconfig.json, the "scripts" in package.json, build.gradle(.kts), pom.xml) unless the ticket explicitly requires it.
- Fix only the gate failures YOUR change caused. Failures that already exist on the base branch before your change — errors in files you did not touch, a missing auto-generated file, broken tooling — are NOT yours to fix; the orchestrator already knows about them. Do NOT chase them and do NOT patch tooling to mask them.
- BUT a test that PASSED on the base and now fails BECAUSE of your change IS yours to fix — a regression you caused, even in a file you did not write. Common case: you add a new export to a module existing tests mock, and a test fails with "X is not a function" / "undefined" because the mock hard-codes the old export list. Fix such cascades at the ROOT: make the mock resilient with importOriginal so it keeps real exports and overrides only what the test needs — e.g. \`vi.mock('@/x', async (importOriginal) => ({ ...(await importOriginal()), getThing: vi.fn() }))\` — rather than hand-adding every new export into each mock.
- Cover each acceptance criterion with ONE focused test (extend an existing test where natural). Do not write an exhaustive suite — a handful of clear tests per criterion, not dozens.
- DEFINITION OF DONE for this workflow: run ALL the gates yourself and see them pass — (1) lint, (2) build/typecheck, (3) tests, and (4) the repo's \`npm run smoke\` script when defined. Passing only tests is NOT done; a change that greens tests but breaks lint or build is a failed attempt. For UI changes, also boot the app and load every page you touched (headless browser, or curl + checking the server log) — a render crash with green tests is still a failure. Kill any server you start.
- If this is a RESUME, your earlier changes are ALREADY in this checkout. Run \`git status\` and \`git diff\` to see what you did — do NOT start over or re-explore the whole repo. Use relative paths from the working directory.
- Never push to main and never merge. Work only on the feature branch in your working directory.
- ALWAYS finish by emitting the checklist JSON block (see the task), even if you could not make everything green. Mark unsatisfied criteria as not satisfied rather than omitting the checklist — a missing checklist is itself treated as a failed attempt.`;

/** Changes already made in another repository for the same ticket. */
export interface PriorRepoWork {
  readonly repo: string;
  readonly diff: string;
}

/** Another repo's slice of the cross-repo plan, shown for scope awareness. */
export interface OtherRepoPlan {
  readonly repo: string;
  readonly changes: readonly string[];
}

/**
 * Cross-run context for one repo's dev work: why this run is happening
 * (reviewer feedback on an open PR means it is a rework), what the ticket
 * already changed elsewhere (other repos' diffs, whose contracts must be
 * honoured), and this repo's slice of the code-aware cross-repo plan.
 */
export interface RepoDevContext {
  readonly reviewFeedback: readonly string[];
  readonly priorWork: readonly PriorRepoWork[];
  /** The planner's todo for THIS repo (empty when planning was skipped). */
  readonly plannedChanges: readonly string[];
  /** What the plan assigns to OTHER repos — out of scope here. */
  readonly otherRepoPlans: readonly OtherRepoPlan[];
}

/** A first, plain run: no reviewer feedback, no other-repo work to honour. */
export const EMPTY_DEV_CONTEXT: RepoDevContext = {
  reviewFeedback: [],
  priorWork: [],
  plannedChanges: [],
  otherRepoPlans: [],
};

export interface ImplementPromptInput {
  readonly ticket: Ticket;
  readonly repoName: string;
  readonly stack: Stack;
  /** The acceptance criteria THIS repo is responsible for. */
  readonly criteria: readonly string[];
  /** Gaps the orchestrator's independent verification found (resume). */
  readonly priorProblems: readonly string[];
  /** Reviewer feedback on the open PR (rework after changes requested). */
  readonly reviewFeedback: readonly string[];
  /** Diffs already shipped in other repos for this ticket. */
  readonly priorWork: readonly PriorRepoWork[];
  /** The cross-repo planner's todo for THIS repo. */
  readonly plannedChanges: readonly string[];
  /** What the plan assigns to other repos (scope awareness only). */
  readonly otherRepoPlans: readonly OtherRepoPlan[];
}

export function implementPrompt(input: ImplementPromptInput): string {
  const { ticket, repoName, stack } = input;
  const criteria = input.criteria
    .map((criterion, index) => `${index + 1}. ${criterion}`)
    .join('\n');

  const resuming = input.priorProblems.length > 0;
  const retrySection = resuming
    ? [
        '',
        'This is a RESUME. Your earlier work is already on disk in this same checkout — do NOT start over or re-explore the whole repo. Independent verification found ONLY these specific gaps; fix exactly these and re-run the gates:',
        ...input.priorProblems.map((problem) => `- ${problem}`),
      ].join('\n')
    : '';

  const firstRunSteps = [
    '',
    'Work like a senior engineer in ONE focused session — you have a generous turn budget, so do the whole job here rather than leaving it half-done:',
    '1. Briefly survey the codebase: list the tree once and open only the few files relevant to this ticket (the route/page, a similar component, an example test). Do not read everything; use TodoWrite to track your steps.',
    '2. Implement the change, then add ONE focused test per acceptance criterion (not an exhaustive suite).',
    '3. Run ALL the gates yourself and iterate until each passes for YOUR code: `npm run lint`, `npm run build`, `npm test`, and `npm run smoke` if the repo defines it. A test your change broke is yours to fix (prefer fixing brittle mocks at the root with importOriginal); failures that pre-date your change are not.',
    '4. For UI changes, also boot the app and load the pages you touched (headless browser or dev server + log check) — a render crash with green tests is still a failed attempt.',
    '5. You are NOT done until every gate is green and the touched pages actually render.',
  ].join('\n');

  return [
    `Implement ticket ${ticket.key} in the "${repoName}" repository (${stack}).`,
    `You are in a checkout on branch feature/${ticket.key}.`,
    '',
    `Summary: ${ticket.summary}`,
    '',
    ticket.description,
    '',
    'Acceptance criteria:',
    criteria,
    planSection(input.plannedChanges, input.otherRepoPlans),
    reviewFeedbackSection(input.reviewFeedback),
    priorWorkSection(input.priorWork),
    resuming ? retrySection : firstRunSteps,
    '',
    'CRITICAL — your VERY LAST message must be the checklist JSON block below (a tool call must not be the last thing you do), mapping each criterion to its test. Set "satisfied": false for any you could not complete. A missing checklist fails the run:',
    checklistTemplate(repoName),
  ]
    .filter((section): section is string => section !== null)
    .join('\n');
}

/**
 * Rendered when the code-aware planner produced a cross-repo plan: this repo's
 * todo, plus what other repos handle — so the agent neither implements another
 * repo's work locally (e.g. hardcoding data the backend will serve) nor skips
 * its own slice assuming someone else does it.
 */
function planSection(
  plannedChanges: readonly string[],
  otherRepoPlans: readonly OtherRepoPlan[],
): string | null {
  const others = otherRepoPlans.filter((plan) => plan.changes.length > 0);
  if (plannedChanges.length === 0 && others.length === 0) {
    return null;
  }
  const parts: string[] = [''];
  if (plannedChanges.length > 0) {
    parts.push(
      'Cross-repo plan — the changes THIS repo must make (a planner already inspected every repo of this ticket; follow this plan):',
      ...plannedChanges.map((change) => `- ${change}`),
    );
  }
  for (const plan of others) {
    parts.push(
      `Changes handled in "${plan.repo}" — do NOT implement these here; rely on them being done there:`,
      ...plan.changes.map((change) => `- ${change}`),
    );
  }
  return parts.join('\n');
}

/**
 * Rendered on a REWORK: the previous implementation is already on the branch
 * and a reviewer asked for changes. The agent's job is to address the feedback,
 * not to redo the ticket — redoing it would also orphan the inline comments.
 */
function reviewFeedbackSection(feedback: readonly string[]): string | null {
  if (feedback.length === 0) {
    return null;
  }
  return [
    '',
    'REWORK — a reviewer reviewed the open PR for this branch and requested changes. Your previous implementation is ALREADY in this checkout. Do NOT re-implement the ticket; address each piece of feedback below with the smallest sensible change (some items may already be fixed — verify before changing), then re-run the gates:',
    ...feedback.map((item) => `- ${item}`),
  ].join('\n');
}

/**
 * Rendered when other repos already changed for this ticket: their diffs are
 * the source of truth for any cross-repo contract (endpoint paths, payload
 * shapes, status codes). The agent must conform to them, not invent its own.
 */
function priorWorkSection(priorWork: readonly PriorRepoWork[]): string | null {
  if (priorWork.length === 0) {
    return null;
  }
  const sections = priorWork.map((work) =>
    [
      `Changes already made in "${work.repo}" for this ticket — treat every contract in them (endpoints, request/response shapes, field names) as FIXED and conform to it exactly:`,
      '```diff',
      work.diff,
      '```',
    ].join('\n'),
  );
  return ['', ...sections].join('\n');
}

/** The checklist JSON template the agent must emit, shared across prompts. */
function checklistTemplate(repoName: string): string {
  return [
    '```json',
    '{',
    '  "items": [',
    '    { "criterion": "<verbatim criterion>", "testReference": "<Test#method>", "satisfied": true, "untestable": false }',
    '  ],',
    `  "affectedRepos": ["${repoName}"]`,
    '}',
    '```',
  ].join('\n');
}

/**
 * Prompt for the focused checklist-recovery call: the implementation already
 * happened and the gates passed; the agent only needs to inspect the diff and
 * emit the checklist. No new code changes.
 */
export function checklistOnlyPrompt(
  ticket: Ticket,
  repoName: string,
  acceptanceCriteria: readonly string[],
): string {
  const criteria = acceptanceCriteria
    .map((criterion, index) => `${index + 1}. ${criterion}`)
    .join('\n');
  return [
    `The implementation for ticket ${ticket.key} in "${repoName}" is already complete and the gates pass.`,
    'Do NOT change any code. Inspect the changes (e.g. `git diff`) and the tests that exist, then map each acceptance criterion to the test that covers it.',
    '',
    'Acceptance criteria:',
    criteria,
    '',
    'Output ONLY the checklist JSON block (set "satisfied": false only if a criterion genuinely is not covered):',
    checklistTemplate(repoName),
  ].join('\n');
}
