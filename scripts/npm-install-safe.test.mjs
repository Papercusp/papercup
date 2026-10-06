import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  cacheVerifyArgs,
  installLockWaitReporter,
  lockfileDepFlagOnlyChanges,
  main,
  publishDependencyGeneration,
  readLockfileText,
  restoreScopedFlagOnlyLockfileRewrite,
  workspaceSelectorsForNpmArgs,
  npmChildEnv,
  normalizeNpmArgs,
  parseCliArgs,
  repoLockName,
  runCommandUnderInstallMutex,
  USAGE,
  verifyDepsExtracted,
  withPackageCacheReadLease,
  verificationScopeForNpmArgs,
  verifyNpmCache,
  verifyNpmCacheExclusive,
} from "./npm-install-safe.mjs";
import {
  PACKAGE_CACHE_MUTEX_NAME,
  resolveFsMutexTimeoutMs,
  withFsMutex,
} from "./lib/fs-mutex.mjs";

// EI-24961470606265468: the P-532f capacity build died after the interactive
// 180 s fs-mutex wait behind a peer's install. The unattended lock-wait knob
// (seconds) now sets it, and the explicit ms knob still wins.
test("fs-mutex wait budget honours the unattended knob below the explicit one", () => {
  assert.equal(resolveFsMutexTimeoutMs({}), 180_000);
  assert.equal(resolveFsMutexTimeoutMs({ PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: "3600" }), 3_600_000);
  assert.equal(
    resolveFsMutexTimeoutMs({
      PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: "3600",
      PAPERCUSP_FS_MUTEX_TIMEOUT_MS: "25",
    }),
    25,
  );
  assert.equal(resolveFsMutexTimeoutMs({ PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: "junk" }), 180_000);
});

// WI-10006385: a printed wait must be closed by a line saying how long it really lasted
// and under which budget; an uncontested lock stays silent.
test("installLockWaitReporter closes a printed wait with its real length and stays quiet uncontested", () => {
  const quiet = [];
  const uncontested = installLockWaitReporter({
    lock: "writer",
    describe: (owner, elapsedMs) => `waiting ${elapsedMs} ${owner}`,
    log: line => quiet.push(line),
    budgetMs: 3_600_000,
  });
  uncontested.onAcquired({ waitedMs: 3 });
  assert.deepEqual(quiet, []);

  const lines = [];
  const contested = installLockWaitReporter({
    lock: "writer",
    describe: (owner, elapsedMs) => `waiting ${elapsedMs} ${owner}`,
    log: line => lines.push(line),
    budgetMs: 3_600_000,
  });
  contested.onWaiting({ owner: "  {\"pid\":7}\n", elapsedMs: 0 });
  contested.onWaiting({ owner: "{\"pid\":8}", elapsedMs: 30_000 });
  contested.onAcquired({ waitedMs: 2_712_345 });
  assert.deepEqual(lines, [
    'waiting 0 {"pid":7}',
    'waiting 30000 {"pid":8}',
    "NPM_INSTALL_SAFE_LOCK_ACQUIRED lock=writer waitedMs=2712345 budgetMs=3600000",
  ]);
});

// WI-10003114 fixture: the measured shape of the 2026-09-29 flip. An unscoped
// install wrote `devOptional`; the desktop build's scoped install wrote `dev`
// (and added a bare `optional`) back, touching no version/resolved/integrity.
function lockfileFixture({ jsdomFlags, zodFlags, undiciVersion = "7.16.0" }) {
  return {
    name: "papercusp",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "papercusp", workspaces: ["apps/*"] },
      "node_modules/@asamuzakjp/css-color": {
        version: "5.1.11",
        ...jsdomFlags,
        license: "MIT",
      },
      "node_modules/zod": { version: "3.25.76", license: "MIT", ...zodFlags },
      "node_modules/undici": {
        version: undiciVersion,
        resolved: `https://registry.npmjs.org/undici/-/undici-${undiciVersion}.tgz`,
        integrity: `sha512-${undiciVersion}`,
      },
    },
  };
}

const unscopedLock = lockfileFixture({
  jsdomFlags: { devOptional: true },
  zodFlags: {},
});
const scopedLock = lockfileFixture({
  jsdomFlags: { dev: true },
  zodFlags: { optional: true },
});

const lockText = (lock) => `${JSON.stringify(lock, null, 2)}\n`;

test("workspaceSelectorsForNpmArgs reads every npm workspace selector form", () => {
  assert.deepEqual(
    workspaceSelectorsForNpmArgs([
      "install",
      "--workspace=@papercusp/web",
      "--workspace",
      "@papercusp/sse",
      "-w",
      "apps/operator-vite",
      "-w=@papercusp/omp",
    ]),
    ["@papercusp/web", "@papercusp/sse", "apps/operator-vite", "@papercusp/omp"],
  );
  assert.deepEqual(workspaceSelectorsForNpmArgs(["install", "--legacy-peer-deps"]), []);
});

test("lockfileDepFlagOnlyChanges names entries that differ only in dependency-type flags", () => {
  assert.deepEqual(lockfileDepFlagOnlyChanges(unscopedLock, scopedLock), [
    "node_modules/@asamuzakjp/css-color",
    "node_modules/zod",
  ]);
  assert.deepEqual(lockfileDepFlagOnlyChanges(unscopedLock, unscopedLock), []);
});

test("lockfileDepFlagOnlyChanges refuses anything that changes what gets installed", () => {
  const versionBump = lockfileFixture({
    jsdomFlags: { dev: true },
    zodFlags: { optional: true },
    undiciVersion: "7.24.0",
  });
  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, versionBump), null);

  const added = structuredClone(scopedLock);
  added.packages["node_modules/left-pad"] = { version: "1.3.0" };
  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, added), null);

  const removed = structuredClone(scopedLock);
  delete removed.packages["node_modules/zod"];
  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, removed), null);

  const newEdge = structuredClone(scopedLock);
  newEdge.packages["node_modules/zod"].dependencies = { tslib: "^2" };
  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, newEdge), null);

  const topLevel = structuredClone(scopedLock);
  topLevel.lockfileVersion = 2;
  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, topLevel), null);

  assert.equal(lockfileDepFlagOnlyChanges(unscopedLock, null), null);
});

test("restoreScopedFlagOnlyLockfileRewrite restores the pre-install bytes after a flag-only rewrite", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "npm-install-safe-flags-"));
  try {
    const committed = lockText(unscopedLock);
    writeFileSync(join(repoRoot, "package-lock.json"), lockText(scopedLock));
    const result = restoreScopedFlagOnlyLockfileRewrite({
      repoRoot,
      beforeText: committed,
    });
    assert.equal(result.restored, true);
    assert.equal(result.reason, "dep-flags-only");
    assert.equal(result.entries.length, 2);
    assert.equal(
      readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
      committed,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("restoreScopedFlagOnlyLockfileRewrite keeps a substantive rewrite exactly as npm wrote it", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "npm-install-safe-flags-"));
  try {
    const rewritten = lockText(
      lockfileFixture({
        jsdomFlags: { dev: true },
        zodFlags: {},
        undiciVersion: "7.24.0",
      }),
    );
    writeFileSync(join(repoRoot, "package-lock.json"), rewritten);
    const result = restoreScopedFlagOnlyLockfileRewrite({
      repoRoot,
      beforeText: lockText(unscopedLock),
    });
    assert.deepEqual(result, {
      restored: false,
      reason: "substantive-change",
      entries: [],
    });
    assert.equal(
      readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
      rewritten,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("restoreScopedFlagOnlyLockfileRewrite is a no-op without a before snapshot, an unchanged file, or a removed file", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "npm-install-safe-flags-"));
  try {
    assert.equal(readLockfileText(repoRoot), undefined);
    assert.equal(
      restoreScopedFlagOnlyLockfileRewrite({ repoRoot, beforeText: undefined })
        .reason,
      "no-lockfile-before",
    );
    assert.equal(
      restoreScopedFlagOnlyLockfileRewrite({
        repoRoot,
        beforeText: lockText(unscopedLock),
      }).reason,
      "lockfile-removed",
    );
    const committed = lockText(unscopedLock);
    writeFileSync(join(repoRoot, "package-lock.json"), committed);
    assert.equal(readLockfileText(repoRoot), committed);
    assert.equal(
      restoreScopedFlagOnlyLockfileRewrite({ repoRoot, beforeText: committed })
        .reason,
      "unchanged",
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("cacheVerifyArgs preserves an explicit npm cache path", () => {
  assert.deepEqual(cacheVerifyArgs(["dedupe", "--cache", "/tmp/npm-cache"]), [
    "cache",
    "verify",
    "--cache",
    "/tmp/npm-cache",
  ]);
  assert.deepEqual(cacheVerifyArgs(["--cache=/tmp/npm-cache", "install"]), [
    "cache",
    "verify",
    "--cache=/tmp/npm-cache",
  ]);
  assert.deepEqual(cacheVerifyArgs(["install"]), ["cache", "verify"]);
});

test("verificationScopeForNpmArgs maps npm workspace names and paths without widening to unselected workspaces", () => {
  const repoRoot = "/repo";
  const manifests = new Map([
    ["/repo/package.json", { workspaces: ["apps/*"] }],
    ["/repo/apps/web/package.json", { name: "@papercusp/web" }],
    [
      "/repo/apps/operator-vite/package.json",
      { name: "@papercusp/operator-vite" },
    ],
    [
      "/repo/apps/operator-docs/package.json",
      { name: "@papercusp/operator-docs" },
    ],
  ]);
  const deps = {
    readJson: (path) => manifests.get(path),
    existsSync: (path) => path === "/repo/apps" || manifests.has(path),
    readDir: () => [
      { name: "web", isDir: true },
      { name: "operator-vite", isDir: true },
      { name: "operator-docs", isDir: true },
    ],
  };

  assert.deepEqual(
    verificationScopeForNpmArgs({
      repoRoot,
      npmArgs: [
        "install",
        "--workspace=@papercusp/web",
        "-w",
        "apps/operator-vite",
      ],
      deps,
    }),
    {
      workspaceDirs: ["apps/web", "apps/operator-vite"],
      repairWorkspaceArgs: [
        "--workspace=@papercusp/web",
        "--workspace=apps/operator-vite",
      ],
    },
  );
  assert.deepEqual(
    verificationScopeForNpmArgs({ repoRoot, npmArgs: ["install"], deps }),
    { workspaceDirs: undefined, repairWorkspaceArgs: [] },
  );
});

test("verifyNpmCache invokes npm cache verify in the target repo and returns its status", () => {
  const calls = [];
  const env = { NPM_CONFIG_CACHE: "/tmp/npm-cache" };
  const status = verifyNpmCache({
    repoRoot: "/tmp/papercusp-test-repo",
    npmArgs: ["dedupe", "--cache", "/tmp/explicit-cache"],
    env,
    runNpm: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    [
      "npm",
      ["cache", "verify", "--cache", "/tmp/explicit-cache"],
      {
        cwd: "/tmp/papercusp-test-repo",
        stdio: "inherit",
        env,
      },
    ],
  ]);
});

test("verifyNpmCache returns a failure status without hiding npm cache errors", () => {
  assert.equal(
    verifyNpmCache({
      runNpm: () => ({ status: 7 }),
    }),
    7,
  );
});

test("parseCliArgs consumes the wrapper-only offline-safe flag", () => {
  const parsed = parseCliArgs(["--offline-safe", "ci", "--ignore-scripts"]);

  assert.equal(parsed.offlineSafe, true);
  assert.deepEqual(parsed.npmArgs, ["ci", "--ignore-scripts"]);
});

test("parseCliArgs keeps offline-safe out of npm argv after an explicit repo root", () => {
  const parsed = parseCliArgs(
    ["--repo-root", "../sidestage", "--offline-safe", "--", "install", "--no-save"],
    { cwd: "/managed/papercusp" },
  );

  assert.deepEqual(parsed, {
    repoRoot: "/managed/sidestage",
    npmArgs: ["install", "--no-save"],
    offlineSafe: true,
  });
});

test("npmChildEnv overrides onnxruntime postinstall only in offline-safe mode", () => {
  const callerEnv = {
    PATH: "/bin",
    CUSTOM_SETTING: "preserve",
  };

  assert.deepEqual(npmChildEnv({ env: callerEnv }), callerEnv);
  assert.deepEqual(npmChildEnv({ env: callerEnv, offlineSafe: true }), {
    ...callerEnv,
    ONNXRUNTIME_NODE_INSTALL: "skip",
  });
  assert.equal(callerEnv.ONNXRUNTIME_NODE_INSTALL, undefined);
});

test("npmChildEnv preserves an explicit caller install choice in offline-safe mode", () => {
  const callerEnv = { ONNXRUNTIME_NODE_INSTALL: "cuda12" };

  assert.deepEqual(
    npmChildEnv({ env: callerEnv, offlineSafe: true }),
    callerEnv,
  );
});

test("verifyDepsExtracted passes the selected npm environment to bounded repairs", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-repair-env-"));
  const workspace = join(repoRoot, "apps/operator");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(repoRoot, "package.json"),
    JSON.stringify({ workspaces: ["apps/operator"] }),
  );
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ dependencies: { "was-missing": "^1" } }),
  );

  const env = {
    PATH: "/bin",
    ONNXRUNTIME_NODE_INSTALL: "skip",
    PAPERCUSP_INSTALL_SAFE_ACTIVE: "1",
  };
  const calls = [];
  try {
    const status = await verifyDepsExtracted({
      repoRoot,
      env,
      runNpm: (args, options) => {
        calls.push({ args, options });
        mkdirSync(join(repoRoot, "node_modules/was-missing"), {
          recursive: true,
        });
        return 0;
      },
      deps: { sleep: async () => {} },
    });

    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["install", "--legacy-peer-deps"]);
    assert.deepEqual(calls[0].options, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("publishDependencyGeneration invokes the shared atomic publisher after install verification", async () => {
  const repoRoot = mkdtempSync(
    join(tmpdir(), "install-safe-generation-publish-"),
  );
  const calls = [];
  const env = { PATH: "/bin" };
  try {
    const status = await publishDependencyGeneration({
      repoRoot,
      env,
      runPublisher: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
    });

    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "bash");
    assert.match(calls[0][1][0], /dependency-generation\.sh$/);
    assert.deepEqual(calls[0][1].slice(1), ["--integration", repoRoot]);
    assert.deepEqual(calls[0][2], {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("publishDependencyGeneration preserves an explicit emergency skip", async () => {
  let called = false;
  assert.equal(
    await publishDependencyGeneration({
      env: { PAPERCUSP_SKIP_DEP_GENERATION: "1" },
      runPublisher: () => {
        called = true;
        return { status: 0 };
      },
    }),
    0,
  );
  assert.equal(called, false);
});

test("package-cache cleanup waits for every safe-install cache reader across repo locks", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "install-safe-package-cache-reader-"),
  );
  const previousLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(root, "locks");

  let readerStarted;
  const readerReady = new Promise((resolve) => {
    readerStarted = resolve;
  });
  let releaseReader;
  const readerMayFinish = new Promise((resolve) => {
    releaseReader = resolve;
  });
  let reader;

  try {
    reader = withPackageCacheReadLease(async () => {
      readerStarted();
      await readerMayFinish;
      return "installed";
    });
    await readerReady;

    let cleanupEntered = false;
    let cleanupWaiting = false;
    const cleanup = withFsMutex(
      PACKAGE_CACHE_MUTEX_NAME,
      async () => {
        cleanupEntered = true;
        return "cleaned";
      },
      {
        timeoutMs: 2_000,
        retryMs: 1,
        onWaiting: () => {
          cleanupWaiting = true;
        },
      },
    );
    for (let attempt = 0; attempt < 100 && !cleanupWaiting; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(cleanupWaiting, true);
    assert.equal(cleanupEntered, false);

    releaseReader();
    assert.equal(await reader, "installed");
    assert.equal(await cleanup, "cleaned");
    assert.equal(cleanupEntered, true);
  } finally {
    releaseReader?.();
    if (reader) await reader.catch(() => {});
    if (previousLockRoot === undefined)
      delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishDependencyGeneration holds a reader lock until the publisher finishes", async () => {
  const repoRoot = mkdtempSync(
    join(tmpdir(), "install-safe-generation-reader-"),
  );
  const previousLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(repoRoot, "locks");

  let publisherStarted;
  const publisherReady = new Promise((resolve) => {
    publisherStarted = resolve;
  });
  let releasePublisher;
  const publisherMayFinish = new Promise((resolve) => {
    releasePublisher = resolve;
  });
  let publishing;

  try {
    publishing = publishDependencyGeneration({
      repoRoot,
      env: { PATH: process.env.PATH ?? "" },
      runPublisher: async () => {
        publisherStarted();
        await publisherMayFinish;
        return { status: 0 };
      },
    });
    await publisherReady;

    let writerEntered = false;
    let writerWaiting = false;
    const writer = withFsMutex(
      repoLockName(repoRoot),
      async () => {
        writerEntered = true;
        return 0;
      },
      {
        timeoutMs: 2_000,
        retryMs: 1,
        onWaiting: () => {
          writerWaiting = true;
        },
      },
    );
    for (let attempt = 0; attempt < 100 && !writerWaiting; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(writerWaiting, true);
    assert.equal(writerEntered, false);

    releasePublisher();
    assert.equal(await publishing, 0);
    assert.equal(await writer, 0);
    assert.equal(writerEntered, true);
  } finally {
    releasePublisher?.();
    if (publishing) await publishing.catch(() => {});
    if (previousLockRoot === undefined)
      delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockRoot;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("nested exec-under-lock readers do not reacquire the writer mutex", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-nested-reader-"));
  const previousEnv = {
    PAPERCUSP_FS_MUTEX_LOCK_DIR: process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR,
    PAPERCUSP_FS_MUTEX_TIMEOUT_MS: process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS,
    PAPERCUSP_FS_MUTEX_RETRY_MS: process.env.PAPERCUSP_FS_MUTEX_RETRY_MS,
    PAPERCUSP_INSTALL_MUTEX_HELD: process.env.PAPERCUSP_INSTALL_MUTEX_HELD,
  };
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(repoRoot, "locks");
  process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS = "25";
  process.env.PAPERCUSP_FS_MUTEX_RETRY_MS = "1";
  process.env.PAPERCUSP_INSTALL_MUTEX_HELD = repoLockName(repoRoot);

  try {
    const calls = [];
    await withFsMutex(repoLockName(repoRoot), async () => {
      await assert.doesNotReject(
        runCommandUnderInstallMutex({
          repoRoot,
          commandArgs: ["ptool", "events:status"],
          runCommand: (...args) => {
            calls.push(args);
            return { status: 0 };
          },
        }),
      );
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].env.PAPERCUSP_INSTALL_MUTEX_HELD, repoLockName(repoRoot));
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("install readers keep reporting a held writer on the configured cadence", async (context) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "install-safe-reader-notices-"));
  const previousLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  const previousTimeout = process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS;
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(repoRoot, "locks");
  process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS = "180000";
  const originalError = console.error;
  let releaseWriter;
  let writerStarted;
  const writerReady = new Promise(resolve => { writerStarted = resolve; });
  const writer = withFsMutex(repoLockName(repoRoot), async () => {
    writerStarted();
    await new Promise(resolve => { releaseWriter = resolve; });
  });
  let reading;
  let noticeDeadline;
  try {
    await writerReady;
    let firstNotice;
    let nextNotice;
    const first = new Promise(resolve => { firstNotice = resolve; });
    const next = new Promise(resolve => { nextNotice = resolve; });
    const notices = [];
    const acquiredLines = [];
    console.error = message => {
      if (String(message).startsWith("NPM_INSTALL_SAFE reader waiting")) {
        notices.push(String(message));
        if (notices.length === 1) firstNotice();
        else nextNotice();
      }
      if (String(message).startsWith("NPM_INSTALL_SAFE_LOCK_ACQUIRED")) acquiredLines.push(String(message));
    };
    // Advance only the observed clock. Real filesystem operations and the
    // mutex retry timer continue to run, without waiting 30 seconds in CI.
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    let childEntered = false;
    reading = runCommandUnderInstallMutex({
      repoRoot,
      commandArgs: ["reader"],
      env: {},
      runCommand: () => { childEntered = true; return { status: 0 }; },
    });
    await first;
    context.mock.timers.tick(30_000);
    await Promise.race([next, new Promise((_, reject) => {
      noticeDeadline = setTimeout(() => reject(new Error("reader stopped reporting its held writer")), 1500);
    })]);
    assert.match(notices[0], /\(0s so far\)/);
    assert.match(notices[1], /\(30s so far\)/);
    assert.equal(childEntered, false);
    assert.deepEqual(acquiredLines, []);
    releaseWriter();
    await writer;
    assert.equal(await reading, 0);
    assert.equal(childEntered, true);
    // WI-10006385: the wait closes with ONE line naming its real length and budget.
    assert.equal(acquiredLines.length, 1);
    const [, waitedMs, budgetMs] =
      acquiredLines[0].match(/^NPM_INSTALL_SAFE_LOCK_ACQUIRED lock=reader waitedMs=(\d+) budgetMs=(\d+)$/) ?? [];
    assert.ok(Number(waitedMs) >= 30_000, acquiredLines[0]);
    assert.equal(Number(budgetMs), 180_000);
  } finally {
    clearTimeout(noticeDeadline);
    releaseWriter?.();
    await writer.catch(() => {});
    await reading?.catch(() => {});
    context.mock.timers.reset();
    console.error = originalError;
    if (previousLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockRoot;
    if (previousTimeout === undefined) delete process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS;
    else process.env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS = previousTimeout;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// WI-10004430: `npm cache verify` ends with `rm -rf <cache>/tmp`, so it must never run
// while another checkout reifies from the same user-level cache. The repo-keyed install
// mutex cannot provide that (different checkouts hash to different locks); only the
// host-wide package-cache lock can.

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function holdPackageCacheReader() {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const mayFinish = new Promise((resolve) => {
    release = resolve;
  });
  const done = withPackageCacheReadLease(async () => {
    started();
    await mayFinish;
  });
  return { ready, release, done };
}

test("install:safe verifies the npm cache with the package cache held exclusively, then reifies under a shared lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "install-safe-cache-order-"));
  const binDir = join(root, "bin");
  const repoRoot = join(root, "repo");
  const npmLog = join(root, "npm.log");
  mkdirSync(binDir);
  mkdirSync(repoRoot);
  // A fake npm that records, for each call, whether the host-wide package-cache WRITER
  // lock exists and how many READER leases are held at that instant.
  writeFileSync(
    join(binDir, "npm"),
    [
      "#!/usr/bin/env bash",
      'L="$PAPERCUSP_FS_MUTEX_LOCK_DIR"',
      'w=no; [ -d "$L/package-manager-cache.lock" ] && w=yes',
      'r=$(ls -A "$L/package-manager-cache.readers" 2>/dev/null | wc -l | tr -d " ")',
      'echo "$1 writer=$w readers=$r" >> "$FAKE_NPM_LOG"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const restoreEnv = setEnv({
    PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, "locks"),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    FAKE_NPM_LOG: npmLog,
    PAPERCUSP_SKIP_DEP_VERIFY: "1",
    PAPERCUSP_SKIP_DEP_GENERATION: "1",
  });
  try {
    // NPM_INSTALL_SAFE_SUBJECT lets scripts/mutation-probe.sh point this guard at a copy.
    const subject = process.env.NPM_INSTALL_SAFE_SUBJECT;
    const runMain = subject
      ? (await import(pathToFileURL(subject).href)).main
      : main;
    assert.equal(await runMain(["--repo-root", repoRoot, "install"]), 0);
    assert.deepEqual(readFileSync(npmLog, "utf8").trim().split("\n"), [
      "cache writer=yes readers=0",
      "install writer=no readers=1",
    ]);
  } finally {
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyNpmCacheExclusive waits for a concurrent install's cache lease before verifying", async () => {
  const root = mkdtempSync(join(tmpdir(), "install-safe-verify-wait-"));
  const restoreEnv = setEnv({ PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, "locks") });
  const reader = holdPackageCacheReader();
  try {
    await reader.ready;
    let verifyEntered = false;
    let waiting = false;
    const verifying = verifyNpmCacheExclusive({
      verify: () => {
        verifyEntered = true;
        return 0;
      },
      waitMs: 5_000,
      log: (line) => {
        if (line.includes("waiting for exclusive use")) waiting = true;
      },
    });
    for (let attempt = 0; attempt < 400 && !waiting; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(waiting, true);
    assert.equal(verifyEntered, false);

    reader.release();
    await reader.done;
    assert.equal(await verifying, 0);
    assert.equal(verifyEntered, true);
  } finally {
    reader.release();
    await reader.done.catch(() => {});
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyNpmCacheExclusive skips verify instead of failing the install when the cache stays busy", async () => {
  const root = mkdtempSync(join(tmpdir(), "install-safe-verify-skip-"));
  const restoreEnv = setEnv({ PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, "locks") });
  const reader = holdPackageCacheReader();
  try {
    await reader.ready;
    const lines = [];
    let verifyCalled = false;
    const status = await verifyNpmCacheExclusive({
      verify: () => {
        verifyCalled = true;
        return 1;
      },
      waitMs: 150,
      log: (line) => lines.push(line),
    });
    assert.equal(status, 0);
    assert.equal(verifyCalled, false);
    assert.ok(
      lines.some((line) => line.startsWith("NPM_INSTALL_SAFE_CACHE_VERIFY_SKIPPED")),
      `expected a loud skip line, got: ${JSON.stringify(lines)}`,
    );
  } finally {
    reader.release();
    await reader.done.catch(() => {});
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyNpmCacheExclusive reports verify's own failure instead of treating it as a skip", async () => {
  const acquire = async (_name, fn) => fn();
  assert.equal(
    await verifyNpmCacheExclusive({ verify: () => 3, acquire, log: () => {} }),
    3,
  );
  await assert.rejects(
    verifyNpmCacheExclusive({
      verify: () => {
        throw new Error("verify crashed");
      },
      acquire,
      log: () => {},
    }),
    /verify crashed/,
  );
});

test("test:file runs Vitest under the repo install reader mutex", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  // WI-10005802: both hops start under the committed-source loader, so the mutex wrapper and the
  // router run their committed (HEAD) bytes.
  assert.match(
    packageJson.scripts["test:file"],
    /bash scripts\/pc-heavy\.sh node --import \.\/scripts\/lib\/committed-source-loader\.mjs scripts\/npm-install-safe\.mjs --exec-under-lock -- node --import \.\/scripts\/lib\/committed-source-loader\.mjs scripts\/test-files\.mjs$/,
  );
});

test("symlinked npm-install-safe CLI executes reader commands", () => {
  const root = mkdtempSync(join(tmpdir(), "npm-install-safe-symlink-"));
  const cliLink = join(root, "npm-install-safe.mjs");
  try {
    symlinkSync(
      fileURLToPath(new URL("./npm-install-safe.mjs", import.meta.url)),
      cliLink,
    );
    const result = spawnSync(
      process.execPath,
      [
        cliLink,
        "--repo-root",
        root,
        "--exec-under-lock",
        "--",
        process.execPath,
        "-e",
        'process.stdout.write("npm-install-safe-symlink-reader-ran")',
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, "locks"),
        },
        timeout: 10_000,
      },
    );

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /NPM_INSTALL_SAFE guarding reader/);
    assert.match(result.stdout, /npm-install-safe-symlink-reader-ran/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// EI-24937341882865098: `--help` used to be rewritten to `npm install --help`, which first waited
// on the repo-keyed install mutex — a silent multi-minute hang that read like a real install.
test("parseCliArgs treats a leading --help / -h as a wrapper help request", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { help: true });
  assert.deepEqual(parseCliArgs(["-h"]), { help: true });
  // Only the FIRST argument is the wrapper's: an explicit npm subcommand keeps npm's own help.
  assert.deepEqual(parseCliArgs(["install", "--help"]).npmArgs, ["install", "--help"]);
  // Calibration: an ordinary leading flag still gets the implicit install.
  assert.deepEqual(parseCliArgs(["--legacy-peer-deps"]).npmArgs, ["install", "--legacy-peer-deps"]);
});

test("the CLI prints usage for --help and exits 0 without spawning npm or taking the mutex", () => {
  const cli = fileURLToPath(new URL("./npm-install-safe.mjs", import.meta.url));
  // A PATH with no npm on it: if --help ever reached npm again the child would fail, not hang.
  const result = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, PATH: "/nonexistent-npm-install-safe-help" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, USAGE);
  assert.match(USAGE, /^Usage: npm run install:safe/);
});
