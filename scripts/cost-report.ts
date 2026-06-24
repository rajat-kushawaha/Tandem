import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  emptyAgentCost,
  totalCostUsd,
  totalInputTokens,
  type AgentCost,
  type RunRecord,
} from '../src/shared/types.js';

/**
 * Prints a per-ticket AI cost summary from .run-store.json, broken down by
 * agent (BA, Dev) with the model used and token counts.
 *
 *   npm run cost:report
 *   npm run cost:report -- /path/to/custom-run-store.json
 *
 * Token counts are RAW counts (not thousands or millions). "In tokens" is the
 * TOTAL input — non-cached + cache read + cache creation — which is what
 * reconciles with the billed cost; "(cache)" shows how much of that input was
 * cache read/creation, since the non-cached slice alone looks misleadingly
 * small next to the cost.
 *
 * Reviewer cost is not included: the reviewer runs in CI as a separate process
 * and its usage is not reported back to the orchestrator.
 */

const storePath =
  process.argv[2] ??
  process.env['RUN_STORE_FILE'] ??
  join(process.cwd(), '.run-store.json');

let records: RunRecord[];
try {
  const raw = readFileSync(storePath, 'utf8');
  const parsed = JSON.parse(raw) as RunRecord[];
  records = parsed.map((r) => ({
    ...r,
    ba: { ...emptyAgentCost(), ...r.ba },
    dev: { ...emptyAgentCost(), ...r.dev },
  }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Cannot read run store at ${storePath}: ${message}\n`);
  process.exit(1);
}

if (records.length === 0) {
  process.stdout.write('No ticket records found.\n');
  process.exit(0);
}

// Sort by descending total cost so the most expensive tickets are at the top.
records.sort((a, b) => totalCostUsd(b) - totalCostUsd(a));

const COL = {
  ticket: 10,
  agent: 7,
  model: 20,
  inTok: 14,
  cacheTok: 18,
  outTok: 12,
  cost: 11,
};

const WIDTH = Object.values(COL).reduce((a, b) => a + b, 0);

function pad(s: string, width: number): string {
  return s.length >= width
    ? s.slice(0, width)
    : s + ' '.repeat(width - s.length);
}

function fmtCost(usd: number): string {
  return usd > 0 ? `$${usd.toFixed(4)}` : '-';
}

function fmtTokens(n: number): string {
  return n > 0 ? n.toLocaleString() : '-';
}

/** Cache read + creation tokens, for the "(cache)" column. */
function cacheTokens(cost: AgentCost): number {
  return cost.cacheReadInputTokens + cost.cacheCreationInputTokens;
}

function row(ticket: string, agent: string, cost: AgentCost): string {
  return (
    pad(ticket, COL.ticket) +
    pad(agent, COL.agent) +
    pad(cost.model || '-', COL.model) +
    pad(fmtTokens(totalInputTokens(cost)), COL.inTok) +
    pad(fmtTokens(cacheTokens(cost)), COL.cacheTok) +
    pad(fmtTokens(cost.outputTokens), COL.outTok) +
    pad(fmtCost(cost.costUsd), COL.cost)
  );
}

const header =
  pad('Ticket', COL.ticket) +
  pad('Agent', COL.agent) +
  pad('Model', COL.model) +
  pad('In tokens', COL.inTok) +
  pad('(of which cache)', COL.cacheTok) +
  pad('Out tokens', COL.outTok) +
  pad('Cost', COL.cost);

const divider = '-'.repeat(WIDTH);

process.stdout.write('\nAI cost per Jira ticket (reviewer not included)\n');
process.stdout.write(
  'Tokens are raw counts. "In tokens" is total input (incl. cache).\n',
);
process.stdout.write(divider + '\n');
process.stdout.write(header + '\n');
process.stdout.write(divider + '\n');

const grand = { in: 0, cache: 0, out: 0, cost: 0 };

for (const r of records) {
  // One row per agent, plus a per-ticket subtotal line.
  process.stdout.write(row(r.ticketKey, 'BA', r.ba) + '\n');
  process.stdout.write(row('', 'Dev', r.dev) + '\n');
  const tIn = totalInputTokens(r.ba) + totalInputTokens(r.dev);
  const tCache = cacheTokens(r.ba) + cacheTokens(r.dev);
  const tOut = r.ba.outputTokens + r.dev.outputTokens;
  const tCost = totalCostUsd(r);
  process.stdout.write(
    pad('', COL.ticket) +
      pad('TOTAL', COL.agent) +
      pad(`[${r.state}]`, COL.model) +
      pad(fmtTokens(tIn), COL.inTok) +
      pad(fmtTokens(tCache), COL.cacheTok) +
      pad(fmtTokens(tOut), COL.outTok) +
      pad(fmtCost(tCost), COL.cost) +
      '\n',
  );
  process.stdout.write(divider + '\n');
  grand.in += tIn;
  grand.cache += tCache;
  grand.out += tOut;
  grand.cost += tCost;
}

process.stdout.write(
  pad('ALL', COL.ticket) +
    pad('', COL.agent) +
    pad('', COL.model) +
    pad(fmtTokens(grand.in), COL.inTok) +
    pad(fmtTokens(grand.cache), COL.cacheTok) +
    pad(fmtTokens(grand.out), COL.outTok) +
    pad(fmtCost(grand.cost), COL.cost) +
    '\n\n',
);
