/**
 * Live-editable memory-backend selection (mem0-revive-or-retire / Brief 30).
 *
 * Which `MemoryBackend` `getMemoryBackend()` serves, persisted as a
 * single-row operator setting (`operator_memory_backend`) and read LIVE —
 * the operator passes `() => currentMemoryBackendChoice()` as the memory
 * host's `backend` thunk (see ./configure), so a UI flip on the settings
 * memory page takes effect on the next memory call with no restart. This
 * lets the owner switch to `'claude-file'` (the real ~/.claude topic-file
 * store, which is populated) to *see* real data and inform the pending
 * revive-vs-retire decision (docs-and-memory-as-projections P-006).
 *
 * Resolution order: persisted setting → `PAPERCUSP_MEMORY_BACKEND` → `'mem0'`.
 * Mirrors rate-limit-config.ts (single-process in-memory cache + PG persist);
 * the dev box runs one operator process, so a plain module cache suffices
 * (PG LISTEN/NOTIFY is the documented multi-process extension).
 */
import { readOperatorState, writeOperatorState } from '../operator-state-pg';

const SETTING_KEY = 'operator_memory_backend';

/** The env fallback, evaluated live (tests may set it per-case). */
function envDefault(): string {
  return process.env.PAPERCUSP_MEMORY_BACKEND || 'mem0';
}

interface StoredSelection {
  backend?: string;
}

// undefined = not yet loaded from PG → fall back to env/default.
let cached: string | undefined;
let booted = false;

/**
 * The synchronous live choice the memory host thunk reads on every
 * `getMemoryBackend()`. Persisted setting (once loaded) → env → 'mem0'.
 */
export function currentMemoryBackendChoice(): string {
  return cached ?? envDefault();
}

/**
 * Load the persisted selection into the in-process cache. Idempotent;
 * best-effort (a PG miss leaves the env/default fallback in place). Fire
 * once at operator boot — but it is also safe to never call (the thunk
 * just stays on the env default until a write happens).
 */
export async function initMemoryBackendSelection(): Promise<void> {
  if (booted) return;
  booted = true;
  const stored = await readOperatorState<StoredSelection>(SETTING_KEY).catch(() => null);
  if (stored?.backend) cached = stored.backend;
}

/** Read the persisted choice (independent of the cache); env/default if unset. */
export async function readMemoryBackendChoice(): Promise<string> {
  const stored = await readOperatorState<StoredSelection>(SETTING_KEY).catch(() => null);
  return stored?.backend ?? envDefault();
}

/**
 * Persist + apply the choice live (this process sees it on the next
 * `getMemoryBackend()`). The caller MUST validate `backend` against
 * `registeredMemoryBackends()` first — an unknown name makes
 * `getMemoryBackend()` throw loud by design.
 */
export async function writeMemoryBackendChoice(backend: string): Promise<string> {
  cached = backend;
  booted = true;
  await writeOperatorState<StoredSelection>(SETTING_KEY, { backend });
  return backend;
}

/** Test hook — drop the cache + boot latch. */
export function __resetMemoryBackendSelectionForTest(): void {
  cached = undefined;
  booted = false;
}
