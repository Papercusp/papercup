import { describe, expect, it } from "vitest";
import { composeTemplates, validateTemplateSet } from "./composition.js";
import {
  AGENTIC_DESKTOP_APP_TEMPLATE,
  PAPERCUSP_OPS_HIVES_TEMPLATE,
  REFERENCE_TEMPLATES,
  TAURI_DESKTOP_SHELL_TEMPLATE,
} from "./reference-templates.js";
import type { TemplateManifest } from "./template-manifest.js";

function aspect(id: string, over: Partial<TemplateManifest> = {}): TemplateManifest {
  return {
    id,
    version: "1.0.0",
    scope: "aspect",
    summary: `${id} aspect`,
    components: [{ id: `${id}-lib`, version: "1.0.0" }],
    contracts: [],
    decisionPoints: [],
    composesWith: [],
    checks: [{ id: "smoke", run: "checks/smoke.test.ts" }],
    ...over,
  };
}

describe("validateTemplateSet", () => {
  it("accepts a set with unique ids and resolvable composesWith", () => {
    const a = aspect("a", { composesWith: ["b"] });
    const b = aspect("b");
    expect(validateTemplateSet([a, b])).toEqual({ ok: true, errors: [] });
  });

  it("collects invalid entries, duplicate ids, and dangling composesWith", () => {
    const a = aspect("a", { composesWith: ["ghost"] });
    const { ok, errors } = validateTemplateSet([a, aspect("a"), { junk: true }]);
    expect(ok).toBe(false);
    expect(errors).toContain("entry[1]: duplicate template id 'a'");
    expect(errors).toContain("'a' composesWith unknown template 'ghost'");
    expect(errors.some((e) => e.startsWith("entry[2]: "))).toBe(true);
  });
});

describe("composeTemplates", () => {
  it("rejects an empty selection", () => {
    expect(composeTemplates([])).toEqual({
      ok: false,
      errors: ["composition requires at least one template"],
      composition: null,
    });
  });

  it("rejects duplicate templates and two app-scope templates", () => {
    const app1 = aspect("app-one", { scope: "app", components: [], composesWith: ["x"] });
    const app2 = aspect("app-two", { scope: "app" });
    const dup = composeTemplates([app1, app1]);
    expect(dup.ok).toBe(false);
    expect(dup.errors).toContain("duplicate template 'app-one' in the composition");
    const twoApps = composeTemplates([app1, app2]);
    expect(twoApps.ok).toBe(false);
    expect(twoApps.errors).toContain(
      "at most ONE app-scope template per composition — got 'app-one', 'app-two'",
    );
  });

  it("flags component pin conflicts instead of silently resolving them", () => {
    const a = aspect("a", { components: [{ id: "shared", version: "1.0.0" }] });
    const b = aspect("b", { components: [{ id: "shared", version: "2.0.0" }] });
    const { ok, errors } = composeTemplates([a, b]);
    expect(ok).toBe(false);
    expect(errors).toContain("component pin conflict on 'shared': 'a' pins 1.0.0, 'b' pins 2.0.0");
  });

  it("dedupes agreeing component refs and unions everything tagged by source", () => {
    const a = aspect("a", {
      components: [{ id: "shared", version: "1.0.0" }, { id: "a-lib", version: "1.0.0" }],
      blueprints: ["a-print"],
      contracts: ["a-contract"],
      decisionPoints: [{ id: "a-choice", prompt: "?" }],
    });
    const b = aspect("b", { components: [{ id: "shared", version: "1.0.0" }] });
    const { ok, composition } = composeTemplates([a, b]);
    expect(ok).toBe(true);
    expect(composition!.scope).toBe("aspect");
    expect(composition!.appTemplateId).toBeUndefined();
    expect(composition!.components).toEqual([
      { id: "shared", version: "1.0.0" },
      { id: "a-lib", version: "1.0.0" },
    ]);
    expect(composition!.blueprints).toEqual([{ templateId: "a", item: "a-print" }]);
    expect(composition!.contracts).toEqual([{ templateId: "a", item: "a-contract" }]);
    expect(composition!.decisionPoints).toEqual([{ templateId: "a", item: { id: "a-choice", prompt: "?" } }]);
    // The union-of-checks: same check id from two templates stays TWO entries.
    expect(composition!.checks).toEqual([
      { templateId: "a", item: { id: "smoke", run: "checks/smoke.test.ts" } },
      { templateId: "b", item: { id: "smoke", run: "checks/smoke.test.ts" } },
    ]);
  });
});

describe("the reference composition (P-014 acceptance: template #1 as a 3-way split)", () => {
  it("REFERENCE_TEMPLATES validates as a set (all composesWith resolve)", () => {
    expect(validateTemplateSet(REFERENCE_TEMPLATES)).toEqual({ ok: true, errors: [] });
  });

  it("agentic-desktop-app + both aspects compose: one app scope, consistent pins", () => {
    const { ok, errors, composition } = composeTemplates(REFERENCE_TEMPLATES);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(composition!.scope).toBe("app");
    expect(composition!.appTemplateId).toBe("agentic-desktop-app");
    // The effective component set is the full two-plane construction.
    expect(composition!.components.map((c) => c.id).sort()).toEqual([
      "embedded-postgres-server",
      "hive-app-seam",
      "hono-host",
      "tauri-release-kit",
      "tauri-shell",
      "typed-contracts",
    ]);
  });

  it("the union-of-checks carries every aspect's flagship checks + the app's integrity check", () => {
    const { composition } = composeTemplates(REFERENCE_TEMPLATES);
    const keys = composition!.checks.map((c) => `${c.templateId}:${c.item.id}`).sort();
    expect(keys).toEqual([
      "agentic-desktop-app:composition-integrity",
      "papercusp-ops-hives:confinement-guard",
      "papercusp-ops-hives:gym-signals",
      "papercusp-ops-hives:seam-round-trip",
      "tauri-desktop-shell:boot-e2e",
    ]);
  });

  it("aspects also compose WITHOUT the app template (aspect-only composition)", () => {
    const { ok, composition } = composeTemplates([PAPERCUSP_OPS_HIVES_TEMPLATE, TAURI_DESKTOP_SHELL_TEMPLATE]);
    expect(ok).toBe(true);
    expect(composition!.scope).toBe("aspect");
    expect(composition!.appTemplateId).toBeUndefined();
    expect(AGENTIC_DESKTOP_APP_TEMPLATE.composesWith.sort()).toEqual(
      ["papercusp-ops-hives", "tauri-desktop-shell"],
    );
  });
});
