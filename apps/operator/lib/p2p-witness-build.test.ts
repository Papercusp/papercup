import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createProgressAwareWatchdog } from "../../../scripts/lib/batch-watchdog.mjs";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture({ missingDependency = false, wildcard = false, missingRoot = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "p2p-witness-build-"));
  temporary.push(root);
  const repo = join(root, "repo"), commands = join(root, "commands"), output = join(root, "artifact"), scratch = join(root, "scratch");
  await mkdir(scratch);
  const runtimePackage = wildcard ? "@fixture/runtime" : "witness-runtime";
  async function file(path: string, content: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await file(join(repo, "apps/operator/bin/bundle-host-common.sh"),
    `HOST_COMMON_EXTERNALS=(--external:${wildcard ? "@fixture/*" : runtimePackage})\nNATIVE_PKGS=()\nHOST_BANNER=''\nHOST_BANNER_DEFINES=()\nbundle_host_run_step() { shift; "$@"; }\nbundle_host_esbuild() { shift; npx "$@"; }\n`);
  await file(join(repo, "apps/operator/bin/serve.ts"), `import '${runtimePackage}';\n`);
  await file(join(repo, "apps/operator/bin/host-bootstrap.ts"), "initializeRuntimeObservability(); await startDbos();\n");
  await file(join(repo, "packages/operator-core/lib/dbos/bootstrap.ts"), "export {};\n");
  await file(join(repo, "node_modules/@dbos-inc/dbos-sdk/dist/src/dbos.js"),
    "if (!(0, traces_1.isTraceContextWorking)()) (0, traces_1.installTraceContextManager)();\n");
  await file(join(repo, "package-lock.json"), '{"lockfileVersion":3}');
  await file(join(repo, "libs/papercusp/libs/db/sql/001.sql"), "select 1;");
  await file(join(repo, "libs/papercusp/packages/embedded-postgres-server/bin/build-seed.mjs"), "export {};\n");
  await mkdir(join(repo, "scripts"), { recursive: true });
  // Execute the exact current producer bytes in the disposable source fixture.
  // A symlink back into the checkout lets the inherited committed-source loader
  // substitute HEAD for an edited producer, testing a different input cohort.
  await copyFile(join(repository, "scripts/p2p-witness-manifest.mjs"), join(repo, "scripts/p2p-witness-manifest.mjs"));
  await mkdir(join(repo, "node_modules/@papercusp"), { recursive: true });
  await symlink(join(repository, "node_modules/@papercusp/operator-core"), join(repo, "node_modules/@papercusp/operator-core"));
  await symlink(join(repository, "node_modules/typescript"), join(repo, "node_modules/typescript"));
  await mkdir(join(repo, "papercusp-desktop/bin/lib"), { recursive: true });
  for (const name of ["host-runtime-closure.sh", "transformers-models.sh"]) {
    await symlink(join(repository, "papercusp-desktop/bin/lib", name), join(repo, "papercusp-desktop/bin/lib", name));
  }
  // These production packages are loaded through opaque createRequire calls,
  // so neither the fake compiler's import graph nor a native-only list sees them.
  for (const name of ["@iarna/toml", "rrule", "luxon", "lost-pixel", "pixelmatch", "pngjs",
    "google-auth-library", "jose", "solc", "@openzeppelin/contracts", "shell-quote"]) {
    await file(join(repo, "node_modules", name, "package.json"), JSON.stringify({ name, main: "index.js" }));
    await file(join(repo, "node_modules", name, "index.js"), "module.exports = 'opaque-runtime-ok';\n");
  }
  if (!missingRoot) {
    await file(join(repo, "node_modules", runtimePackage, "package.json"),
      JSON.stringify({ name: runtimePackage, main: "dist/index.js", dependencies: { "witness-child": "1" } }));
    await file(join(repo, "node_modules", runtimePackage, "dist/index.js"), "module.exports = require('witness-child');\n");
    if (!missingDependency) {
      await file(join(repo, "node_modules", runtimePackage, "node_modules/witness-child/package.json"),
        JSON.stringify({ name: "witness-child", main: "index.js" }));
      await file(join(repo, "node_modules", runtimePackage, "node_modules/witness-child/index.js"), "module.exports = 'isolated-runtime-ok';\n");
    }
  }
  await file(join(commands, "git"), "#!/bin/sh\nprintf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  await file(join(commands, "npx"), `#!/usr/bin/env node
const fs = require('node:fs');
const output = process.argv.find(value => value.startsWith('--outfile=')).slice('--outfile='.length);
const metafile = process.argv.find(value => value.startsWith('--metafile='))?.slice('--metafile='.length);
fs.writeFileSync(output, output.endsWith('.assembly-trace-context.mjs')
  ? 'console.log(JSON.stringify({schemaVersion:"private-default-trace-context-v1",contextWorking:true,registered:true,otlp:false,primaryStarted:false}));\\n'
  : "import { createRequire } from 'node:module'; import value from '${runtimePackage}'; if (createRequire(import.meta.url)('shell-quote') !== 'opaque-runtime-ok') throw new Error('opaque runtime missing'); console.log(value);\\n");
if (metafile) fs.writeFileSync(metafile, JSON.stringify({inputs:{'bin/serve.ts':{imports:[{path:'${runtimePackage}',external:true,kind:'import-statement'}]}},outputs:{}}));
`);
  for (const name of ["git", "npx"]) await chmod(join(commands, name), 0o755);
  return { root, repo, commands, output, scratch };
}

async function buildWitness(f: Awaited<ReturnType<typeof fixture>>) {
  // The maintained producer starts a Node process for each closure phase.
  // Keep the inherited source-identity instrumentation, drain output while it
  // runs, and reuse the router's bounded progress policy instead of killing a
  // progressing build when the closure gains another required package.
  const child = spawn("bash", [join(repository, "scripts/build-p2p-witness.sh")], {
    detached: true,
    env: { ...process.env, TMPDIR: f.scratch, PATH: `${f.commands}:${process.env.PATH}`, PAPERCUSP_REPO_ROOT: f.repo, PAPERCUSP_WITNESS_OUT: f.output },
  });
  const watchdog = createProgressAwareWatchdog({
    timeoutMs: 30_000, maxMs: 90_000, stallWindowMs: 15_000, extensionMs: 15_000,
    onKill: () => { if (child.pid) process.kill(-child.pid, "SIGKILL"); },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data; watchdog.noteProgress(); });
  child.stderr.on("data", (data: Buffer) => { stderr += data; watchdog.noteProgress(); });
  try {
    return await new Promise<{ status: number | null; stdout: string; stderr: string; diagnostic: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, stdout, stderr,
        diagnostic: JSON.stringify({ status, signal, timeout: watchdog.killReason }) + stdout + stderr }));
    });
  } finally { watchdog.stop(); }
}

describe("P2P witness runtime closure", () => {
  it.each([false, true])("loads copied externals and nested dependencies after the donor disappears (wildcard=%s)", async (wildcard) => {
    const f = await fixture({ wildcard });
    const built = await buildWitness(f);
    expect(built.status, built.diagnostic).toBe(0);
    await rm(f.repo, { recursive: true, force: true });
    const loadStarted = performance.now();
    const loaded = spawnSync(process.execPath, [join(f.output, "serve.mjs")], { encoding: "utf8", timeout: 10_000 });
    expect(loaded.status, JSON.stringify({ status: loaded.status, signal: loaded.signal,
      error: loaded.error && { message: loaded.error.message, code: (loaded.error as NodeJS.ErrnoException).code },
      elapsedMs: performance.now() - loadStarted }) + loaded.stdout + loaded.stderr).toBe(0);
    expect(loaded.stdout.trim()).toBe("isolated-runtime-ok");
    const manifest = JSON.parse(await readFile(join(f.output, "witness-manifest.json"), "utf8"));
    expect(manifest.inputs.dependencies.some((row: { input: string }) => row.input === "runtime/node_modules"),
      built.stdout + built.stderr + JSON.stringify(manifest.inputs.dependencies)).toBe(true);
  }, 120_000);

  it("refuses publication when a required external dependency is missing", async () => {
    const f = await fixture({ missingDependency: true });
    const built = await buildWitness(f);
    expect(built.status).not.toBe(0);
    expect(built.stdout + built.stderr).toContain("witness-child");
    expect(built.stderr).toContain("retained staging directory:");
    const retainedStage = built.stderr.match(/retained staging directory: (.+)/)?.[1];
    expect(retainedStage, built.diagnostic).toBeDefined();
    expect(dirname(retainedStage!)).toBe(dirname(f.output));
    expect(dirname(retainedStage!)).not.toBe(f.scratch);
    await expect(readFile(join(f.output, "witness-manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("refuses publication when a wildcard import's root package is absent", async () => {
    const f = await fixture({ wildcard: true, missingRoot: true });
    const built = await buildWitness(f);
    expect(built.status).not.toBe(0);
    expect(built.stdout + built.stderr).toContain("@fixture/runtime");
    await expect(readFile(join(f.output, "witness-manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);
});
