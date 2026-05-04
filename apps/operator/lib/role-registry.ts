/**
 * Role registry — scans the harness package's `prompts/` directory for
 * `<role>.role.json` sidecar files and returns parsed manifests.
 *
 * Adding a new cross-cutting expert role becomes:
 *   1. Write `prompts/<role>.md` (the agent's system prompt).
 *   2. Write `prompts/<role>.role.json` (this manifest).
 *
 * No substrate code changes; the scoper consumes the registry via the
 * `/api/harness/<slug>/expert-roles` endpoint and decides per replan
 * which roles to consult.
 *
 * Manifest shape:
 *   {
 *     id:           "infra-reviewer",
 *     whenUseful:   "Consult when SPEC additions might affect deploy pipeline...",
 *     output:       { kind: "features", featureKind: "infra" },
 *     alwaysFireOn: ["onProvisioned"],     // plugin lifecycle / event names
 *     budgetCents:  50,
 *     featureSize:  "small"
 *   }
 *
 * Roles without a sidecar are NOT in the registry — even if a prompt
 * file exists. This is intentional: the sidecar is the opt-in to make
 * a role visible to scoper.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { harnessPackageDir } from '../app/api/_hono/harness-paths';

export interface RoleManifest {
  /** Matches the prompt filename: `prompts/<id>.md`. */
  id: string;
  /** Free-form description scoper uses to decide whether to consult. */
  whenUseful: string;
  /**
   * What the role produces. Today only `kind: 'features'` is supported;
   * `kind: 'spec'` is reserved for future intermediate-spec roles.
   */
  output: { kind: 'features'; featureKind: string };
  /**
   * Plugin lifecycle / event names that trigger this role outside of
   * scoper-decides flow. The substrate's expert-triggers module reads
   * this field to wire post-hoc triggers (e.g. infra-reviewer fires on
   * `onProvisioned` to verify newly-provisioned infrastructure).
   */
  alwaysFireOn?: string[];
  /** Soft budget cap in USD cents per dispatch. Best-effort. */
  budgetCents?: number;
  /** Size hint for the dispatcher / UI. */
  featureSize?: 'small' | 'standard' | 'large';
}

const ROLE_ID_RE = /^[a-z][a-z0-9-]*$/;

let cached: { roles: RoleManifest[]; mtime: number } | null = null;

/**
 * Returns all valid role manifests sorted by id. Caches based on the
 * prompts directory's mtime so that adding a new sidecar at runtime
 * is picked up on the next call without restarting the dev server.
 *
 * Skips invalid manifests (missing required fields, malformed JSON,
 * id that doesn't match `^[a-z][a-z0-9-]*$`) — silently, since the
 * registry is best-effort. Use `validateAllRoles()` to surface errors
 * during development.
 */
export function listRoles(): RoleManifest[] {
  const promptsDir = join(harnessPackageDir(), 'prompts');
  if (!existsSync(promptsDir)) return [];

  // Cheap mtime cache — readdir cost is small but every scoper-replan
  // hits this endpoint and we'd rather not re-parse JSON each time.
  let mtime = 0;
  try {
    const stats = require('node:fs').statSync(promptsDir);
    mtime = stats.mtimeMs;
  } catch { /* fall through with mtime=0 */ }
  if (cached && cached.mtime === mtime) return cached.roles;

  const out: RoleManifest[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(promptsDir).filter((e) => e.endsWith('.role.json'));
  } catch { return []; }

  for (const entry of entries) {
    const id = entry.replace(/\.role\.json$/, '');
    if (!ROLE_ID_RE.test(id)) continue;
    try {
      const raw = readFileSync(join(promptsDir, entry), 'utf8');
      const parsed = JSON.parse(raw) as RoleManifest;
      // Required fields
      if (parsed.id !== id) continue;  // sidecar id must match filename
      if (!parsed.whenUseful || typeof parsed.whenUseful !== 'string') continue;
      if (!parsed.output || parsed.output.kind !== 'features' || !parsed.output.featureKind) continue;
      // Sanity: featureKind should be a slug-ish string
      if (!ROLE_ID_RE.test(parsed.output.featureKind)) continue;
      // Verify the prompt file exists; a manifest without a prompt is dead.
      if (!existsSync(join(promptsDir, `${id}.md`))) continue;
      out.push(parsed);
    } catch { /* malformed JSON or read error — skip silently */ }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  cached = { roles: out, mtime };
  return out;
}

/**
 * Returns a single role's manifest by id, or null if not registered.
 * Useful for the dispatcher to look up an alwaysFireOn list, or for
 * the expert-triggers module to verify a triggered role exists.
 */
export function getRole(id: string): RoleManifest | null {
  return listRoles().find((r) => r.id === id) ?? null;
}

/**
 * Returns roles whose `alwaysFireOn` includes the given event/lifecycle
 * name. The expert-triggers module uses this to dispatch all matching
 * roles when a plugin event fires.
 */
export function rolesFiringOn(event: string): RoleManifest[] {
  return listRoles().filter((r) => (r.alwaysFireOn ?? []).includes(event));
}

/** For the test suite: clear the mtime cache. */
export function __clearRoleRegistryCache(): void {
  cached = null;
}
