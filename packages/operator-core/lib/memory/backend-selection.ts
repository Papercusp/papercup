/**
 * Live-editable memory-backend selection (mem0-revive-or-retire / Brief 30).
 *
 * Which `MemoryBackend` `getMemoryBackend()` serves, persisted as an
 * operator-wide key/value setting (`harness_shared.operator_settings`,
 * key `memory_backend`) and read LIVE — the operator passes
 * `() => currentMemoryBackendChoice()` as the memory host's `backend`
 * thunk (see ./configure), so a UI flip on the settings memory page takes
 * effect on the next memory call with NO restart. This lets the owner
 * switch to `'claude-file'` (the real ~/.claude topic-file store, which is
 * populated) to *see* real data and inform the pending revive-vs-retire
 * decision (docs-and-memory-as-projections P-006).
 *
 * Resolution order: persisted setting → `PAPERCUSP_MEMORY_BACKEND` → `'mem0'`.
 * Operator-wide (not per-workspace): it's an infra choice over the whole
 * store. The dev box runs one operator process, so a plain in-process
 * cache suffices (PG is the source of truth across restarts; a second
 * process re-reads at its own boot).
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';

const SETTING_KEY = 'memory_backend';
const osTable = generated.operatorSettingsInHarnessShared;

/** The env fallback, evaluated live (tests may set it per-case). */
function envDefault(): string {
  return process.env.PAPERCUSP_MEMORY_BACKEND || 'mem0';
}

// undefined = not yet loaded from PG → fall back to env/default.
let cached: string | undefined;
let booted = false;

async function readSetting(): Promise<string | null> {
  try {
    const { db } = getOrgPg();
    const rows = await db
      .select({ value: osTable.value })
      .from(osTable)
      .where(eq(osTable.key, SETTING_KEY))
      .limit(1);
    return rows.length > 0 ? rows[0].value : null;
  } catch {
    return null; // PG not up yet / table absent → fall back to env
  }
}

async function writeSetting(value: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at)
    VALUES (${SETTING_KEY}, ${value}, 'Active MemoryBackend (mem0-revive-or-retire / Brief 30)', ${Date.now()})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

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
  const stored = await readSetting();
  if (stored) cached = stored;
}

/** Read the persisted choice (independent of the cache); env/default if unset. */
export async function readMemoryBackendChoice(): Promise<string> {
  const stored = await readSetting();
  return stored ?? envDefault();
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
  await writeSetting(backend);
  return backend;
}

/** Test hook — drop the cache + boot latch (does not touch PG). */
export function __resetMemoryBackendSelectionForTest(): void {
  cached = undefined;
  booted = false;
}
