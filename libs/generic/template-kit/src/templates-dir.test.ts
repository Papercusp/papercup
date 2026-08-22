/**
 * Anti-drift pin between the shipped template dirs (papercup repo
 * `templates/<id>/template.yaml` — the v1 source-of-truth location, P-006)
 * and the machine reference manifests (`src/reference-templates.ts`).
 *
 * Free-text fields (summary, decision prompts, check summaries) compare
 * whitespace-NORMALIZED (yaml folded scalars vs TS string concatenation);
 * every structural field compares exactly. YAML parsing happens HERE (a test
 * devDep) — the lib runtime stays zero-dep by design.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REFERENCE_TEMPLATES } from "./reference-templates.js";
import { parseTemplateManifest, type TemplateManifest } from "./template-manifest.js";
import { validateTemplateAgainstCatalog } from "./template-manifest.js";
import { COMPONENT_CATALOG } from "./catalog.js";
import { lintTemplateProse } from "./guide-lint.js";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../templates");

const ws = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Strip free-text down to a normalized form so folded YAML == concatenated TS. */
function normalized(m: TemplateManifest) {
  return {
    ...m,
    summary: ws(m.summary),
    decisionPoints: m.decisionPoints.map((d) => ({ id: d.id, prompt: ws(d.prompt) })),
    checks: m.checks.map((c) => ({ id: c.id, run: c.run, ...(c.summary !== undefined ? { summary: ws(c.summary) } : {}) })),
    ...(m.musts !== undefined
      ? { musts: m.musts.map((x) => ({ id: x.id, rule: ws(x.rule), enforcedBy: x.enforcedBy })) }
      : {}),
  };
}

describe("templates/ dir ⇄ reference manifests (P-006 anti-drift pin)", () => {
  it("the templates dir exists in this repo layout", () => {
    expect(existsSync(TEMPLATES_DIR)).toBe(true);
  });

  it("every reference manifest has a template dir whose template.yaml matches it", () => {
    for (const ref of REFERENCE_TEMPLATES) {
      const yamlPath = join(TEMPLATES_DIR, ref.id, "template.yaml");
      expect(existsSync(yamlPath), `${ref.id}: missing ${yamlPath}`).toBe(true);
      const parsed = parseTemplateManifest(parse(readFileSync(yamlPath, "utf8")));
      expect(normalized(parsed), `${ref.id}: template.yaml drifted from reference-templates.ts`).toEqual(normalized(ref));
      expect(validateTemplateAgainstCatalog(parsed, COMPONENT_CATALOG)).toEqual({ ok: true, errors: [] });
    }
  });

  it("every template dir ships GUIDE.md and is a known reference manifest", () => {
    // templates/ is also the @papercusp/templates workspace member (P-007), so
    // skip repo plumbing: node_modules + dot-dirs are not template dirs.
    const dirs = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "node_modules" && !d.name.startsWith("."))
      .map((d) => d.name);
    const known = new Set(REFERENCE_TEMPLATES.map((t) => t.id));
    for (const dir of dirs) {
      expect(known.has(dir), `templates/${dir} has no reference manifest in template-kit`).toBe(true);
      expect(existsSync(join(TEMPLATES_DIR, dir, "GUIDE.md")), `templates/${dir}: missing GUIDE.md`).toBe(true);
    }
    expect(dirs.sort()).toEqual([...known].sort());
  });

  it("declared blueprints and contracts exist as starter files", () => {
    for (const ref of REFERENCE_TEMPLATES) {
      for (const b of ref.blueprints ?? []) {
        const p = join(TEMPLATES_DIR, ref.id, "blueprints", b, "blueprint.yaml");
        expect(existsSync(p), `${ref.id}: declared blueprint '${b}' missing at ${p}`).toBe(true);
      }
      for (const c of ref.contracts) {
        const p = join(TEMPLATES_DIR, ref.id, "contracts", `${c}.ts`);
        expect(existsSync(p), `${ref.id}: declared contract '${c}' missing at ${p}`).toBe(true);
      }
    }
  });
});

/** Recursive file walk (template-relative paths), skipping repo plumbing. */
function walkFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(join(dir, e.name), childRel));
    else out.push(childRel);
  }
  return out;
}

describe("P-005 prose referential integrity over the real templates (template-prompt-hardening-2026-07-05)", () => {
  const knownTemplateIds = REFERENCE_TEMPLATES.map((t) => t.id);
  const knownComponentIds = COMPONENT_CATALOG.map((c) => c.id);

  it("every template's GUIDE + READMEs pass lintTemplateProse (WI-2888/WI-2891 stay fixed)", () => {
    for (const ref of REFERENCE_TEMPLATES) {
      const dir = join(TEMPLATES_DIR, ref.id);
      const files = walkFiles(dir);
      const prose = ["GUIDE.md", "reference/README.md", "checks/README.md"]
        .filter((p) => existsSync(join(dir, p)))
        .map((p) => ({ path: p, content: readFileSync(join(dir, p), "utf8") }));
      const r = lintTemplateProse({
        manifest: ref,
        files,
        prose,
        knownComponentIds,
        knownTemplateIds,
        allowedPackages: ["template-kit", "templates", "grid", "grid-core", "bloom-grid"], // real packages GUIDEs name that are not catalog components (kit, the templates workspace, papergrid sub-packages under libs/generic/papergrid)
      });
      expect(r.errors, `${ref.id}:\n  ${r.errors.join("\n  ")}`).toEqual([]);
    }
  });

  it("every template declares structured MUSTs (P-004 adoption is total)", () => {
    for (const ref of REFERENCE_TEMPLATES) {
      expect(ref.musts !== undefined && ref.musts.length > 0, `${ref.id}: no musts[]`).toBe(true);
    }
  });
});

/**
 * Recurrence guard for EI-21110451200329856 (plan
 * official-mobile-app-templates-2026-08-20, P-018).
 *
 * `templates:new-app` overlays ONLY a template's own root directory into the
 * new app, so a shipped check that reaches a SIBLING template directory
 * (a "../../papercusp-<id>" template.yaml path) resolves in this repo and
 * ENOENTs in every materialized app. Both mobile app roots shipped exactly that,
 * which made the union a greenfield builder is told to run red out of the box —
 * inside the very check contract that is supposed to prove these templates make
 * no private source-tree assumptions.
 *
 * The class is "a shipped check dereferences a sibling path unconditionally".
 * The fix routes every such path through `checks/closure-manifests.ts`, whose
 * tri-state resolver skips only when NO sibling resolves and still throws when
 * some-but-not-all do. This guard therefore asserts the routing, not the fix's
 * internals: a check that names a sibling template must import that resolver,
 * and the resolver must ship in the same directory so it travels with the app.
 */
describe("shipped template checks make no private source-tree assumption (EI-21110451200329856)", () => {
  const SIBLING_REF = /\.\.\/\.\.\/papercusp-[a-z0-9-]+/;
  const RESOLVER = "closure-manifests";

  it("every check naming a sibling template routes it through the tri-state resolver", () => {
    const offenders: string[] = [];

    for (const ref of REFERENCE_TEMPLATES) {
      const checksDir = join(TEMPLATES_DIR, ref.id, "checks");
      if (!existsSync(checksDir)) continue;

      for (const rel of walkFiles(checksDir)) {
        if (!rel.endsWith(".ts")) continue;
        if (rel.startsWith(RESOLVER)) continue; // the resolver itself may not name one, but never assume

        const source = readFileSync(join(checksDir, rel), "utf8");
        if (!SIBLING_REF.test(source)) continue;

        if (!source.includes(`./${RESOLVER}.js`)) {
          offenders.push(
            `templates/${ref.id}/checks/${rel}: reads a sibling template path ` +
              `but does not import ./${RESOLVER}.js — it will ENOENT in every materialized app`,
          );
          continue;
        }
        if (!existsSync(join(checksDir, `${RESOLVER}.ts`))) {
          offenders.push(
            `templates/${ref.id}/checks/${rel}: imports ./${RESOLVER}.js but ` +
              `checks/${RESOLVER}.ts is not shipped in the same directory`,
          );
        }
      }
    }

    expect(offenders, `\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
