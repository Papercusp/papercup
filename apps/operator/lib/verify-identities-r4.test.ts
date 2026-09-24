import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { checkedCommand, serializeEvidence, toolArgs } from "../../../scripts/verify-identities-r4.mjs";
import { findBoxIdentityPaths } from "../../../scripts/lib/identity-leak-patterns.mjs";

const script = readFileSync(resolve(__dirname, "../../../scripts/verify-identities-r4.mjs"), "utf8");

describe("P-015 R-4 maintained identity UI verifier", () => {
  it("requires the isolated verifier database and bridge provenance", () => {
    expect(script).toContain('required("HARNESS_ADMIN_DATABASE_URL")');
    expect(script).toContain('required("VERIFY_TAURI_PID")');
    expect(script).toContain("VERIFY_TAURI_OWNER_SID");
    expect(script).toContain("VERIFY_TAURI_LAUNCH_PROVENANCE");
    expect(script).toContain("VERIFY_TAURI_SPA_DIST");
  });

  it("seeds the presence-primary roster plus matching launch/session state", () => {
    expect(script).toContain("INSERT INTO harness_shared.coord_presence");
    expect(script).toContain("INSERT INTO harness_shared.adv_sessions");
    expect(script).toContain("INSERT INTO harness_shared.session_briefs");
    expect(script).toContain("ON CONFLICT (owner_id)");
  });

  it("uses real pointer clicks and settle guards for every transition", () => {
    expect(script).toContain('Inspect identity research-steward');
    expect(script).toContain('button[aria-label="Apply identity"]');
    expect(script).toContain('button[aria-label="Roll back identity"]');
    expect(script).toContain("inline:'center'");
    expect(script).toContain("node.scrollWidth > node.clientWidth");
    expect(script).toContain("pointer target outside viewport");
    expect(script.match(/settle\(\);/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps synthetic UI proof separate from host activation proof", () => {
    expect(script).toContain("syntheticMutationResponses: !realBackend");
    expect(script).toContain("hostActivationProven: false");
    expect(script).toContain("p015-r4-fetch-patched");
  });

  it("has a real-backend branch with a workspace-wide fixture and host acknowledgement", () => {
    expect(script).toContain('process.env.P015_R4_REAL_BACKEND === "1"');
    expect(script).toContain("planSlug: null");
    expect(script).toContain("real-switch-change-requested");
    expect(script).toContain("real-rollback-applied");
    expect(script).toContain("/api/agent-mcp/turn-start-memory");
    expect(script).toContain("attribution: { actorId: owner, principalId: owner, sessionId: owner }");
    expect(script).toContain("hostActivationProven: false");
  });

  it("has a real-backend recovery leg: nuqs round-trip, provider boundary, forced CAS failure, retry, SSE invalidation", () => {
    expect(script).toContain('realBackend && process.env.P015_R4_REAL_RECOVERY === "1"');
    expect(script).toContain("nuqs-state-restored-from-url");
    expect(script).toContain("provider-bindings boundary exposes a selectable control");
    // The failure must come from the real compare-and-swap, not a patched response.
    expect(script).toContain("jsonb_set(launch_spec, '{launchedBy}'");
    expect(script).toContain('includes("changed concurrently")');
    // Deterministic, not a race: the writer holds the row lock until the switch's
    // compare-and-swap is observed waiting on it, then commits.
    expect(script).toContain("wait_event_type = 'Lock'");
    expect(script).toContain("the switch never blocked on the concurrent writer's row lock");
    expect(script).toContain("forced failure mutated prior state");
    expect(script).toContain("retry is not reachable after the forced failure");
    expect(script).toContain("bySseName?.['identities.surface']");
    expect(script).toContain("window.__p015R4NoReload === 'p015-r4-no-reload'");
    expect(script).toContain("forcedRealFailureProven: false");
    // Selected-tab reads are scoped to the identity tablist: the app shell renders
    // other tablists earlier in the document, so a bare [role="tab"] query reads theirs.
    expect(script).not.toMatch(/querySelector\('\[role=\\"tab\\"\]\[aria-selected/);
    expect(script).toContain(`[aria-label=\\"Identity management sections\\"] [role=\\"tab\\"][aria-selected=\\"true\\"]`);
  });

  it("fails fast and writes an evidence artifact on both pass and failure", () => {
    expect(script).toContain("status = \"fail\"");
    expect(script).toContain("throw error");
    expect(script).toContain("evidence.json");
    expect(script).toContain("await cleanup().catch");
  });

  it("refuses a shared database before any seed or bridge command", () => {
    const result = spawnSync(process.execPath, [resolve(__dirname, "../../../scripts/verify-identities-r4.mjs"), "--preflight"], {
      encoding: "utf8",
      env: { ...process.env, VERIFY_TAURI_PID: "123", HARNESS_ADMIN_DATABASE_URL: "postgresql://localhost:5432/shared", PAPERCUSP_VERIFY_TAURI_ISOLATED: "0" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing shared database");
  });

  it("rejects a database port that disagrees with the verifier", () => {
    const result = spawnSync(process.execPath, [resolve(__dirname, "../../../scripts/verify-identities-r4.mjs"), "--preflight"], {
      encoding: "utf8",
      env: { ...process.env, VERIFY_TAURI_PID: "123", HARNESS_ADMIN_DATABASE_URL: "postgresql://localhost:5432/shared", PAPERCUSP_VERIFY_TAURI_ISOLATED: "1", PAPERCUSP_HOME: "/tmp/verify-example/papercusp-home", PAPERCUSP_PG_PORT: "45001" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("database address does not match");
  });

  it("uses the supported eval syntax, with no --json flag", () => {
    expect(toolArgs("123", ["eval", "--file", "/tmp/a script.js"])).toEqual(["eval", "--pid", "123", "--file", "/tmp/a script.js"]);
    expect(toolArgs("123", ["check", "--selector", "body"])).toEqual(["check", "--pid", "123", "--selector", "body", "--json"]);
  });

  it("guards eval polls with a rendered subject before evaluating state", () => {
    expect(script).toContain('["--require", "body", ...args]');
    expect(script).toContain('"--selector", \'[aria-label="Agent to manage"]\'');
  });

  it("keeps the identity library responsive to the content panel, not only the window", () => {
    const page = readFileSync(resolve(__dirname, "../app/settings/identities/page.tsx"), "utf8");
    expect(page).toContain("container-type: inline-size");
    expect(page).toContain("@container identities (max-width: 900px)");
    expect(page).not.toContain("@media (max-width: 900px)");
  });

  it("writes an artifact git-sync's identity-leak guard will commit", () => {
    // Built by concatenation so this tracked file does not itself spell a home path.
    const toolPath = ["", "home", "zqxdev", ".local", "node25", "bin", "tauri-agent-tools"].join("/");
    const evidence = {
      steps: [{ label: "seed", command: `${toolPath} --pid 1 check --selector body` }],
      error: `Error: Command failed: ${toolPath} eval --pid 1`,
    };
    // Positive control: the raw form DOES trip the detector, so the assertion below is not vacuous.
    expect(findBoxIdentityPaths(JSON.stringify(evidence, null, 2)).length).toBeGreaterThan(0);
    const written = serializeEvidence(evidence);
    expect(findBoxIdentityPaths(written)).toEqual([]);
    expect(JSON.parse(written).steps[0].command).toContain("tauri-agent-tools --pid 1 check");
    expect(script.match(/writeFileSync\(`\$\{outDir\}\/evidence\.json`, serializeEvidence\(evidence\)\)/g)?.length).toBe(2);
  });

  it("propagates a failed assertion instead of replacing it with a later successful command", () => {
    expect(() => checkedCommand(process.execPath, ["-e", "process.exit(7)"])).toThrow();
    expect(checkedCommand(process.execPath, ["-e", "process.stdout.write('observed')"])).toBe("observed");
  });
});
