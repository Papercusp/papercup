/**
 * Session + profile helpers — Stage 7 scaffold.
 *
 * Profile preferences (model defaults, default project location, theme)
 * persist in `harness_shared.operator_user_profile` (PG, migration 021).
 * Was previously `~/.papercusp/profile.json` mode 0600. The PG migration
 * was the explicit pre-NextAuth TODO in this module's prior comment —
 * once NextAuth lands we'll switch the lookup key from workspace_id to
 * user_id, but the PG-resident shape is correct now.
 *
 * API credentials remain in `harness_shared.operator_credentials`
 * (PG-only, no Zero) — see `lib/credentials.ts`.
 */

import { readOperatorState, writeOperatorState } from './operator-state-pg';

export interface Profile {
  email?: string;
  display_name?: string;
  default_project_dir?: string;
  preferred_models?: {
    scoper?: string;
    worker?: string;
    validator?: string;
    reviewer?: string;
    orchestrator?: string;
  };
  theme?: 'dark' | 'light' | 'auto';
  /** Auto-scan toggle. Was previously localStorage 'papercusp.autoScan'. */
  auto_scan?: boolean;
  auto_accept?: 'off' | 'low' | 'medium' | 'high';
  /** Last-seen timestamp (ms epoch) for the toast/notification log.
   *  Was previously localStorage 'papercusp.toastLog.lastSeen'. */
  toast_last_seen_ms?: number;
  updated_at?: string;
}

export async function readProfile(): Promise<Profile> {
  return (await readOperatorState<Profile>('operator_user_profile')) ?? {};
}

export async function writeProfile(profile: Profile): Promise<Profile> {
  const next: Profile = { ...profile, updated_at: new Date().toISOString() };
  await writeOperatorState('operator_user_profile', next);
  return next;
}

/** @deprecated kept for legacy callers — returns the table name now. */
export function PROFILE_PATH_CONST() { return 'harness_shared.operator_user_profile'; }
