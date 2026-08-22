import { execFileSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./capture-signals.py", import.meta.url));

describe("capture-signals.py CLI", () => {
  it("prints help without creating a capture artifact", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "capture-signals-help-"));

    try {
      const help = execFileSync(
        "python3",
        [scriptPath, "--help", "--out", outputDir],
        { encoding: "utf8" },
      );

      expect(help).toContain("usage:");
      expect(help).toContain("--label");
      expect(help).toContain("--out");
      expect(readdirSync(outputDir)).toEqual([]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
