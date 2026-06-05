/**
 * DOCUMENTING test for the ROLE-path SID-binding bug — issue EI-4.
 *
 * Status: CONFIRMED (read-only audit, 2026-06-04). Filed as EI-4.
 * NOT fixed here — the binding code (bootstrap-role.ts / role-launch-spec.ts /
 * role-codex-home.ts) is owned by in-flight federation work (su-584a8), so
 * this file only DOCUMENTS the desired contract via `it.todo` + a
 * `describe.skip` of the would-be assertions. Nothing here runs/fails CI.
 *
 * The bug (see EI-4 for the full writeup + file:line evidence):
 *   - bootstrap-role.ts mints `sid = role-<uuid>` and exports it as
 *     `envelopeEnv.PAPERCUSP_SID` (the lock-hook + coord owner), but
 *   - buildRoleLaunchSpec signs the MCP URL with NO `client=` (the sid is
 *     never passed in), and
 *   - writeRoleCodexHome takes no sid and calls writeCodexLockHooks() with no
 *     coordSid — so the codex role home bakes neither `&client=` nor
 *     PAPERCUSP_SID.
 *   ⇒ a role session's lock-hook owner (role-<uuid>) and its MCP-call owner
 *     (signed-spawn-derived, no client) DIVERGE — the self-deadlock class the
 *     SU path eliminated by binding all three to one sid (P-022).
 *
 * The DESIRED contract (what the SU path already does, role should too):
 *   role MCP url `client=` === envelopeEnv.PAPERCUSP_SID === the codex-home
 *   baked client.
 *
 * Proposed fix (in EI-4): thread the minted sid into buildRoleLaunchSpec's
 * signed params (`client=<sid>`) and into writeRoleCodexHome (bake the same
 * client + pass it as coordSid to writeCodexLockHooks).
 */
import { describe, expect, it } from 'vitest';

// ── The contract we WANT (kept as a runnable spec once EI-4 lands) ─────────
// Tracking: EI-4 — un-skip + flesh out when the federation owner threads the
// sid through buildRoleLaunchSpec + writeRoleCodexHome.
describe.skip('role launch: PAPERCUSP_SID is bound across hook/MCP/codex-home (EI-4 — desired contract)', () => {
  it('the signed role MCP url carries client === the minted PAPERCUSP_SID', () => {
    // Once buildRoleLaunchSpec accepts + signs `client=<sid>`:
    //   const sid = bootstrapResult.envelopeEnv.PAPERCUSP_SID;
    //   expect(new URL(spec.mcpUrl).searchParams.get('client')).toBe(sid);
    expect(true).toBe(true); // placeholder — un-skip with the real assertion
  });

  it('the codex role home bakes the same client (config.toml url client= === PAPERCUSP_SID)', () => {
    // Once writeRoleCodexHome bakes `&client=<sid>` like writeSuCodexHome:
    //   expect(readFileSync(configPath,'utf8')).toContain(`client=${sid}`);
    expect(true).toBe(true);
  });

  it('the codex role home coord/lock hook bakes PAPERCUSP_SID === the MCP client', () => {
    // Once writeRoleCodexHome calls writeCodexLockHooks(home, sid):
    //   expect(JSON.stringify(hooks)).toContain(`PAPERCUSP_SID='${sid}'`);
    expect(true).toBe(true);
  });
});

// ── Explicit todos so the gap stays visible in the test report ─────────────
// EI-4: role-path SID binding (lock-hook owner === MCP client === codex-home client).
it.todo(
  'EI-4: buildRoleLaunchSpec should accept the session sid and sign it as client= on the role MCP url',
);
it.todo(
  'EI-4: writeRoleCodexHome should take the sid and bake it as the config.toml url client= (parity with writeSuCodexHome)',
);
it.todo(
  'EI-4: bootstrap-role should mint sid before the spec and pass it to both buildRoleLaunchSpec + writeRoleCodexHome so PAPERCUSP_SID === url client= === codex-home baked client',
);
