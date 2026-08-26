import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "measure-context-token-baseline.mjs",
);

describe("measure-context-token-baseline injected accounting", () => {
  it("distinguishes sibling attachment bytes from in-block slices without double counting", () => {
    const fixtureHome = mkdtempSync(join(tmpdir(), "context-token-baseline-"));
    const transcriptDir = join(fixtureHome, ".claude", "projects", "fixture");
    const outputPath = join(fixtureHome, "baseline.json");
    const attachment = "attachment-context";
    const hostPrefix = "human text\n\n";
    const markerSpan = "## Relevant memory\nremembered context";

    try {
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(
        join(transcriptDir, "session.jsonl"),
        [
          JSON.stringify({
            type: "attachment",
            attachment: {
              type: "hook_additional_context",
              hookName: "PostToolBatch",
              content: attachment,
            },
          }),
          JSON.stringify({
            type: "user",
            message: {
              content: [{ type: "text", text: `${hostPrefix}${markerSpan}` }],
            },
          }),
        ].join("\n"),
      );

      const stdout = execFileSync(process.execPath, [SCRIPT, "2", outputPath], {
        encoding: "utf8",
        env: { ...process.env, HOME: fixtureHome },
      });
      const summary = JSON.parse(stdout);
      const persisted = JSON.parse(readFileSync(outputPath, "utf8"));
      const injectedKind = summary.byKind.find(
        (row: { kind: string }) => row.kind === "injected_context",
      );

      expect(injectedKind.chars).toBe(attachment.length);
      expect(summary.injected.attachmentChars).toBe(attachment.length);
      expect(summary.injected.inTextChars).toBe(markerSpan.length);
      expect(summary.injected.inToolResultChars).toBe(0);
      expect(summary.injected.chars).toBe(
        attachment.length + markerSpan.length,
      );
      expect(
        summary.byKind.reduce(
          (sum: number, row: { chars: number }) => sum + row.chars,
          0,
        ),
      ).toBe(summary.totalChars);
      expect(summary.injected.caveat).toContain(
        "attachmentChars is already counted as the sibling byKind injected_context category",
      );
      expect(summary.injected.caveat).toContain(
        "inTextChars + inToolResultChars are slices of those existing kinds",
      );
      expect(summary.injected.caveat).toContain(
        "Do not add the combined injected.chars roll-up to the kind totals again",
      );
      expect(persisted.injected).toEqual(summary.injected);
    } finally {
      rmSync(fixtureHome, { recursive: true, force: true });
    }
  });
});
