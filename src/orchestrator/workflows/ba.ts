import { inngest } from '../inngest.js';
import { runStore } from '../store.js';
import { applyEvent, loadOrCreate } from '../run-store.js';
import { canTransition } from '../state-machine.js';
import { agentLogger } from '../../shared/logger.js';
import { analyzeTicket, refineTicket } from '../../agents/ba/agent.js';
import {
  renderJiraDescription,
  type RefinedTicket,
} from '../../agents/ba/refined-ticket.js';
import { config } from '../../shared/config.js';
import {
  addComment,
  ensureStatus,
  readTicket,
  updateDescription,
} from '../../integrations/jira/client.js';
import { postThreadReply } from '../../integrations/slack/client.js';
import { configuredRepos } from '../../integrations/github/configured-repos.js';
import {
  preparePlanningCheckout,
  ticketSandboxRoot,
} from '../../agents/dev/sandbox.js';

/** How long to wait for a human to answer in Slack before escalating. */
const CLARIFICATION_TIMEOUT = '3d';

/**
 * BA refinement workflow. Runs the BA agent; if it needs clarification it posts
 * to Slack and this workflow pauses durably on `slack/clarification.answered`,
 * resuming when a human replies in the thread. The pause survives restarts —
 * Inngest, not a held-open process, owns the wait.
 */
export const baRefinementWorkflow = inngest.createFunction(
  {
    id: 'ba-refinement',
    concurrency: { key: 'event.data.ticketKey', limit: 1 },
    retries: 3,
  },
  { event: 'ticket/refine.requested' },
  async ({ event, step }) => {
    const { ticketKey } = event.data;
    const log = agentLogger('ba', ticketKey);

    const ticket = await step.run('read-ticket', () => readTicket(ticketKey));

    await step.run('begin-refining', async () => {
      const record = await loadOrCreate(runStore, ticketKey);
      if (canTransition(record.state, 'START_REFINEMENT')) {
        await applyEvent(runStore, record, 'START_REFINEMENT');
      }
    });

    // Read-only checkouts of every configured repo, so the BA answers
    // technical questions (existing endpoints, shapes, formats) from the code
    // and asks the team only genuine business questions.
    const repoDirs = await step.run('prepare-checkouts', async () => {
      const repos = configuredRepos();
      await Promise.all(
        repos.map((repo) =>
          preparePlanningCheckout(
            { owner: repo.owner, repo: repo.repo },
            ticketKey,
            config.GITHUB_BASE_BRANCH,
          ),
        ),
      );
      return repos.map((repo) => repo.repo);
    });
    const checkoutRoot = ticketSandboxRoot(ticketKey);

    log.info('running BA analysis');
    const analysis = await step.run('analyze', () =>
      analyzeTicket(ticket, runStore, checkoutRoot, repoDirs),
    );

    let refined: RefinedTicket | null = analysis.draft;

    if (analysis.askedClarification) {
      log.info('asked clarification on Slack; pausing until answer arrives');
      const answer = await step.waitForEvent('await-clarification', {
        event: 'slack/clarification.answered',
        match: 'data.ticketKey',
        timeout: CLARIFICATION_TIMEOUT,
      });

      if (!answer) {
        await step.run('block-on-timeout', () =>
          blockTicket(
            ticketKey,
            'No Slack answer to the BA agent within the clarification window.',
          ),
        );
        return { outcome: 'blocked-awaiting-clarification' };
      }

      log.info('clarification received; refining ticket');
      refined = await step.run('refine-with-answer', async () => {
        // The clarification pause can outlast the checkout (another ticket's
        // dev run may have re-cloned or disposed the sandbox); re-prepare so
        // the refine session always has the code.
        await Promise.all(
          configuredRepos().map((repo) =>
            preparePlanningCheckout(
              { owner: repo.owner, repo: repo.repo },
              ticketKey,
              config.GITHUB_BASE_BRANCH,
            ),
          ),
        );
        return refineTicket(
          ticket,
          answer.data.answer,
          runStore,
          checkoutRoot,
          repoDirs,
        );
      });
    }

    if (!refined) {
      await step.run('block-no-refinement', () =>
        blockTicket(ticketKey, 'BA agent produced no usable refinement.'),
      );
      return { outcome: 'blocked-no-refinement' };
    }

    await step.run('write-back', () =>
      writeRefinement(ticketKey, refined, ticket.description),
    );

    await step.run('mark-ready', async () => {
      const record = await loadOrCreate(runStore, ticketKey);
      await applyEvent(runStore, record, 'REFINEMENT_COMPLETE');
    });

    log.info('ticket refined and ready for dev pickup');
    return { outcome: 'ready-for-dev' };
  },
);

/**
 * Writes the refinement back to Jira and moves the ticket into IN_PROGRESS so
 * the dev agent picks it up automatically on the next poll. The handoff is
 * status-driven (not a direct event) so it stays idempotent: the poller only
 * fires the dev agent once, when the ticket is IN_PROGRESS and its run record is
 * still READY_FOR_DEV.
 */
async function writeRefinement(
  ticketKey: string,
  refined: RefinedTicket,
  originalDescription: string,
): Promise<void> {
  await updateDescription(
    ticketKey,
    renderJiraDescription(refined, originalDescription),
  );
  await ensureStatus(ticketKey, config.JIRA_STATUS_IN_PROGRESS);
  await addComment(
    ticketKey,
    `Refined and moved to "${config.JIRA_STATUS_IN_PROGRESS}". The dev agent will pick it up.`,
  );
  const record = await loadOrCreate(runStore, ticketKey);
  if (record.slackThreadTs) {
    await postThreadReply(
      record.slackThreadTs,
      `Thanks — ${ticketKey} is refined and moved to "${config.JIRA_STATUS_IN_PROGRESS}". The dev agent will take it from here.`,
    );
  }
}

async function blockTicket(ticketKey: string, reason: string): Promise<void> {
  const record = await loadOrCreate(runStore, ticketKey);
  if (canTransition(record.state, 'BLOCK')) {
    await applyEvent(runStore, record, 'BLOCK', { blockedReason: reason });
  }
  await addComment(ticketKey, `:warning: BA refinement blocked: ${reason}`);
}
