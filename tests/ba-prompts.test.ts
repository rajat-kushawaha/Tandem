import { describe, expect, it } from 'vitest';
import {
  BA_SYSTEM_PROMPT,
  MUST_ASK_RULES,
  analyzePrompt,
  refinePrompt,
} from '../src/agents/ba/prompts.js';
import type { Ticket } from '../src/shared/types.js';

const ticket: Ticket = {
  key: 'AGENT-1',
  summary: 'Sync user profile across services',
  description: 'Pull the profile from the upstream source and show it in the UI.',
  status: 'Backlog',
  acceptanceCriteria: [],
  url: 'https://example.atlassian.net/browse/AGENT-1',
};

describe('BA system prompt — must-ask rules', () => {
  it('embeds every must-ask category verbatim in the system prompt', () => {
    // Pins the contract: a future prompt edit cannot silently drop a category
    // and let the agent assume away an expensive ambiguity.
    for (const rule of MUST_ASK_RULES) {
      expect(BA_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it('covers the three high-cost ambiguity classes', () => {
    const joined = MUST_ASK_RULES.join(' ').toLowerCase();
    expect(joined).toContain('data source'); // undefined data source / API
    expect(joined).toContain('both repos'); // cross-repo contract
    expect(joined).toContain('contradicts'); // internal contradiction
    expect(MUST_ASK_RULES).toHaveLength(3);
  });

  it('frames must-ask as overriding the prefer-assumptions default', () => {
    expect(BA_SYSTEM_PROMPT).toMatch(/MUST ask/);
    expect(BA_SYSTEM_PROMPT).toMatch(/prefer reasonable assumptions/i);
  });
});

const repoDirs = ['revelio-api', 'revelio-ui'];

describe('BA prompt builders', () => {
  it('analyze prompt carries the ticket and the ask-or-refine instruction', () => {
    const p = analyzePrompt(ticket, repoDirs);
    expect(p).toContain('AGENT-1');
    expect(p).toContain('Sync user profile across services');
    expect(p).toMatch(/ask_clarification/);
  });

  it('analyze prompt lists the code checkouts and demands code-first answers', () => {
    const p = analyzePrompt(ticket, repoDirs);
    expect(p).toContain('./revelio-api');
    expect(p).toContain('./revelio-ui');
    expect(p).toMatch(/explore the code checkouts first/i);
  });

  it('refine prompt includes the answers and forbids further questions', () => {
    const p = refinePrompt(
      ticket,
      'Use the v2 profile API; backend owns it.',
      repoDirs,
    );
    expect(p).toContain('Use the v2 profile API; backend owns it.');
    expect(p).toMatch(/Do not ask further questions/i);
  });
});

describe('BA system prompt — code first', () => {
  it('forbids asking the team questions the code answers', () => {
    expect(BA_SYSTEM_PROMPT).toMatch(/CODE FIRST/);
    expect(BA_SYSTEM_PROMPT).toMatch(/must never reach Slack/i);
  });
});

describe('BA system prompt — testable acceptance criteria', () => {
  it('requires acceptance criteria to be positive and testable', () => {
    // Pins Option A: scope exclusions / "do not change X" must not land in
    // acceptanceCriteria, where they become an untestable item that blocks the
    // dev agent's checklist and traps it in a re-verify loop.
    expect(BA_SYSTEM_PROMPT).toMatch(/POSITIVE AND TESTABLE/);
    expect(BA_SYSTEM_PROMPT).toMatch(/never in acceptanceCriteria/);
    expect(BA_SYSTEM_PROMPT).toMatch(/untestable/i);
    expect(BA_SYSTEM_PROMPT).toMatch(/technicalNotes/);
  });
});
