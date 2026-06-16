#!/usr/bin/env node
/**
 * Per-agent log viewer. Reads the orchestrator's JSON log stream on stdin,
 * keeps only the lines for one agent role, and prints them in a compact,
 * human-readable form — so each agent can be watched in its own terminal:
 *
 *   npm start | node scripts/log-filter.mjs dev
 *
 * Filtering is by the `agent` field that the workflow and SDK loggers bind
 * (see src/shared/logger.ts: agentLogger / claude.ts). Lines with no `agent`
 * field (pure infra: pollers, server boot) are shown only in the unfiltered
 * `all` mode so nothing is silently lost.
 *
 * Pure Node, no dependencies, line-buffered so it streams live.
 */
import { createInterface } from 'node:readline';

const ROLES = new Set(['ba', 'dev', 'reviewer', 'all']);
const role = process.argv[2] ?? 'all';
if (!ROLES.has(role)) {
  process.stderr.write(
    `usage: log-filter.mjs <ba|dev|reviewer|all>\n  got: ${role}\n`,
  );
  process.exit(2);
}

const LEVELS = { 60: 'FATAL', 50: 'ERROR', 40: 'WARN', 30: 'INFO', 20: 'DEBUG', 10: 'TRACE' };
const COLOR = { FATAL: 41, ERROR: 31, WARN: 33, INFO: 32, DEBUG: 36, TRACE: 90 };
const useColor = process.stdout.isTTY;
const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text);

function format(rec) {
  const lvl = LEVELS[rec.level] ?? String(rec.level ?? '?');
  const time = (rec.time ?? '').toString().slice(11, 19); // HH:MM:SS
  const head = [
    paint(90, time),
    paint(COLOR[lvl] ?? 0, lvl.padEnd(5)),
    rec.agent ? paint(35, `[${rec.agent}]`) : '',
    rec.ticketKey ? paint(36, rec.ticketKey) : '',
  ]
    .filter(Boolean)
    .join(' ');

  const extras = Object.entries(rec)
    .filter(
      ([k]) =>
        !['level', 'time', 'agent', 'ticketKey', 'msg', 'service'].includes(k),
    )
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');

  return `${head}  ${rec.msg ?? ''}${extras ? '  ' + paint(90, extras) : ''}`;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    // Non-JSON line (e.g. a stack trace or a child tool's raw output): pass it
    // through untouched in `all` mode, drop it in a role-scoped view.
    if (role === 'all') process.stdout.write(line + '\n');
    return;
  }
  if (role !== 'all' && rec.agent !== role) return;
  process.stdout.write(format(rec) + '\n');
});
