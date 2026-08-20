import { describe, expect, it } from "vitest";
import { COMPONENT_CATALOG } from "./catalog.js";
import { validateCatalog } from "./component-manifest.js";

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

  it("tier-B components are exactly the seam disciplines (D-002)", () => {
    const tierB = COMPONENT_CATALOG.filter((m) => m.tier === "B")
      .map((m) => m.id)
      .sort();
    expect(tierB).toEqual(["pot-app-seam", "typed-contracts"]);
  });
});
