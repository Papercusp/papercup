import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cacheVerifyArgs,
  lockfileDepFlagOnlyChanges,
  publishDependencyGeneration,
  readLockfileText,
  restoreScopedFlagOnlyLockfileRewrite,
  workspaceSelectorsForNpmArgs,
  npmChildEnv,
  normalizeNpmArgs,
  parseCliArgs,
  repoLockName,
  runCommandUnderInstallMutex,
  verifyDepsExtracted,
  withPackageCacheReadLease,
  verificationScopeForNpmArgs,
  verifyNpmCache,
} from "./npm-install-safe.mjs";
import { PACKAGE_CACHE_MUTEX_NAME, withFsMutex } from "./lib/fs-mutex.mjs";

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
  process.env.PAPERCUSP_INSTALL_MUTEX_HELD = "1";

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
    assert.equal(calls[0][2].env.PAPERCUSP_INSTALL_MUTEX_HELD, "1");
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
