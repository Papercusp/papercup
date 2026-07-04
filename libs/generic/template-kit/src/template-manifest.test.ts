import { describe, expect, it } from "vitest";
import { COMPONENT_CATALOG } from "./catalog.js";
import type { ComponentManifest } from "./component-manifest.js";
import {
  AGENTIC_DESKTOP_APP_TEMPLATE,
  PAPERCUSP_OPS_HIVES_TEMPLATE,
  REFERENCE_TEMPLATES,
  TAURI_DESKTOP_SHELL_TEMPLATE,
} from "./reference-templates.js";
import {
  parseTemplateManifest,
  validateTemplateAgainstCatalog,
  validateTemplateManifest,
  type TemplateManifest,
} from "./template-manifest.js";

function valid(): TemplateManifest {
  return {
    id: "my-template",
    version: "1.0.0",
    scope: "aspect",
    summary: "A test template.",
    components: [{ id: "hive-app-seam", version: "0.1.0" }],
    contracts: ["my-contract"],
    decisionPoints: [{ id: "a-choice", prompt: "Pick something." }],
    composesWith: ["another-template"],
    checks: [{ id: "smoke", run: "checks/smoke.test.ts" }],
  };
}

describe("validateTemplateManifest", () => {
  it("accepts a valid manifest (blueprints optional)", () => {
    expect(validateTemplateManifest(valid())).toEqual({ ok: true, errors: [] });
    expect(validateTemplateManifest({ ...valid(), blueprints: ["ops-hive"] }).ok).toBe(true);
  });

  it("rejects a non-object outright", () => {
    for (const raw of [null, undefined, "yaml", 7, ["nope"]]) {
      expect(validateTemplateManifest(raw)).toEqual({
        ok: false,
        errors: ["template manifest must be an object"],
      });
    }
  });

  it("collects EVERY problem on an empty object", () => {
    const { ok, errors } = validateTemplateManifest({});
    expect(ok).toBe(false);
    for (const field of ["id:", "version:", "scope:", "summary:", "components:", "contracts:", "decisionPoints:", "composesWith:", "checks:"]) {
      expect(errors.some((e) => e.startsWith(field))).toBe(true);
    }
  });

  it("rejects bad scalar fields", () => {
    expect(validateTemplateManifest({ ...valid(), id: "Not Kebab" }).errors).toContain("id: required kebab-case string");
    expect(validateTemplateManifest({ ...valid(), version: "1.0" }).errors).toContain("version: required semver string (x.y.z)");
    expect(validateTemplateManifest({ ...valid(), scope: "global" }).errors).toContain("scope: required one of app|aspect");
    expect(validateTemplateManifest({ ...valid(), summary: "  " }).errors).toContain("summary: required non-empty string");
  });

  it("requires well-formed, duplicate-free components; empty only for a pure composition", () => {
    expect(validateTemplateManifest({ ...valid(), components: [], composesWith: [] }).errors).toContain(
      "components: may be empty only for a pure-composition template (non-empty composesWith)",
    );
    // Pure composition: empty components is fine when composesWith is non-empty.
    expect(validateTemplateManifest({ ...valid(), components: [] }).ok).toBe(true);
    expect(validateTemplateManifest({ ...valid(), components: "nope" }).errors).toContain(
      "components: required array of { id, version }",
    );
    expect(validateTemplateManifest({ ...valid(), components: ["hive-app-seam"] }).errors).toContain(
      "components[0]: must be an object { id, version }",
    );
    const dup = { ...valid(), components: [{ id: "x", version: "1.0.0" }, { id: "x", version: "1.0.0" }] };
    expect(validateTemplateManifest(dup).errors).toContain("components[1]: duplicate component ref 'x'");
    const badPin = { ...valid(), components: [{ id: "x", version: "^1.0.0" }] };
    expect(validateTemplateManifest(badPin).errors).toContain("components[0].version: required exact semver pin (x.y.z)");
  });

  it("enforces kebab-case across blueprints/contracts/composesWith", () => {
    expect(validateTemplateManifest({ ...valid(), blueprints: ["Ops Hive"] }).errors).toContain("blueprints: 'Ops Hive' is not kebab-case");
    expect(validateTemplateManifest({ ...valid(), contracts: ["My_Contract"] }).errors).toContain("contracts: 'My_Contract' is not kebab-case");
    expect(validateTemplateManifest({ ...valid(), composesWith: ["Bad"] }).errors).toContain("composesWith: 'Bad' is not kebab-case");
  });

  it("validates decisionPoints structure and uniqueness", () => {
    const bad = { ...valid(), decisionPoints: [{ id: "ok", prompt: "" }, "nope", { id: "ok", prompt: "again" }] };
    const { errors } = validateTemplateManifest(bad);
    expect(errors).toContain("decisionPoints[0].prompt: required non-empty string");
    expect(errors).toContain("decisionPoints[1]: must be an object { id, prompt }");
    expect(errors).toContain("decisionPoints[2]: duplicate decision point 'ok'");
  });

  it("requires a non-empty, duplicate-free checks suite", () => {
    expect(validateTemplateManifest({ ...valid(), checks: [] }).errors).toContain(
      "checks: required non-empty array of { id, run } — checks are load-bearing",
    );
    const bad = { ...valid(), checks: [{ id: "smoke", run: " " }, { id: "smoke", run: "x", summary: 3 }] };
    const { errors } = validateTemplateManifest(bad);
    expect(errors).toContain("checks[0].run: required non-empty string");
    expect(errors).toContain("checks[1].summary: must be a string when present");
    expect(errors).toContain("checks[1]: duplicate check 'smoke'");
  });
});

describe("parseTemplateManifest", () => {
  it("returns the typed manifest when valid", () => {
    expect(parseTemplateManifest(valid()).id).toBe("my-template");
  });

  it("throws ONE error listing every problem", () => {
    expect(() => parseTemplateManifest({ ...valid(), id: "Bad Id", checks: [] })).toThrow(
      /^invalid template manifest: id: required kebab-case string; checks:/,
    );
  });
});

describe("validateTemplateAgainstCatalog", () => {
  const catalog: ComponentManifest[] = [
    {
      id: "hive-app-seam",
      version: "0.1.0",
      tier: "B",
      kind: "package",
      provides: ["hive-bootstrap"],
      composesWith: [],
      source: { package: "@papercusp/hive-app-seam" },
      tests: "npm test",
      summary: "seam",
    },
  ];

  it("accepts refs that resolve with matching pins", () => {
    expect(validateTemplateAgainstCatalog(valid(), catalog)).toEqual({ ok: true, errors: [] });
  });

  it("flags unknown components and stale version pins", () => {
    const m = {
      ...valid(),
      components: [
        { id: "hive-app-seam", version: "0.0.9" },
        { id: "ghost-component", version: "1.0.0" },
      ],
    };
    const { ok, errors } = validateTemplateAgainstCatalog(m, catalog);
    expect(ok).toBe(false);
    expect(errors).toContain(
      "'my-template' pins 'hive-app-seam@0.0.9' but the catalog has 0.1.0 (stale pin — update the template or the catalog)",
    );
    expect(errors).toContain("'my-template' references unknown component 'ghost-component'");
  });
});

describe("REFERENCE_TEMPLATES (the retro-fitted quartermaster manifests — P-005/P-014 acceptance)", () => {
  it("each validates as a template manifest (the app template as a pure composition)", () => {
    for (const t of REFERENCE_TEMPLATES) {
      expect(validateTemplateManifest(t)).toEqual({ ok: true, errors: [] });
    }
    expect(parseTemplateManifest(AGENTIC_DESKTOP_APP_TEMPLATE).scope).toBe("app");
    expect(AGENTIC_DESKTOP_APP_TEMPLATE.components).toEqual([]);
  });

  it("each cross-validates against the REAL component catalog (catalog drift breaks this loudly)", () => {
    for (const t of REFERENCE_TEMPLATES) {
      expect(validateTemplateAgainstCatalog(t, COMPONENT_CATALOG)).toEqual({ ok: true, errors: [] });
    }
  });

  it("the ops-hives aspect carries both Tier B components; the shell carries the chassis", () => {
    expect(PAPERCUSP_OPS_HIVES_TEMPLATE.components.map((c) => c.id).sort()).toEqual(
      ["hive-app-seam", "typed-contracts"],
    );
    expect(TAURI_DESKTOP_SHELL_TEMPLATE.components.map((c) => c.id).sort()).toEqual(
      ["embedded-postgres-server", "hono-host", "tauri-release-kit", "tauri-shell"],
    );
  });
});
