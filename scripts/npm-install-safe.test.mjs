import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cacheVerifyArgs,
  publishDependencyGeneration,
  repoLockName,
  runCommandUnderInstallMutex,
  withPackageCacheReadLease,
  verificationScopeForNpmArgs,
  verifyNpmCache,
} from "./npm-install-safe.mjs";
import { PACKAGE_CACHE_MUTEX_NAME, withFsMutex } from "./lib/fs-mutex.mjs";

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
