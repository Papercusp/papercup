import { describe, expect, it } from "vitest";
import { composeTemplates, resolveRequiresClosure, validateTemplateSet } from "./composition.js";
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
    category: "data",
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

  // Template #1's composition = the agentic-desktop-app requires-closure
  // (P-015) — NOT the whole reference set, which now also carries templates
  // the app does not require (data-sync, …).
  const template1 = () => resolveRequiresClosure([AGENTIC_DESKTOP_APP_TEMPLATE], REFERENCE_TEMPLATES).templates;

  it("agentic-desktop-app + both aspects compose: one app scope, consistent pins", () => {
    const { ok, errors, composition } = composeTemplates(template1());
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
    const { composition } = composeTemplates(template1());
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

describe("P-015 — requires: hard pinned cross-template deps", () => {
  it("validateTemplateSet resolves requires refs and checks the pin", () => {
    const b = aspect("b");
    const a = aspect("a", { requires: [{ id: "b", version: "1.0.0" }] });
    expect(validateTemplateSet([a, b])).toEqual({ ok: true, errors: [] });
    expect(validateTemplateSet([a]).errors.join(";")).toContain("requires unknown template 'b'");
    const stale = aspect("a", { requires: [{ id: "b", version: "9.9.9" }] });
    expect(validateTemplateSet([stale, b]).errors.join(";")).toContain("stale pin");
  });

  it("composeTemplates enforces closure completeness (requires satisfied IN the selection)", () => {
    const b = aspect("b");
    const a = aspect("a", { requires: [{ id: "b", version: "1.0.0" }] });
    expect(composeTemplates([a, b]).ok).toBe(true);
    const missing = composeTemplates([a]);
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(";")).toContain("not in the composition");
    const wrongPin = composeTemplates([aspect("a", { requires: [{ id: "b", version: "2.0.0" }] }), b]);
    expect(wrongPin.ok).toBe(false);
    expect(wrongPin.errors.join(";")).toContain("stale pin");
  });

  it("resolveRequiresClosure expands roots dep-first, deduped", () => {
    const c = aspect("c");
    const b = aspect("b", { requires: [{ id: "c", version: "1.0.0" }] });
    const a = aspect("a", { requires: [{ id: "b", version: "1.0.0" }, { id: "c", version: "1.0.0" }] });
    const res = resolveRequiresClosure([a], [a, b, c]);
    expect(res.ok).toBe(true);
    expect(res.templates.map((t) => t.id)).toEqual(["c", "b", "a"]);
    // the closure then composes clean
    expect(composeTemplates(res.templates).ok).toBe(true);
  });

  it("resolveRequiresClosure errors on unknown ref, stale pin, and cycles", () => {
    const a = aspect("a", { requires: [{ id: "ghost", version: "1.0.0" }] });
    expect(resolveRequiresClosure([a], [a]).errors.join(";")).toContain("unknown template 'ghost'");

    const b = aspect("b");
    const stale = aspect("a", { requires: [{ id: "b", version: "0.0.9" }] });
    expect(resolveRequiresClosure([stale], [stale, b]).errors.join(";")).toContain("stale pin");

    const x = aspect("x", { requires: [{ id: "y", version: "1.0.0" }] });
    const y = aspect("y", { requires: [{ id: "x", version: "1.0.0" }] });
    expect(resolveRequiresClosure([x], [x, y]).errors.join(";")).toContain("requires cycle");
  });

  it("the reference set: agentic-desktop-app's requires-closure = the 3-way split, composing green", () => {
    const res = resolveRequiresClosure([AGENTIC_DESKTOP_APP_TEMPLATE], REFERENCE_TEMPLATES);
    expect(res.ok).toBe(true);
    expect(new Set(res.templates.map((t) => t.id))).toEqual(
      new Set(["agentic-desktop-app", "papercusp-ops-hives", "tauri-desktop-shell"]),
    );
    expect(res.templates[res.templates.length - 1]!.id).toBe("agentic-desktop-app"); // deps first
    const composed = composeTemplates(res.templates);
    expect(composed.ok).toBe(true);
    expect(composed.composition!.appTemplateId).toBe("agentic-desktop-app");
  });
});
