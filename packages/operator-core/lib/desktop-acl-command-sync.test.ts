/**
 * desktop-acl-command-sync — recurrence guard for WI-2143.
 *
 * The Tauri desktop shell registers its app commands via tauri-specta's
 * `collect_commands![]` (main.rs), NOT the `generate_handler!` macro Tauri's
 * build script scans. So Tauri does NOT auto-generate the `allow-<command>`
 * ACL permissions for them — `build.rs` must re-declare each command name in
 * its `AppManifest::commands(&[...])` list so the permission is generated, and
 * `capabilities/default.json` must then GRANT it. The operator SPA loads from a
 * remote http origin (http://127.0.0.1:<port>), and Tauri 2's ACL rejects any
 * un-granted app-command invoke from a non-local origin with
 * "<cmd> not allowed. Command not found".
 *
 * WI-1976 wired up a handful of commands this way; the rest of
 * `collect_commands![]` drifted un-listed and were silently ACL-dead from the
 * webview — the recurring "workspaces_list not allowed. Command not found"
 * toast (WI-2143) plus a whole class of broken desktop commands (version chip,
 * terminals, WSL, env-switch). This test locks the three lists together so the
 * drift cannot recur:
 *
 *   1. every `collect_commands![]` entry is registered in build.rs
 *      (⊆ — build.rs may hold inert extras like the `window_title_for` helper);
 *   2. the capability's `allow-*` grants EXACTLY match the build.rs command
 *      list (catches BOTH a missing grant and an orphaned one).
 *
 * When you add/remove a `collect_commands![]` command, update build.rs's
 * `.commands(&[...])` AND capabilities/default.json in the SAME change — this
 * test prints exactly what drifted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// packages/operator-core/lib -> repo root -> papercusp-desktop submodule
const SRC_TAURI = resolve(here, '../../..', 'papercusp-desktop/src-tauri');
const MAIN_RS = resolve(SRC_TAURI, 'src/main.rs');
const BUILD_RS = resolve(SRC_TAURI, 'build.rs');
const CAP_JSON = resolve(SRC_TAURI, 'capabilities/default.json');

/** command name -> Tauri capability permission id (underscores -> dashes). */
function permId(cmd: string): string {
  return 'allow-' + cmd.replace(/_/g, '-');
}

/** Drop `// ...` line comments (both macro/array blocks use them inline). */
function stripLineComments(s: string): string {
  return s.replace(/\/\/[^\n]*/g, '');
}

function extractCollectCommands(mainRs: string): string[] {
  const m = mainRs.match(/collect_commands!\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('collect_commands![] not found in main.rs');
  return stripLineComments(m[1])
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.split('::').pop()!.trim()) // strip module path (pty::pty_spawn -> pty_spawn)
    .filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
}

function extractBuildCommands(buildRs: string): string[] {
  const m = buildRs.match(/\.commands\(&\[([\s\S]*?)\]\)/);
  if (!m) throw new Error('.commands(&[...]) not found in build.rs');
  const body = stripLineComments(m[1]);
  const out: string[] = [];
  const re = /"([^"]+)"/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(body))) out.push(mm[1]);
  return out;
}

function extractCapabilityAllows(capJson: string): string[] {
  const cap = JSON.parse(capJson) as { permissions: string[] };
  return cap.permissions.filter((p) => p.startsWith('allow-'));
}

const present = existsSync(MAIN_RS) && existsSync(BUILD_RS) && existsSync(CAP_JSON);
if (!present) {
  // Loud, not silent (repo convention): a checkout without the desktop
  // submodule can't run this guard. Everywhere the submodule IS present
  // (the canonical tree + CI submodule-init) the assertions below gate.
  // eslint-disable-next-line no-console
  console.warn(
    '[desktop-acl-command-sync] papercusp-desktop submodule not checked out — ACL command-sync guard SKIPPED',
  );
}
const maybe = present ? it : it.skip;

describe('desktop ACL command sync (WI-2143 guard)', () => {
  maybe('every collect_commands![] entry is registered in build.rs', () => {
    const collect = extractCollectCommands(readFileSync(MAIN_RS, 'utf8'));
    const build = new Set(extractBuildCommands(readFileSync(BUILD_RS, 'utf8')));
    expect(collect.length).toBeGreaterThan(0);
    const missing = collect.filter((c) => !build.has(c));
    // If this fails: add the listed command name(s) to build.rs
    // `.commands(&[...])` AND grant `allow-<name>` in capabilities/default.json.
    expect(missing, `collect_commands! entries missing from build.rs: ${missing.join(', ')}`).toEqual([]);
  });

  maybe('capability allow-* grants exactly match the build.rs command list', () => {
    const build = extractBuildCommands(readFileSync(BUILD_RS, 'utf8'));
    const expected = [...new Set(build.map(permId))].sort();
    const actual = [...new Set(extractCapabilityAllows(readFileSync(CAP_JSON, 'utf8')))].sort();
    const missingGrants = expected.filter((p) => !actual.includes(p));
    const orphanGrants = actual.filter((p) => !expected.includes(p));
    expect(
      missingGrants,
      `commands registered in build.rs but not granted in capabilities/default.json: ${missingGrants.join(', ')}`,
    ).toEqual([]);
    expect(
      orphanGrants,
      `allow-* grants in capabilities/default.json with no matching build.rs command: ${orphanGrants.join(', ')}`,
    ).toEqual([]);
  });

  maybe('WI-2143 regression: workspaces_list is registered AND granted', () => {
    const build = new Set(extractBuildCommands(readFileSync(BUILD_RS, 'utf8')));
    const grants = new Set(extractCapabilityAllows(readFileSync(CAP_JSON, 'utf8')));
    const collect = new Set(extractCollectCommands(readFileSync(MAIN_RS, 'utf8')));
    expect(collect.has('workspaces_list')).toBe(true);
    expect(build.has('workspaces_list')).toBe(true);
    expect(grants.has('allow-workspaces-list')).toBe(true);
  });
});
