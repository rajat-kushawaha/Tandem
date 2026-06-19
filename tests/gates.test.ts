import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allGatesPassed,
  baselineFailures,
  detectStack,
  gatesEffectivelyGreen,
  gatesForStack,
  resolveGates,
  summarizeGates,
  type GateResult,
} from '../src/agents/dev/gates.js';

describe('detectStack', () => {
  it('detects maven, gradle, and node roots', () => {
    expect(detectStack(['pom.xml', 'src'])).toBe('maven');
    expect(detectStack(['build.gradle'])).toBe('gradle');
    expect(detectStack(['build.gradle.kts'])).toBe('gradle');
    expect(detectStack(['package.json', 'vite.config.ts'])).toBe('node');
  });

  it('prefers maven when multiple build files exist', () => {
    expect(detectStack(['pom.xml', 'package.json'])).toBe('maven');
  });

  it('returns null for an unrecognised repo', () => {
    expect(detectStack(['README.md'])).toBeNull();
  });
});

describe('gatesForStack', () => {
  it('runs the full npm pipeline for node repos', () => {
    expect(gatesForStack('node').map((g) => g.name)).toEqual([
      'npm install',
      'lint',
      'build',
      'test',
      'smoke',
    ]);
  });
});

describe('resolveGates', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gates-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writePackageJson = (scripts: Record<string, string>): Promise<void> =>
    writeFile(join(dir, 'package.json'), JSON.stringify({ scripts }));

  it('keeps all node gates when lint and build scripts exist', async () => {
    await writePackageJson({ lint: 'eslint .', build: 'tsc', test: 'vitest' });
    const names = (await resolveGates('node', dir)).map((g) => g.name);
    expect(names).toEqual(['npm install', 'lint', 'build', 'test']);
  });

  it('drops lint/build gates the repo does not define', async () => {
    await writePackageJson({ test: 'vitest' });
    const names = (await resolveGates('node', dir)).map((g) => g.name);
    expect(names).toEqual(['npm install', 'test']);
  });

  it('still runs install and test when package.json is missing', async () => {
    const names = (await resolveGates('node', dir)).map((g) => g.name);
    expect(names).toEqual(['npm install', 'test']);
  });

  it('returns the fixed gate list unchanged for non-node stacks', async () => {
    expect((await resolveGates('maven', dir)).map((g) => g.name)).toEqual([
      'maven verify',
    ]);
  });
});

describe('baselineFailures', () => {
  it('returns the names of waivable gates failing on the base', () => {
    const baseline: GateResult[] = [
      { name: 'npm install', passed: true, output: '' },
      { name: 'lint', passed: false, output: 'pre-existing' },
      { name: 'test', passed: false, output: 'pre-existing' },
    ];
    expect([...baselineFailures(baseline)].sort()).toEqual(['lint', 'test']);
  });

  it('never waives install or build (those always block)', () => {
    const baseline: GateResult[] = [
      { name: 'npm install', passed: false, output: 'cannot install' },
      { name: 'build', passed: false, output: 'tsc error' },
      { name: 'lint', passed: false, output: 'pre-existing' },
    ];
    const waived = baselineFailures(baseline);
    expect(waived.has('npm install')).toBe(false);
    expect(waived.has('build')).toBe(false);
    expect(waived.has('lint')).toBe(true);
  });

  it('is empty when the base is fully green', () => {
    const baseline: GateResult[] = [
      { name: 'lint', passed: true, output: '' },
      { name: 'test', passed: true, output: '' },
    ];
    expect(baselineFailures(baseline).size).toBe(0);
  });
});

describe('gatesEffectivelyGreen', () => {
  const none = new Set<string>();

  it('is true when all gates passed', () => {
    expect(
      gatesEffectivelyGreen(
        [
          { name: 'lint', passed: true, output: '' },
          { name: 'test', passed: true, output: '' },
        ],
        none,
      ),
    ).toBe(true);
  });

  it('is true when the only failing gate is waived (pre-existing)', () => {
    expect(
      gatesEffectivelyGreen(
        [
          { name: 'lint', passed: false, output: 'pre-existing' },
          { name: 'test', passed: true, output: '' },
        ],
        new Set(['lint']),
      ),
    ).toBe(true);
  });

  it('is false when a non-waived gate fails (a real regression)', () => {
    expect(
      gatesEffectivelyGreen(
        [{ name: 'test', passed: false, output: 'regression' }],
        new Set(['lint']),
      ),
    ).toBe(false);
  });

  it('is false when no gates ran', () => {
    expect(gatesEffectivelyGreen([], none)).toBe(false);
  });
});

describe('gate aggregation', () => {
  const pass: GateResult = { name: 'build', passed: true, output: '' };
  const fail: GateResult = { name: 'test', passed: false, output: 'boom' };

  it('passes only when every gate passed and at least one ran', () => {
    expect(allGatesPassed([pass, pass])).toBe(true);
    expect(allGatesPassed([pass, fail])).toBe(false);
    expect(allGatesPassed([])).toBe(false);
  });

  it('summarizes with check and cross marks', () => {
    expect(summarizeGates([pass, fail])).toBe('✓ build\n✗ test');
  });

  it('marks a waived gate as ⚠ pre-existing, not ✗, so the reviewer does not block on it', () => {
    // The dev↔reviewer loop bug: a base-branch failure waived by the dev side
    // was rendered as a plain ✗ on the PR, and the reviewer blocked on it. A
    // waived gate must read distinctly as pre-existing/non-blocking.
    const summary = summarizeGates([pass, fail], new Set(['test']));
    expect(summary).toContain('✓ build');
    expect(summary).toContain('⚠ test');
    expect(summary).toContain('pre-existing');
    expect(summary).not.toContain('✗ test');
  });

  it('still renders a non-waived failure as ✗ (a real regression)', () => {
    expect(summarizeGates([fail], new Set())).toBe('✗ test');
  });
});
