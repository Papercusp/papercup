/**
 * Recurrence guard for WI-6554700010048341.
 *
 * A copy-mode dependency snapshot verifies through the frozen helper's
 * `snapshot-generation-locked` route, whose verifier demands an external source
 * receipt. Only the committed-ref route (VERIFY_TAURI_SOURCE_REF) writes one, so
 * the working-tree route used to fail only after a ~20-minute tree copy (boot 7
 * burned ~45 minutes of a heavy slot). The script must refuse that combination
 * up front, before the operator source snapshot, and must not refuse any route
 * that can actually boot.
 */
import { hermeticSpawnEnv } from "./__tests__/hermetic-spawn-env";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this guard at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? resolve(__dirname, "../../../scripts/verify-tauri-headless.sh");
const src = readFileSync(SCRIPT, "utf8");

const fnStart = src.indexOf("refuse_unreceipted_working_tree_copy() {");
const callIdx = src.indexOf("\nrefuse_unreceipted_working_tree_copy || exit $?");
const snapshotRootIdx = src.indexOf("\nverifier_run_step verifier-snapshot-root ");
const sourceSnapshotIdx = src.indexOf("\nverifier_run_step operator-source-snapshot ");

const LOCKED_HELPER = [
  "#!/usr/bin/env bash",
  'case "${1:-}" in',
  "  snapshot-generation-locked) : ;;",
  "esac",
  "",
].join("\n");
const LEGACY_HELPER = ["#!/usr/bin/env bash", 'case "${1:-}" in', "  snapshot) : ;;", "esac", ""].join("\n");

function runRefusal(env: Record<string, string>, helper = LOCKED_HELPER) {
  const fixture = mkdtempSync(resolve(tmpdir(), "verifier-working-tree-copy-"));
  const desktop = resolve(fixture, "papercusp-desktop");
  mkdirSync(resolve(desktop, "bin/lib"), { recursive: true });
  writeFileSync(resolve(desktop, "bin/lib/pinned-deps.sh"), helper);
  try {
    const result = spawnSync(
      "bash",
      ["-c", ["set -u", src.slice(fnStart, callIdx), "refuse_unreceipted_working_tree_copy"].join("\n")],
      { encoding: "utf8", timeout: 15_000, env: { ...hermeticSpawnEnv(), DESKTOP_DIR: desktop, ...env } },
    );
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("working-tree route refuses an unreceipted copy-mode snapshot before the copy", () => {
  it("defines the refusal and calls it after mode selection but before the source snapshot", () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(fnStart);
    expect(snapshotRootIdx).toBeGreaterThan(-1);
    expect(sourceSnapshotIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(snapshotRootIdx);
    expect(callIdx).toBeLessThan(sourceSnapshotIdx);
  });

  it("refuses copy mode with an empty source ref and no receipt", () => {
    const result = runRefusal({ VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: "copy" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("FATAL: the working-tree route");
    expect(result.stderr).toContain("VERIFY_TAURI_SOURCE_REF=<committed sha>");
  });

  it("refuses when a dependency generation root forces copy mode", () => {
    const result = runRefusal({
      VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: "hardlink",
      PAPERCUSP_DEPENDENCY_GENERATION_ROOT: "/generations",
    });
    expect(result.status).toBe(2);
  });

  it.each([
    ["hardlink mode", { VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: "hardlink" }],
    ["the committed-ref route", { VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: "copy", VERIFY_TAURI_SOURCE_REF: "a".repeat(40) }],
    ["a caller-supplied receipt", { VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: "copy", VERIFY_TAURI_SOURCE_RECEIPT: "/tmp/receipt.json" }],
  ])("admits %s", (_label, env) => {
    const result = runRefusal(env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("admits copy mode when the helper has no locked-generation route", () => {
    const result = runRefusal({ VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: "copy" }, LEGACY_HELPER);
    expect(result.status, result.stderr).toBe(0);
  });
});
