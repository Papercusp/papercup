import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChecksConfig, validateChecksConfig } from "./checks-config.js";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../templates");

const valid = {
  app: { name: "quartermaster", root: "." },
  confinement: {
    blueprints: ["blueprints/quartermaster-ops/blueprint.yaml"],
    dangerousCapabilities: ["cart:*", "checkout:*", "approvals:write"],
    dangerousTools: ["checkout:*"],
  },
  seam: {
    workItemKind: "purchase-research",
    contractModule: "packages/contracts/src/index.ts",
    parseInputExport: "parsePurchaseResearchInput",
    parseOutputExport: "parseCandidateSet",
    joinKey: "itemId",
    validInput: { itemId: 42, item: "Cash Drawer", qty: 2 },
    validOutput: { itemId: 42, candidates: [], searchNotes: "none qualified", ts: "2026-07-04T00:00:00Z" },
    invalidOutput: { itemId: 42, candidates: [] },
  },
  boot: { mode: "attach", discoveryFile: "~/.quartermaster/operator.json" },
  gym: { blueprint: "blueprints/quartermaster-ops/blueprint.yaml", requiredSignals: ["no-checkout-reach"] },
};

describe("validateChecksConfig", () => {
  it("accepts a fully-populated config", () => {
    expect(validateChecksConfig(valid)).toEqual([]);
  });

  it("accepts a minimal config (app only — every check skips)", () => {
    expect(validateChecksConfig({ app: { name: "x" } })).toEqual([]);
  });

  it("collects every error, not just the first", () => {
    const errors = validateChecksConfig({
      app: {},
      confinement: { blueprints: [], dangerousCapabilities: "cart" },
      boot: { mode: "spawn", discoveryFile: "" },
      gym: { requiredSignals: [] },
    });
    expect(errors).toContain("app.name: required non-empty string");
    expect(errors).toContain("confinement.blueprints: must be non-empty");
    expect(errors).toContain("confinement.dangerousCapabilities: must be a list of non-empty strings");
    expect(errors).toContain("boot.command: required (list of strings) in spawn mode");
    expect(errors).toContain("boot.discoveryFile: required non-empty string");
    expect(errors).toContain("gym.blueprint: required non-empty string");
    expect(errors).toContain("gym.requiredSignals: must be non-empty");
  });

  it("rejects a seam section missing its gates and fixtures", () => {
    const errors = validateChecksConfig({ app: { name: "x" }, seam: { workItemKind: "k" } });
    expect(errors).toContain("seam.contractModule: required non-empty string");
    expect(errors).toContain("seam.parseInputExport: required non-empty string");
    expect(errors).toContain("seam.parseOutputExport: required non-empty string");
    expect(errors).toContain("seam.validInput: required object fixture");
    expect(errors).toContain("seam.invalidOutput: required object fixture");
  });

  it("parseChecksConfig throws on invalid, returns typed on valid", () => {
    expect(() => parseChecksConfig({})).toThrow(/invalid checks config/);
    expect(parseChecksConfig(valid).app.name).toBe("quartermaster");
  });

  it("the committed quartermaster reference config validates", () => {
    const raw = JSON.parse(
      readFileSync(join(TEMPLATES_DIR, "agentic-desktop-app/reference/quartermaster.checks-config.json"), "utf8"),
    );
    expect(validateChecksConfig(raw)).toEqual([]);
  });
});
