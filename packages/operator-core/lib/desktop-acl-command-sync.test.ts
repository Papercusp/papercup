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

/**
 * Find the `]` that closes the `[` at `openIdx`, by bracket-DEPTH counting
 * rather than a lazy `[\s\S]*?\]` regex. EI-12083 regression: one of the
 * array's own inline comments reads `not a #[tauri::command];` — a lazy
 * regex terminates on THAT `]` (immediately followed by `;`) and silently
 * truncates the extracted command list many entries early. Depth counting is
 * immune: `#[` opens a nested bracket that its own `]` closes, so depth
 * never spuriously returns to 0 inside a balanced inline comment.
 */
function findMatchingBracket(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`no matching ']' found for '[' at index ${openIdx}`);
}

function extractBuildCommands(buildRs: string): string[] {
  // EI-12083: the command list moved from an inline `.commands(&[...])` array
  // literal to a hoisted `let commands: &[&str] = &[...]` binding (so build.rs's
  // own pre-tauri_build capability/manifest cross-check — see
  // check_capability_commands_are_registered — can read the same list without
  // duplicating it). Match either shape so this extractor survives both.
  const letMatch = /let\s+commands\s*:\s*&\[&str\]\s*=\s*&(\[)/.exec(buildRs);
  const inlineMatch = letMatch ? null : /\.commands\(&(\[)/.exec(buildRs);
  const m = letMatch ?? inlineMatch;
  if (!m) throw new Error('.commands(&[...]) / let commands: &[&str] = &[...] not found in build.rs');
  const openIdx = m.index + m[0].length - 1; // index of the `[` captured in group 1
  const closeIdx = findMatchingBracket(buildRs, openIdx);
  const body = stripLineComments(buildRs.slice(openIdx + 1, closeIdx));
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

  maybe('clean-checkout guard validates the db-sql resource independently of serve.mjs', () => {
    const buildRs = readFileSync(BUILD_RS, 'utf8');
    const helper = buildRs.match(/fn ensure_sidecar_placeholder[\s\S]*?\n\}/)?.[0] ?? '';
    expect(helper).toContain('has_db_sql_entry');

    // The invariant is that the early return is gated on an AND-conjunction
    // INCLUDING the independently-computed db-sql check — not on any one
    // literal spelling of that conjunction. Asserting the exact two-resource
    // text pinned this guard to a snapshot of the resource list and went red
    // when `spa` was legitimately added as a third (WI-41672), even though the
    // db-sql protection was fully intact.
    const earlyReturn = helper.match(/if ([^{]*?)\{\s*return;/);
    expect(earlyReturn, 'no early-return guard found in ensure_sidecar_placeholder').not.toBeNull();
    const condition = earlyReturn![1];
    // A disjunction would let a present serve.mjs excuse an absent db-sql —
    // the exact WI-2143 shape — so the conjunction must stay an AND-chain.
    expect(condition, 'early-return condition must be an AND-chain, not a disjunction').not.toContain('||');
    const conjuncts = condition.split('&&').map((c) => c.trim());
    expect(conjuncts).toContain('has_db_sql_entry');

    // Derive the resource set from the placeholder writes themselves, so a
    // NEWLY added resource is automatically held to "validate every resource
    // glob independently" instead of quietly escaping this guard.
    const placeholderFlags = [...helper.matchAll(/if !(\w+)\s*\{/g)].map((m) => m[1]);
    expect(placeholderFlags).toContain('has_db_sql_entry');
    for (const flag of placeholderFlags) {
      expect(
        conjuncts,
        `ensure_sidecar_placeholder writes a placeholder for ${flag}, but the early return does not check it — a partial sidecar would skip it`,
      ).toContain(flag);
    }

    // Regression shape from the release gate: a partial sidecar retained
    // serve.mjs but omitted db-sql, and this shortcut skipped its placeholder.
    expect(helper).not.toMatch(/if sidecar\.join\("serve\.mjs"\)\.exists\(\)\s*\{\s*return;/);
    expect(buildRs).toContain('std::env::var_os("CARGO_MANIFEST_DIR")');
    expect(buildRs).not.toContain('env!("CARGO_MANIFEST_DIR")');
  });

  maybe(
    'EI-12083: a capability/manifest mismatch panics BEFORE tauri_build with an actionable message, not the ~500-line permission wall',
    () => {
      const buildRs = readFileSync(BUILD_RS, 'utf8');
      // The pre-check must run before tauri_build::try_build in main(), on the
      // SAME `commands` list passed to AppManifest::commands(...) — otherwise it
      // could silently validate a different list than what actually ships.
      const checkFn =
        buildRs.match(/fn check_capability_commands_are_registered[\s\S]*?\n\}\n/)?.[0] ?? '';
      expect(checkFn).not.toBe('');
      expect(checkFn).toContain("strip_prefix(\"allow-\")");
      expect(checkFn).toContain('panic!(');
      // The actionable message must name BOTH plausible causes: the transient
      // git-sync split-commit race this was filed for, AND a genuine omission —
      // never just "expected one of [...]" like tauri_build's own wall.
      expect(checkFn).toMatch(/mid-edit/);
      expect(checkFn).toMatch(/git-sync/);
      expect(checkFn).toContain('desktop-acl-command-sync.test.ts');

      const mainFn = buildRs.match(/fn main\(\)[\s\S]*$/)?.[0] ?? '';
      const checkCallIdx = mainFn.indexOf('check_capability_commands_are_registered(');
      const tryBuildIdx = mainFn.indexOf('tauri_build::try_build(');
      expect(checkCallIdx).toBeGreaterThan(-1);
      expect(tryBuildIdx).toBeGreaterThan(-1);
      expect(checkCallIdx).toBeLessThan(tryBuildIdx);
      // Both calls must reference the SAME `commands` binding the extractor reads.
      expect(mainFn).toMatch(/check_capability_commands_are_registered\(&manifest_dir,\s*commands\)/);
      expect(mainFn).toMatch(/AppManifest::new\(\)\.commands\(commands\)/);
    },
  );
});
