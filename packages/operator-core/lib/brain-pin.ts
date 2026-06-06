/**
 * The canonical BRAIN session pointer (native-terminal-desktop-2026-06-06 D-013).
 *
 * The desktop chat dock's RIGHT pane is "the brain" — ONE persistent psu
 * engineer session resumed on every launch. The pointer to that session
 * (the agent's NATIVE session uuid — the same handle `psu --resume <uuid>`
 * takes) lives in `harness_shared.operator_settings` under
 * `brain_session_id`: PG-canonical, one row, no FS mirror.
 *
 * Written by POST bootstrap-su on a `brain: true` launch — the server mints
 * the uuid and forces it via claude `--session-id`, so the pin exists BEFORE
 * the session's first turn (no in-process capture hook needed). Read by
 * GET bootstrap-su/brain, which `psu --brain` resolves to an exact resume
 * (picker-free; falls back to a fresh re-pinning launch when unset/stale).
 */
import { getOrgPg } from '@papercusp/db-org';

export const BRAIN_SESSION_KEY = 'brain_session_id';

/** Pin `nativeSessionId` as the canonical brain (upsert — one row, last write wins). */
export async function setBrainSession(nativeSessionId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at)
    VALUES (
      ${BRAIN_SESSION_KEY},
      ${nativeSessionId},
      'The canonical brain session (native uuid) the desktop chat dock resumes (native-terminal-desktop D-013).',
      ${Date.now()}
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

/** The pinned brain's native session uuid, or null when no brain is pinned yet. */
export async function getBrainSession(): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT value FROM harness_shared.operator_settings WHERE key = ${BRAIN_SESSION_KEY} LIMIT 1
  `;
  const v = (rows[0] as { value?: string } | undefined)?.value;
  return v?.trim() || null;
}
