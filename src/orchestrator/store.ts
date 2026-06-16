import { config } from '../shared/config.js';
import {
  FileRunStore,
  InMemoryRunStore,
  type RunStore,
} from './run-store.js';

/**
 * Process-wide {@link RunStore} singleton used by the Inngest workflows.
 *
 * - `RUN_STORE_FILE` set → file-backed store: per-ticket state survives a
 *   process restart, so an interrupted ticket resumes (single-process only).
 * - unset → in-memory store: correct for tests; state is lost on restart.
 *
 * A production deployment replaces this with a Mongo/Redis-backed store
 * implementing the same interface — the workflows depend only on the interface,
 * never on the concrete store.
 */
export const runStore: RunStore = config.RUN_STORE_FILE
  ? new FileRunStore(config.RUN_STORE_FILE)
  : new InMemoryRunStore();
