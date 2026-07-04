import { describe, expect, it } from "vitest";
import {
  parseComponentManifest,
  validateCatalog,
  validateComponentManifest,
} from "./component-manifest.js";

const GOOD = {
  id: "hive-app-seam",
  version: "0.1.0",
  tier: "B",
  kind: "package",
  provides: ["hive-bootstrap"],
  composesWith: ["typed-contracts"],
  source: { repo: "Papercusp/hive-app-seam", package: "@papercusp/hive-app-seam" },
  tests: "npm test",
  summary: "The one app-hive seam.",
};

describe("validateComponentManifest", () => {
  it("accepts a well-formed manifest (guide optional)", () => {
    expect(validateComponentManifest(GOOD)).toEqual({ ok: true, errors: [] });
    expect(validateComponentManifest({ ...GOOD, guide: "agent-insights/x" }).ok).toBe(true);
    expect(parseComponentManifest(GOOD).id).toBe("hive-app-seam");
  });

  it("rejects non-objects outright", () => {
    expect(validateComponentManifest(null).ok).toBe(false);
    expect(validateComponentManifest([]).ok).toBe(false);
    expect(validateComponentManifest("x").errors).toEqual(["manifest must be an object"]);
  });

  it("collects EVERY problem, not just the first", () => {
    const { ok, errors } = validateComponentManifest({
      id: "Not Kebab",
      version: "1.0",
      tier: "Z",
      kind: "library",
      provides: [],
      composesWith: ["Bad Ref"],
      source: {},
      tests: "",
      summary: "",
    });
    expect(ok).toBe(false);
    expect(errors).toEqual(
      expect.arrayContaining([
        "id: required kebab-case string",
        "version: required semver string (x.y.z)",
        "tier: required one of A|B|C",
        "kind: required one of package|pattern",
        "provides: required non-empty string[]",
        "composesWith: 'Bad Ref' is not kebab-case",
        "source: at least one of repo/path/package is required",
        "tests: required non-empty string",
        "summary: required non-empty string",
      ]),
    );
  });

  it("parseComponentManifest throws one Error naming the problems", () => {
    expect(() => parseComponentManifest({ ...GOOD, tier: "Z" })).toThrow(/invalid component manifest: tier/);
  });
});

describe("validateCatalog", () => {
  it("accepts entries with unique ids and resolvable composesWith", () => {
    const other = { ...GOOD, id: "typed-contracts", composesWith: ["hive-app-seam"] };
    expect(validateCatalog([GOOD, other])).toEqual({ ok: true, errors: [] });
  });

  it("flags duplicate ids and dangling composesWith refs", () => {
    const dup = { ...GOOD };
    const dangling = { ...GOOD, id: "solo", composesWith: ["nowhere"] };
    const { ok, errors } = validateCatalog([GOOD, dup, dangling]);
    expect(ok).toBe(false);
    expect(errors).toEqual(
      expect.arrayContaining([
        "entry[1]: duplicate id 'hive-app-seam'",
        "'solo' composesWith unknown component 'nowhere'",
        "'hive-app-seam' composesWith unknown component 'typed-contracts'",
      ]),
    );
  });
});
