#!/usr/bin/env node
import { spawn } from 'node:child_process';

/**
 * Launches the Inngest server in PERSISTENT self-hosted mode (`inngest start`),
 * replacing the ephemeral `inngest dev`: run state and history are written to
 * .inngest/ (SQLite + queue snapshots), so workflows survive a restart of the
 * Inngest server, the orchestrator, or both — no more orphaned tickets when
 * both processes bounce mid-run.
 *
 * Keys come from .env (loaded by the npm script via --env-file): the server
 * and the SDK must share INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY, and the SDK
 * needs INNGEST_BASE_URL=http://127.0.0.1:8288 to send events here instead of
 * Inngest Cloud.
 */
const { INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY } = process.env;
if (!INNGEST_EVENT_KEY || !INNGEST_SIGNING_KEY) {
  process.stderr.write(
    'INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY must be set (see .env).\n',
  );
  process.exit(1);
}

const child = spawn(
  'npx',
  [
    'inngest-cli@latest',
    'start',
    '-u',
    'http://localhost:3000/api/inngest',
    '--sqlite-dir',
    '.inngest',
    '--event-key',
    INNGEST_EVENT_KEY,
    '--signing-key',
    INNGEST_SIGNING_KEY,
  ],
  { stdio: ['inherit', 'inherit', 'pipe'] },
);

// Inngest's self-hosted server sends internal health-check events to itself using
// a built-in key that doesn't match the user-supplied --event-key, producing
// "rejecting event; event key not recognized" noise on stderr. These are harmless
// (tracked upstream: https://github.com/inngest/inngest/issues/3129); suppress them
// while forwarding everything else.
child.stderr.on('data', (chunk) => {
  const line = chunk.toString();
  if (!line.includes('rejecting event; event key not recognized')) {
    process.stderr.write(chunk);
  }
});

child.on('exit', (code) => process.exit(code ?? 1));
