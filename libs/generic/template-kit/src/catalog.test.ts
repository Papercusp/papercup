import { describe, expect, it } from "vitest";
import { COMPONENT_CATALOG } from "./catalog.js";
import { validateCatalog } from "./component-manifest.js";

// The P-004 acceptance: "manifests validate" — every curated entry parses,
// ids are unique, and every composesWith reference resolves in-catalog.
describe("COMPONENT_CATALOG", () => {
  it("every entry validates; ids unique; composesWith refs resolve", () => {
    expect(validateCatalog(COMPONENT_CATALOG)).toEqual({ ok: true, errors: [] });
  });

  it("covers the P-004 component set", () => {
    const ids = COMPONENT_CATALOG.map((m) => m.id);
    for (const required of [
      "hive-app-seam",
      "tauri-shell",
      "embedded-postgres-server",
      "tauri-release-kit",
      "typed-contracts",
      "hono-host",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("tier-B components are exactly the seam disciplines (D-002)", () => {
    const tierB = COMPONENT_CATALOG.filter((m) => m.tier === "B").map((m) => m.id).sort();
    expect(tierB).toEqual(["hive-app-seam", "typed-contracts"]);
  });
});
