import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(missingDependency = false) {
  const root = await mkdtemp(join(tmpdir(), "p2p-witness-build-"));
  temporary.push(root);
  const repo = join(root, "repo"), commands = join(root, "commands"), output = join(root, "artifact");
  async function file(path: string, content: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await file(join(repo, "apps/operator/bin/bundle-host-common.sh"),
    "HOST_COMMON_EXTERNALS=(--external:witness-runtime)\nNATIVE_PKGS=()\nHOST_BANNER=''\nHOST_BANNER_DEFINES=()\nbundle_host_run_step() { shift; \"$@\"; }\n");
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
  await mkdir(join(repo, "papercusp-desktop/bin/lib"), { recursive: true });
  for (const name of ["host-runtime-closure.sh", "transformers-models.sh"]) {
    await symlink(join(repository, "papercusp-desktop/bin/lib", name), join(repo, "papercusp-desktop/bin/lib", name));
  }
  await file(join(repo, "node_modules/witness-runtime/package.json"),
    JSON.stringify({ name: "witness-runtime", main: "dist/index.js", dependencies: { "witness-child": "1" } }));
  await file(join(repo, "node_modules/witness-runtime/dist/index.js"), "module.exports = require('witness-child');\n");
  if (!missingDependency) {
    await file(join(repo, "node_modules/witness-runtime/node_modules/witness-child/package.json"),
      JSON.stringify({ name: "witness-child", main: "index.js" }));
    await file(join(repo, "node_modules/witness-runtime/node_modules/witness-child/index.js"), "module.exports = 'isolated-runtime-ok';\n");
  }
  await file(join(commands, "git"), "#!/bin/sh\nprintf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  await file(join(commands, "npx"), `#!/usr/bin/env node
const fs = require('node:fs');
const output = process.argv.find(value => value.startsWith('--outfile=')).slice('--outfile='.length);
fs.writeFileSync(output, "import value from 'witness-runtime'; console.log(value);\\n");
`);
  for (const name of ["git", "npx"]) await chmod(join(commands, name), 0o755);
  return { root, repo, commands, output };
}

describe("P2P witness runtime closure", () => {
  it("loads copied externals and nested dependencies after the donor disappears", async () => {
    const f = await fixture();
    const built = spawnSync("bash", [join(repository, "scripts/build-p2p-witness.sh")], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, TMPDIR: f.root, PATH: `${f.commands}:${process.env.PATH}`, PAPERCUSP_REPO_ROOT: f.repo, PAPERCUSP_WITNESS_OUT: f.output },
    });
    expect(built.status, built.stdout + built.stderr).toBe(0);
    await rm(f.repo, { recursive: true, force: true });
    const loaded = spawnSync(process.execPath, [join(f.output, "serve.mjs")], { encoding: "utf8", timeout: 10_000 });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout.trim()).toBe("isolated-runtime-ok");
    const manifest = JSON.parse(await readFile(join(f.output, "witness-manifest.json"), "utf8"));
    expect(manifest.inputs.dependencies.some((row: { input: string }) => row.input === "runtime/node_modules"),
      built.stdout + built.stderr + JSON.stringify(manifest.inputs.dependencies)).toBe(true);
  });

  it("refuses publication when a required external dependency is missing", async () => {
    const f = await fixture(true);
    const built = spawnSync("bash", [join(repository, "scripts/build-p2p-witness.sh")], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, TMPDIR: f.root, PATH: `${f.commands}:${process.env.PATH}`, PAPERCUSP_REPO_ROOT: f.repo, PAPERCUSP_WITNESS_OUT: f.output },
    });
    expect(built.status).not.toBe(0);
    expect(built.stdout + built.stderr).toContain("witness-child");
    expect(built.stderr).toContain("retained staging directory:");
    await expect(readFile(join(f.output, "witness-manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
