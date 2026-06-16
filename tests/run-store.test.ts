import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileRunStore,
  InMemoryRunStore,
} from '../src/orchestrator/run-store.js';
import { createRunRecord } from '../src/shared/types.js';

describe('InMemoryRunStore.getByThreadTs', () => {
  it('finds the record whose Slack thread matches', async () => {
    const store = new InMemoryRunStore();
    await store.save({ ...createRunRecord('ABC-1'), slackThreadTs: '111.222' });
    await store.save({ ...createRunRecord('ABC-2'), slackThreadTs: '333.444' });

    const found = await store.getByThreadTs('333.444');
    expect(found?.ticketKey).toBe('ABC-2');
  });

  it('returns null when no record has that thread', async () => {
    const store = new InMemoryRunStore();
    await store.save({ ...createRunRecord('ABC-1'), slackThreadTs: '111.222' });

    expect(await store.getByThreadTs('999.000')).toBeNull();
  });

  it('does not match records with no thread on a null lookup', async () => {
    const store = new InMemoryRunStore();
    await store.save(createRunRecord('ABC-1')); // slackThreadTs is null

    expect(await store.getByThreadTs('111.222')).toBeNull();
  });

  it('returns a clone, not the stored reference', async () => {
    const store = new InMemoryRunStore();
    await store.save({ ...createRunRecord('ABC-1'), slackThreadTs: '111.222' });

    const found = await store.getByThreadTs('111.222');
    found!.state = 'BLOCKED';

    const reread = await store.getByThreadTs('111.222');
    expect(reread?.state).toBe('NEW');
  });
});

describe('FileRunStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-store-'));
    path = join(dir, 'state.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists records across instances (a restart resumes state)', async () => {
    const first = new FileRunStore(path);
    await first.save({
      ...createRunRecord('ABC-1'),
      state: 'IN_PROGRESS',
      slackThreadTs: '111.222',
      repos: [{ name: 'api', prUrl: 'https://x/pr/1' }],
    });

    // A new instance reading the same file simulates a process restart.
    const reloaded = new FileRunStore(path);
    const got = await reloaded.get('ABC-1');
    expect(got?.state).toBe('IN_PROGRESS');
    expect(got?.slackThreadTs).toBe('111.222');
    expect(got?.repos[0]?.prUrl).toBe('https://x/pr/1');
  });

  it('indexes the Slack thread across a restart', async () => {
    const first = new FileRunStore(path);
    await first.save({ ...createRunRecord('ABC-9'), slackThreadTs: '777.888' });

    const reloaded = new FileRunStore(path);
    expect((await reloaded.getByThreadTs('777.888'))?.ticketKey).toBe('ABC-9');
  });

  it('upserts (last save for a key wins, no duplicates)', async () => {
    const store = new FileRunStore(path);
    await store.save(createRunRecord('ABC-1'));
    await store.save({ ...createRunRecord('ABC-1'), state: 'BLOCKED' });

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.state).toBe('BLOCKED');
  });

  it('starts empty when the file does not exist yet', async () => {
    const store = new FileRunStore(join(dir, 'missing.json'));
    expect(await store.list()).toEqual([]);
  });

  it('starts empty (does not throw) on a corrupt file', async () => {
    writeFileSync(path, '{ this is not valid json');
    const store = new FileRunStore(path);
    expect(await store.list()).toEqual([]);
    // and is still usable
    await store.save(createRunRecord('ABC-1'));
    expect(await store.get('ABC-1')).not.toBeNull();
  });

  it('writes the file on save', async () => {
    const store = new FileRunStore(path);
    await store.save(createRunRecord('ABC-1'));
    expect(existsSync(path)).toBe(true);
  });

  it('stores a clone — external mutation does not leak in', async () => {
    const store = new FileRunStore(path);
    const record = createRunRecord('ABC-1');
    await store.save(record);
    record.state = 'BLOCKED';
    expect((await store.get('ABC-1'))?.state).toBe('NEW');
  });
});
