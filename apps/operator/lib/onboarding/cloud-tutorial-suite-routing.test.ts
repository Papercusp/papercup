import { describe, expect, it } from "vitest";
import { minimatch } from "minimatch";
import integration from "../../vitest.integration.config";

describe("maintained operator integration suite routing", () => {
  it.each(["test", "app", "lib", "scripts"])("enrolls both TS and TSX integrations in %s", (directory) => {
    const include: string[] = integration.test?.include ?? [];
    for (const extension of ["ts", "tsx"]) {
      expect(include.some((glob) => minimatch(`${directory}/onboarding/example.integration.test.${extension}`, glob))).toBe(true);
    }
    expect(include.some((glob) => minimatch(`${directory}/onboarding/example.test.tsx`, glob))).toBe(false);
  });
  it("resolves real app imports and installs the existing Radix/ResizeObserver shims", () => {
    const alias = integration.resolve?.alias as Array<{ find: string | RegExp; replacement: string }>;
    expect(alias.some((entry) => entry.find instanceof RegExp && entry.find.test("@/app/harness/Modal"))).toBe(true);
    expect(integration.test?.setupFiles).toEqual(expect.arrayContaining([
      expect.stringContaining("vitest-shims/radix-jsdom.ts"),
      expect.stringContaining("vitest-shims/resize-observer.ts"),
    ]));
    expect(integration.test?.globalSetup).toHaveLength(2);
  });
});
