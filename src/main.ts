import http from 'node:http';
import { serve } from 'inngest/node';
import { config } from './shared/config.js';
import { logger } from './shared/logger.js';
import { inngest } from './orchestrator/inngest.js';
import { functions } from './orchestrator/functions.js';
import { runWatchdogOnce } from './orchestrator/watchdog-runner.js';
import { startJiraPoller } from './integrations/jira/poller.js';
import { pollReviewsOnce } from './integrations/github/review-poller.js';
import { pollMergesOnce } from './integrations/github/merge-poller.js';
import { createSlackSocketClient } from './integrations/slack/socket.js';
import { reconcileClarificationThreads } from './integrations/slack/reconcile.js';

/**
 * Single-process entrypoint that runs the whole orchestrator locally:
 *  - serves the Inngest workflows over HTTP (the Inngest dev server invokes them),
 *  - polls Jira for tickets entering actionable statuses,
 *  - polls open PRs for reviewer verdicts (the no-public-URL path) and for
 *    human merges (which close tickets out),
 *  - re-triggers tickets the watchdog finds stalled (self-healing),
 *  - listens on Slack Socket Mode for clarification answers, recovering any
 *    that arrived while the orchestrator was down.
 *
 * Pollers and the Socket Mode client share the in-process run store; a
 * production deployment splits these into separate services over a shared,
 * durable store.
 */
const PORT = 3000;

async function main(): Promise<void> {
  const handler = serve({ client: inngest, functions });
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/inngest')) {
      void handler(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'Inngest functions served at /api/inngest');
  });

  startJiraPoller();

  setInterval(() => {
    pollReviewsOnce().catch((error: unknown) => {
      logger.error({ error }, 'review poll failed');
    });
    pollMergesOnce().catch((error: unknown) => {
      logger.error({ error }, 'merge poll failed');
    });
    runWatchdogOnce().catch((error: unknown) => {
      logger.error({ error }, 'watchdog run failed');
    });
  }, config.JIRA_POLL_INTERVAL_MS);

  const slack = createSlackSocketClient();
  await slack.start();
  logger.info('Slack Socket Mode client connected');

  // Recover clarification answers humans posted while we were down — Socket
  // Mode only delivers live messages, so missed replies exist only in Slack's
  // history until this re-reads the open threads.
  reconcileClarificationThreads().catch((error: unknown) => {
    logger.warn({ error }, 'slack thread reconciliation failed');
  });
}

main().catch((error: unknown) => {
  logger.error({ error }, 'fatal: orchestrator failed to start');
  process.exit(1);
});
