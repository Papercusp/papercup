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
const STAGING_SYNC_SCRIPT = join(
  REPO_ROOT,
  "apps/operator/bin/release/sync-staging-checkout.sh",
);

describe("staging systemd drop-ins keep the serving alias and runtime generation aligned", () => {
  const checkout = readFileSync(
    join(DROPIN_ROOT, "50-staging-checkout.conf"),
    "utf8",
  );
  const bundle = readFileSync(
    join(DROPIN_ROOT, "95-bundled-entry.conf"),
    "utf8",
  );

  it("points WorkingDirectory, SPA, and initial integration root at the stable alias", () => {
    expect(checkout).toContain(
      "WorkingDirectory=%h/papercupai-workspace/papercusp-staging.current/apps/operator",
    );
    expect(checkout).toContain(
      "Environment=PAPERCUSP_INTEGRATION_ROOT=%h/papercupai-workspace/papercusp-staging.current",
    );
    expect(checkout).toContain(
      "Environment=PAPERCUSP_SPA_DIST=%h/papercupai-workspace/papercusp-staging.current/apps/operator-vite/dist",
    );
    expect(checkout).not.toMatch(
      /papercupai-workspace\/papercusp\/apps\/operator/,
    );
  });

  // EI-24049239243821100: moving PAPERCUSP_INTEGRATION_ROOT off the edit tree without
  // naming the edit tree made every working-tree reader on :3170 describe the clean
  // mirror, so dev:pipeline_position reported an uncommitted edit as clean and live.
  it("declares the canonical EDIT tree separately from the served mirror", () => {
    const envValue = (name: string): string | null => {
      const prefix = "Environment=" + name + "=";
      return checkout
        .split("\n")
        .find((line) => line.startsWith(prefix))
        ?.slice(prefix.length) ?? null;
    };
    const served = envValue("PAPERCUSP_INTEGRATION_ROOT");
    const edited = envValue("PAPERCUSP_CANONICAL_TREE");
    expect(served).toBe("%h/papercupai-workspace/papercusp-staging.current");
    expect(edited).toBe("%h/papercupai-workspace/papercusp");
    expect(edited).not.toBe(served);
  });

  it("builds from that same tree and enables proof-bound reuse before plain-node start", () => {
    expect(bundle).toContain("Environment=PAPERCUSP_BUNDLE_REUSE_FRESH=1");
    expect(bundle).toContain(
      "ExecStartPre=/usr/bin/flock -s /tmp/papercup-staging-sync.lock %h/papercupai-workspace/papercusp-staging.current/apps/operator/bin/bundle-host.sh",
    );
    expect(bundle).toContain(
      'export PAPERCUSP_INTEGRATION_ROOT="$(cd ../.. && pwd -P)"',
    );
    expect(bundle).toContain("exec node dist-host/hono-host.mjs");
    expect(bundle).toContain("PAPERCUSP_BIND_HOST=127.0.0.1");
  });

  it("builds and marks an isolated candidate ready before publishing the alias", () => {
    const sync = readFileSync(STAGING_SYNC_SCRIPT, "utf8");
    const acquire = sync.indexOf('exec 9>"/tmp/papercup-staging-sync.lock"');
    const prepare = sync.indexOf('prepare_staging_candidate "$target"');
    const build = sync.indexOf(
      'PAPERCUSP_INTEGRATION_ROOT="$SYNC_ROOT" PAPERCUSP_BUNDLE_REUSE_FRESH=1 bash "$bundle_script"',
    );
    const ready = sync.indexOf('mark_staging_candidate_ready "$target"');
    const publish = sync.indexOf(
      'publish_staging_generation "$STAGING_CANDIDATE_ROOT"',
    );
    const downgrade = sync.indexOf("flock -s 9");
    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(acquire);
    expect(sync).toContain(
      'PAPERCUSP_INTEGRATION_ROOT="$INTEGRATION_ROOT" PAPERCUSP_RELEASE_ROOT="$STAGING_CANDIDATE_ROOT"',
    );
    expect(sync).toContain('--release "$STAGING_CANDIDATE_ROOT"');
    expect(build).toBeGreaterThan(prepare);
    expect(ready).toBeGreaterThan(build);
    expect(publish).toBeGreaterThan(ready);
    expect(downgrade).toBeGreaterThan(publish);
    expect(bundle).toContain(
      "/usr/bin/flock -s /tmp/papercup-staging-sync.lock",
    );
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

describe("bundle-host freshness helper paths", () => {
  const bundleHost = readFileSync(
    join(REPO_ROOT, "apps/operator/bin/bundle-host.sh"),
    "utf8",
  );

  it("passes relative or absolute paths unchanged to both freshness operations", () => {
    // The verifier supplies an absolute dist-verify outfile. Prefixing PWD to
    // that value creates an invalid double-rooted path and makes the optional
    // freshness stamp fail open, so both check and stamp must pass the original
    // arguments to the Node helper (which resolves relative paths itself).
    expect(bundleHost.match(/--entry "\$ENTRY"/g)).toHaveLength(2);
    expect(bundleHost.match(/--outfile "\$OUTFILE"/g)).toHaveLength(2);
    expect(bundleHost.match(/--manifest "\$FRESH_MARKER"/g)).toHaveLength(2);
    expect(bundleHost).not.toContain('--entry "$PWD/$ENTRY"');
    expect(bundleHost).not.toContain('--outfile "$PWD/$OUTFILE"');
    expect(bundleHost).not.toContain('--manifest "$PWD/$FRESH_MARKER"');
  });
});
