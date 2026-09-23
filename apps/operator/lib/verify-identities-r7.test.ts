import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { appliesLayer, identitiesUrl, settleOutcome } from "../../../scripts/verify-identities-r7.mjs";

const scriptPath = resolve(__dirname, "../../../scripts/verify-identities-r7.mjs");
const script = readFileSync(scriptPath, "utf8");
const pagePath = resolve(__dirname, "../app/settings/identities/page.tsx");

const preflight = (env: Record<string, string>) =>
  spawnSync(process.execPath, [scriptPath, "--preflight"], {
    encoding: "utf8",
    env: { ...process.env, R7_OWNER: "", HARNESS_ADMIN_DATABASE_URL: "", PAPERCUSP_VERIFY_TAURI_ISOLATED: "", ...env },
  });

describe("P-015 R-7 live identity-switch verifier", () => {
  it("refuses an isolated verifier database: R-7 must act on the real launched agent", () => {
    const result = preflight({ PAPERCUSP_VERIFY_TAURI_ISOLATED: "1", R7_OWNER: "su-x", HARNESS_ADMIN_DATABASE_URL: "postgresql://localhost:5432/shared" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing an isolated verifier database");
  });

  it("requires the real owner and resolves the shared DSN canonically when none is passed", () => {
    const noOwner = preflight({ HARNESS_ADMIN_DATABASE_URL: "postgresql://localhost:5432/shared" });
    expect(noOwner.status).not.toBe(0);
    expect(noOwner.stderr).toContain("missing R7_OWNER");
    const ok = preflight({ R7_OWNER: "su-x", HARNESS_ADMIN_DATABASE_URL: "postgresql://localhost:5432/shared" });
    expect(ok.status, ok.stderr).toBe(0);
    const resolved = preflight({ R7_OWNER: "su-x" });
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(script).toContain("getHarnessAdminUrl()");
  });

  it("seeds and deletes nothing, and never posts a synthetic host acknowledgement", () => {
    expect(script).not.toMatch(/INSERT INTO|DELETE FROM|UPDATE harness_shared/);
    expect(script).not.toContain("/api/agent-mcp/turn-start-memory");
    expect(script).toContain("syntheticHostAcknowledgement: false");
  });

  it("switches TO the installed identity with a real switch, not a rollback", () => {
    expect(script).toContain('button[aria-label="Apply identity"]');
    expect(script).not.toContain("Roll back identity");
    expect(script).toContain('switchTo(returnTo, "to-installed")');
  });

  it("proves spans by joining tool invocations inside the applied layer windows", () => {
    expect(script).toContain("harness_shared.session_identity_layer_spans");
    expect(script).toContain("t.invoked_at >= s.active_from");
    expect(script).toContain("s.owner_id = t.coord_owner_id");
  });

  it("starts each switch on the tab that renders the identity library it asserts and clicks", () => {
    const url = new URL(identitiesUrl("su-a b", "papercusp-engineer", 7), "http://x");
    expect(url.pathname).toBe("/settings/identities");
    expect(url.searchParams.get("identityAgent")).toBe("su-a b");
    expect(url.searchParams.get("identityId")).toBe("papercusp-engineer");
    // No tab param: the page must open on its default tab ...
    expect(url.searchParams.has("identityTab")).toBe(false);
    expect(script).not.toContain("identityTab=agent");
    // ... and that default must be the library tab, the only one rendering the rows switchTo needs.
    const page = readFileSync(pagePath, "utf8");
    expect(page).toMatch(/"identityTab",\s*parseAsStringEnum<Tab>\(\[\.\.\.TABS\]\)\.withDefault\("library"\)/);
    const library = page.indexOf('tab === "library"');
    const agent = page.indexOf('tab === "agent"');
    const row = page.indexOf('aria-label={`Inspect identity ${identity.id}`}');
    expect(library).toBeGreaterThan(-1);
    expect(row).toBeGreaterThan(library);
    expect(row).toBeLessThan(agent);
  });

  it("treats a busy/unknown settle as recorded evidence, never as a pass or a silent swallow", () => {
    expect(settleOutcome({ status: 1 })).toBe("busy");
    expect(settleOutcome({ status: 3 })).toBe("unknown");
    // A killed child (status null), a missing script (127) or any other exit is a real error.
    expect(settleOutcome({ status: null })).toBeNull();
    expect(settleOutcome({ status: 127 })).toBeNull();
    expect(settleOutcome(undefined)).toBeNull();
    // Each page-dependent step still polls for its own target, so settle is never the gate.
    expect(script).toContain('waitForCall("preview", beforePreview');
    expect(script).toContain('waitForCall("switch", beforeSwitch');
  });

  it("re-clicks a swallowed pointer click only while no request has LEFT, so it cannot double-apply", () => {
    // The effect is a request that STARTED (counted before its response), not one that completed:
    // judging on completion would re-click a slow request and hit its busy, disabled button.
    expect(script).toContain("? ++net.started : 0;");
    expect(script).toMatch(/clickUntil\('button\[aria-label="Apply identity"\]', `\$\{label\}-apply`, `\(window\.__p015R7Seq\?\.started \?\? 0\) > \$\{beforeSwitch\}`\)/);
    expect(script).toMatch(/clickUntil\("\.pc-identities__actions button", `\$\{label\}-review`, `\(window\.__p015R7Seq\?\.started \?\? 0\) > \$\{beforePreview\}`\)/);
  });

  it("matches a response by its start sequence, so an earlier orphaned request cannot pin the wait", () => {
    // Each recorded response carries the sequence number it was given when it LEFT ...
    expect(script).toContain("net.calls.push({ seq,");
    // ... and the wait selects responses newer than the baseline, never an array-length count,
    // which an orphaned earlier request (started, never answered) makes unsatisfiable.
    expect(script).toContain("c.seq > ${before} && c.request?.action === ${JSON.stringify(action)}");
    expect(script).not.toMatch(/calls\.length \?\? 0\) > \$\{before\}/);
  });

  it("appliesLayer only accepts a NEW applied event whose stack carries the layer", () => {
    const row = { id: 10, phase: "applied", stack_refs: ["domain:research-steward", "fleet-posture:su.fleet-leader"] };
    expect(appliesLayer(row, "domain:research-steward", 9)).toBe(true);
    expect(appliesLayer(row, "domain:research-steward", 10)).toBe(false);
    expect(appliesLayer({ ...row, phase: "desired" }, "domain:research-steward", 9)).toBe(false);
    expect(appliesLayer(row, "domain:papercusp-engineer", 9)).toBe(false);
    expect(appliesLayer({ ...row, stack_refs: null }, "domain:research-steward", 9)).toBe(false);
  });
});
