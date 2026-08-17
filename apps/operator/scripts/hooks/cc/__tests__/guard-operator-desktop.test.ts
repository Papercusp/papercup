/**
 * Regression guard for the PreToolUse desktop/browser hook
 * (`guard-operator-desktop.mjs`), covering BOTH of its blocks:
 *
 *  1. operator ports (:3055/:3070/:3170) opened in a browser — pre-existing;
 *  2. the loopback-DECEPTION block (EI-20732462499061834) — a remote-looking
 *     hostname that resolves to 127.0.0.1, so a "prod" check silently
 *     verifies localhost and returns a clean 200 with no tell.
 *
 * Resolution is exercised through a PATH-shimmed `getent`, NOT this machine's
 * /etc/hosts: the real bug depends on a host-specific pin
 * (`sidestage.papercusp.com` → 127.0.0.1) that must not decide whether this
 * suite passes. The shim keeps the production code path intact — the hook
 * still shells out to `getent` exactly as it does in production — while
 * making the resolver's ANSWER deterministic here.
 *
 * The fail-open contract is the important half: a guard that blocks on its
 * own resolver error is worse than the bug it prevents.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

const HOOK = join(__dirname, "..", "guard-operator-desktop.mjs");

/** Hostnames the shimmed resolver knows about. */
const PINNED = "pinned-prod.example.test"; // → loopback (the bug)
const REMOTE = "real-remote.example.test"; // → a routable address
const SPLIT = "split-horizon.example.test"; // → loopback AND routable
const UNKNOWN = "no-such-host.example.test"; // → getent exits 2

let shimDir: string;

beforeAll(() => {
  shimDir = fs.mkdtempSync(join(os.tmpdir(), "guard-desktop-shim-"));
  const getent = join(shimDir, "getent");
  fs.writeFileSync(
    getent,
    [
      "#!/usr/bin/env bash",
      '# Fake `getent hosts <name>` — deterministic stand-in for /etc/hosts.',
      'case "$2" in',
      `  ${PINNED}) echo "127.0.0.1       ${PINNED}" ;;`,
      `  ${REMOTE}) echo "93.184.216.34   ${REMOTE}" ;;`,
      `  ${SPLIT}) echo "127.0.0.1       ${SPLIT}"; echo "93.184.216.34   ${SPLIT}" ;;`,
      "  *) exit 2 ;;", // getent's "not found" status
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
});
afterAll(() => fs.rmSync(shimDir, { recursive: true, force: true }));

function run(input: string, opts: { shim?: boolean } = {}) {
  const shim = opts.shim ?? true;
  // Launch by ABSOLUTE path: some cases below strip PATH to starve the hook's
  // `getent` lookup, and a bare "node" would then fail to spawn at all —
  // spawnSync reports that as status:null, which is not the fail-open we mean
  // to assert.
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(shim ? { PATH: `${shimDir}:${process.env.PATH ?? ""}` } : {}),
    },
  });
  return { status: r.status, stderr: (r.stderr ?? "").trim() };
}

const navigate = (url: string) =>
  JSON.stringify({
    tool_name: "mcp__playwright__browser_navigate",
    tool_input: { url },
  });
const verdict = (url: string) =>
  JSON.stringify({
    tool_name: "Skill",
    tool_input: { skill: "verdict", args: { url } },
  });

describe("guard-operator-desktop — loopback deception (EI-20732462499061834)", () => {
  it("BLOCKS a remote-looking hostname that resolves to loopback", () => {
    const r = run(navigate(`https://${PINNED}/healthz`));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("resolves to LOOPBACK");
    // The message must name the host, or the agent cannot act on it.
    expect(r.stderr).toContain(PINNED);
  });

  it("BLOCKS it through the verdict skill too (the vector that filed the bug)", () => {
    const r = run(verdict(`https://${PINNED}/?tab=seller`));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("resolves to LOOPBACK");
  });

  it("tells the agent how to confirm the pin themselves", () => {
    const r = run(navigate(`https://${PINNED}/`));
    expect(r.stderr).toContain(`getent hosts ${PINNED}`);
  });

  it("ALLOWS a genuinely remote host", () => {
    expect(run(navigate(`https://${REMOTE}/`)).status).toBe(0);
  });

  it("ALLOWS a host that also has a routable address (not wholly loopback)", () => {
    // Deliberate: only an ALL-loopback answer guarantees the connection
    // lands locally. A split-horizon name can still reach the real host.
    expect(run(navigate(`https://${SPLIT}/`)).status).toBe(0);
  });

  it.each(["http://localhost:5173/", "http://127.0.0.1:8080/", "https://box.local/"])(
    "ALLOWS an explicitly-local target (%s) — pointing there is intentional",
    (url) => {
      expect(run(navigate(url)).status).toBe(0);
    },
  );

  describe("fail-open contract", () => {
    it("ALLOWS when the host does not resolve", () => {
      expect(run(navigate(`https://${UNKNOWN}/`)).status).toBe(0);
    });

    it("ALLOWS when no resolver is on PATH at all", () => {
      const r = spawnSync(process.execPath, [HOOK], {
        input: navigate(`https://${PINNED}/`),
        encoding: "utf8",
        env: { ...process.env, PATH: "/nonexistent-dir-for-this-test" },
      });
      // Guard against the trap this test just hit: a failure to spawn also
      // yields a non-2 status, which would pass a bare `not.toBe(2)`.
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
    });

    it("ALLOWS on unparseable stdin", () => {
      expect(run("not json at all").status).toBe(0);
    });

    it("ALLOWS an unrelated tool", () => {
      expect(
        run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } }))
          .status,
      ).toBe(0);
    });

    it("ALLOWS a non-verdict skill pointed at the pinned host", () => {
      // Branch 2 is deliberately scoped to the verdict skill.
      const r = run(
        JSON.stringify({
          tool_name: "Skill",
          tool_input: { skill: "dataviz", args: { url: `https://${PINNED}/` } },
        }),
      );
      expect(r.status).toBe(0);
    });
  });
});

describe("guard-operator-desktop — operator ports (pre-existing block)", () => {
  it.each([
    "http://localhost:3055/",
    "http://127.0.0.1:3070/",
    "http://0.0.0.0:3170/",
  ])("BLOCKS a browser navigation to %s", (url) => {
    const r = run(navigate(url));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Tauri DESKTOP app");
  });

  it("BLOCKS the verdict skill pointed at an operator port", () => {
    expect(run(verdict("http://localhost:3055/")).status).toBe(2);
  });

  it("ALLOWS a non-operator local port", () => {
    expect(run(navigate("http://localhost:5173/")).status).toBe(0);
  });
});
