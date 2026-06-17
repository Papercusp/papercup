/**
 * Per-user preference overrides on top of workspace-scoped settings.
 *
 * Resolution order at read time:
 *   1. user pref (if user has a value set for the key)
 *   2. workspace pref
 *   3. default
 *
 * The workspace layer is unchanged — this module is purely additive.
 * Per Plan 4 + PLAN-operator-arc-2026-05-12.md.
 *
 * Settings that get user-override scope (see UI list):
 *   agentLanguage, elevenlabsVoiceId, wakeWordKeyword, voiceMaxSpokenWords,
 *   fullAgentIdleTimeoutMin, fullAgentSessionMaxMin,
 *   operatorHistoryTokenBudget, operatorActiveOnStartup, voicePrivacyMode,
 *   speakSuggestions, speakReceivingFlips, speakCadenceStatus,
 *   operatorBackstoryEnabled
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export type UserPrefsPayload = Record<string, unknown>;

// workspace-data-isolation-leaks-2026-06-17 (owner D-001): user overrides are
// PER-WORKSPACE — keyed (user_id, workspace_id) (migration 304). A user's
// voice/budget/language override in one workspace no longer bleeds into another;
// a workspace with no override still falls through to the workspace-level pref.

/**
 * Read user-scoped preferences (the override layer) for the ACTIVE workspace.
 * Returns {} when the user has no row yet (read on the user_id = null path).
 */
export async function loadUserPreferences(userId: string | null): Promise<UserPrefsPayload> {
  if (!userId) return {};
  const { sql } = getOrgPg();
  const rows = await sql<{ payload: UserPrefsPayload }[]>`
    SELECT payload
      FROM harness_shared.user_preferences
     WHERE user_id = ${userId} AND workspace_id = ${activeWorkspaceId()}
     LIMIT 1
  `;
  return rows[0]?.payload ?? {};
}

export async function saveUserPreferences(
  userId: string,
  patch: UserPrefsPayload,
): Promise<UserPrefsPayload> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ payload: UserPrefsPayload }[]>`
    INSERT INTO harness_shared.user_preferences (user_id, workspace_id, payload, updated_at)
    VALUES (${userId}, ${ws}, ${JSON.stringify(patch)}::text::jsonb, now())
    ON CONFLICT (user_id, workspace_id) DO UPDATE
      SET payload = harness_shared.user_preferences.payload || EXCLUDED.payload,
          updated_at = now()
    RETURNING payload
  `;
  return rows[0]?.payload ?? {};
}

/**
 * Clear a single key from user-scoped prefs for the active workspace (falls back
 * to the workspace-level pref on next read).
 */
export async function clearUserPreferenceKey(userId: string, key: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.user_preferences
       SET payload = payload - ${key},
           updated_at = now()
     WHERE user_id = ${userId} AND workspace_id = ${activeWorkspaceId()}
  `;
}

/**
 * Merge workspace prefs with user overrides. User prefs win on any key
 * the user has set; workspace prefs fill the rest.
 *
 * The "set" check is meaningful: user prefs only override when the user
 * has a value present. `null` and `undefined` are treated as "not set"
 * so the user can explicitly clear an override by setting null AND we
 * fall through to workspace. (Truly "use null" cases don't exist in
 * our pref schema — every override-eligible field has a defined type.)
 */
export function mergeUserOverWorkspace<W extends Record<string, unknown>>(
  workspace: W,
  user: UserPrefsPayload,
  overrideKeys: ReadonlyArray<keyof W & string>,
): W {
  const merged: Record<string, unknown> = { ...workspace };
  for (const k of overrideKeys) {
    if (k in user && user[k] !== null && user[k] !== undefined) {
      merged[k] = user[k];
    }
  }
  return merged as W;
}

/**
 * The list of keys that voice/operator prefs honor as user overrides.
 * Keep in sync with the user-settings UI. Each key MUST also exist in
 * the workspace-level VoicePrefs schema so the fallback works.
 */
export const VOICE_USER_OVERRIDE_KEYS = [
  'agentLanguage',
  'elevenlabsVoiceId',
  'wakeWordKeyword',
  'voiceMaxSpokenWords',
  'fullAgentIdleTimeoutMin',
  'fullAgentSessionMaxMin',
  'operatorHistoryTokenBudget',
  'operatorContextMode',
  'operatorActiveOnStartup',
  'voicePrivacyMode',
  'speakSuggestions',
  'speakReceivingFlips',
  'speakCadenceStatus',
  'operatorBackstoryEnabled',
  'memoryEmbedderMode',
] as const;

export type VoiceUserOverrideKey = (typeof VOICE_USER_OVERRIDE_KEYS)[number];
