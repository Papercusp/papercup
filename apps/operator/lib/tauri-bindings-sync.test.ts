// @vitest-environment node
/**
 * tauri-bindings-sync — the checked-in specta bindings must actually be the
 * bindings for the commands the Rust app collects.
 *
 * WHY THIS EXISTS (EI-18899060060624700). From the papercup→papercusp rename
 * until 2026-07-28, `papercusp-desktop/src-tauri/src/main.rs` exported the
 * tauri-specta bindings to `"../../papercup/apps/operator/lib/tauri-bindings.ts"`.
 * That path is relative to the CRATE dir and specta CREATES missing parent
 * directories — so the export could not fail. It silently conjured a one-file
 * `papercup/` tree at the repo root, wrote every regeneration into it, and left
 * the real `apps/operator/lib/tauri-bindings.ts` 52 lines stale for ~7 weeks.
 * Every command added in that window (including `endpoint_ipc_status`, the IPC
 * health command an observability panel needed) had no typed binding in the tree
 * anything imports.
 *
 * Three silences stacked to hide it, and each is covered by one assertion here:
 *   1. a wrong export path cannot error, because specta mkdir -p's it
 *      → `it('exports to the canonical bindings path')` resolves the literal.
 *   2. only a debug run regenerates (`#[cfg(debug_assertions)]`), so nobody
 *      watches the write
 *      → assertion 2 does not depend on a run happening at all; it compares the
 *        committed file against the collected command list.
 *   3. nothing asserted the command list and the bindings agree, so a missing
 *      binding surfaced only as a TS error at a call site nobody had written yet
 *      → `it('has a binding for every collected command')`.
 *
 * If assertion 2 fails, the fix is NOT to hand-edit the bindings (the file is
 * generated — a hand-edit is lost on the next dev run). Run the desktop app in
 * dev (`cd papercusp-desktop && npm run dev`), which regenerates it in place.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from this file to the monorepo root (the package.json with "workspaces"). */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('tauri-bindings-sync: could not locate the monorepo root');
}

const REPO_ROOT = findRepoRoot();
const CRATE_DIR = path.join(REPO_ROOT, 'papercusp-desktop', 'src-tauri');
const MAIN_RS = path.join(CRATE_DIR, 'src', 'main.rs');
const CANONICAL_BINDINGS = path.join(REPO_ROOT, 'apps', 'operator', 'lib', 'tauri-bindings.ts');

/**
 * The command names inside `tauri_specta::collect_commands![ ... ]`.
 *
 * Entries are paths (`endpoint_ipc::endpoint_ipc_status`) or bare idents
 * (`app_version`); specta registers them under the LAST segment, which is the
 * name the generated `__TAURI_INVOKE("...")` uses.
 */
function collectedCommands(mainRs: string): string[] {
  const macro = 'collect_commands![';
  const start = mainRs.indexOf(macro);
  if (start < 0) throw new Error('tauri-bindings-sync: collect_commands![ not found in main.rs');

  // Scan to the matching close bracket so the list can grow/reflow freely.
  let depth = 1;
  let i = start + macro.length;
  for (; i < mainRs.length && depth > 0; i++) {
    if (mainRs[i] === '[') depth++;
    else if (mainRs[i] === ']') depth--;
  }
  if (depth !== 0) throw new Error('tauri-bindings-sync: unterminated collect_commands![');

  return mainRs
    .slice(start + macro.length, i - 1)
    .split(',')
    .map((entry) => entry.replace(/\/\/[^\n]*/g, '').trim()) // strip line comments
    .filter(Boolean)
    .map((entry) => entry.split('::').pop()!.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

/** The path literal passed to `specta_builder.export(...)`. */
function exportPathLiteral(mainRs: string): string {
  const m = mainRs.match(
    /specta_builder\s*\.export\(\s*specta_typescript::Typescript::default\(\)\s*,\s*"([^"]+)"/,
  );
  if (!m) throw new Error('tauri-bindings-sync: could not find the specta export path literal');
  return m[1];
}

describe('tauri-specta bindings stay in sync with the Rust command list', () => {
  const mainRs = readFileSync(MAIN_RS, 'utf8');

  it('exports to the canonical bindings path, resolved from the crate dir', () => {
    const literal = exportPathLiteral(mainRs);
    // The literal is resolved relative to the crate dir at run time (cargo runs
    // the binary with src-tauri as cwd), NOT the repo root.
    const resolved = path.resolve(CRATE_DIR, literal);
    expect(
      resolved,
      `main.rs exports specta bindings to "${literal}", which resolves to\n  ${resolved}\n` +
        `but the frontend imports\n  ${CANONICAL_BINDINGS}\n` +
        'A mismatch cannot fail at run time (specta creates the directory), so it goes ' +
        'unnoticed until a call site needs a binding that was never written there.',
    ).toBe(CANONICAL_BINDINGS);
  });

  it('does not resurrect the dead pre-rename `papercup/` tree', () => {
    // The one-file tree the misdirected export used to create. Its reappearance
    // means the export path regressed (or a second one was added).
    expect(
      existsSync(path.join(REPO_ROOT, 'papercup')),
      'A `papercup/` directory is back at the repo root. It is not a real tree — it is ' +
        'what a misdirected specta export creates. Check the export path in ' +
        'papercusp-desktop/src-tauri/src/main.rs.',
    ).toBe(false);
  });

  it('has a binding for every collected command', () => {
    const commands = collectedCommands(mainRs);
    // Sanity floor: a parse that silently yields nothing would make this test
    // vacuously green — exactly the failure mode it exists to catch.
    expect(commands.length).toBeGreaterThan(20);

    const bindings = readFileSync(CANONICAL_BINDINGS, 'utf8');
    const missing = commands.filter((name) => !bindings.includes(`__TAURI_INVOKE("${name}"`));

    expect(
      missing,
      `${missing.length} command(s) collected in main.rs have no binding in ` +
        'apps/operator/lib/tauri-bindings.ts. The file is GENERATED — do not hand-add them; ' +
        'run the desktop app in dev (cd papercusp-desktop && npm run dev) to regenerate it.',
    ).toEqual([]);
  });
});
