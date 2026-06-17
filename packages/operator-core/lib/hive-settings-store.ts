/**
 * hive-settings-store — PG access to harness_shared.hive_settings, per-Hive
 * settings that federate as first-class Hive state (shared-hive-federation-2026-06-08
 * P-005; migration 186).
 *
 * A Hive's settings are scoped to its HOME harness slug (the `harness_slug`
 * column = the Hive's home_slug, which carries the Hive identity) so they ride the
 * Hive's peer-log (P-004 topic re-key) via the existing harness_plans-style
 * federation. This module is the LOCAL write/read path; it enforces the logical
 * "settings belong to a Hive" scope (the migration has no hard FK, to keep the
 * read-side projection tolerant of cross-machine join ordering). `value` crosses
 * the boundary as a JSON-serializable value (stored as JSON text).
 *
 * Every fn takes an optional `sql` client so integration tests can pass a per-file
 * test schema.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getHiveBySlug } from './hive-store';

export interface HiveSettingRecord {
  workspaceId: string;
  /** The Hive's home_slug (= the `harness_slug` scope column). */
  hiveHomeSlug: string;
  settingKey: string;
  /** The JSON-decoded setting value (null when unset). */
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface SetHiveSettingInput {
  workspaceId: string;
  hiveHomeSlug: string;
  settingKey: string;
  /** Any JSON-serializable value. `undefined` stores SQL NULL. */
  value: unknown;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

const COLS = `workspace_id, harness_slug, setting_key, value, created_at, updated_at`;

interface HiveSettingDbRow {
  workspace_id: string;
  harness_slug: string;
  setting_key: string;
  value: string | null;
  created_at: string | number;
  updated_at: string | number;
}

function rowToRecord(r: HiveSettingDbRow): HiveSettingRecord {
  let value: unknown = null;
  if (r.value != null) {
    try {
      value = JSON.parse(r.value);
    } catch {
      value = r.value; // tolerate a non-JSON legacy value rather than throw
    }
  }
  return {
    workspaceId: r.workspace_id,
    hiveHomeSlug: r.harness_slug,
    settingKey: r.setting_key,
    value,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/**
 * Set (upsert) a Hive setting. Enforces the logical scope — the Hive must exist
 * (the migration has no hard FK). The value federates over the Hive's peer-log via
 * the capture trigger.
 */
export async function setHiveSetting(input: SetHiveSettingInput, sql?: Sql): Promise<HiveSettingRecord> {
  const s = pg(sql);
  const hive = await getHiveBySlug(input.workspaceId, input.hiveHomeSlug, sql);
  if (!hive) {
    throw new Error(
      `setHiveSetting: no Hive '${input.hiveHomeSlug}' in workspace '${input.workspaceId}' — settings belong to a Hive`,
    );
  }
  const value = input.value === undefined ? null : JSON.stringify(input.value);
  const now = Date.now();
  const rows = (await s.unsafe(
    `INSERT INTO harness_shared.hive_settings (${COLS})
       VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (workspace_id, harness_slug, setting_key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = $5
     RETURNING ${COLS}`,
    [input.workspaceId, input.hiveHomeSlug, input.settingKey, value, now],
  )) as unknown as HiveSettingDbRow[];
  return rowToRecord(rows[0]);
}

/** Get one Hive setting by key (null when unset). */
export async function getHiveSetting(
  workspaceId: string,
  hiveHomeSlug: string,
  settingKey: string,
  sql?: Sql,
): Promise<HiveSettingRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.hive_settings
      WHERE workspace_id = $1 AND harness_slug = $2 AND setting_key = $3 LIMIT 1`,
    [workspaceId, hiveHomeSlug, settingKey],
  )) as unknown as HiveSettingDbRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** All settings for a Hive. */
export async function listHiveSettings(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<HiveSettingRecord[]> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.hive_settings
      WHERE workspace_id = $1 AND harness_slug = $2 ORDER BY setting_key`,
    [workspaceId, hiveHomeSlug],
  )) as unknown as HiveSettingDbRow[];
  return rows.map(rowToRecord);
}

/** Delete a Hive setting (idempotent). The delete federates (capture trigger). */
export async function deleteHiveSetting(
  workspaceId: string,
  hiveHomeSlug: string,
  settingKey: string,
  sql?: Sql,
): Promise<boolean> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `DELETE FROM harness_shared.hive_settings
      WHERE workspace_id = $1 AND harness_slug = $2 AND setting_key = $3 RETURNING setting_key`,
    [workspaceId, hiveHomeSlug, settingKey],
  )) as unknown as Array<{ setting_key: string }>;
  return rows.length > 0;
}

// ── Hive-INSTANCE agent-prompt overrides ──────────────────────────────────────
// domain-generic-agent-personas-2026-06-17 P-003 / D-003. A Hive INSTANCE (e.g. the
// Papercusp hive) carries its own per-role prompt specialization here — stored as a
// `hive_settings` value under key `promptOverride.<role>`, so it federates over the
// Hive's peer-log like any other setting. This is the INSTANCE layer that sits ON TOP
// of the blueprint -> ancestors -> base FILE chain (prompt-resolve): the reusable
// blueprint persona stays a file + generic; only instance-specifics live here. The
// override SPECIALIZES (is appended after the resolved persona) — it does not replace
// the role; the caller (the prompt assembler) owns that composition.

export const PROMPT_OVERRIDE_SETTING_PREFIX = 'promptOverride.';

/** The `hive_settings` key a role's instance prompt override is stored under. */
export function promptOverrideSettingKey(role: string): string {
  return `${PROMPT_OVERRIDE_SETTING_PREFIX}${role}`;
}

/** Get a Hive instance's prompt override for a role (null when unset). */
export async function getHiveInstancePromptOverride(
  workspaceId: string,
  hiveHomeSlug: string,
  role: string,
  sql?: Sql,
): Promise<string | null> {
  const rec = await getHiveSetting(workspaceId, hiveHomeSlug, promptOverrideSettingKey(role), sql);
  if (!rec || rec.value == null) return null;
  return typeof rec.value === 'string' ? rec.value : String(rec.value);
}

/** Set (upsert) a Hive instance's prompt override for a role (markdown). Federates. */
export async function setHiveInstancePromptOverride(
  workspaceId: string,
  hiveHomeSlug: string,
  role: string,
  promptMd: string,
  sql?: Sql,
): Promise<void> {
  await setHiveSetting(
    { workspaceId, hiveHomeSlug, settingKey: promptOverrideSettingKey(role), value: promptMd },
    sql,
  );
}

/** All per-role prompt overrides set on a Hive instance (role -> markdown). */
export async function listHiveInstancePromptOverrides(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<Record<string, string>> {
  const all = await listHiveSettings(workspaceId, hiveHomeSlug, sql);
  const out: Record<string, string> = {};
  for (const rec of all) {
    if (rec.settingKey.startsWith(PROMPT_OVERRIDE_SETTING_PREFIX) && rec.value != null) {
      const role = rec.settingKey.slice(PROMPT_OVERRIDE_SETTING_PREFIX.length);
      out[role] = typeof rec.value === 'string' ? rec.value : String(rec.value);
    }
  }
  return out;
}
