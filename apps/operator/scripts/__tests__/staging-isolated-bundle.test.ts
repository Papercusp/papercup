import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const HELPER = join(REPO_ROOT, "apps/operator/bin/bundle-host-freshness.mjs");
const DROPIN_ROOT = join(
  REPO_ROOT,
  "apps/operator/scripts/systemd/papercup-staging-api.service.d",
);

describe("staging systemd drop-ins keep sync, bundle and runtime on one isolated tree", () => {
  const checkout = readFileSync(
    join(DROPIN_ROOT, "50-staging-checkout.conf"),
    "utf8",
  );
  const bundle = readFileSync(
    join(DROPIN_ROOT, "95-bundled-entry.conf"),
    "utf8",
  );

  it("points WorkingDirectory and PAPERCUSP_INTEGRATION_ROOT at papercusp-staging", () => {
    expect(checkout).toContain(
      "WorkingDirectory=%h/papercupai-workspace/papercusp-staging/apps/operator",
    );
    expect(checkout).toContain(
      "PAPERCUSP_INTEGRATION_ROOT=%h/papercupai-workspace/papercusp-staging",
    );
    expect(checkout).not.toMatch(
      /papercupai-workspace\/papercusp\/apps\/operator/,
    );
  });

  it("builds from that same tree and enables proof-bound reuse before plain-node start", () => {
    expect(bundle).toContain("Environment=PAPERCUSP_BUNDLE_REUSE_FRESH=1");
    expect(bundle).toContain(
      "ExecStartPre=%h/papercupai-workspace/papercusp-staging/apps/operator/bin/bundle-host.sh",
    );
    expect(bundle).toContain("exec node dist-host/hono-host.mjs");
    expect(bundle).toContain("PAPERCUSP_BIND_HOST=127.0.0.1");
  });
});

describe("bundle-host-freshness proof", () => {
  let repo: string;
  let entry: string;
  let outfile: string;
  let manifest: string;

  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
      {
        encoding: "utf8",
      },
    ).trim();

  const run = (operation: "check" | "stamp") =>
    spawnSync(
      process.execPath,
      [
        HELPER,
        operation,
        "--repo-root",
        repo,
        "--entry",
        entry,
        "--outfile",
        outfile,
        "--manifest",
        manifest,
      ],
      { encoding: "utf8" },
    );

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bundle-freshness-"));
    git("init", "-q");
    entry = join(repo, "entry.ts");
    outfile = join(repo, "dist-host", "hono-host.mjs");
    manifest = join(repo, "dist-host", ".bundle-fresh.json");
    writeFileSync(join(repo, ".gitignore"), "dist-host/\n");
    writeFileSync(entry, "export const version = 1;\n");
    git("add", ".gitignore", "entry.ts");
    git("commit", "-q", "-m", "fixture");
    mkdirSync(join(repo, "dist-host", "sql"), { recursive: true });
    writeFileSync(outfile, 'console.log("bundle");\n');
    writeFileSync(join(repo, "dist-host", "sql", "001.sql"), "select 1;\n");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("accepts the same clean HEAD, entry and complete output tree", () => {
    expect(run("stamp").status).toBe(0);
    expect(run("check").status).toBe(0);
  });

  it("ignores the esbuild metafile removed by bundle-host.sh's EXIT trap after stamping", () => {
    const metafile = `${outfile}.tmp.12345.meta.json`;
    writeFileSync(metafile, '{"inputs":{}}\n');

    expect(run("stamp").status).toBe(0);
    unlinkSync(metafile);
    expect(run("check").status).toBe(0);
  });

  it("rejects tracked source drift and a later commit even when output bytes remain", () => {
    expect(run("stamp").status).toBe(0);
    writeFileSync(entry, "export const version = 2;\n");
    expect(run("check").status).not.toBe(0);
    git("add", "entry.ts");
    git("commit", "-q", "-m", "new source");
    expect(run("check").status).not.toBe(0);
  });

  it("rejects missing or modified runtime output siblings", () => {
    expect(run("stamp").status).toBe(0);
    writeFileSync(join(repo, "dist-host", "sql", "001.sql"), "select 2;\n");
    expect(run("check").status).not.toBe(0);
  });
});
