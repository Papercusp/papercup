import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const HOST_BUNDLER = join(REPO_ROOT, "apps/operator/bin/bundle-host.sh");
const source = readFileSync(HOST_BUNDLER, "utf8");

describe("host bundle disk admission", () => {
  it("reserves the mutex and output filesystems before creating the shared reader", () => {
    const mutexCheck = source.indexOf("installMutexIsHeld");
    const start = source.indexOf("# >>> host bundle disk admission");
    const end = source.indexOf("# <<< host bundle disk admission", start);
    const reader = source.indexOf("--exec-under-lock", start);

    expect(mutexCheck).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(mutexCheck);
    expect(end).toBeGreaterThan(start);
    expect(reader).toBeGreaterThan(end);

    const admission = source.slice(start, end);
    expect(admission).toContain('source "$REPO_ROOT/papercusp-desktop/bin/lib/disk-preflight.sh"');
    expect(admission).toContain("resolveFsMutexLockRoot");
    expect(admission).toContain('papercusp_mount_key "$HOST_FS_MUTEX_ROOT"');
    expect(admission).toContain('papercusp_mount_key "$OUTDIR"');
    expect(admission).toContain('papercusp_require_free_gb "$HOST_FS_MUTEX_ROOT" 1');
    expect(admission).toContain('papercusp_require_free_gb "$OUTDIR" 1');
  });

  it("runs the mutex-root loader with its argument-supplied module URL", () => {
    const command = source.match(/'([^'\n]*resolveFsMutexLockRoot[^'\n]*)'/)?.[1];
    if (!command) throw new Error("Host bundle mutex-root Node eval command is missing");

    const moduleUrl = pathToFileURL(join(REPO_ROOT, "scripts/lib/fs-mutex.mjs")).href;
    const resolved = execFileSync(process.execPath, [
      "--input-type=module", "-e", command, moduleUrl,
    ], { encoding: "utf8" }).trim();

    expect(resolved).toBeTruthy();
  });
});
