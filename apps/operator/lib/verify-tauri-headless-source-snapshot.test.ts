/**
 * Recurrence guard for EI-21590235587564636.
 *
 * The verifier source is read lazily by bash. An in-place peer save during the
 * multi-minute Tauri boot can therefore splice a partial line into the running
 * script even though the source was valid at launch. The SPA snapshot guard
 * protects the bundle served by the rig, but it cannot protect this wrapper's
 * own source. Pin the startup snapshot/re-exec contract on the real script.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../../scripts/verify-tauri-headless.sh");
const src = readFileSync(SCRIPT, "utf8");

const snapshotGuardIdx = src.indexOf("VERIFY_TAURI_SOURCE_SNAPSHOT_PATH=");
const argumentParserIdx = src.indexOf('if [ "${1:-}" = "--help" ]');
const installPreflightIdx = src.indexOf(
  "install_in_flight_preflight || exit $?",
);
const workAllocationIdx = src.indexOf('WORK="$(mktemp -d');
const sourceReexecIdx = src.indexOf(
  'exec bash "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH" "$@"',
);
const assertionExecIdx = src.lastIndexOf('log "running assertion command: $*"');
const operatorSnapshotIdx = src.indexOf("snapshot_operator_source() {");
const operatorSnapshotCallIdx = src.indexOf("snapshot_operator_source || {");
const operatorSnapshotSource = src.slice(
  operatorSnapshotIdx,
  operatorSnapshotCallIdx,
);

describe("EI-21590235587564636 — verifier source is immutable for the run", () => {
  it("captures and syntax-checks the source before parsing arguments or allocating resources", () => {
    expect(snapshotGuardIdx).toBeGreaterThan(-1);
    expect(argumentParserIdx).toBeGreaterThan(snapshotGuardIdx);
    expect(src).toContain(
      'cp -- "$VERIFY_TAURI_SOURCE_PATH" "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH"',
    );
    expect(src).toContain('bash -n -- "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH"');
    expect(installPreflightIdx).toBeGreaterThan(snapshotGuardIdx);
    expect(workAllocationIdx).toBeGreaterThan(snapshotGuardIdx);
  });

  it("re-execs the frozen copy before the mutable checkout can reach the long-lived path", () => {
    expect(sourceReexecIdx).toBeGreaterThan(snapshotGuardIdx);
    expect(sourceReexecIdx).toBeLessThan(argumentParserIdx);
    expect(sourceReexecIdx).toBeLessThan(assertionExecIdx);
    expect(src).toContain(
      "export VERIFY_TAURI_SOURCE_SNAPSHOT_PATH VERIFY_TAURI_ORIGINAL_REPO_DIR",
    );
    // A temp snapshot changes BASH_SOURCE[0]; preserve the original repo root
    // so the re-exec still loads the intended desktop sidecar and dependencies.
    expect(src).toContain(
      'VERIFY_TAURI_ORIGINAL_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)',
    );
  });

  it("cleans the source snapshot on both normal teardown and boot-only handoff", () => {
    expect(src).toContain("cleanup_verifier_source_snapshot");
    const teardownIdx = src.indexOf("teardown() {");
    expect(
      src.indexOf("cleanup_verifier_source_snapshot", teardownIdx),
    ).toBeGreaterThan(teardownIdx);
    const bootOnlyExitIdx = src.indexOf(
      "cleanup_verifier_source_snapshot\n  exit 0",
      argumentParserIdx,
    );
    expect(bootOnlyExitIdx).toBeGreaterThan(argumentParserIdx);
  });
});

describe("EI-22586651291409125 — derived indexes stay out of the immutable operator snapshot", () => {
  it("excludes and defensively removes .gitnexus before the isolated sidecar boots", () => {
    expect(operatorSnapshotIdx).toBeGreaterThan(-1);
    expect(operatorSnapshotCallIdx).toBeGreaterThan(operatorSnapshotIdx);
    expect(operatorSnapshotSource).toContain("--exclude='.gitnexus'");
    expect(operatorSnapshotSource).toContain('"$snapshot_root/.gitnexus"');
  });
});

describe("EI-22587788892654404 — a repo-local temp root cannot enter its own snapshot", () => {
  it("excludes and defensively removes local Papercusp state before the isolated sidecar boots", () => {
    expect(operatorSnapshotSource).toContain("--exclude='.papercusp'");
    expect(operatorSnapshotSource).toContain('"$snapshot_root/.papercusp"');
  });
});

describe("EI-22616267024724225 — frozen verifier hosts exclude the tsx runtime loader", () => {
  const bundleFunctionIdx = src.indexOf("build_verifier_operator_host() {");
  const bundleCallIdx = src.indexOf(
    "build_verifier_operator_host || { cleanup_operator_source_snapshot; exit 1; }",
  );
  const launchEnvIdx = src.indexOf('OPERATOR_SOURCE_ENV_LINE="');

  it("builds the maintained host bundle only after the source/dependency snapshot is frozen", () => {
    expect(bundleFunctionIdx).toBeGreaterThan(operatorSnapshotCallIdx);
    expect(bundleCallIdx).toBeGreaterThan(bundleFunctionIdx);
    expect(operatorSnapshotSource).toContain(
      'papercusp_pinned_deps_snapshot_locked "$REPO_DIR" "$snapshot_root"',
    );
    expect(src.slice(bundleFunctionIdx, bundleCallIdx)).toContain(
      "apps/operator/bin/bundle-host.sh",
    );
    expect(src.slice(bundleFunctionIdx, bundleCallIdx)).toContain(
      'bin/hono-host.ts "$OPERATOR_HOST_BUNDLE"',
    );
    expect(src.slice(bundleFunctionIdx, bundleCallIdx)).toContain(
      '[ -s "$OPERATOR_HOST_BUNDLE" ]',
    );
  });

  it("hands the private plain-node entry to the existing dev-operator launcher", () => {
    expect(launchEnvIdx).toBeGreaterThan(bundleCallIdx);
    expect(src.slice(launchEnvIdx, launchEnvIdx + 500)).toContain(
      'PAPERCUSP_DEV_HOST_ENTRY=\\"$OPERATOR_HOST_BUNDLE\\"',
    );
    expect(src).toContain('OPERATOR_HOST_BUNDLE=""');
    expect(
      src.slice(
        src.indexOf("cleanup_operator_source_snapshot() {"),
        operatorSnapshotIdx,
      ),
    ).toContain('OPERATOR_HOST_BUNDLE=""');
  });
});

describe("EI-22590231221058313 — workspace runtime exports survive the snapshot", () => {
  function requireSnapshot(output: "dist" | "build", blanketExclude = false) {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-runtime-export-"));
    const donor = resolve(fixture, "donor");
    const copy = resolve(fixture, "copy");
    try {
      const runtime = resolve(donor, "libs/runtime");
      mkdirSync(resolve(runtime, output), { recursive: true });
      writeFileSync(
        resolve(runtime, "package.json"),
        JSON.stringify({
          name: "@fixture/runtime",
          exports: { require: `./${output}/index.js` },
        }),
      );
      writeFileSync(
        resolve(runtime, output, "index.js"),
        "module.exports = 42;\n",
      );
      const excluded = ["dist", "build", "apps/operator-vite/dist"];
      for (const path of excluded) {
        mkdirSync(resolve(donor, path), { recursive: true });
        writeFileSync(resolve(donor, path, "artifact.js"), "unrelated output");
      }
      mkdirSync(copy);
      const filters = [
        ...operatorSnapshotSource.matchAll(/--exclude='([^']+)'/g),
      ].map((match) => `--exclude=${match[1]}`);
      expect(filters.length).toBeGreaterThan(0);
      const snapshot = spawnSync(
        "rsync",
        [
          "-a",
          ...filters,
          ...(blanketExclude ? [`--exclude=${output}`] : []),
          `${donor}/`,
          `${copy}/`,
        ],
        { encoding: "utf8" },
      );
      expect(snapshot.status, snapshot.stderr).toBe(0);
      // The pinned dependency helper preserves relative workspace symlinks.
      mkdirSync(resolve(copy, "node_modules/@fixture"), { recursive: true });
      symlinkSync(
        "../../libs/runtime",
        resolve(copy, "node_modules/@fixture/runtime"),
      );
      const result = spawnSync(
        process.execPath,
        ["-e", "console.log(require('@fixture/runtime'))"],
        {
          cwd: copy,
          encoding: "utf8",
        },
      );
      return {
        ...result,
        excluded: excluded.map((path) => existsSync(resolve(copy, path))),
      };
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  it.each(["dist", "build"] as const)(
    "resolves a workspace package's %s entrypoint from the copy",
    (output) => {
      const result = requireSnapshot(output);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("42");
      expect(result.excluded).toEqual([false, false, false]);
    },
  );

  it("detects the original blanket-exclusion failure", () => {
    const result = requireSnapshot("dist", true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MODULE_NOT_FOUND");
  });
});

describe("EI-22588292228855829 — dependency snapshot stays on the donor filesystem", () => {
  const chooserStart = src.indexOf("select_verifier_snapshot_root() {");
  const chooserEnd = src.indexOf(
    'OPERATOR_SNAPSHOT_PARENT="$(select_verifier_snapshot_root)"',
    chooserStart,
  );

  function chooseRoot(crossDevice: boolean, fallbackCrossDevice = false) {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-work-root-"));
    const donor = resolve(fixture, "donor");
    const preferred = resolve(fixture, "preferred");
    mkdirSync(donor);
    mkdirSync(preferred);
    try {
      expect(chooserStart).toBeGreaterThan(-1);
      expect(chooserEnd).toBeGreaterThan(chooserStart);
      // Exercise the actual shell chooser with deterministic mount identities.
      // No snapshot/build process is launched, and no real mount is required.
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "stat() {",
            '  if [ "$4" = "$REPO_DIR" ]; then printf "1\\n";',
            '  elif [ "$4" = "$TMPDIR" ]; then printf "%s\\n" "$TEST_PREFERRED_DEVICE";',
            '  else printf "%s\\n" "$TEST_FALLBACK_DEVICE"; fi',
            "}",
            src.slice(chooserStart, chooserEnd),
            "select_verifier_snapshot_root",
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            REPO_DIR: donor,
            TMPDIR: preferred,
            TEST_PREFERRED_DEVICE: crossDevice ? "2" : "1",
            TEST_FALLBACK_DEVICE: fallbackCrossDevice ? "2" : "1",
          },
        },
      );
      return { ...result, donor, preferred };
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  it("retains a requested temporary root on the donor filesystem", () => {
    const result = chooseRoot(false);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(result.preferred);
  });

  it("uses excluded repository-local scratch when /tmp is on another filesystem", () => {
    const result = chooseRoot(true);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(resolve(result.donor, ".papercusp/tmp"));
  });

  it("refuses a fallback that is also mounted on a different filesystem", () => {
    const result = chooseRoot(true, true);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "no verifier snapshot root on the dependency donor filesystem",
    );
  });

  it("keeps bulk payloads on TMPDIR and gives both roots the same cleanup and owner", () => {
    expect(src).toContain(
      'WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-tauri-headless.XXXXXX")"',
    );
    expect(operatorSnapshotSource).toContain(
      'snapshot_root="$OPERATOR_SOURCE_WORK/operator-source"',
    );
    expect(src).toContain(
      'cp -- "$WORK/.papercusp-run" "$OPERATOR_SOURCE_WORK/.papercusp-run"',
    );
    expect(src).toContain(
      "snapshot_operator_source || { cleanup_operator_source_snapshot; exit 1; }",
    );
    expect(src).toContain(
      '[ -n "$OPERATOR_SOURCE_WORK" ] && rm -rf -- "$OPERATOR_SOURCE_WORK"',
    );
  });
});

describe("EI-22589054433344154 — aggregate disk admission precedes bulk allocation", () => {
  const reservationStart = src.indexOf("reserve_verifier_disk() {");
  const releaseStart = src.indexOf("release_verifier_disk_reservations() {");
  const releaseEnd = src.indexOf(
    "cleanup_operator_source_snapshot() {",
    releaseStart,
  );

  function reserve(
    sameMount: boolean,
    freeSource: number,
    freeBulk: number,
    isolated = true,
  ) {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-disk-admission-"));
    try {
      const desktop = resolve(fixture, "desktop");
      mkdirSync(resolve(desktop, "bin/lib"), { recursive: true });
      mkdirSync(resolve(fixture, "source"));
      mkdirSync(resolve(fixture, "bulk"));
      // Exercise the real shared reservation writer with deterministic device
      // measurements. Each test has a private ledger and reserves no real disk.
      writeFileSync(
        resolve(desktop, "bin/lib/disk-preflight.sh"),
        [
          `. ${JSON.stringify(resolve(__dirname, "../../../papercusp-desktop/bin/lib/disk-preflight.sh"))}`,
          'papercusp_mount_key() { if [ "$TEST_SAME_MOUNT" = 1 ] || [ "$1" = "$OPERATOR_SNAPSHOT_PARENT" ]; then printf source; else printf bulk; fi; }',
          'papercusp_free_gb() { if [ "$TEST_SAME_MOUNT" = 1 ] || [ "$1" = "$OPERATOR_SNAPSHOT_PARENT" ]; then printf "%s" "$TEST_FREE_SOURCE"; else printf "%s" "$TEST_FREE_BULK"; fi; }',
        ].join("\n"),
      );
      return spawnSync(
        "bash",
        [
          "-c",
          [
            "VERIFIER_DISK_RESERVATIONS=()",
            src.slice(releaseStart, releaseEnd),
            src.slice(reservationStart, operatorSnapshotIdx),
            "reserve_verifier_disk 1073741824",
            "status=$?",
            'printf "status=%s claims=%s\\n" "$status" "${#VERIFIER_DISK_RESERVATIONS[@]}"',
            'for f in "${VERIFIER_DISK_RESERVATIONS[@]}"; do sed -n "/^gb=/p" "$f"; done',
            "release_verifier_disk_reservations",
            'find "$PAPERCUSP_DISK_RESERVATION_DIR" -name "*.res" -print',
            'exit "$status"',
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DESKTOP_DIR: desktop,
            REPO_DIR: fixture,
            OPERATOR_SNAPSHOT_PARENT: resolve(fixture, "source"),
            WORK: resolve(fixture, "bulk"),
            PAPERCUSP_DISK_RESERVATION_DIR: resolve(fixture, "ledger"),
            VERIFY_TAURI_ISOLATED_DB: isolated ? "1" : "0",
            TEST_SAME_MOUNT: sameMount ? "1" : "0",
            TEST_FREE_SOURCE: String(freeSource),
            TEST_FREE_BULK: String(freeBulk),
          },
        },
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  it("refuses aggregate demand even when each individual payload would fit", () => {
    const result = reserve(true, 10, 10);
    expect(result.status).toBe(28);
    expect(result.stdout).toBe("status=28 claims=0\n");
    expect(result.stderr).toContain("need ~11GB");
  });

  it("reserves separate source and bulk demands and releases both", () => {
    const result = reserve(false, 3, 10);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("status=0 claims=2\ngb=2\ngb=9\n");
  });

  it("rolls back the source reservation when bulk admission fails", () => {
    const result = reserve(false, 3, 8);
    expect(result.status).toBe(28);
    expect(result.stdout).toBe("status=28 claims=0\n");
  });

  it("omits the database budget for a read-only shared-database run", () => {
    const result = reserve(true, 3, 3, false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("status=0 claims=1\ngb=3\n");
  });

  it("estimates with the copy filters and admits before rsync can allocate bytes", () => {
    expect(
      operatorSnapshotSource.indexOf('reserve_verifier_disk "$source_bytes"'),
    ).toBeLessThan(
      operatorSnapshotSource.indexOf(
        'rsync -a --delete "${source_filters[@]}"',
      ),
    );
    expect(operatorSnapshotSource).toContain(
      'rsync -an --stats "${source_filters[@]}"',
    );
    expect(src.slice(src.indexOf('BOOT_ONLY_ENV="$WORK/env.sh"'))).toContain(
      "release_verifier_disk_reservations",
    );
  });
});
