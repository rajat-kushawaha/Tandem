import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../shared/logger.js';

/**
 * The "gate on green" checks. A PR is opened only if every gate in every
 * affected repo passes. Gates are derived from the repo's build files so we run
 * the right toolchain (Maven/Gradle for the backend, npm for the frontend).
 */

const exec = promisify(execFile);

export type Stack = 'maven' | 'gradle' | 'node';

export interface GateCommand {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface GateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly output: string;
}

/** Picks the stack from the files present at a repo root. */
export function detectStack(rootEntries: readonly string[]): Stack | null {
  const entries = new Set(rootEntries);
  if (entries.has('pom.xml')) {
    return 'maven';
  }
  if (entries.has('build.gradle') || entries.has('build.gradle.kts')) {
    return 'gradle';
  }
  if (entries.has('package.json')) {
    return 'node';
  }
  return null;
}

const GATES: Record<Stack, readonly GateCommand[]> = {
  maven: [{ name: 'maven verify', command: 'mvn', args: ['-B', 'verify'] }],
  gradle: [{ name: 'gradle check', command: './gradlew', args: ['check'] }],
  node: [
    { name: 'npm install', command: 'npm', args: ['ci'] },
    { name: 'lint', command: 'npm', args: ['run', 'lint'] },
    { name: 'build', command: 'npm', args: ['run', 'build'] },
    { name: 'test', command: 'npm', args: ['test'] },
    // Browser provisioning for the smoke gate (e.g. `playwright install
    // chromium`). MUST run AFTER `npm install` (it invokes the playwright CLI
    // from node_modules/.bin) and BEFORE `smoke`. Without it `npm run smoke`
    // errors on a missing browser, gets waived as a pre-existing baseline
    // failure, and the browser gate dies fleet-wide. Repo-defined and
    // non-blocking — see resolveGates / runGates: a backend repo has no such
    // script (dropped), and a failed install lets `smoke` surface the problem
    // loudly rather than silently disabling it.
    { name: 'smoke:install', command: 'npm', args: ['run', 'smoke:install'] },
    // Browser smoke: boots the app headlessly and fails on render crashes AND
    // broken interactions (a button that navigates to the wrong route) that
    // lint/build/unit tests (which run against mocks) cannot see. Repo-defined,
    // skipped when absent — see resolveGates.
    { name: 'smoke', command: 'npm', args: ['run', 'smoke'] },
  ],
};

export function gatesForStack(stack: Stack): readonly GateCommand[] {
  return GATES[stack];
}

/** npm scripts the node gates invoke via `npm run <script>`. */
const OPTIONAL_NPM_SCRIPTS: Record<string, string> = {
  lint: 'lint',
  build: 'build',
  'smoke:install': 'smoke:install',
  smoke: 'smoke',
};

/**
 * Gates that must not stop the sequence on failure, even outside a baseline run.
 * `smoke:install` only provisions the browser for the `smoke` gate; if it fails
 * we still want `smoke` to run and report the real (now-visible) problem rather
 * than aborting the whole gate sequence here. It is also never the quality
 * signal itself — the `smoke` gate is.
 */
const NON_BLOCKING_GATES = new Set(['smoke:install']);

/** True for gates that provision/support others and never block shipping. */
export function isNonBlockingGate(name: string): boolean {
  return NON_BLOCKING_GATES.has(name);
}

/** Reads the `scripts` map from a repo's package.json (empty on any error). */
async function readNpmScripts(cwd: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const scripts =
      parsed && typeof parsed === 'object'
        ? (parsed as { scripts?: unknown }).scripts
        : undefined;
    return scripts && typeof scripts === 'object'
      ? (scripts as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Resolves the gates to run for a stack at a given checkout. For node it drops
 * `npm run lint` / `npm run build` when the repo defines no such script —
 * otherwise `npm` exits with "Missing script", a failure unrelated to the
 * agent's change that it cannot fix (editing package.json scripts is out of
 * scope and the config guard blocks tooling edits). `npm ci` and `npm test`
 * always run: `test` has npm's built-in default and is the core quality signal.
 */
export async function resolveGates(
  stack: Stack,
  cwd: string,
): Promise<readonly GateCommand[]> {
  if (stack !== 'node') {
    return GATES[stack];
  }
  const scripts = await readNpmScripts(cwd);
  return GATES.node.filter((gate) => {
    const scriptName = OPTIONAL_NPM_SCRIPTS[gate.name];
    if (scriptName === undefined) {
      return true; // npm ci / npm test always run
    }
    const present = typeof scripts[scriptName] === 'string';
    if (!present) {
      logger.info(
        { gate: gate.name, cwd },
        'skipping node gate: repo defines no such npm script',
      );
    }
    return present;
  });
}

/**
 * Hard ceiling per gate. A gate that exceeds this is treated as a failure, not
 * an infinite hang: a repo whose `test` script is bare `vitest` / `jest --watch`
 * (watch mode) would otherwise freeze the whole workflow forever. The first
 * Gradle/Maven run downloads dependencies, so this is generous.
 */
const GATE_TIMEOUT_MS = 15 * 60 * 1000;

export async function runGates(
  cwd: string,
  gates: readonly GateCommand[],
  options: { readonly continueOnFailure?: boolean } = {},
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    logger.info({ gate: gate.name, cwd }, 'running gate');
    try {
      const { stdout, stderr } = await exec(gate.command, [...gate.args], {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        timeout: GATE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        // CI=true forces test runners out of interactive watch mode (e.g. a
        // repo whose `test` script is a bare `vitest`). Non-interactive stdio
        // alone is not enough for every runner.
        env: { ...process.env, CI: 'true' },
      });
      logger.info({ gate: gate.name }, 'gate passed');
      results.push({ name: gate.name, passed: true, output: stdout + stderr });
    } catch (error) {
      logger.warn({ gate: gate.name }, 'gate failed');
      results.push({
        name: gate.name,
        passed: false,
        output: error instanceof Error ? error.message : String(error),
      });
      // A non-blocking gate (browser provisioning) must never abort the
      // sequence — the gate it serves still has to run and report.
      if (NON_BLOCKING_GATES.has(gate.name)) {
        continue;
      }
      // Normally stop at the first failure: later gates depend on earlier ones.
      // For a BASELINE run we continue, so we learn each gate's pre-existing
      // status even when an earlier one is already red on the base branch.
      if (!options.continueOnFailure) {
        break;
      }
    }
  }
  return results;
}

/**
 * Runs the gates on the PRISTINE checkout to learn the base branch's status,
 * retrying any gate that fails on its FIRST run exactly once.
 *
 * The first gate run per ticket is the cold one: Gradle/Maven download the whole
 * dependency graph and start a daemon, npm runs `ci` from an empty cache — and
 * under that load a gate can flake (slow download, transient daemon error, or a
 * brush with the timeout) on a base branch that is actually green. A baseline
 * flake is uniquely damaging: the gate gets WAIVED as "pre-existing", the dev
 * agent ships, and the PR body then advertises a red gate the reviewer blocks
 * on — an unbreakable dev↔reviewer loop. A single retry on a now-warm checkout
 * distinguishes a genuine pre-existing failure (fails twice) from a cold-start
 * flake (passes on retry), at the cost of one extra run only when a gate is red.
 */
export async function runBaselineGates(
  cwd: string,
  gates: readonly GateCommand[],
): Promise<GateResult[]> {
  const first = await runGates(cwd, gates, { continueOnFailure: true });
  const results: GateResult[] = [];
  for (const result of first) {
    if (result.passed) {
      results.push(result);
      continue;
    }
    logger.info(
      { gate: result.name, cwd },
      'baseline gate failed on cold run; retrying once on the warm checkout',
    );
    const gate = gates.find((g) => g.name === result.name);
    const [retry] = gate
      ? await runGates(cwd, [gate], { continueOnFailure: true })
      : [];
    results.push(retry ?? result);
  }
  return results;
}

/**
 * Names of gates that were already failing on the clean base checkout, i.e.
 * regressions that pre-date the agent's change.
 *
 * `install` and `build` are deliberately NOT eligible to be "pre-existing":
 * a base that doesn't install or build is broken in a way that blocks shipping
 * regardless of the agent, so we never wave those through.
 */
const NON_WAIVABLE = new Set(['npm install', 'build']);

export function baselineFailures(
  baseline: readonly GateResult[],
): ReadonlySet<string> {
  return new Set(
    baseline
      .filter((result) => !result.passed && !NON_WAIVABLE.has(result.name))
      .map((result) => result.name),
  );
}

export function allGatesPassed(results: readonly GateResult[]): boolean {
  const blocking = results.filter((r) => !NON_BLOCKING_GATES.has(r.name));
  return blocking.length > 0 && blocking.every((result) => result.passed);
}

/**
 * True when every gate either passed or is a waived pre-existing failure — i.e.
 * the agent's own code introduced no gate regression. Used to decide whether a
 * missing checklist is worth recovering (the work is otherwise done) vs. a real
 * failure that needs another implementation attempt.
 */
export function gatesEffectivelyGreen(
  results: readonly GateResult[],
  waived: ReadonlySet<string>,
): boolean {
  const blocking = results.filter((r) => !NON_BLOCKING_GATES.has(r.name));
  return (
    blocking.length > 0 &&
    blocking.every((result) => result.passed || waived.has(result.name))
  );
}

export function summarizeGates(
  results: readonly GateResult[],
  waived: ReadonlySet<string> = new Set(),
): string {
  return results
    .filter((result) => result.passed || !NON_BLOCKING_GATES.has(result.name))
    .map((result) => {
      if (result.passed) {
        return `✓ ${result.name}`;
      }
      // A waived gate was already red on the base branch BEFORE this change —
      // not a regression this PR introduced. Mark it distinctly (⚠, not ✗) and
      // say so, so the reviewer does not block on a pre-existing failure the
      // change did not cause (which would loop the ticket back to dev forever).
      if (waived.has(result.name)) {
        return `⚠ ${result.name} — pre-existing failure on the base branch (not introduced by this change); not blocking`;
      }
      return `✗ ${result.name}`;
    })
    .join('\n');
}
