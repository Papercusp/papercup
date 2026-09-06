/**
 * Mounted-surface CSS guard (portal-parity-with-papercusp-2026-09-03 P-005/P-013,
 * EI-22432328055190066, EI-22432712291442636).
 *
 * The operator surfaces in packages/operator-ui/src/surfaces/index.tsx are mounted
 * NATIVELY by hosts other than the operator — the cloud portal above all — and those
 * hosts deliberately do not import the operator's globals.css (28k lines of app
 * chrome). A surface is therefore only as styled as the stylesheets that travel WITH
 * it: its own directory's *.css (dev/dev.css, settings/settings.css, support/support.css)
 * and the shared _primitives.css, all imported from the surfaces index.
 *
 * MEASURED 2026-09-05 on :3081: Settings rendered as plain blue links (its rules lived
 * only in globals.css) and, after those moved, its Profile form still rendered
 * browser-default because .pc-card/.pc-input/.pc-btn were still globals-only. This
 * guard fails when a class a mounted surface uses has its defining rule ONLY in
 * globals.css, so the next such rule cannot ship unstyled by omission.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const OPERATOR_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(OPERATOR_ROOT, '../..');
const APP_DIR = resolve(OPERATOR_ROOT, 'app');
const GLOBALS = resolve(APP_DIR, 'globals.css');
const PRIMITIVES = resolve(APP_DIR, '_primitives.css');
const SURFACES_INDEX = resolve(REPO_ROOT, 'packages/operator-ui/src/surfaces/index.tsx');
const ADV_HEADER_PILLS = resolve(REPO_ROOT, 'apps/operator-vite/src/components/adv/adv-header-pills.css');

/**
 * Classes a mounted surface uses that are DELIBERATELY globals-only, with the reason.
 * Shrink-only: a new entry needs a reason a reviewer can check.
 */
const GLOBALS_ONLY_ALLOWED: Record<string, string> = {
  // The operator's page-shell wrapper: a host supplies its own shell around the
  // surface (the portal's PortalShellView), so these rules must NOT travel with it.
  'pc-shell': 'operator page shell — the host owns the shell around a mounted surface',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === 'node_modules') continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** The `<kind>: lazy(() => import('<module>'))` entries of the surfaces registry. */
function mountedSurfaceModules(): Map<string, string> {
  const src = readFileSync(SURFACES_INDEX, 'utf8');
  const modules = new Map<string, string>();
  let kind: string | null = null;
  for (const line of src.split('\n')) {
    const head = line.match(/^\s*'?([a-z][a-z-]*)'?:\s*lazy\(/);
    if (head) kind = head[1]!;
    const imp = kind && line.match(/import\(\s*'([^']+)'\s*\)/);
    if (imp && kind && !modules.has(kind)) modules.set(kind, resolve(dirname(SURFACES_INDEX), imp[1]!));
  }
  return modules;
}

/** Stylesheets the surfaces index itself imports — what every host mounting a surface loads. */
function stylesheetsImportedBySurfacesIndex(): string[] {
  const src = readFileSync(SURFACES_INDEX, 'utf8');
  return [...src.matchAll(/^import\s+'([^']+\.css)';/gm)].map((m) => resolve(dirname(SURFACES_INDEX), m[1]!));
}

/** Classes with a DEFINING rule (`.class` as the first compound of a selector) in a stylesheet. */
function definedClasses(cssPath: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(cssPath)) return out;
  postcss.parse(readFileSync(cssPath, 'utf8'), { from: cssPath }).walkRules((rule) => {
    for (const sel of rule.selectors) {
      // `.pc-card` and the specificity-0 `:where(.pc-btn-primary)` form alike.
      const m = sel.trim().match(/^(?::where\(\s*)?\.(pc-[a-z0-9-]+)/);
      if (m) out.add(m[1]!);
    }
  });
  return out;
}

function classesUsedUnder(dir: string): Map<string, string> {
  const used = new Map<string, string>();
  for (const file of walk(dir)) {
    if (!/\.(tsx?|mts)$/.test(file) || /\.(test|spec)\./.test(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bpc-[a-z0-9-]+/g)) if (!used.has(m[0])) used.set(m[0], relative(REPO_ROOT, file));
  }
  return used;
}

describe('mounted-surface CSS: a surface the portal mounts carries its own styling', () => {
  const modules = mountedSurfaceModules();
  // Only the surfaces that live in the operator app tree; the operator-vite /adv
  // components are styled by the adv stylesheets the index already imports.
  const appSurfaces = [...modules].filter(([, m]) => m.startsWith(APP_DIR + '/'));
  const globalsClasses = definedClasses(GLOBALS);
  const indexSheets = stylesheetsImportedBySurfacesIndex();
  const sharedClasses = new Set(indexSheets.flatMap((s) => [...definedClasses(s)]));

  it('positive control: the registry resolves and the shared primitives are imported by it', () => {
    expect(appSurfaces.map(([k]) => k)).toEqual(expect.arrayContaining(['settings', 'dev', 'support', 'cloud']));
    expect(indexSheets).toContain(PRIMITIVES);
    expect(sharedClasses.has('pc-card'), '.pc-card is a shared primitive').toBe(true);
    expect(globalsClasses.size).toBeGreaterThan(100);
  });

  it('the native task-roster surface carries its canonical stylesheet', () => {
    expect(modules.get('tasks-roster')).toContain('apps/operator-vite/src/components/adv/TasksRosterPanel');
    expect(indexSheets).toContain(ADV_HEADER_PILLS);
    expect(sharedClasses.has('pc-tasks-roster'), '.pc-tasks-roster is styled for native hosts').toBe(true);
    expect(readFileSync(ADV_HEADER_PILLS, 'utf8')).toMatch(/\.pc-tasks-roster__row\s*\{/);
  });

  it('the primitives file defines the form building blocks the surfaces are written against', () => {
    const prim = definedClasses(PRIMITIVES);
    for (const cls of ['pc-card', 'pc-input', 'pc-btn', 'pc-btn-primary', 'pc-badge']) {
      expect(prim.has(cls), `.${cls} in _primitives.css`).toBe(true);
    }
    const src = readFileSync(PRIMITIVES, 'utf8');
    expect(src).toMatch(/:where\(button, \.pc-btn\)/);
    // …and globals.css loads it too, so the operator sees exactly one copy of each rule.
    expect(readFileSync(GLOBALS, 'utf8')).toMatch(/^@import '\.\/_primitives\.css';/m);
  });

  it('no class a mounted app surface uses has its defining rule ONLY in globals.css', () => {
    const misses: string[] = [];
    for (const [kind, modulePath] of appSurfaces) {
      const dir = dirname(modulePath);
      const localSheets = walk(dir).filter((f) => f.endsWith('.css'));
      const carried = new Set([...sharedClasses, ...localSheets.flatMap((s) => [...definedClasses(s)])]);
      for (const [cls, where] of classesUsedUnder(dir)) {
        if (!globalsClasses.has(cls) || carried.has(cls) || GLOBALS_ONLY_ALLOWED[cls]) continue;
        misses.push(`.${cls} (used by ${kind} at ${where}) is defined only in app/globals.css`);
      }
    }
    expect(
      misses,
      'move the rule into the surface\'s own stylesheet (imported from its entry and from the surfaces index) or into app/_primitives.css',
    ).toEqual([]);
  });

  it('every stylesheet a surface directory carries reaches a host: imported by the index or by a component in that directory', () => {
    // dev/dev.css was imported ONLY by dev/layout.tsx — a route-level layout the
    // portal never renders — so the sheet never reached the portal until the index
    // imported it. A sheet imported by a component (plans-pane.css from PlansPane.tsx)
    // travels with that component and is fine; a layout-only import is the trap.
    const missing: string[] = [];
    for (const [kind, modulePath] of appSurfaces) {
      const dir = dirname(modulePath);
      const componentSources = walk(dir)
        .filter((f) => /\.(tsx?|mts)$/.test(f) && !/(^|\/)layout\.tsx$/.test(f) && !/\.(test|spec)\./.test(f))
        .map((f) => readFileSync(f, 'utf8'));
      for (const sheet of readdirSync(dir).filter((f) => f.endsWith('.css') && !f.endsWith('.module.css'))) {
        const full = join(dir, sheet);
        const importedByComponent = componentSources.some((src) => new RegExp(`import\\s+['"][^'"]*/${sheet.replace('.', '\\.')}['"]`).test(src));
        if (!indexSheets.includes(full) && !importedByComponent) missing.push(`${kind}: ${relative(REPO_ROOT, full)}`);
      }
    }
    expect(missing, 'import the sheet from a component the host renders, or add it to packages/operator-ui/src/surfaces/index.tsx — a route layout.tsx import never reaches a host').toEqual([]);
  });

  it('the globals-only allowlist is shrink-only and every entry is still real', () => {
    for (const [cls, reason] of Object.entries(GLOBALS_ONLY_ALLOWED)) {
      expect(reason.length, cls).toBeGreaterThan(10);
      expect(globalsClasses.has(cls), `.${cls} no longer defined in globals.css — drop the allowlist entry`).toBe(true);
    }
  });
});
