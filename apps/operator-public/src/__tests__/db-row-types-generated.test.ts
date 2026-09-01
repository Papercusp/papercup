import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GENERATOR = resolve(APP_ROOT, "scripts/generate-db-row-types.mjs");

describe("migration-derived public DB row types", () => {
  it("match every table produced by the complete migration set", () => {
    expect(() =>
      execFileSync(process.execPath, [GENERATOR, "--check"], {
        cwd: APP_ROOT,
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
