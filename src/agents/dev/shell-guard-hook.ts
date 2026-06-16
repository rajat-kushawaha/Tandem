import { z } from 'zod';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { inspectCommand, inspectFileWrite } from './shell-guard.js';
import { logger } from '../../shared/logger.js';

/**
 * PreToolUse hook that denies destructive shell commands and edits to the gate
 * tooling before they run. The dev agent's Bash/Write/Edit calls go through this;
 * a blocked call is rejected with a reason the agent can read and route around.
 */

const bashInputSchema = z.object({ command: z.string() });
const fileInputSchema = z.object({ file_path: z.string() });
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Blocked by shell guard: ${reason}.`,
    },
  };
}

function guardHook(input: HookInput): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') {
    return Promise.resolve({ continue: true });
  }

  if (input.tool_name === 'Bash') {
    const parsed = bashInputSchema.safeParse(input.tool_input);
    if (!parsed.success) {
      return Promise.resolve({ continue: true });
    }
    const verdict = inspectCommand(parsed.data.command);
    if (!verdict.blocked) {
      return Promise.resolve({ continue: true });
    }
    logger.warn(
      { command: parsed.data.command, reason: verdict.reason },
      'shell guard blocked a command',
    );
    return Promise.resolve(deny(verdict.reason ?? 'destructive command'));
  }

  if (FILE_TOOLS.has(input.tool_name)) {
    const parsed = fileInputSchema.safeParse(input.tool_input);
    if (!parsed.success) {
      return Promise.resolve({ continue: true });
    }
    const verdict = inspectFileWrite(parsed.data.file_path);
    if (!verdict.blocked) {
      return Promise.resolve({ continue: true });
    }
    logger.warn(
      { filePath: parsed.data.file_path, reason: verdict.reason },
      'shell guard blocked a file write',
    );
    return Promise.resolve(deny(verdict.reason ?? 'protected file'));
  }

  return Promise.resolve({ continue: true });
}

/** Hook configuration for {@link runAgent}; wire into the dev agent only. */
export const shellGuardHooks: Options['hooks'] = {
  PreToolUse: [{ hooks: [guardHook] }],
};
