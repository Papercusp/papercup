import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPONENT_CATALOG } from "./catalog.js";
import { validateCatalog, type ComponentManifest } from "./component-manifest.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DOCS_DIR = join(REPO_ROOT, "apps/operator-docs/src/content/docs");

/**
 * RESOLUTION of the catalog's semantic reference fields (EI-21113414214889358).
 *
 * `validateComponentManifest` shape-checks these fields (string, non-empty) and
 * `validateCatalog` resolves `composesWith` IN-catalog — but nothing proved that
 * `source.path`, `source.package`, or `guide` still point at anything real. They
 * are second copies of truths the repo owns, so they drift silently: a moved lib,
 * a renamed package, a retired docs page all leave the catalog confidently wrong.
 *
 * The validator is PURE + zero-dep BY DESIGN and must stay that way, so the
 * resolution lives HERE, where a test may touch the filesystem — the same split
 * `templates-dir.test.ts` already uses for template dirs.
 *
 * `kind` is the discriminator, and it is load-bearing:
 *   package — extracted, consumable code: `source.path` is a REAL repo-relative
 *             dir whose package.json name must equal `source.package`.
 *   pattern — a documented shape whose canonical form lives in the reference
 *             apps: `source.path` is deliberately PROSE ("internal reference
 *             app: apps/desktop/…"), so resolving it would fail on correct
 *             entries. A pattern therefore must NOT claim a `source.package` —
 *             that claim is exactly what would smuggle an unverifiable package
 *             reference in behind a prose path.
 *
 * `tests` and `summary` stay unresolved on purpose: they are prose for a human
 * or agent to act on, not machine references (derived-truth ladder rung 4).
 */
function resolveEntry(m: ComponentManifest): string[] {
  const errors: string[] = [];
  const { path, package: pkg } = m.source;

  if (m.kind === "package") {
    if (pkg === undefined) {
      errors.push(`${m.id}: kind 'package' must declare source.package`);
    }
    if (path === undefined) {
      errors.push(`${m.id}: kind 'package' must declare source.path`);
    } else {
      const abs = join(REPO_ROOT, path);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        errors.push(`${m.id}: source.path '${path}' does not resolve to a directory`);
      } else {
        const manifestPath = join(abs, "package.json");
        if (!existsSync(manifestPath)) {
          errors.push(`${m.id}: source.path '${path}' has no package.json`);
        } else if (pkg !== undefined) {
          const name = JSON.parse(readFileSync(manifestPath, "utf8")).name;
          if (name !== pkg) {
            errors.push(`${m.id}: source.package '${pkg}' but ${path}/package.json is named '${name}'`);
          }
        }
      }
    }
  } else if (pkg !== undefined) {
    errors.push(
      `${m.id}: kind 'pattern' must not declare source.package ('${pkg}') — a pattern's source.path is prose, so its package claim would go unverified`,
    );
  }

  if (m.guide !== undefined && !existsSync(join(DOCS_DIR, `${m.guide}.mdx`))) {
    errors.push(`${m.id}: guide '${m.guide}' does not resolve to a docs page`);
  }

  return errors;
}

// The P-004 acceptance: "manifests validate" — every curated entry parses,
// ids are unique, and every composesWith reference resolves in-catalog.
describe("COMPONENT_CATALOG", () => {
  it("every entry validates; ids unique; composesWith refs resolve", () => {
    expect(validateCatalog(COMPONENT_CATALOG)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("covers the P-004 component set", () => {
    const ids = COMPONENT_CATALOG.map((m) => m.id);
    for (const required of [
      "pot-app-seam",
      "tauri-shell",
      "embedded-postgres-server",
      "tauri-release-kit",
      "typed-contracts",
      "hono-host",
      "rust-uniffi-mobile-base",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("pins the shared mobile base as one neutral Tier-A pattern", () => {
    const mobileBase = COMPONENT_CATALOG.find((entry) => entry.id === "rust-uniffi-mobile-base");
    expect(mobileBase).toMatchObject({
      version: "0.1.0",
      tier: "A",
      kind: "pattern",
      composesWith: [],
    });
    expect(mobileBase?.provides).toEqual(
      expect.arrayContaining([
        "portable-mobile-core",
        "uniffi-native-boundary",
        "cross-language-design-tokens",
        "mobile-source-hygiene",
      ]),
    );
  });

  it("every semantic reference field RESOLVES (paths, packages, guides)", () => {
    expect(existsSync(DOCS_DIR), `docs dir missing at ${DOCS_DIR}`).toBe(true);
    expect(COMPONENT_CATALOG.flatMap(resolveEntry)).toEqual([]);
  });

  // The controls: a guard that has never failed is a guard nobody has tested.
  // These feed deliberately-wrong entries through the SAME resolver, so the
  // guard above is falsifiable by construction — no tree mutation, no window
  // in which the git-sync sweep could commit a mutant.
  it("the resolver actually catches each way a reference can rot", () => {
    const pkgEntry = COMPONENT_CATALOG.find((m) => m.kind === "package")!;
    const patternEntry = COMPONENT_CATALOG.find((m) => m.kind === "pattern")!;

    // a moved / deleted lib
    expect(
      resolveEntry({ ...pkgEntry, source: { ...pkgEntry.source, path: "libs/generic/does-not-exist" } }),
    ).toEqual([expect.stringContaining("does not resolve to a directory")]);

    // a renamed npm package
    expect(
      resolveEntry({ ...pkgEntry, source: { ...pkgEntry.source, package: "@papercusp/renamed-away" } }),
    ).toEqual([expect.stringContaining("is named")]);

    // a pattern smuggling in an unverifiable package claim behind a prose path
    expect(
      resolveEntry({ ...patternEntry, source: { ...patternEntry.source, package: "@papercusp/unverified" } }),
    ).toEqual([expect.stringContaining("must not declare source.package")]);

    // a retired docs page
    expect(resolveEntry({ ...pkgEntry, guide: "agent-insights/retired-page" })).toEqual([
      expect.stringContaining("does not resolve to a docs page"),
    ]);

    // calibration: the unmodified entries must pass, or the controls above
    // would "pass" even with the resolver broken.
    expect(resolveEntry(pkgEntry)).toEqual([]);
    expect(resolveEntry(patternEntry)).toEqual([]);
  });

  it("tier-B components are exactly the seam disciplines (D-002)", () => {
    const tierB = COMPONENT_CATALOG.filter((m) => m.tier === "B")
      .map((m) => m.id)
      .sort();
    expect(tierB).toEqual(["pot-app-seam", "typed-contracts"]);
  });
});
