import pino from 'pino';
import type { AgentRole } from './types.js';

/**
 * Structured logger. Every agent action and orchestrator transition is logged
 * through a child logger bound to the ticket key so a single ticket's history
 * can be reconstructed from logs alone.
 *
 * The level is read straight from `LOG_LEVEL` (not via `config`) so that pure,
 * unit-tested modules can log without pulling in environment validation.
 */
const LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
const envLevel = process.env.LOG_LEVEL;
const level = envLevel && LEVELS.has(envLevel) ? envLevel : 'info';

export const logger = pino({
  level,
  base: { service: 'agentic-sdlc' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function ticketLogger(ticketKey: string): pino.Logger {
  return logger.child({ ticketKey });
}

/**
 * Logger bound to both an agent role and a ticket. Use this in the workflow
 * layer so workflow-level lines carry the same `agent` field the inner agent
 * runs do — which lets a per-agent terminal filter (`… | grep '"agent":"dev"'`)
 * show a complete picture of one agent's activity, not just its SDK calls.
 */
export function agentLogger(role: AgentRole, ticketKey: string): pino.Logger {
  return logger.child({ agent: role, ticketKey });
}
