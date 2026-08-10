/**
 * template-bundle-integrity — the guard for WI-37777 (plan
 * template-supply-chain-repair-2026-08-10, P-002).
 *
 * WHAT WENT WRONG, so the next reader knows what this is defending:
 * `templates/*​/checks/*.test.ts` are PORTABLE content — `overlayTemplateFiles`
 * copies a template's whole `<ref>/` dir into a user's newly materialized app,
 * where those checks are then meant to run. They are deliberately NOT owned by
 * any vitest config in this repo (`testing:run` answers TEST_FILE_ROUTE_ERROR
 * for them), so nothing here ever resolves their imports.
 *
 * `@papercusp/template-kit` was dropped from the tree in the papercup->papercusp
 * migration (it survives only on origin/legacy-papercup-main-2026-07-07) and was
 * never in the root `workspaces` list. The three app-root templates kept importing
 * it. For ~5 weeks every user who materialized a whole-app template got a
 * composition-integrity check that could not execute — and nothing was red,
 * because nothing was looking.
 *
 * This file looks. It runs in operator-core (which IS test-discovered) and makes
 * assertions ABOUT the templates tree, so it cannot be silenced by the same
 * exclusion that hid the original break.
 *
 * TWO INVARIANTS:
 *  1. Every non-node import in a template check resolves to something the RELEASE
 *     BUNDLE puts inside the user's app — i.e. an `@papercusp/*` import must have
 *     a vendored package dir inside that same template, since only `<ref>/` is
 *     overlaid. A copy at libs/generic/ does NOT satisfy this: it reaches the user
 *     only via source.tar.zst, which macOS builds do not ship.
 *  2. Each vendored copy is byte-identical to its canonical libs/generic source.
 *     Vendoring buys platform-independence at the cost of duplication; this is the
 *     price paid so the duplication cannot drift silently (plan D-001).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Repo root: walk up from this file until the root package.json (the one with `workspaces`). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return dir;
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('template-bundle-integrity: could not locate the monorepo root');
}

const ROOT = repoRoot();
const TEMPLATES_DIR = join(ROOT, 'templates');

/**
 * Bare npm packages a portable check may import without vendoring: the app is
 * expected to declare these itself and they ARE on the public registry. Anything
 * else bare must be vendored (see invariant 1).
 */
const PUBLIC_DEVDEPS = new Set(['vitest', 'yaml']);

function listTemplateRefs(): string[] {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR)
    .filter((e) => statSync(join(TEMPLATES_DIR, e)).isDirectory())
    .sort();
}

function listCheckFiles(ref: string): string[] {
  const dir = join(TEMPLATES_DIR, ref, 'checks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f))
    .sort();
}

/**
 * Every non-relative, non-`node:` import specifier in a TS source.
 *
 * Matches on the `from "<spec>"` tail rather than on `import` + specifier, so a
 * MULTILINE named import (`import {\n  A,\n  B,\n} from "pkg";`) is caught. That
 * shape is exactly what hid the template-kit import from a hand grep during the
 * audit that produced this file — a single-line `grep "^import .*@papercusp"`
 * reported the checks as import-clean while three of them imported the kit.
 */
export function externalImportsOf(source: string): string[] {
  const out = new Set<string>();
  const re = /\bfrom\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
    out.add(spec);
  }
  return [...out].sort();
}

/** `@papercusp/template-kit` -> `template-kit` (the dir name a vendored copy uses). */
function vendorDirName(spec: string): string {
  return spec.startsWith('@') ? spec.split('/').slice(1).join('/') : spec;
}

/** Every file under `dir`, as paths relative to `dir`. */
function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

/**
 * Invariant 1, as a pure function of a templates root so it can be exercised
 * against a FIXTURE tree. The falsifiability proof for this guard must never
 * mutate the shared checkout: git-sync commits the whole tree every few minutes,
 * so a probe that breaks a real file can be committed mid-run even when nothing
 * goes wrong (CLAUDE.md, "Proving a guard is falsifiable").
 */
export function findUnvendoredImports(templatesDir: string): string[] {
  const violations: string[] = [];
  if (!existsSync(templatesDir)) return violations;
  for (const ref of readdirSync(templatesDir).sort()) {
    if (!statSync(join(templatesDir, ref)).isDirectory()) continue;
    const checksDir = join(templatesDir, ref, 'checks');
    if (!existsSync(checksDir)) continue;
    for (const f of readdirSync(checksDir).filter((x) => x.endsWith('.ts')).sort()) {
      const file = join(checksDir, f);
      for (const spec of externalImportsOf(readFileSync(file, 'utf8'))) {
        if (PUBLIC_DEVDEPS.has(spec)) continue;
        const dir = vendorDirName(spec);
        if (existsSync(join(templatesDir, ref, dir, 'package.json'))) continue;
        violations.push(
          `templates/${ref}/checks/${f} imports "${spec}" but templates/${ref}/${dir}/package.json does not ` +
            `exist — only <ref>/ is overlaid into a materialized app, so this import cannot resolve for a user`,
        );
      }
    }
  }
  return violations;
}

/** Invariant 2, likewise pure so a fixture can prove it fires. */
export function findVendorDrift(templatesDir: string, libsGenericDir: string): string[] {
  const drift: string[] = [];
  if (!existsSync(templatesDir)) return drift;
  for (const ref of readdirSync(templatesDir).sort()) {
    const templateDir = join(templatesDir, ref);
    if (!statSync(templateDir).isDirectory()) continue;
    for (const entry of readdirSync(templateDir).sort()) {
      const vendored = join(templateDir, entry);
      if (!statSync(vendored).isDirectory()) continue;
      if (!existsSync(join(vendored, 'package.json'))) continue;
      const canonical = join(libsGenericDir, entry);
      if (!existsSync(canonical)) {
        drift.push(`templates/${ref}/${entry} is vendored but has no canonical source at libs/generic/${entry}`);
        continue;
      }
      for (const rel of filesUnder(vendored)) {
        const b = join(canonical, rel);
        if (!existsSync(b)) {
          drift.push(`templates/${ref}/${entry}/${rel} has no counterpart in libs/generic/${entry}`);
          continue;
        }
        if (readFileSync(join(vendored, rel), 'utf8') !== readFileSync(b, 'utf8')) {
          drift.push(`templates/${ref}/${entry}/${rel} differs from libs/generic/${entry}/${rel}`);
        }
      }
    }
  }
  return drift;
}

describe('template bundle integrity — a materialized app can run the checks it ships with', () => {
  it('the templates dir is present (otherwise every assertion below is vacuous)', () => {
    expect(existsSync(TEMPLATES_DIR), `no templates dir at ${TEMPLATES_DIR}`).toBe(true);
    expect(listTemplateRefs().length).toBeGreaterThan(0);
  });

  it('every check file has at least one import (proves the extractor is not silently matching nothing)', () => {
    // Falsifier for the extractor itself. If externalImportsOf ever stops working,
    // the invariant below would pass vacuously for every file — the exact failure
    // mode (an absence "proved" by a search that never matched) this guards against.
    const checks = listTemplateRefs().flatMap(listCheckFiles);
    expect(checks.length, 'no template check files found at all').toBeGreaterThan(0);
    const withImports = checks.filter((f) => externalImportsOf(readFileSync(f, 'utf8')).length > 0);
    expect(withImports.length).toBe(checks.length);
  });

  it('extracts a MULTILINE named import (the shape that hid the original break)', () => {
    const src = 'import {\n  COMPONENT_CATALOG,\n  composeTemplates,\n} from "@papercusp/template-kit";\n';
    expect(externalImportsOf(src)).toEqual(['@papercusp/template-kit']);
  });

  it('every non-node import in a template check is vendored INSIDE that template or is a public devDep', () => {
    const violations = findUnvendoredImports(TEMPLATES_DIR);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every vendored package is byte-identical to its canonical libs/generic source', () => {
    const drift = findVendorDrift(TEMPLATES_DIR, join(ROOT, 'libs', 'generic'));
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('a vendored package ships its runtime entrypoint, not just a manifest', () => {
    const bad: string[] = [];
    for (const ref of listTemplateRefs()) {
      const templateDir = join(TEMPLATES_DIR, ref);
      for (const entry of readdirSync(templateDir)) {
        const vendored = join(templateDir, entry);
        if (!statSync(vendored).isDirectory()) continue;
        const manifestPath = join(vendored, 'package.json');
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { main?: string };
        const main = manifest.main ?? 'index.js';
        if (!existsSync(resolve(vendored, main))) {
          bad.push(`templates/${ref}/${entry}: package.json main "${main}" does not exist in the vendored copy`);
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

/**
 * Falsifiability. Both invariants above assert an EMPTY array, so a bug that made
 * them scan nothing would look identical to a healthy tree. These run the same two
 * functions against a deliberately-broken FIXTURE and require them to complain.
 *
 * The fixture lives in os.tmpdir(), never in the checkout: mutating a real file to
 * prove a guard fires races git-sync's whole-tree sweep, which will happily commit
 * the mutant even when nothing errors (CLAUDE.md, "Proving a guard is falsifiable").
 */
describe('template bundle integrity — the guard itself fails when it should', () => {
  let fixture: string;
  let templates: string;
  let libsGeneric: string;

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'tmpl-bundle-guard-'));
    templates = join(fixture, 'templates');
    libsGeneric = join(fixture, 'libs', 'generic');

    // A HEALTHY template: imports a kit that IS vendored, byte-identical to canonical.
    mkdirSync(join(templates, 'good', 'checks'), { recursive: true });
    mkdirSync(join(templates, 'good', 'demo-kit', 'src'), { recursive: true });
    mkdirSync(join(libsGeneric, 'demo-kit', 'src'), { recursive: true });
    writeFileSync(
      join(templates, 'good', 'checks', 'a.test.ts'),
      'import {\n  thing,\n} from "@papercusp/demo-kit";\nimport { it } from "vitest";\n',
    );
    for (const base of [join(templates, 'good', 'demo-kit'), join(libsGeneric, 'demo-kit')]) {
      writeFileSync(join(base, 'package.json'), '{"name":"@papercusp/demo-kit","main":"./src/index.ts"}');
      writeFileSync(join(base, 'src', 'index.ts'), 'export const thing = 1;\n');
    }

    // BROKEN A: imports a kit that is NOT vendored (the original WI-37777 shape).
    mkdirSync(join(templates, 'unvendored', 'checks'), { recursive: true });
    writeFileSync(
      join(templates, 'unvendored', 'checks', 'b.test.ts'),
      'import {\n  gone,\n} from "@papercusp/absent-kit";\n',
    );

    // BROKEN B: vendored copy has drifted from canonical.
    mkdirSync(join(templates, 'drifted', 'checks'), { recursive: true });
    mkdirSync(join(templates, 'drifted', 'demo-kit', 'src'), { recursive: true });
    writeFileSync(join(templates, 'drifted', 'checks', 'c.test.ts'), 'import { it } from "vitest";\n');
    writeFileSync(
      join(templates, 'drifted', 'demo-kit', 'package.json'),
      '{"name":"@papercusp/demo-kit","main":"./src/index.ts"}',
    );
    writeFileSync(join(templates, 'drifted', 'demo-kit', 'src', 'index.ts'), 'export const thing = 999; // DRIFT\n');
  });

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it('passes the healthy template (so a failure below is the fixture, not a false positive)', () => {
    const only = (rows: string[], ref: string) => rows.filter((r) => r.includes(`templates/${ref}/`));
    expect(only(findUnvendoredImports(templates), 'good')).toEqual([]);
    expect(only(findVendorDrift(templates, libsGeneric), 'good')).toEqual([]);
  });

  it('FIRES on an import with no vendored package (the WI-37777 break)', () => {
    const rows = findUnvendoredImports(templates);
    expect(rows.some((r) => r.includes('unvendored') && r.includes('@papercusp/absent-kit'))).toBe(true);
  });

  it('FIRES on a vendored copy that has drifted from canonical', () => {
    const rows = findVendorDrift(templates, libsGeneric);
    expect(rows.some((r) => r.includes('drifted/demo-kit/src/index.ts') && r.includes('differs'))).toBe(true);
  });

  it('does NOT treat `vitest`/`yaml` as needing vendoring', () => {
    expect(findUnvendoredImports(templates).some((r) => r.includes('"vitest"'))).toBe(false);
  });
});
