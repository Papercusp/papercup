// @vitest-environment node
/**
 * panel-reachability — a panel registered in the /adv dock must be REACHABLE.
 *
 * WHY. Registering a type with `panelRegistry.register(...)` makes it renderable,
 * not openable. What the user can actually open is `HarnessTopBar`'s explicit
 * `allowedTypes` allowlist, which AddPanelCatalog filters the catalog by. Miss
 * that list and you ship a panel that exists, passes its own tests, and cannot be
 * opened by anybody — the UI form of shipping behind a flag nobody flips.
 *
 * This is not hypothetical twice over. `adv:sync-health` (2026-07-28, P-003(b) of
 * no-http-anywhere) was registered, 33/33 green, and absent from the running
 * catalog — caught only by driving the real Tauri webview. Writing this guard then
 * immediately found a SECOND, older instance: `adv:member-work` (WI-259 P-010)
 * carried the comment "openable from the panel menu" and had never been listed, so
 * it had been unopenable since it landed.
 *
 * Deliberately a SOURCE-TEXT check rather than a render test: the failure is a
 * mismatch between two literal lists in two files, and reading them as text is
 * both exact and impossible to satisfy accidentally by mocking.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  throw new Error('panel-reachability: could not locate the monorepo root');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCK = path.join(HERE, 'HarnessesDock.tsx');
const TOPBAR = path.join(HERE, 'HarnessTopBar.tsx');

/**
 * Types intentionally registered WITHOUT catalog entries, each with the reason.
 * Adding to this set is a deliberate act — it is the "yes, this one really is
 * unopenable on purpose" declaration, and the reason has to survive review.
 */
const NOT_IN_CATALOG_ON_PURPOSE: Record<string, string> = {
  'adv:pinned':
    'a layout SLOT, not a panel: it renders DetailPanel under a second title in the ' +
    'default layout. Opening a second one from the catalog would be meaningless.',
};

/**
 * Every type registered in HarnessesDock.
 *
 * Not all registrations pass a literal: the chat panel registers through the
 * `CHAT_PANEL_TYPE` constant (it is referenced in several places). A regex that
 * only accepted literals silently dropped it — and a parser that silently drops a
 * type reports it as unreachable, which is the wrong direction for a guard to be
 * wrong in. So resolve single-literal `const` bindings in the same file too.
 */
function registeredTypes(src: string): string[] {
  const consts = new Map<string, string>(
    [...src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
  );
  return [...src.matchAll(/panelRegistry\.register\(\s*(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))/g)]
    .map((m) => m[1] ?? consts.get(m[2]!))
    .filter((t): t is string => Boolean(t));
}

/**
 * Every string literal inside HarnessTopBar's `allowedTypes={[ … ]}`, including
 * ones inside a conditional spread (a flag-gated entry is still reachable — it is
 * gated, not missing).
 */
function allowedTypes(src: string): string[] {
  const start = src.indexOf('allowedTypes={[');
  if (start < 0) throw new Error('panel-reachability: allowedTypes={[ not found in HarnessTopBar');
  let depth = 1;
  let i = start + 'allowedTypes={['.length;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') depth--;
  }
  if (depth !== 0) throw new Error('panel-reachability: unterminated allowedTypes array');
  return [...src.slice(start, i).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('/adv panel reachability', () => {
  const dock = readFileSync(DOCK, 'utf8');
  const topbar = readFileSync(TOPBAR, 'utf8');

  it('parses both lists (a silent empty parse would make this vacuous)', () => {
    expect(registeredTypes(dock).length).toBeGreaterThan(5);
    expect(allowedTypes(topbar).length).toBeGreaterThan(5);
    // The chat panel is the one type present in both lists in every layout.
    expect(registeredTypes(dock)).toContain('adv:chat');
    expect(allowedTypes(topbar)).toContain('adv:chat');
  });

  it('every registered panel is openable from the catalog, or declared otherwise', () => {
    const allowed = new Set(allowedTypes(topbar));
    const unreachable = registeredTypes(dock).filter(
      (t) => !allowed.has(t) && !(t in NOT_IN_CATALOG_ON_PURPOSE),
    );

    expect(
      unreachable,
      'These panel types are registered in HarnessesDock but missing from ' +
        "HarnessTopBar's allowedTypes, so NOTHING CAN OPEN THEM. Add each to that " +
        'array, or to NOT_IN_CATALOG_ON_PURPOSE in this test with the reason it is ' +
        'deliberately unopenable.',
    ).toEqual([]);
  });

  it('does not allow a type that is not registered anywhere', () => {
    // The mirror failure: a catalog entry whose panel type nobody registers opens
    // the MissingPanel sentinel instead of a panel.
    const registered = new Set(registeredTypes(dock));
    // Other docks register their own types (adv:git-graph / adv:prs in AdvGitDock),
    // so only judge the ones this topbar offers that look Harness-dock-scoped.
    const orphans = allowedTypes(topbar).filter(
      (t) => !registered.has(t) && !t.startsWith('adv:git'),
    );
    expect(orphans, 'Catalog entries with no registered panel open MissingPanel.').toEqual([]);
  });

  it('declares a real reason for each deliberate omission', () => {
    for (const [type, reason] of Object.entries(NOT_IN_CATALOG_ON_PURPOSE)) {
      expect(reason.length, `${type} needs a substantive reason, not a placeholder`).toBeGreaterThan(
        40,
      );
    }
  });
});
