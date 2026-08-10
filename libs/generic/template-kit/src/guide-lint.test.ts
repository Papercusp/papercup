/**
 * guide-lint.test — the prose referential-integrity lint (P-001,
 * template-prompt-hardening-2026-07-05). The two seed cases are the real
 * round-3 failures: a GUIDE naming a reference file that doesn't ship
 * (WI-2888) and a GUIDE naming a phantom component (WI-2891).
 */
import { describe, expect, it } from "vitest";
import { lintTemplateProse, type TemplateProseLintInput } from "./guide-lint.js";
import type { TemplateManifest } from "./template-manifest.js";

const MANIFEST: TemplateManifest = {
  id: "papercusp-fixture-shell",
  version: "0.1.0",
  scope: "aspect",
  category: "shell",
  summary: "fixture",
  components: [{ id: "tauri-shell", version: "0.0.1" }],
  contracts: [],
  decisionPoints: [],
  composesWith: [],
  docs: ["agent-insights/templates-system-design"],
  checks: [{ id: "boot-e2e", run: "checks/boot-e2e.test.ts" }],
};

function lint(overrides: Partial<TemplateProseLintInput> & { guide: string }) {
  return lintTemplateProse({
    manifest: MANIFEST,
    files: ["template.yaml", "GUIDE.md", "checks/boot-e2e.test.ts", "checks/README.md", "reference/README.md"],
    prose: [{ path: "GUIDE.md", content: overrides.guide }],
    knownComponentIds: ["tauri-shell", "hono-host"],
    knownTemplateIds: ["papercusp-fixture-shell", "papercusp-ops-hives"],
    allowedPackages: ["template-kit"],
    ...overrides,
  });
}

describe("lintTemplateProse", () => {
  it("passes prose whose references all resolve", () => {
    const r = lint({
      guide:
        "Copy the `reference/README.md` shape. Uses `tauri-shell` via `@papercusp/tauri-shell`; " +
        "composes with `papercusp-ops-hives`. Read `agent-insights/templates-system-design`. " +
        "Run `checks/boot-e2e.test.ts`. The kit is `@papercusp/template-kit`.",
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it("WI-2888 class: a referenced template file that does not ship fails", () => {
    const r = lint({ guide: "Copy the reference `reference/main.rs` shape." });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("reference/main.rs");
    expect(r.errors[0]).toContain("does not exist");
  });

  it("WI-2891 class: a phantom @papercusp component fails", () => {
    const r = lint({ guide: "You MUST use `@papercusp/hive-app-seam` for the seam." });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("@papercusp/hive-app-seam");
  });

  it("an unknown papercusp-* template mention fails (rename rot)", () => {
    const r = lint({ guide: "Composes with `papercusp-desktop-app`." });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("papercusp-desktop-app");
  });

  it("a doc slug mentioned in prose but absent from template.yaml docs fails", () => {
    const r = lint({ guide: "See `agent-insights/templates-component-catalog`." });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("not declared in template.yaml docs");
  });

  it("dir refs and glob refs resolve against prefixes", () => {
    const ok = lint({ guide: "Everything under `reference/` and `checks/*.test.ts` ships." });
    expect(ok).toEqual({ ok: true, errors: [] });
    const bad = lint({ guide: "See `blueprints/starter/`.", files: ["GUIDE.md"] });
    expect(bad.ok).toBe(false);
  });

  it("fenced code blocks are NOT linted (illustrative code, not contracts)", () => {
    const r = lint({
      guide: "Shape:\n```rust\n// see reference/main.rs — illustrative\nuse `@papercusp/phantom`;\n```\nDone.",
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it("reports each dangling span once per file and every problem across files", () => {
    const r = lintTemplateProse({
      manifest: MANIFEST,
      files: ["GUIDE.md"],
      prose: [
        { path: "GUIDE.md", content: "`reference/main.rs` twice: `reference/main.rs`." },
        { path: "checks/README.md", content: "`@papercusp/phantom-seam` here." },
      ],
      knownComponentIds: [],
      knownTemplateIds: [MANIFEST.id],
    });
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toContain("GUIDE.md");
    expect(r.errors[1]).toContain("checks/README.md");
  });
});
