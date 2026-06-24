import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createRunRecord,
  emptyAgentCost,
  type RunRecord,
} from '../shared/types.js';
import { transition, type TicketEvent } from './state-machine.js';

/**
 * Durable store of {@link RunRecord}s, keyed by Jira ticket key. The default
 * implementation is in-memory (used in tests and local runs); a production
 * deployment swaps in a Mongo/Redis-backed store implementing the same
 * interface. The store is the single source of truth linking a Jira key to its
 * Slack thread and PR URLs.
 */
export interface RunStore {
  get(ticketKey: string): Promise<RunRecord | null>;
  save(record: RunRecord): Promise<void>;
  list(): Promise<RunRecord[]>;
  /**
   * Finds the record whose Slack clarification thread matches, or null. A
   * dedicated lookup (rather than `list()` + filter at the call site) lets a
   * durable store index `slackThreadTs` instead of scanning the whole
   * collection on every inbound Slack message.
   */
  getByThreadTs(threadTs: string): Promise<RunRecord | null>;
}

export class InMemoryRunStore implements RunStore {
  private readonly records = new Map<string, RunRecord>();

  get(ticketKey: string): Promise<RunRecord | null> {
    const record = this.records.get(ticketKey);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  save(record: RunRecord): Promise<void> {
    this.records.set(record.ticketKey, structuredClone(record));
    return Promise.resolve();
  }

  list(): Promise<RunRecord[]> {
    return Promise.resolve(
      [...this.records.values()].map((record) => structuredClone(record)),
    );
  }

  getByThreadTs(threadTs: string): Promise<RunRecord | null> {
    for (const record of this.records.values()) {
      if (record.slackThreadTs === threadTs) {
        return Promise.resolve(structuredClone(record));
      }
    }
    return Promise.resolve(null);
  }
}

/**
 * File-backed {@link RunStore}: an in-memory map mirrored to a JSON file so the
 * orchestrator's per-ticket state survives a process restart. This makes
 * restarts safe for local/demo use — combined with Inngest's already-durable
 * workflows, an interrupted ticket resumes correctly instead of being re-ingested
 * from scratch or losing its Slack-thread mapping.
 *
 * Scope: single-process only. There is no cross-process locking, so this is NOT
 * a substitute for a real database in production (where multiple orchestrator
 * instances share state) — for that, implement this same interface against
 * Mongo/Redis. Within one process, writes are serialized and atomic (temp file
 * + rename), so a crash mid-write cannot corrupt the file.
 */
export class FileRunStore implements RunStore {
  private readonly records = new Map<string, RunRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    this.load();
  }

  /** Reads the file once at construction; an absent/corrupt file starts empty. */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return; // no file yet — first run
    }
    try {
      const parsed = JSON.parse(raw) as RunRecord[];
      for (const record of parsed) {
        // Fill in cost fields that may be absent or partial in records written
        // before cost tracking (or before cache tokens were added), so the store
        // never serves a record with undefined fields.
        this.records.set(record.ticketKey, {
          ...record,
          ba: { ...emptyAgentCost(), ...record.ba },
          dev: { ...emptyAgentCost(), ...record.dev },
        });
      }
    } catch {
      // A corrupt file must not crash boot. Start empty; the next save rewrites.
    }
  }

  /**
   * Serializes writes through a promise chain so concurrent saves (e.g. adjacent
   * Inngest steps) can't interleave, and writes atomically via temp-file rename
   * so a crash never leaves a half-written file.
   */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.records.values()], null, 2);
    this.writeChain = this.writeChain.then(() => {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, snapshot);
      renameSync(tmp, this.path);
    });
    return this.writeChain;
  }

  get(ticketKey: string): Promise<RunRecord | null> {
    const record = this.records.get(ticketKey);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  async save(record: RunRecord): Promise<void> {
    this.records.set(record.ticketKey, structuredClone(record));
    await this.persist();
  }

  list(): Promise<RunRecord[]> {
    return Promise.resolve(
      [...this.records.values()].map((record) => structuredClone(record)),
    );
  }

  getByThreadTs(threadTs: string): Promise<RunRecord | null> {
    for (const record of this.records.values()) {
      if (record.slackThreadTs === threadTs) {
        return Promise.resolve(structuredClone(record));
      }
    }
    return Promise.resolve(null);
  }
}

/** Loads the record for a ticket, creating a fresh NEW record if absent. */
export async function loadOrCreate(
  store: RunStore,
  ticketKey: string,
): Promise<RunRecord> {
  const existing = await store.get(ticketKey);
  return existing ?? createRunRecord(ticketKey);
}

/**
 * Applies a state-machine event to a record and persists it. Throws (via the
 * state machine) if the transition is illegal, so an out-of-order event can
 * never corrupt a ticket's state.
 */
export async function applyEvent(
  store: RunStore,
  record: RunRecord,
  event: TicketEvent,
  patch: Partial<Omit<RunRecord, 'ticketKey' | 'state'>> = {},
): Promise<RunRecord> {
  const updated: RunRecord = {
    ...record,
    ...patch,
    state: transition(record.state, event),
    updatedAt: new Date().toISOString(),
  };
  await store.save(updated);
  return updated;
}
