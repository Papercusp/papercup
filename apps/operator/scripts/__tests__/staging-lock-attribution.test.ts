import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const HELPER = join(REPO_ROOT, "apps/operator/scripts/systemd/staging-lock-attribution.sh");
const DROPIN = join(
  REPO_ROOT,
  "apps/operator/scripts/systemd/papercup-staging-api.service.d/95-bundled-entry.conf",
);
const SYNC = join(REPO_ROOT, "apps/operator/bin/release/sync-staging-checkout.sh");

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function shell(command: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/usr/bin/bash", ["-c", command], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

function lockTarget(lockPath: string): string {
  const stat = spawnSync("stat", ["-Lc", "%d:%i", lockPath], {
    encoding: "utf8",
  });
  if (stat.status !== 0) throw new Error(stat.stderr || "stat failed");
  const [deviceText, inode] = stat.stdout.trim().split(":");
  const device = BigInt(deviceText);
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & ~0xfffn);
  const minor = (device & 0xffn) | ((device >> 12n) & ~0xffn);
  return (
    major.toString(16).padStart(2, "0") +
    ":" +
    minor.toString(16).padStart(2, "0") +
    ":" +
    inode
  );
}

function mockSystemctl(binDir: string, properties: string): void {
  const path = join(binDir, "systemctl");
  writeFileSync(
    path,
    "#!/usr/bin/env bash\nprintf '%s\\n' '" +
      properties.replaceAll("\n", "' '") +
      "'\n",
    { mode: 0o700 },
  );
}

describe("staging lock attribution", () => {
  it("matches a conflicting holder by exact device/inode and excludes waiters", () => {
    const dir = makeTempDir("staging-lock-parser-");
    try {
      const lock = join(dir, "sync.lock");
      const procLocks = join(dir, "proc-locks");
      writeFileSync(lock, "");
      const target = lockTarget(lock);
      const [major, minor, inode] = target.split(":");
      const otherInode = (BigInt(inode) + 1n).toString();
      const currentComm = readFileSync("/proc/" + process.pid + "/comm", "utf8")
        .trim()
        .replace(/[^A-Za-z0-9_.-]/g, "_");
      writeFileSync(
        procLocks,
        [
          "1: FLOCK ADVISORY READ " + process.pid + " " + target + " 0 EOF",
          "2: -> FLOCK ADVISORY WRITE " + process.pid + " " + target + " 0 EOF",
          "3: FLOCK ADVISORY WRITE " +
            process.pid +
            " " +
            major +
            ":" +
            minor +
            ":" +
            otherInode +
            " 0 EOF",
          "4: FLOCK ADVISORY WRITE " + process.pid + " " + target + " 0 EOF",
        ].join("\n"),
      );

      const result = shell(
        'source "$HELPER"; staging_lock_holder_fields "$LOCK" shared "$PROC_LOCKS"',
        { HELPER, LOCK: lock, PROC_LOCKS: procLocks },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        "holder_pid=" + process.pid + " holder_comm=" + currentComm,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an explicit unknown holder when no exact kernel record is available", () => {
    const dir = makeTempDir("staging-lock-unknown-");
    try {
      const lock = join(dir, "sync.lock");
      const procLocks = join(dir, "proc-locks");
      writeFileSync(lock, "");
      writeFileSync(procLocks, "1: FLOCK ADVISORY WRITE 1234 00:00:999 0 EOF\n");

      const result = shell(
        'source "$HELPER"; staging_lock_holder_fields "$LOCK" exclusive "$PROC_LOCKS"',
        { HELPER, LOCK: lock, PROC_LOCKS: procLocks },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("holder_pid=unknown holder_comm=unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records bounded wait samples and exact holder details under temporary-lock contention", async () => {
    const dir = makeTempDir("staging-lock-contention-");
    let holder: ReturnType<typeof spawn> | undefined;
    let holderExit: Promise<void> | undefined;
    try {
      const lock = join(dir, "sync.lock");
      const bundle = join(dir, "fixture-bundle.sh");
      const binDir = join(dir, "bin");
      const ready = join(dir, "holder-ready");
      mkdirSync(binDir);
      writeFileSync(lock, "");
      writeFileSync(
        bundle,
        "#!/usr/bin/env bash\nprintf 'fixture-bundle-ran\\n'\n",
        { mode: 0o700 },
      );
      mockSystemctl(
        binDir,
        "ActiveState=activating\nSubState=start-pre\nMainPID=0\nType=notify\nResult=success",
      );

      holder = spawn(
        "/usr/bin/flock",
        [
          "--exclusive",
          "--no-fork",
          lock,
          "/usr/bin/bash",
          "-c",
          'touch "$1"; exec /usr/bin/sleep 6',
          "staging-lock-holder",
          ready,
        ],
        { stdio: "ignore" },
      );
      holderExit = new Promise((resolveExit) => holder?.once("exit", () => resolveExit()));
      for (let i = 0; i < 300 && !existsSync(ready); i += 1) {
        await new Promise((resolveReady) => setTimeout(resolveReady, 10));
      }
      expect(existsSync(ready)).toBe(true);

      const result = spawnSync(
        "/usr/bin/bash",
        [HELPER, "api-pre", lock, bundle],
        {
          env: {
            ...process.env,
            PATH: binDir + ":" + (process.env.PATH ?? ""),
            INVOCATION_ID: "test-start-pre-attempt-42",
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status).toBe(0);
      const output = result.stdout + "\n" + result.stderr;
      expect(output).toContain(
        "event=start surface=start-pre attempt_id=test-start-pre-attempt-42",
      );
      expect(output).toContain("event=acquired surface=start-pre");
      expect(output).toContain("acquisition_outcome=acquired");
      expect(output).toContain("readiness_phase=before-execstart");
      expect(output).toContain("api_readiness=not_ready_or_unknown");
      expect(output).toContain("fixture-bundle-ran");
      expect(output).toContain("holder_pid=" + holder.pid);
      expect(output).toMatch(/holder_comm=(sleep|flock)/);
      const sampleCount = (output.match(/event=wait_sample/g) ?? []).length;
      expect(sampleCount).toBeGreaterThan(0);
      expect(sampleCount).toBeLessThanOrEqual(5);
    } finally {
      if (holder && holder.exitCode === null) holder.kill("SIGTERM");
      await holderExit;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records ready state from ExecStartPost after Type=notify", () => {
    const dir = makeTempDir("staging-lock-ready-");
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      mockSystemctl(
        binDir,
        "ActiveState=active\nSubState=running\nMainPID=4321\nType=notify\nResult=success",
      );
      const result = spawnSync(
        "/usr/bin/bash",
        [HELPER, "api-post", "papercup-staging-api.service"],
        {
          env: {
            ...process.env,
            PATH: binDir + ":" + (process.env.PATH ?? ""),
            INVOCATION_ID: "test-start-pre-attempt-42",
          },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        "event=api_ready surface=exec-start-post attempt_id=test-start-pre-attempt-42",
      );
      expect(result.stderr).toContain("api_main_pid=4321");
      expect(result.stderr).toContain("api_readiness=ready");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wires the API start/post records and staging-sync lock transitions", () => {
    const dropin = readFileSync(DROPIN, "utf8");
    const sync = readFileSync(SYNC, "utf8");
    expect(dropin).toContain(
      "ExecStartPre=/usr/bin/bash %h/papercupai-workspace/papercusp-staging.current/apps/operator/scripts/systemd/staging-lock-attribution.sh api-pre",
    );
    expect(dropin).toContain(
      "ExecStartPost=/usr/bin/bash %h/papercupai-workspace/papercusp-staging.current/apps/operator/scripts/systemd/staging-lock-attribution.sh api-post",
    );
    const attempt = sync.indexOf(
      "state=wait_start lock_path=$STAGING_SYNC_LOCK_PATH lock_mode=exclusive",
    );
    const open = sync.indexOf('exec 9>"$STAGING_SYNC_LOCK_PATH"');
    const acquire = sync.indexOf("if ! flock -n 9", open);
    expect(attempt).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(attempt);
    expect(acquire).toBeGreaterThan(open);
    expect(sync).toContain("state=shared_acquired phase=preflight-restart");
    expect(sync).toContain("state=shared_acquired phase=final-restart");
  });
});
