import { inngest } from '../src/orchestrator/inngest.js';

/**
 * Manually re-trigger the dev agent for a ticket, e.g. after fixing a repo so
 * its gates pass:
 *
 *   npm run dev:trigger -- CR-22
 *
 * Sends `ticket/dev.requested` to the running orchestrator (via the Inngest dev
 * server). The dev workflow's RESTART_DEV path resets the ticket to IN_PROGRESS
 * and re-runs idempotently — existing branches are force-updated and an open PR
 * is reused rather than re-created.
 */
async function main(): Promise<void> {
  const ticketKey = process.argv[2];
  if (!ticketKey) {
    process.stderr.write('usage: npm run dev:trigger -- <TICKET-KEY>\n');
    process.exit(1);
  }

  await inngest.send({
    name: 'ticket/dev.requested',
    data: { ticketKey },
  });
  process.stdout.write(`sent ticket/dev.requested for ${ticketKey}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`failed to send event: ${String(error)}\n`);
  process.exit(1);
});
