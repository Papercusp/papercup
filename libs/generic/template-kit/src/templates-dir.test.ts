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

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../templates");

const ws = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Strip free-text down to a normalized form so folded YAML == concatenated TS. */
function normalized(m: TemplateManifest) {
  return {
    ...m,
    summary: ws(m.summary),
    decisionPoints: m.decisionPoints.map((d) => ({ id: d.id, prompt: ws(d.prompt) })),
    checks: m.checks.map((c) => ({ id: c.id, run: c.run, ...(c.summary !== undefined ? { summary: ws(c.summary) } : {}) })),
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
