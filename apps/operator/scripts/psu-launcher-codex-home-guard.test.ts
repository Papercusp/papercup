/**
 * psu-launcher-codex-home-guard.test.ts (WI-38706) — recurrence guards for the class
 * "a codex RESUME comes up against a CODEX_HOME whose config.toml no longer carries
 * the provider the rollout is bound to".
 *
 * The outage this pins (owner-hit 2026-08-14, 11 homes / 89 rollouts):
 *   1. session-archive collected the codex home's SHARED config.toml under whichever
 *      session ended first, then unlinked it — killing every sibling thread in that
 *      home. (Pinned on the archive side in session-archive.test.ts.)
 *   2. codex then re-created an 87-byte trust-only stub on the next launch. It LOOKS
 *      like a config and carries neither the gateway provider nor the coordination
 *      MCP server — so the resume either died with
 *      "Model provider `papercusp-codex-gateway` not found" (-32600) or, worse, came
 *      up quietly with NO coordination MCP at all.
 *   3. The launcher's own gateway patch made it unrecoverable: a DEFAULT-mode resume
 *      produces an empty patch, and the old code took that to mean "strip the gateway
 *      block" — deleting the provider table out from under a gateway-born thread.
 *
 * So the three functions below are the resume leg's whole defence, and each fails
 * SILENTLY (a wrong boolean, an unchanged-looking file) rather than throwing. They are
 * pinned here because none of them is exercised by a typechecker.
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-launcher-codex-home-guard.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexGatewayConfigPatch,
  codexRolloutModelProvider,
  isCodexHomeLaunchReady,
} from './psu-launcher.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'psu-codex-guard-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** What psu writes into a managed home (shape only — the markers are what matter). */
const REAL_CONFIG = `# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT
model_provider = "papercusp-codex-gateway"
# END PAPERCUSP_CODEX_GATEWAY_ROOT

[mcp_servers.papercusp-su]
command = "npx"

# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER
[model_providers.papercusp-codex-gateway]
name = "Papercusp gateway"
base_url = "http://127.0.0.1:3070/api/codex-gateway"
# END PAPERCUSP_CODEX_GATEWAY_PROVIDER
`;

/** What codex itself re-creates after the config is unlinked (the 87-byte stub). */
const CODEX_STUB = `[projects."${join(homedir(), 'workspace', 'repo')}"]
trust_level = "trusted"
`;

function managedHooks(owner: string, includeLifecycle = true) {
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              command: `PAPERCUSP_LOCK_SID='${owner}' PAPERCUSP_SID='${owner}' lock.sh`,
            },
          ],
        },
      ],
      ...(includeLifecycle
        ? {
            SessionStart: [
              {
                hooks: [
                  { command: `PAPERCUSP_SID='${owner}' lifecycle-report.sh` },
                ],
              },
            ],
            SessionEnd: [
              {
                hooks: [
                  { command: `PAPERCUSP_SID='${owner}' lifecycle-report.sh` },
                ],
              },
            ],
          }
        : {}),
    },
  };
}

describe('isCodexHomeLaunchReady — a codex-written stub must NOT read as a usable home', () => {
  it('true for a real papercusp home (has the coordination MCP block)', () => {
    writeFileSync(join(dir, 'config.toml'), REAL_CONFIG);
    expect(isCodexHomeLaunchReady(dir)).toBe(true);
  });

  it('FALSE for the trust-only stub codex writes after the config is deleted', () => {
    writeFileSync(join(dir, 'config.toml'), CODEX_STUB);
    // The stub is a plausible-looking config.toml; existence is NOT the test.
    expect(isCodexHomeLaunchReady(dir)).toBe(false);
  });

  it('FALSE when config.toml is absent entirely (the state the archiver left behind)', () => {
    expect(isCodexHomeLaunchReady(dir)).toBe(false);
  });

  it('FALSE for a config that routes the gateway but never registers the MCP server', () => {
    // The dangerous middle case: the resume SUCCEEDS and the agent comes up with no
    // coordination tools — no error anywhere. The MCP block is what separates them.
    writeFileSync(
      join(dir, 'config.toml'),
      '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT\nmodel_provider = "papercusp-codex-gateway"\n# END PAPERCUSP_CODEX_GATEWAY_ROOT\n',
    );
    expect(isCodexHomeLaunchReady(dir)).toBe(false);
  });

  it('FALSE for a null/empty home rather than throwing', () => {
    expect(isCodexHomeLaunchReady(null)).toBe(false);
    expect(isCodexHomeLaunchReady('')).toBe(false);
  });

  it('FALSE for a structurally ready home whose config/hooks/diagnostics belong to a prior owner', () => {
    const oldOwner = 'su-old-owner';
    const currentOwner = 'su-current-owner';
    writeFileSync(
      join(dir, 'config.toml'),
      `${REAL_CONFIG}\n[mcp_servers.papercusp-su]\nurl = "http://x/api/mcp?superuser=1&client=${oldOwner}"\n`,
    );
    writeFileSync(
      join(dir, 'papercusp-diagnostics.json'),
      JSON.stringify({ lockOwnerSid: oldOwner }),
    );
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify(managedHooks(oldOwner)),
    );

    expect(isCodexHomeLaunchReady(dir, currentOwner)).toBe(false);
    expect(isCodexHomeLaunchReady(dir, oldOwner)).toBe(true);

    writeFileSync(
      join(dir, 'config.toml'),
      `${REAL_CONFIG}\n[mcp_servers.papercusp-su]\nurl = "http://x/api/mcp?superuser=1&client=${currentOwner}"\n`,
    );
    writeFileSync(
      join(dir, 'papercusp-diagnostics.json'),
      JSON.stringify({ lockOwnerSid: currentOwner }),
    );
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify(managedHooks(currentOwner)),
    );
    expect(isCodexHomeLaunchReady(dir, currentOwner)).toBe(true);
  });

  it("FALSE for a same-owner pre-WI-41305 home that omits SessionStart/SessionEnd", () => {
    const owner = "su-lifecycle-gap";
    writeFileSync(
      join(dir, "config.toml"),
      `${REAL_CONFIG}\n[mcp_servers.papercusp-su]\nurl = "http://x/api/mcp?superuser=1&client=${owner}"\n`,
    );
    writeFileSync(
      join(dir, "papercusp-diagnostics.json"),
      JSON.stringify({ lockOwnerSid: owner }),
    );
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify(managedHooks(owner, false)),
    );

    expect(isCodexHomeLaunchReady(dir, owner)).toBe(false);
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify(managedHooks(owner, true)),
    );
    expect(isCodexHomeLaunchReady(dir, owner)).toBe(true);
  });
});

describe('codexGatewayConfigPatch — a default-mode RESUME must not strip a bound provider', () => {
  // An empty patch (no account pin, gateway off) means "this LAUNCH has no gateway
  // route". It does NOT mean "this HOME has no gateway thread".

  it('keepExistingWhenUnrouted: leaves a gateway-born config byte-identical', () => {
    const out = codexGatewayConfigPatch(REAL_CONFIG, null, {
      gatewayOn: false,
      keepExistingWhenUnrouted: true,
    });
    expect(out).toBe(REAL_CONFIG);
    expect(out).toContain('[model_providers.papercusp-codex-gateway]');
  });

  it('WITHOUT the flag the provider table is stripped — the pre-fix behaviour, kept for a fresh launch', () => {
    const out = codexGatewayConfigPatch(REAL_CONFIG, null, { gatewayOn: false });
    expect(out).not.toContain('[model_providers.papercusp-codex-gateway]');
    // non-papercusp content survives either way
    expect(out).toContain('[mcp_servers.papercusp-su]');
  });

  it('a real route still rewrites the block even when keepExistingWhenUnrouted is set', () => {
    // The flag is a floor, not a freeze: an ACTIVE route must still be applied.
    const out = codexGatewayConfigPatch(REAL_CONFIG, null, {
      gatewayOn: true,
      ownerId: 'su-test',
      keepExistingWhenUnrouted: true,
    });
    expect(out).toContain('[model_providers.papercusp-codex-gateway]');
    expect(out).toContain('# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER');
    expect(out).toContain('[mcp_servers.papercusp-su]');
  });

  it('keepExistingWhenUnrouted on an EMPTY config yields empty (nothing to preserve)', () => {
    expect(codexGatewayConfigPatch('', null, { gatewayOn: false, keepExistingWhenUnrouted: true })).toBe('');
  });
});

describe('codexRolloutModelProvider — reads the binding the resume must honour', () => {
  const rollout = (line: unknown) => {
    const p = join(dir, 'rollout.jsonl');
    writeFileSync(p, `${JSON.stringify(line)}\n{"type":"message"}\n`);
    return p;
  };

  it('returns the provider id stamped into session_meta on line 1', () => {
    const p = rollout({ type: 'session_meta', payload: { model_provider: 'papercusp-codex-gateway' } });
    expect(codexRolloutModelProvider(p)).toBe('papercusp-codex-gateway');
  });

  it('returns null for a rollout with no provider binding (a default-route thread)', () => {
    expect(codexRolloutModelProvider(rollout({ type: 'session_meta', payload: { cwd: '/x' } }))).toBe(null);
  });

  it('returns null — never throws — on an unreadable or non-JSON rollout', () => {
    expect(codexRolloutModelProvider(join(dir, 'does-not-exist.jsonl'))).toBe(null);
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, 'not json at all\n');
    expect(codexRolloutModelProvider(bad)).toBe(null);
    // a truncated single line with no trailing newline must not hang or throw
    const partial = join(dir, 'partial.jsonl');
    writeFileSync(partial, '{"type":"session_meta","payload":{"model_provider":"papercusp-codex-gateway"}}');
    expect(codexRolloutModelProvider(partial)).toBe('papercusp-codex-gateway');
  });

  it('reads only the FIRST line — a later line cannot re-bind the thread', () => {
    const p = join(dir, 'two.jsonl');
    writeFileSync(
      p,
      `${JSON.stringify({ type: 'session_meta', payload: { model_provider: 'papercusp-codex-gateway' } })}\n` +
        `${JSON.stringify({ type: 'session_meta', payload: { model_provider: 'something-else' } })}\n`,
    );
    expect(codexRolloutModelProvider(p)).toBe('papercusp-codex-gateway');
  });
});

describe('the composed invariant: a stub home + a bound rollout is DETECTABLE and RECOVERABLE', () => {
  it('stub home reads not-ready while its rollout still names the gateway provider', () => {
    // This exact pair is what 11 homes were in. The launcher must see BOTH:
    // not-ready (⇒ rebuild the home) and a bound provider (⇒ require the gateway
    // table in the rebuild, and never strip it afterwards).
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'config.toml'), CODEX_STUB);
    const p = join(dir, 'sessions', 'rollout-2026-08-14T01-00-00-abc.jsonl');
    writeFileSync(
      p,
      `${JSON.stringify({ type: 'session_meta', payload: { model_provider: 'papercusp-codex-gateway' } })}\n`,
    );

    expect(isCodexHomeLaunchReady(dir)).toBe(false);
    expect(codexRolloutModelProvider(p)).toBe('papercusp-codex-gateway');
    // and once rebuilt, a default-mode resume must not undo the rebuild
    writeFileSync(join(dir, 'config.toml'), REAL_CONFIG);
    expect(isCodexHomeLaunchReady(dir)).toBe(true);
    expect(
      codexGatewayConfigPatch(REAL_CONFIG, null, { gatewayOn: false, keepExistingWhenUnrouted: true }),
    ).toContain('[model_providers.papercusp-codex-gateway]');
  });
});
