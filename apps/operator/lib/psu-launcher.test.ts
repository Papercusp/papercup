import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, symlinkSync, lstatSync, realpathSync, readlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs,
  planValue,
  parkRoleScopedMcpJson,
  ompDefaultModelAdvisory,
  ompDefaultModel,
  writeOmpSessionConfigDir,
  applyOmpToolsAllowlist,
  applyOmpOperatorOrigin,
  applyOmpMcpUrlParams,
  ompCoreToolNames,
  claudeSeedToolNames,
  CLAUDE_SEED_EXTRA_TOOL_NAMES,
  isWeakOmpModel,
  OMP_CORE_MCP_TOOL_NAMES,
  SU_CONTEXT_CHOICES,
  SU_CONTEXT_DEFAULT,
  SU_CONTEXT_TOKEN_ESTIMATES,
  selectionsFromArgs,
  presetsFromArgs,
  resumeArgsFor,
  resumeEnvFor,
  resumeAccountPlan,
  buildResumeEnv,
  rehealResumeCredentials,
  claudeCredExpiresAt,
  gatewayPinEnv,
  gatewayAutoEnv,
  accountRoutingMode,
  codexGatewayConfigPatch,
  accountPinnable,
  accountProviderFromChoices,
  GATEWAY_ACCOUNT_HEADER,
  addDirArgs,
  forkUnsupportedMessage,
  forkBootstrapBody,
  trackedForkEnvelopeEnv,
  freshSuBootstrapBody,
  psuLaunchArgvRecord,
  effectiveAutoMode,
  assertFleetJoined,
  roleBootstrapBody,
  forkSeedPaths,
  findUntrackedSession,
  findTrackedCodexHomeRollout,
  sessionOwnersRoot,
  recordSessionOwner,
  recoverSessionOwner,
  nativeSessionIdFromLaunchArgs,
  mintRecycleArgs,
  claudeStoreHasSession,
  sessionHasTranscript,
  sessionTranscriptFile,
  lastActiveModelFor,
  modelArgsFor,
  reportSessionEnded,
  reportSessionResumed,
  tryRematerializeFromArchive,
  roleLaunchArgs,
  suLaunchArgs,
  kickoffPositionalArgs,
  tagKickoffProvenance,
  resolveKickoffText,
  resumeKickoffText,
  agentInvalidForRole,
  suWrapperExtraArgs,
  usePtyHost,
  PTY_DEFAULT_ON,
  AGENTS,
  NO_PLAN,
  NATIVE_SCHEDULER_DENY_FLAG,
  NO_SUBAGENTS_DENY_FLAG,
  BRAIN_TOMBSTONE_MESSAGE,
  fetchWithResilience,
  resolveFallbackOperatorTargets,
  resolveOperatorUrl,
  resolveOperatorTarget,
  readToken,
  claudeOAuthTokenPath,
  readStoredClaudeOAuthToken,
  applyDefaultClaudeOAuthToken,
  applyGithubTokenEnv,
  storeClaudeOAuthToken,
  fleetSlugFromName as launcherFleetSlugFromName,
  hexToRgb,
  colorSwatch,
  schemeNameInAccent,
  assertLaunchPersona,
  preflightWindowGuard,
  runLaunchPreflight,
  normalizeModelSpec,
  validateModelSpec,
  cloudModelBackendHint,
  validateAgentModelPair,
  autoCompactWindowEnv,
  isFleetMemberLaunch,
  COMPACTION_LIMIT_1M_LEADER,
  COMPACTION_LIMIT_1M_FLEET_MEMBER,
  setupReminderLines,
  AGENT_LABELS,
  whichBin,
  wellKnownBackendBin,
  startSupervisorBeat,
} from '../scripts/psu-launcher.mjs';
import { nativeSchedulerDenyFlag } from '@papercusp/orchestrator/native-scheduler-deny';
import { noSubagentToolsDenyFlag } from '@papercusp/orchestrator/no-subagent-deny';
import { ACCOUNT_HEADER } from '@papercusp/operator-core/lib/inference-gateway/gateway';
import { fleetSlugFromName as storeFleetSlugFromName } from '@papercusp/operator-core/lib/agent-fleets-store';
// WI-1993: the operator-core TS TWIN of validateModelSpec (node can't import the .mjs, so the
// tool boundary carries its own copy). The parity suite below pins them value-for-value.
import { validateCloudModelSpec } from '@papercusp/operator-core/lib/agent-config-constants';
// EI-7138: the operator-core TS TWIN of suWrapperExtraArgs's model:effort → CLI-flag mapping
// (same psu-launcher.mjs / operator-core import-boundary constraint as WI-1993 above — the
// mapping is duplicated by necessity, not oversight). The parity suite below pins them
// value-for-value so a fix landed in one (the codex effort-drop, found 2026-07-03) can never
// again silently miss the other.
import { applyRoleModel } from '@papercusp/operator-core/lib/harness-invoke-once';
// weak-model-tool-tier: the canonical core spine — the psu-launcher.mjs inlined copy
// (OMP_CORE_MCP_TOOL_NAMES) is its omp/weak-model VARIANT: identical except it adds
// fleet:launch-on-plan (drift guard below). (The old second divergence — dropping the
// granular lock tools — became a no-op when the 2026-07-05 rebalance cut them from the
// canonical list too.)
import { CORE_MCP_TOOL_NAMES } from '@papercusp/orchestrator';

describe('backend-not-installed helpers (owner req 2026-07-06 — psu prompt-to-install)', () => {
  it('AGENT_LABELS names all three backends', () => {
    expect(AGENT_LABELS.claude).toMatch(/Claude/);
    expect(AGENT_LABELS.codex).toMatch(/Codex/);
    expect(AGENT_LABELS.omp).toMatch(/oh-my-pi/);
  });

  it('whichBin returns null for a binary that cannot exist', () => {
    expect(whichBin('definitely-not-a-real-binary-xyz-123')).toBeNull();
  });

  it('wellKnownBackendBin finds a bin the setup flow installed under a known path', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-wk-'));
    try {
      // omp installer target on unix: ~/.local/bin/omp
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      writeFileSync(join(home, '.local', 'bin', 'omp'), '#!/bin/sh\n');
      expect(wellKnownBackendBin('omp', { home, env: {} })).toBe(join(home, '.local/bin/omp'));
      // codex installer target: ~/.papercusp/runtime/node_modules/.bin/codex
      mkdirSync(join(home, '.papercusp', 'runtime', 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(home, '.papercusp', 'runtime', 'node_modules', '.bin', 'codex'), '');
      expect(wellKnownBackendBin('codex', { home, env: {} })).toBe(
        join(home, '.papercusp/runtime/node_modules/.bin/codex'),
      );
      // nothing installed → null
      expect(wellKnownBackendBin('claude', { home, env: {} })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('wellKnownBackendBin honors %USERPROFILE% for the Windows omp path', () => {
    const winHome = mkdtempSync(join(tmpdir(), 'psu-win-'));
    try {
      mkdirSync(join(winHome, '.papercusp', 'bin'), { recursive: true });
      writeFileSync(join(winHome, '.papercusp', 'bin', 'omp.exe'), '');
      // home has no omp; USERPROFILE does → resolves via the winHome candidate
      const home = mkdtempSync(join(tmpdir(), 'psu-home-'));
      try {
        expect(wellKnownBackendBin('omp', { home, env: { USERPROFILE: winHome } })).toBe(
          join(winHome, '.papercusp', 'bin', 'omp.exe'),
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(winHome, { recursive: true, force: true });
    }
  });
});

describe('tagKickoffProvenance (turn-provenance-owner-vs-agent-2026-07-11 P-002)', () => {
  let provDir: string;
  beforeEach(() => {
    provDir = mkdtempSync(join(tmpdir(), 'kickoff-prov-'));
  });
  afterEach(() => {
    rmSync(provDir, { recursive: true, force: true });
  });
  const envFor = () => ({ PAPERCUSP_TURN_PROVENANCE_DIR: provDir }) as NodeJS.ProcessEnv;

  it('prefixes the fleet-kickoff envelope and writes the ledger row FIRST (lockstep JSONL shape)', () => {
    const tagged = tagKickoffProvenance('Begin: advance this plan.', 'su-kick-1', envFor(), 1_760_000_000_000);
    expect(tagged).toMatch(/^⟦turn-origin:fleet-kickoff nonce:[a-f0-9]{16}⟧\nBegin: advance this plan\.$/);
    const raw = readFileSync(join(provDir, 'su-kick-1.jsonl'), 'utf8').trim();
    const row = JSON.parse(raw);
    expect(row).toMatchObject({ sid: 'su-kick-1', origin: 'fleet-kickoff', ts: 1_760_000_000_000 });
    expect(row.nonce).toMatch(/^[a-f0-9]{16}$/);
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(tagged).toContain(row.nonce); // the typed envelope references the ledger row
  });

  it('no sid (interactive/untracked launch) → untagged text, no ledger write', () => {
    expect(tagKickoffProvenance('hello', null, envFor())).toBe('hello');
    expect(existsSync(join(provDir, 'unknown.jsonl'))).toBe(false);
  });

  it('fail-soft: an unwritable ledger dir still returns the untagged text (never a broken launch)', () => {
    // ⚠ NEVER '/proc/…' here: node 25's recursive mkdirSync retries /proc's
    // EPERM forever (wedged every gate for hours on 2026-07-11). A plain file
    // as the path's parent throws ENOTDIR instantly instead.
    const plainFile = join(provDir, 'plain-file');
    writeFileSync(plainFile, 'x');
    const env = { PAPERCUSP_TURN_PROVENANCE_DIR: join(plainFile, 'sub') } as NodeJS.ProcessEnv;
    expect(tagKickoffProvenance('hello', 'su-kick-2', env)).toBe('hello');
  });

  it('sanitizes the sid into the ledger filename', () => {
    tagKickoffProvenance('x', 'su/../evil id', envFor());
    expect(existsSync(join(provDir, 'su_.._evil_id.jsonl'))).toBe(true);
  });
});

describe('kickoffPositionalArgs (EI-5503 plan auto-kickoff)', () => {
  const KICK =
    'Begin: advance this plan. Read the `## Now` block, pick up the next actionable item, and work it.';
  it('seeds the kickoff for a scripted (--no-picker) plan launch', () => {
    const res = { kickoffPrompt: KICK, planSlug: 'p' };
    const args = parseArgs(['--no-picker', '--agent=claude', '--harness=x', '--plan=p']);
    expect(kickoffPositionalArgs(res, args)).toEqual([KICK]);
  });
  it('is empty for an interactive picker launch (picker !== false)', () => {
    const res = { kickoffPrompt: KICK, planSlug: 'p' };
    expect(kickoffPositionalArgs(res, parseArgs([]))).toEqual([]);
  });
  it('is empty when --no-kickoff opts out', () => {
    const res = { kickoffPrompt: KICK, planSlug: 'p' };
    const args = parseArgs(['--no-picker', '--agent=claude', '--harness=x', '--plan=p', '--no-kickoff']);
    expect(args.kickoff).toBe(false);
    expect(kickoffPositionalArgs(res, args)).toEqual([]);
  });
  it('is empty when the server supplied no kickoff (no plan bound)', () => {
    const args = parseArgs(['--no-picker', '--agent=claude', '--harness=x']);
    expect(kickoffPositionalArgs({ kickoffPrompt: null }, args)).toEqual([]);
    expect(kickoffPositionalArgs({}, args)).toEqual([]);
  });
  it('default parse has no kickoff key (so the gate treats it as enabled)', () => {
    expect(parseArgs([]).kickoff).toBeUndefined();
  });

  // Free-form --kickoff (the general, plan-independent first-turn seam used by the
  // desktop tutorial's docs-agent launcher).
  it('a free-form --kickoff seeds the first turn with NO plan bound', () => {
    const args = parseArgs(['--no-picker', '--agent=claude', '--kickoff=answer this: what is a pot?']);
    expect(args.kickoffPromptText).toBe('answer this: what is a pot?');
    expect(kickoffPositionalArgs({}, args)).toEqual(['answer this: what is a pot?']);
  });
  it('--kickoff wins over the server plan-derived kickoff', () => {
    const args = parseArgs(['--no-picker', '--agent=claude', '--kickoff=my question']);
    expect(kickoffPositionalArgs({ kickoffPrompt: KICK, planSlug: 'p' }, args)).toEqual(['my question']);
  });
  it('--kickoff still respects --no-picker (interactive picker → empty) and --no-kickoff', () => {
    expect(kickoffPositionalArgs({}, parseArgs(['--agent=claude', '--kickoff=q']))).toEqual([]); // picker launch
    expect(
      kickoffPositionalArgs({}, parseArgs(['--no-picker', '--agent=claude', '--kickoff=q', '--no-kickoff'])),
    ).toEqual([]);
  });
});

// resolveKickoffText — the SPAWN-SAFE env fallback the desktop docs-agent launcher
// relies on (a free-form question rides PAPERCUSP_KICKOFF_PROMPT, not a --kickoff arg,
// so it survives buildConsoleOneliner's greeting escaping instead of breaking the shell).
describe('resolveKickoffText (PAPERCUSP_KICKOFF_PROMPT env fallback)', () => {
  it('falls back to PAPERCUSP_KICKOFF_PROMPT when no --kickoff flag was parsed', () => {
    const args = parseArgs(['--no-picker', '--agent=claude', '--label=docs-tutor']);
    expect(args.kickoffPromptText).toBeNull();
    const env = { PAPERCUSP_KICKOFF_PROMPT: "what's a pot?\nline two" };
    expect(resolveKickoffText(args, env)).toBe("what's a pot?\nline two");
    // and it actually seeds the first turn once threaded through kickoffPositionalArgs
    expect(kickoffPositionalArgs({}, { ...args, kickoffPromptText: resolveKickoffText(args, env) })).toEqual([
      "what's a pot?\nline two",
    ]);
  });
  it('an explicit --kickoff flag wins over the env var', () => {
    const args = parseArgs(['--no-picker', '--agent=claude', '--kickoff=flag wins']);
    expect(resolveKickoffText(args, { PAPERCUSP_KICKOFF_PROMPT: 'env loses' })).toBe('flag wins');
  });
  it('returns null when neither the flag nor the env var is set', () => {
    const args = parseArgs(['--no-picker', '--agent=claude']);
    expect(resolveKickoffText(args, {})).toBeNull();
  });
});

// resumeKickoffText — the RESUME/FORK first turn (agent-launch-resume-primitives
// P-011/D-008). A resumed session has no positional-prompt seam and is unreachable
// through the roster (its presence rows were reaped at death), so this text is handed
// to the managed-pty host, which injects it once the child settles at its prompt.
describe('resumeKickoffText (P-011: the first turn of a scripted resume/fork)', () => {
  it('takes the --kickoff flag on a scripted resume', () => {
    const args = parseArgs(['--no-picker', '--resume=sid-1', '--account=default', '--kickoff=carry on']);
    expect(resumeKickoffText(args, {})).toBe('carry on');
  });

  it('takes the spawn-safe PAPERCUSP_KICKOFF_PROMPT env when no flag was passed', () => {
    const args = parseArgs(['--no-picker', '--resume=sid-1']);
    expect(resumeKickoffText(args, { PAPERCUSP_KICKOFF_PROMPT: 'multi\nline brief' })).toBe('multi\nline brief');
  });

  it('does NOT seed an interactive (picker) resume — a human opens at an empty prompt', () => {
    const args = parseArgs(['--resume=sid-1', '--kickoff=q']);
    expect(resumeKickoffText(args, {})).toBeNull();
  });

  it('honors --no-kickoff', () => {
    const args = parseArgs(['--no-picker', '--resume=sid-1', '--kickoff=q', '--no-kickoff']);
    expect(resumeKickoffText(args, {})).toBeNull();
  });

  it('is null when nothing asked for a kickoff (a resume opens idle, as before)', () => {
    expect(resumeKickoffText(parseArgs(['--no-picker', '--resume=sid-1']), {})).toBeNull();
  });

  it('never falls back to a server plan kickoff — a resume does no bootstrap POST', () => {
    // kickoffPositionalArgs' res.kickoffPrompt leg must not leak into the resume path.
    const planKickoff = 'Begin: advance this plan';
    const args = parseArgs(['--no-picker', '--resume=sid-1']);
    expect(resumeKickoffText(args, {})).toBeNull();
    expect(kickoffPositionalArgs({ kickoffPrompt: planKickoff, planSlug: 'p' }, args)).toEqual([planKickoff]);
  });
});

describe('parkRoleScopedMcpJson (P-002 SU-omp role-MCP leak guard)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'psu-park-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const mcp = () => join(dir, '.mcp.json');
  const parked = () => join(dir, '.mcp.json.su-parked');

  it('parks a role-scoped .mcp.json (signed role= URL) and removes the original', () => {
    writeFileSync(mcp(), JSON.stringify({ mcpServers: { papercusp: { type: 'http', url: 'http://127.0.0.1:9071/api/mcp?workspace=ws&role=planner&sig=abc&exp=1' } } }));
    expect(parkRoleScopedMcpJson(dir)).toBe(parked());
    expect(existsSync(mcp())).toBe(false);
    expect(existsSync(parked())).toBe(true);
  });

  it('leaves a superuser (non-role) .mcp.json untouched', () => {
    writeFileSync(mcp(), JSON.stringify({ mcpServers: { 'papercusp-su': { type: 'http', url: 'http://localhost:3070/api/mcp?superuser=1&client=x' } } }));
    expect(parkRoleScopedMcpJson(dir)).toBe(null);
    expect(existsSync(mcp())).toBe(true);
  });

  it('no-op when there is no .mcp.json', () => {
    expect(parkRoleScopedMcpJson(dir)).toBe(null);
  });

  it('overwrites a stale prior park instead of failing', () => {
    writeFileSync(parked(), 'STALE');
    writeFileSync(mcp(), JSON.stringify({ mcpServers: { p: { url: 'http://h/api/mcp?role=sentinel&sig=z' } } }));
    expect(parkRoleScopedMcpJson(dir)).toBe(parked());
    expect(existsSync(mcp())).toBe(false);
  });

  it('leaves an unparseable .mcp.json untouched (never throws)', () => {
    writeFileSync(mcp(), 'not json{');
    expect(parkRoleScopedMcpJson(dir)).toBe(null);
    expect(existsSync(mcp())).toBe(true);
  });
});

describe('ompDefaultModelAdvisory (P-004 first-turn overflow guard)', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-cfg-')); mkdirSync(join(home, '.omp', 'agent'), { recursive: true }); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const writeCfg = (s: string) => writeFileSync(join(home, '.omp', 'agent', 'config.yml'), s);

  it('advises when the default role is a local ollama model', () => {
    writeCfg('modelRoles:\n  default: ollama/ornith:fast\n  slow: anthropic/claude-opus-4-6:high\n');
    expect(ompDefaultModelAdvisory(home)).toMatch(/ollama\/ornith:fast/);
  });
  it('no advisory when the default is a gateway/anthropic model', () => {
    writeCfg('modelRoles:\n  default: papercusp-gateway/claude-sonnet-4-6\n');
    expect(ompDefaultModelAdvisory(home)).toBe(null);
  });
  it('no advisory when config.yml is absent', () => {
    rmSync(join(home, '.omp', 'agent', 'config.yml'), { force: true });
    expect(ompDefaultModelAdvisory(home)).toBe(null);
  });
});

describe('SU_CONTEXT_CHOICES (WI-1282 su-context-size-variants — terminal picker prompt)', () => {
  it('offers exactly Native/Full/Trimmed with the flag values, Native ⇒ null', () => {
    expect(SU_CONTEXT_CHOICES.map((c) => c.value)).toEqual([null, 'full', 'trimmed']);
    // The Native option maps to null so the picker emits NO --context-size flag —
    // a byte-identical launch to the pre-feature behavior (the key non-regression).
    const native = SU_CONTEXT_CHOICES[0];
    expect(native.value).toBeNull();
    expect(native.name).toMatch(/native/i);
  });

  it('labels embed the token estimates, in parity with the operator UI', () => {
    const full = SU_CONTEXT_CHOICES.find((c) => c.value === 'full')!;
    const trimmed = SU_CONTEXT_CHOICES.find((c) => c.value === 'trimmed')!;
    expect(full.name).toContain(SU_CONTEXT_TOKEN_ESTIMATES.full);
    expect(trimmed.name).toContain(SU_CONTEXT_TOKEN_ESTIMATES.trimmed);
    // Same measured figures the UI's SU_CONTEXT_OPTIONS shows (AdvSessionsClient.tsx).
    // Re-measured 2026-07-02 post-Phase-3: 60.1k sonnet-fleet / ~76k power boot
    // (the P-018 '~83k' was pre-Phase-3, full persona).
    expect(SU_CONTEXT_TOKEN_ESTIMATES).toEqual({ full: '~180k', trimmed: '~70k' });
  });

  it('picker values are a subset of the --context-size flag values parseArgs accepts', () => {
    // Guards drift between the interactive picker and the flag path: every non-null
    // picker value must be a value parseArgs(--context-size=…) yields.
    for (const c of SU_CONTEXT_CHOICES) {
      if (c.value === null) continue;
      expect(parseArgs([`--context-size=${c.value}`]).contextSize).toBe(c.value);
    }
  });

  it('defaults the picker selection to Trimmed, not Native or Full', () => {
    // The tool catalogue the picker highlights by default: neither the full
    // up-front catalog nor each client's native (no-flag) behavior, but the
    // trimmed core-spine + native-soft-trim variant.
    expect(SU_CONTEXT_DEFAULT).toBe('trimmed');
    expect(SU_CONTEXT_CHOICES.some((c) => c.value === SU_CONTEXT_DEFAULT)).toBe(true);
    const defaultChoice = SU_CONTEXT_CHOICES.find((c) => c.value === SU_CONTEXT_DEFAULT)!;
    expect(defaultChoice.name).toMatch(/trimmed/i);
    expect(defaultChoice.name).toMatch(/default/i);
  });
});

describe('writeOmpSessionConfigDir (WI-1282 + weak-model-tool-tier — OMP per-session config)', () => {
  let home: string;
  const AGENT_CFG = [
    'agent:',
    '  discoveryMode: mcp-only',
    'tools:',
    '  discoveryMode: true',
    'modelRoles:',
    '  default: papercusp-gateway/claude-sonnet-4-6',
    '',
  ].join('\n');
  const MCP_JSON = JSON.stringify({
    mcpServers: {
      'papercusp-su': {
        type: 'http',
        url: 'http://localhost:3070/api/mcp?superuser=1&client=abc',
        headers: { Authorization: 'Bearer SECRET' },
      },
    },
  });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'psu-ompcfg-'));
    mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
    writeFileSync(join(home, '.omp', 'agent', 'config.yml'), AGENT_CFG);
    writeFileSync(join(home, '.omp', 'agent', 'auth.json'), '{"token":"AUTHSECRET"}');
    writeFileSync(join(home, '.omp', 'agent', 'models.yml'), 'providers:\n  ollama:\n    baseUrl: http://127.0.0.1:11435/v1\n');
    writeFileSync(join(home, '.omp', 'agent', 'models.db'), 'BINARYREGISTRY');
    writeFileSync(join(home, '.omp', 'agent', 'mcp.json'), MCP_JSON);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // ⚠ HOME-RELATIVE — OMP joins PI_CONFIG_DIR onto homedir(); an absolute value would double.
  const relDir = (id: string) => join('.papercusp', 'su-omp-homes', `session-${id}`);
  const agentPath = (id: string, f: string) => join(home, relDir(id), 'agent', f);

  it('returns a HOME-RELATIVE path (not absolute — OMP joins PI_CONFIG_DIR onto $HOME)', () => {
    const dir = writeOmpSessionConfigDir('sess1', {}, home);
    expect(dir).toBe(relDir('sess1'));
    expect(dir!.startsWith('/')).toBe(false); // relative, so join(home, dir) resolves correctly
  });

  it("full mode (discoveryOff) flips discoveryMode OFF, preserving modelRoles", () => {
    const dir = writeOmpSessionConfigDir('sess1', { discoveryOff: true }, home);
    const written = readFileSync(join(home, dir!, 'agent', 'config.yml'), 'utf8');
    expect(written).toContain('discoveryMode: off');
    expect(written).toContain('discoveryMode: false');
    expect(written).not.toContain('discoveryMode: mcp-only');
    expect(written).toContain('default: papercusp-gateway/claude-sonnet-4-6');
  });

  it('default (no opts) leaves discovery untouched (config copied, eval-off block appended)', () => {
    writeOmpSessionConfigDir('sess1', {}, home);
    const written = readFileSync(agentPath('sess1', 'config.yml'), 'utf8');
    expect(written).toContain('discoveryMode: mcp-only'); // unchanged
    expect(written).toContain('discoveryMode: true');
  });

  it('disables the eval builtin (py/js/rb/jl → false) in the per-session config (WI-2382 scoping fix)', () => {
    // AGENT_CFG has NO eval: block — the surgery must APPEND a canonical all-off one so the weak
    // local model can never doom-loop on eval. This replaces the former GLOBAL omp-config disable.
    writeOmpSessionConfigDir('sess1', {}, home);
    const written = readFileSync(agentPath('sess1', 'config.yml'), 'utf8');
    expect(written).toContain('eval:');
    for (const lang of ['py', 'js', 'rb', 'jl']) {
      expect(written).toMatch(new RegExp(`\\n\\s+${lang}:\\s*false`));
    }
  });

  it('does NOT mutate the user’s global ~/.omp config (eval stays as the user set it)', () => {
    // The scoping guarantee the owner asked for: a user’s own DIRECT (non-psu) omp keeps eval.
    writeOmpSessionConfigDir('sess1', {}, home);
    const globalCfg = readFileSync(join(home, '.omp', 'agent', 'config.yml'), 'utf8');
    expect(globalCfg).toBe(AGENT_CFG); // untouched — no eval: block injected into the global
    expect(globalCfg).not.toContain('eval:');
  });

  it('FLIPS an inherited eval:on block to off (remove-then-append, no duplicate key)', () => {
    // A user who had eval ENABLED globally: the copy must still come out disabled, exactly once.
    const withEval =
      AGENT_CFG + 'eval:\n  py: true\n  js: true\n  rb: true\n  jl: true\n';
    writeFileSync(join(home, '.omp', 'agent', 'config.yml'), withEval);
    writeOmpSessionConfigDir('sess1', {}, home);
    const written = readFileSync(agentPath('sess1', 'config.yml'), 'utf8');
    expect((written.match(/^eval:/gm) ?? []).length).toBe(1); // exactly one eval: block
    expect(written).not.toMatch(/\n\s+py:\s*true/); // no leftover on-value
    expect(written).toMatch(/\n\s+py:\s*false/);
  });

  it('carries the faithful model registry + auth so model resolution survives relocation', () => {
    writeOmpSessionConfigDir('sess1', {}, home);
    expect(readFileSync(agentPath('sess1', 'auth.json'), 'utf8')).toBe('{"token":"AUTHSECRET"}');
    expect(existsSync(agentPath('sess1', 'models.yml'))).toBe(true);
    expect(readFileSync(agentPath('sess1', 'models.db'), 'utf8')).toBe('BINARYREGISTRY');
  });

  it('carries mcp.json so the relocated session keeps papercusp-su (the old full-mode bug)', () => {
    writeOmpSessionConfigDir('sess1', {}, home);
    const mcp = JSON.parse(readFileSync(agentPath('sess1', 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers['papercusp-su'].url).toContain('/api/mcp?superuser=1');
    expect(mcp.mcpServers['papercusp-su'].url).not.toContain('tools='); // no trim without the opt
  });

  it('weak trim (toolsAllowlist) rewrites the papercusp-su URL with ?tools=<core>', () => {
    const dir = writeOmpSessionConfigDir('sess1', { toolsAllowlist: OMP_CORE_MCP_TOOL_NAMES }, home);
    const mcp = JSON.parse(readFileSync(join(home, dir!, 'agent', 'mcp.json'), 'utf8'));
    const url = new URL(mcp.mcpServers['papercusp-su'].url);
    // The server decodes the param and splits on comma → the exact core list.
    expect(url.searchParams.get('tools')!.split(',')).toEqual([...OMP_CORE_MCP_TOOL_NAMES]);
    // Existing params + auth header survive untouched.
    expect(url.searchParams.get('superuser')).toBe('1');
    expect(mcp.mcpServers['papercusp-su'].headers.Authorization).toBe('Bearer SECRET');
  });

  it('WI-1866: clientId stamps the per-session coord ownerId as ?client=, overriding the baked per-machine id', () => {
    // The user-level template bakes ONE per-machine client id, and omp cannot env-expand the
    // SID at connect (unlike claude's ${PAPERCUSP_SID} url) — so without this override every
    // omp session on the box collapsed into a single shared in-band coord identity (shared
    // claims, void member-vs-member claim conflicts, wakes to the visible id black-holing).
    const dir = writeOmpSessionConfigDir('sess1', { clientId: 'su-638fab72-65c7-4dec-b45b-3acb5552d350' }, home);
    const mcp = JSON.parse(readFileSync(join(home, dir!, 'agent', 'mcp.json'), 'utf8'));
    const url = new URL(mcp.mcpServers['papercusp-su'].url);
    expect(url.searchParams.get('client')).toBe('su-638fab72-65c7-4dec-b45b-3acb5552d350');
    expect(url.searchParams.get('superuser')).toBe('1'); // rest of the query survives
  });

  it('WI-1866: without clientId the baked client param is left untouched (no regression)', () => {
    const dir = writeOmpSessionConfigDir('sess1', {}, home);
    const mcp = JSON.parse(readFileSync(join(home, dir!, 'agent', 'mcp.json'), 'utf8'));
    const url = new URL(mcp.mcpServers['papercusp-su'].url);
    expect(url.searchParams.get('client')).toBe('abc');
  });

  it('rewrites the papercusp server ORIGIN to the launcher-resolved operator URL (P-030)', () => {
    // The user-level mcp.json pins :3070; a session launched with
    // PAPERCUSP_OPERATOR_URL (or riding the resilient proxy) must have its COPY
    // follow the launcher's operator, or the member talks to a different host.
    const dir = writeOmpSessionConfigDir('sess1', { operatorUrl: 'http://localhost:3170' }, home);
    const mcp = JSON.parse(readFileSync(join(home, dir!, 'agent', 'mcp.json'), 'utf8'));
    const url = new URL(mcp.mcpServers['papercusp-su'].url);
    expect(url.origin).toBe('http://localhost:3170');
    expect(url.pathname).toBe('/api/mcp');
    expect(url.searchParams.get('superuser')).toBe('1'); // query survives the origin swap
    expect(mcp.mcpServers['papercusp-su'].headers.Authorization).toBe('Bearer SECRET');
  });

  it('returns null for a falsy sessionId (no dir written)', () => {
    expect(writeOmpSessionConfigDir('', {}, home)).toBeNull();
    expect(writeOmpSessionConfigDir(null, {}, home)).toBeNull();
    expect(writeOmpSessionConfigDir(undefined, {}, home)).toBeNull();
  });

  it('returns null when the global OMP config is missing (falls back to native default)', () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'psu-noomp-'));
    try {
      expect(writeOmpSessionConfigDir('sess3', {}, emptyHome)).toBeNull();
      expect(existsSync(join(emptyHome, '.papercusp', 'su-omp-homes'))).toBe(false);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe('ompCoreToolNames (PAPERCUSP_OMP_TOOLS_EXCLUDE — spine trim escape hatch)', () => {
  it('returns the full spine when the env var is unset/empty', () => {
    expect(ompCoreToolNames({})).toEqual([...OMP_CORE_MCP_TOOL_NAMES]);
    expect(ompCoreToolNames({ PAPERCUSP_OMP_TOOLS_EXCLUDE: '' })).toEqual([...OMP_CORE_MCP_TOOL_NAMES]);
  });

  it('drops the named tools (comma-separated, whitespace-tolerant), keeping the rest in order', () => {
    // (work_items:update left the spine in the 2026-07-05 rebalance — exclude two tools
    // that ARE in the spine so the length-2 assertion stays meaningful.)
    const kept = ompCoreToolNames({ PAPERCUSP_OMP_TOOLS_EXCLUDE: 'work_items:set_state, coord:glance' });
    expect(kept).not.toContain('work_items:set_state');
    expect(kept).not.toContain('coord:glance');
    expect(kept.length).toBe(OMP_CORE_MCP_TOOL_NAMES.length - 2);
    expect(kept[0]).toBe(OMP_CORE_MCP_TOOL_NAMES[0]); // order preserved
  });

  it('ignores names not in the spine (no-op, no error)', () => {
    expect(ompCoreToolNames({ PAPERCUSP_OMP_TOOLS_EXCLUDE: 'not:a-tool' })).toEqual([...OMP_CORE_MCP_TOOL_NAMES]);
  });
});

describe('claudeSeedToolNames (EI-9011 — CC lock-hook verbs advertised to Claude only)', () => {
  it('is the spine plus the manual lock verbs, deduped', () => {
    const seed = claudeSeedToolNames({});
    for (const n of OMP_CORE_MCP_TOOL_NAMES) expect(seed).toContain(n);
    for (const n of CLAUDE_SEED_EXTRA_TOOL_NAMES) expect(seed).toContain(n);
    expect(new Set(seed).size).toBe(seed.length);
  });

  it('locks:* stay OUT of the weak-model OMP spine (the 2026-07-05 misuse cut holds)', () => {
    for (const n of CLAUDE_SEED_EXTRA_TOOL_NAMES) expect(ompCoreToolNames({})).not.toContain(n);
  });

  it('honors the spine exclude escape hatch without touching the lock extras', () => {
    const seed = claudeSeedToolNames({ PAPERCUSP_OMP_TOOLS_EXCLUDE: 'coord:glance' });
    expect(seed).not.toContain('coord:glance');
    expect(seed).toContain('locks:acquire');
  });
});

describe('applyOmpMcpUrlParams (stamp caller backend/model — fleet-launch-agent-inheritance-2026-07-03)', () => {
  const mk = (url: string) => JSON.stringify({ mcpServers: { 'papercusp-su': { url } } });
  const urlOf = (json: string) => new URL(JSON.parse(json).mcpServers['papercusp-su'].url);

  it('stamps agent + model onto a papercusp /api/mcp url', () => {
    const out = applyOmpMcpUrlParams(mk('http://127.0.0.1:3070/api/mcp?superuser=1&client=x'), {
      agent: 'omp',
      model: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M',
    });
    const u = urlOf(out);
    expect(u.searchParams.get('agent')).toBe('omp');
    expect(u.searchParams.get('model')).toBe('ollama-cc/maxwell1500/ornith-35b:IQ3_M');
    // pre-existing params survive
    expect(u.searchParams.get('superuser')).toBe('1');
    expect(u.searchParams.get('client')).toBe('x');
  });

  it('omits empty/undefined params (no bare &model=)', () => {
    const u = urlOf(applyOmpMcpUrlParams(mk('http://127.0.0.1:3070/api/mcp?superuser=1'), { agent: 'omp', model: undefined }));
    expect(u.searchParams.get('agent')).toBe('omp');
    expect(u.searchParams.has('model')).toBe(false);
  });

  it('leaves non-papercusp server urls untouched', () => {
    const src = mk('http://example.com/other');
    expect(JSON.parse(applyOmpMcpUrlParams(src, { agent: 'omp' })).mcpServers['papercusp-su'].url).toBe(
      'http://example.com/other',
    );
  });

  it('returns the input unchanged on invalid JSON', () => {
    expect(applyOmpMcpUrlParams('not json', { agent: 'omp' })).toBe('not json');
  });
});

describe('applyOmpOperatorOrigin (P-030 — member mcp.json follows the launcher operator)', () => {
  it('swaps the origin of a papercusp /api/mcp url, preserving path + query verbatim', () => {
    const src = JSON.stringify({
      mcpServers: { 'papercusp-su': { url: 'http://localhost:3070/api/mcp?superuser=1&client=x&tools=a%3Ab', headers: { Authorization: 'Bearer S' } } },
    });
    const out = JSON.parse(applyOmpOperatorOrigin(src, 'http://127.0.0.1:9071'));
    expect(out.mcpServers['papercusp-su'].url).toBe('http://127.0.0.1:9071/api/mcp?superuser=1&client=x&tools=a%3Ab');
    expect(out.mcpServers['papercusp-su'].headers.Authorization).toBe('Bearer S');
  });

  it('leaves non-papercusp server URLs untouched', () => {
    const src = JSON.stringify({ mcpServers: { other: { url: 'http://example.com/mcp' } } });
    const out = JSON.parse(applyOmpOperatorOrigin(src, 'http://localhost:3170'));
    expect(out.mcpServers.other.url).toBe('http://example.com/mcp');
  });

  it('returns the input unchanged on unparseable json or a bad operator url', () => {
    expect(applyOmpOperatorOrigin('not json', 'http://localhost:3170')).toBe('not json');
    const src = JSON.stringify({ mcpServers: { p: { url: 'http://localhost:3070/api/mcp' } } });
    expect(applyOmpOperatorOrigin(src, 'not-a-url')).toBe(src);
  });
});

describe('applyOmpToolsAllowlist (weak-model-tool-tier — mcp.json URL trim)', () => {
  it('appends ?tools= to a papercusp /api/mcp url, encoded so the server decodes it back', () => {
    const src = JSON.stringify({ mcpServers: { 'papercusp-su': { url: 'http://localhost:3070/api/mcp?superuser=1&client=x' } } });
    const out = JSON.parse(applyOmpToolsAllowlist(src, ['coord:orient', 'tools:find']));
    const url = new URL(out.mcpServers['papercusp-su'].url);
    expect(url.searchParams.get('tools')!.split(',')).toEqual(['coord:orient', 'tools:find']);
  });

  it('is idempotent — never double-appends tools= if one is already present', () => {
    const src = JSON.stringify({ mcpServers: { p: { url: 'http://localhost:3070/api/mcp?tools=a:b' } } });
    const out = JSON.parse(applyOmpToolsAllowlist(src, ['coord:orient']));
    expect(out.mcpServers.p.url).toBe('http://localhost:3070/api/mcp?tools=a:b'); // untouched
  });

  it('leaves a non-papercusp server URL untouched', () => {
    const src = JSON.stringify({ mcpServers: { other: { url: 'http://example.com/mcp' } } });
    const out = JSON.parse(applyOmpToolsAllowlist(src, ['coord:orient']));
    expect(out.mcpServers.other.url).toBe('http://example.com/mcp');
  });

  it('returns the input unchanged on unparseable JSON', () => {
    expect(applyOmpToolsAllowlist('not json{', ['coord:orient'])).toBe('not json{');
  });
});

describe('isWeakOmpModel / ompDefaultModel (weak-model-tool-tier — tier gate)', () => {
  it('classifies local-provider models as weak, hosted as not-weak, unknown as not-weak (safe)', () => {
    expect(isWeakOmpModel('ollama/maxwell1500/ornith-35b:IQ3_M:xhigh')).toBe(true);
    expect(isWeakOmpModel('OLLAMA/ornith')).toBe(true); // case-insensitive
    expect(isWeakOmpModel('lmstudio/foo')).toBe(true);
    expect(isWeakOmpModel('anthropic/claude-opus-4-8')).toBe(false);
    expect(isWeakOmpModel('papercusp-gateway/claude-sonnet-4-6')).toBe(false);
    expect(isWeakOmpModel('')).toBe(false);
    expect(isWeakOmpModel(null)).toBe(false);
    expect(isWeakOmpModel(undefined)).toBe(false);
  });

  it('ompDefaultModel reads config.yml modelRoles.default (or null)', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-ompdef-'));
    try {
      mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
      writeFileSync(join(home, '.omp', 'agent', 'config.yml'), 'modelRoles:\n  default: ollama/ornith:fast\n');
      expect(ompDefaultModel(home)).toBe('ollama/ornith:fast');
      expect(isWeakOmpModel(ompDefaultModel(home))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(ompDefaultModel(mkdtempSync(join(tmpdir(), 'psu-noomp2-')))).toBeNull();
  });
});

describe('OMP_CORE_MCP_TOOL_NAMES drift guard (weak-model-tool-tier)', () => {
  // psu-launcher.mjs is a plain node script with no TS imports, so it inlines the spine.
  // It is the omp/weak-model VARIANT of the canonical orchestrator CORE spine, and
  // deliberately diverges in exactly ONE documented way (asserted below); any OTHER
  // drift fails the build — edit the orchestrator source, then mirror here.
  // (The former second divergence — OMP dropping locks:acquire_granular/release_granular —
  // became a no-op in the 2026-07-05 demand-evidence rebalance, which cut the granular
  // lock tools from the CANONICAL list too: hooks auto-lock every Edit/Write on all
  // clients. The not-contains guard stays so they can't silently creep back into either.)
  const LOCK_TOOLS = ['locks:acquire_granular', 'locks:release_granular'];

  it('carries no manual granular lock tools (auto-acquired on Edit/Write via hooks, both spines)', () => {
    for (const t of LOCK_TOOLS) {
      expect([...OMP_CORE_MCP_TOOL_NAMES]).not.toContain(t);
      expect([...CORE_MCP_TOOL_NAMES]).not.toContain(t);
    }
  });

  it('adds fleet:launch-on-plan so a routing-gate leader can actually execute option C', () => {
    // Root cause of session 9870 not launching its fleet: the whole fleet:* group was
    // hidden, so the AUTO-off "(C) launch a fleet" option had no callable verb.
    expect([...OMP_CORE_MCP_TOOL_NAMES]).toContain('fleet:launch-on-plan');
  });

  it('seeds work_items:release for worker handoffs instead of relying on deferred discovery', () => {
    // EI-8588: release existed server-side, but seeded worker/fleet surfaces omitted it,
    // so a member trying to return a misclaimed item could not discover/call the flat
    // MCP tool reliably from the trimmed surface.
    expect([...CORE_MCP_TOOL_NAMES]).toContain('work_items:release');
    expect([...OMP_CORE_MCP_TOOL_NAMES]).toContain('work_items:release');
  });

  it('is otherwise identical to the canonical orchestrator CORE_MCP_TOOL_NAMES, order preserved', () => {
    const ompMinusFleet = OMP_CORE_MCP_TOOL_NAMES.filter((n) => n !== 'fleet:launch-on-plan');
    expect([...ompMinusFleet]).toEqual([...CORE_MCP_TOOL_NAMES]);
  });
});

describe('applyGithubTokenEnv (GitHub MCP plugin token)', () => {
  it('exports the gh token into env when unset', () => {
    const env: Record<string, string> = {};
    applyGithubTokenEnv(env, { runGh: () => ({ status: 0, stdout: 'gho_abc123\n' }) });
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('gho_abc123');
  });
  it('leaves an already-set token untouched', () => {
    const env: Record<string, string> = { GITHUB_PERSONAL_ACCESS_TOKEN: 'preset' };
    applyGithubTokenEnv(env, { runGh: () => ({ status: 0, stdout: 'gho_other' }) });
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('preset');
  });
  it('fail-soft when gh errors or is logged out (env unchanged)', () => {
    const env: Record<string, string> = {};
    applyGithubTokenEnv(env, { runGh: () => ({ status: 1, stdout: '' }) });
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    applyGithubTokenEnv(env, { runGh: () => { throw new Error('no gh'); } });
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
  });
});

describe('psu-launcher arg parsing', () => {
  it('defaults to the interactive picker', () => {
    expect(parseArgs([])).toEqual({
      picker: true,
      resume: false,
      resumeId: null,
      fork: false,
      agent: null,
      role: null,
      feature: null,
      workspace: null,
      harness: null,
      plan: null,
      noPlan: false,
      model: null,
      resumeSession: null,
      launchContext: null,
      launchedBy: null,
      profile: null,
      // drain-mode P-003: named operating mode, default none.
      mode: null,
      // agent-allocation P-005: delegated seat template ref, default none.
      seat: null,
      // su-context-size-variants (WI-1282): defaults to null (each client's native default).
      contextSize: null,
      personaTier: null,
      force: false,
      yes: false,
      brain: false,
      account: null,
      fleet: null,
      fleetRole: null,
      fleetName: null,
      fleetScheme: null,
      headless: false,
      // fleet-auto-mode (WI-1356): null = no explicit --auto/--no-auto (effective
      // default derived from --fleet by effectiveAutoMode).
      auto: null,
      addDir: [],
      passthrough: [],
      setClaudeToken: false,
      setClaudeTokenValue: null,
      clearClaudeToken: false,
      // subagent-launch governance (owner mandate 2026-07-02): tri-state, default
      // null (unset) — the picker prompts (falling back to DENY); a flag preselects.
      allowSubagents: null,
      kickoffPromptText: null,
      label: null,
    });
  });

  it('parses --allow-subagents / --no-subagents (owner mandate 2026-07-02); defaults null (⇒ deny)', () => {
    expect(parseArgs([]).allowSubagents).toBeNull();
    expect(parseArgs(['--allow-subagents']).allowSubagents).toBe(true);
    expect(parseArgs(['--no-subagents']).allowSubagents).toBe(false);
  });

  it('parses --headless (headless-fleet-launch P-001); defaults false and implies --no-picker', () => {
    expect(parseArgs([]).headless).toBe(false);
    expect(parseArgs([]).picker).toBe(true);
    const a = parseArgs(['--headless', '--agent=claude', '--harness=x', '--plan=p']);
    expect(a.headless).toBe(true);
    // No terminal to prompt at — headless forces the scripted (non-picker) path.
    expect(a.picker).toBe(false);
  });

  it('parses retired --brain as a tombstoned flag, not a backend-specific capability', () => {
    expect(parseArgs(['--brain']).brain).toBe(true);
    expect(parseArgs([]).brain).toBe(false);
    const both = parseArgs(['--brain', '--model=opus']);
    expect(both.brain).toBe(true);
    // opus is a default-1M family → parseArgs normalizes the spec to carry [1m]
    // (owner directive 2026-07-02; see the normalizeModelSpec suite below).
    expect(both.model).toBe('opus[1m]');
    expect(BRAIN_TOMBSTONE_MESSAGE).toMatch(/operator\/sentinel converse/i);
  });

  it('parses the scripting-escape flags', () => {
    expect(
      parseArgs(['--no-picker', '--agent=claude', '--workspace=ws1', '--harness=papercup', '--plan=my-plan']),
    ).toEqual({
      picker: false,
      resume: false,
      resumeId: null,
      fork: false,
      agent: 'claude',
      role: null,
      feature: null,
      workspace: 'ws1',
      harness: 'papercup',
      plan: 'my-plan',
      noPlan: false,
      model: null,
      resumeSession: null,
      launchContext: null,
      launchedBy: null,
      profile: null,
      mode: null,
      seat: null,
      contextSize: null,
      personaTier: null,
      force: false,
      yes: false,
      brain: false,
      account: null,
      fleet: null,
      fleetRole: null,
      fleetName: null,
      fleetScheme: null,
      headless: false,
      auto: null,
      addDir: [],
      passthrough: [],
      setClaudeToken: false,
      setClaudeTokenValue: null,
      clearClaudeToken: false,
      allowSubagents: null,
      kickoffPromptText: null,
      label: null,
    });
  });

  it('parses --resume (picker mode — no id)', () => {
    const a = parseArgs(['--resume']);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBeNull();
  });

  it('parses --resume=<id> (direct, skip picker)', () => {
    const a = parseArgs(['--resume=42']);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBe('42');
  });

  it('parses a bare positional id after --resume', () => {
    const a = parseArgs(['--resume', '57']);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBe('57');
  });

  it('parses --no-plan', () => {
    expect(parseArgs(['--no-picker', '--agent=omp', '--harness=x', '--no-plan']).noPlan).toBe(true);
  });

  it('parses --account (psu-account-chooser; both = and space forms; default null)', () => {
    expect(parseArgs([]).account).toBeNull();
    expect(parseArgs(['--account=aviynw6']).account).toBe('aviynw6');
    expect(parseArgs(['--account', 'aviynw6']).account).toBe('aviynw6');
    // Composable with the other launch flags + the `--` passthrough is untouched.
    const a = parseArgs(['--no-picker', '--agent=claude', '--account', 'avi-storewolf', '--', '--verbose']);
    expect(a.account).toBe('avi-storewolf');
    expect(a.agent).toBe('claude');
    expect(a.passthrough).toEqual(['--verbose']);
  });

  it('parses --profile (P-023); defaults to null', () => {
    expect(parseArgs(['--profile=power']).profile).toBe('power');
    expect(parseArgs(['--agent=claude']).profile).toBeNull();
  });

  it('parses --context-size (WI-1282 su-context-size-variants); defaults to null', () => {
    expect(parseArgs(['--context-size=trimmed']).contextSize).toBe('trimmed');
    expect(parseArgs(['--context-size=full']).contextSize).toBe('full');
    expect(parseArgs(['--agent=claude']).contextSize).toBeNull();
  });

  it('parses --yes / -y (untracked-resume confirm bypass); defaults false', () => {
    expect(parseArgs(['--resume=x', '--yes']).yes).toBe(true);
    expect(parseArgs(['--resume=x', '-y']).yes).toBe(true);
    expect(parseArgs(['--resume=x']).yes).toBe(false);
  });

  it('parses --add-dir (space + = forms, repeatable); defaults to []', () => {
    expect(parseArgs([]).addDir).toEqual([]);
    expect(parseArgs(['--add-dir', '/tmp/a']).addDir).toEqual(['/tmp/a']);
    expect(parseArgs(['--add-dir=/tmp/b']).addDir).toEqual(['/tmp/b']);
    // Repeatable, both forms intermixed.
    expect(parseArgs(['--add-dir', '/x', '--add-dir=/y', '--add-dir', '/z']).addDir).toEqual(['/x', '/y', '/z']);
    // An empty `--add-dir=` contributes nothing.
    expect(parseArgs(['--add-dir=']).addDir).toEqual([]);
  });

  it('a value after --add-dir is taken verbatim, not parsed as a psu flag', () => {
    // The space-form value is consumed as the dir even if it looks flag-ish.
    const a = parseArgs(['--add-dir', '--no-plan']);
    expect(a.addDir).toEqual(['--no-plan']);
    expect(a.noPlan).toBe(false);
  });

  it('--add-dir before `--` is psu-parsed; after `--` it is verbatim passthrough', () => {
    const a = parseArgs(['--add-dir', '/early', '--', '--add-dir', '/late']);
    expect(a.addDir).toEqual(['/early']);
    expect(a.passthrough).toEqual(['--add-dir', '/late']);
  });

  it('parses --auto / --no-auto (fleet-auto-mode WI-1356); defaults null', () => {
    expect(parseArgs([]).auto).toBeNull();
    expect(parseArgs(['--auto']).auto).toBe(true);
    expect(parseArgs(['--no-auto']).auto).toBe(false);
    // last one wins if both are (nonsensically) passed
    expect(parseArgs(['--auto', '--no-auto']).auto).toBe(false);
  });

  it('parses --mode=drain; REFUSES any other mode loudly (drain-mode P-003)', () => {
    expect(parseArgs([]).mode).toBeNull();
    expect(parseArgs(['--mode=drain']).mode).toBe('drain');
    // A typo'd mode must fail the launch, not silently launch a plain session.
    expect(() => parseArgs(['--mode=burndown'])).toThrow(/not recognized/);
    expect(() => parseArgs(['--mode='])).toThrow(/not recognized/);
  });

  it('drain-mode P-003: DRAIN implies AUTO — effectiveAutoMode true even against --no-auto', () => {
    expect(effectiveAutoMode(parseArgs(['--mode=drain']))).toBe(true);
    // Not overridable: a non-auto drain is a contradiction.
    expect(effectiveAutoMode(parseArgs(['--mode=drain', '--no-auto']))).toBe(true);
    // Baseline unchanged without the flag.
    expect(effectiveAutoMode(parseArgs(['--no-auto']))).toBe(false);
    expect(effectiveAutoMode(parseArgs([]))).toBe(false);
  });

  it('parses --fork / --fork-session (resume-time branch); defaults false', () => {
    expect(parseArgs(['--resume=42', '--fork']).fork).toBe(true);
    expect(parseArgs(['--resume=42', '--fork-session']).fork).toBe(true);
    expect(parseArgs(['--resume=42']).fork).toBe(false);
  });

  it('collects everything after a literal `--` as verbatim passthrough', () => {
    const a = parseArgs(['--resume=42', '--', '--add-dir', '/tmp', '--foo=bar']);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBe('42');
    expect(a.passthrough).toEqual(['--add-dir', '/tmp', '--foo=bar']);
  });

  it('does NOT parse psu flags that appear after `--` — they are forwarded', () => {
    // `--no-picker` past the `--` is the backend CLI's to interpret, not psu's.
    const a = parseArgs(['--resume=42', '--', '--no-picker']);
    expect(a.picker).toBe(true);
    expect(a.passthrough).toEqual(['--no-picker']);
  });

  it('resumeArgsFor maps each agent to its RAW CLI + resume args (P-042, no wrapper)', () => {
    expect(resumeArgsFor({ agent: 'claude', cwd: '/x' })).toEqual({
      bin: 'claude',
      // Subagent deny is re-armed by DEFAULT on every claude resume (owner mandate 2026-07-02).
      args: ['--continue', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', NO_SUBAGENTS_DENY_FLAG],
    });
    // omp: thread target (or -c) + yolo; -e only when a coordExtPath is supplied.
    expect(resumeArgsFor({ agent: 'omp', cwd: '/x', ompThreadId: 'thr-1' })).toEqual({
      bin: 'omp',
      args: ['-r', 'thr-1', '--approval-mode', 'yolo'],
    });
    expect(resumeArgsFor({ agent: 'omp', cwd: '/x', ompThreadId: null }, { coordExtPath: '/h/.papercusp/papercusp-coord.ts' })).toEqual({
      bin: 'omp',
      args: ['-c', '--approval-mode', 'yolo', '-e', '/h/.papercusp/papercusp-coord.ts'],
    });
    expect(resumeArgsFor({ agent: 'codex', cwd: '/x' })).toEqual({
      bin: 'codex',
      args: ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--last'],
    });
    expect(() => resumeArgsFor({ agent: 'gemini', cwd: '/x' })).toThrow();
  });

  it('resumeArgsFor uses precise resume-by-id when a native sessionId is known', () => {
    // Store-found (untracked) sessions carry the agent's native id → resume EXACTLY it.
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'uuid-1' }).args).toEqual([
      '--resume', 'uuid-1', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', NO_SUBAGENTS_DENY_FLAG,
    ]);
    expect(resumeArgsFor({ agent: 'codex', sessionId: 'uuid-2' }).args).toEqual([
      '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', 'resume', 'uuid-2',
    ]);
  });

  it('resumeArgsFor appends --fork-session for a claude fork (branch, leave the original)', () => {
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'uuid-1' }, { fork: true }).args).toEqual([
      '--resume', 'uuid-1', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', NO_SUBAGENTS_DENY_FLAG, '--fork-session',
    ]);
    // Fork also composes with the most-recent (--continue) resume.
    expect(resumeArgsFor({ agent: 'claude' }, { fork: true }).args).toEqual([
      '--continue', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', NO_SUBAGENTS_DENY_FLAG, '--fork-session',
    ]);
  });

  it('resumeArgsFor maps Codex --fork to native codex fork, and still refuses OMP', () => {
    expect(() => resumeArgsFor({ agent: 'omp', ompThreadId: 't' }, { fork: true })).toThrow(/launch-context/);
    expect(resumeArgsFor({ agent: 'codex', sessionId: 'uuid-2' }, { fork: true }).args).toEqual([
      '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', 'fork', 'uuid-2',
    ]);
    expect(resumeArgsFor({ agent: 'codex' }, { fork: true }).args).toEqual([
      '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', 'fork', '--last',
    ]);
  });

  it('forkUnsupportedMessage documents the safe non-native fallback for OMP', () => {
    expect(forkUnsupportedMessage('omp')).toContain('psu --agent=omp --launch-context=<brief.md>');
    expect(forkUnsupportedMessage('omp')).toContain('will not silently append');
  });

  it('resumeArgsFor forces the fork id via --session-id ONLY alongside --fork-session (tracked fork)', () => {
    // The plain --session-id/--resume conflict is lifted by --fork-session, so the
    // trio is valid — this is how launchTrackedFork pins the fork to a psu-minted id.
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'orig' }, { fork: true, forkSessionId: 'forked' }).args).toEqual([
      '--resume', 'orig', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', NO_SUBAGENTS_DENY_FLAG, '--fork-session', '--session-id', 'forked',
    ]);
    // forkSessionId WITHOUT fork is ignored (no --fork-session ⇒ --session-id would conflict with --resume).
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'orig' }, { forkSessionId: 'forked' }).args).toEqual([
      '--resume', 'orig', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', NO_SUBAGENTS_DENY_FLAG,
    ]);
  });

  it('addDirArgs maps to each backend native flag (claude/codex), [] for omp; uses the greed-safe = form', () => {
    expect(addDirArgs('claude', ['/a', '/b'])).toEqual(['--add-dir=/a', '--add-dir=/b']);
    expect(addDirArgs('codex', ['/a'])).toEqual(['--add-dir=/a']);
    expect(addDirArgs('omp', ['/a'])).toEqual([]); // omp has no --add-dir
    expect(addDirArgs('claude', [])).toEqual([]);
    expect(addDirArgs('gemini', ['/a'])).toEqual([]); // unknown backend
  });

  it('resumeArgsFor threads --add-dir into each backend at the right position', () => {
    // claude: appended after the resume/permission flags.
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'u' }, { addDir: ['/d'] }).args).toEqual([
      '--resume', 'u', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', NO_SUBAGENTS_DENY_FLAG, '--add-dir=/d',
    ]);
    // claude fork: --add-dir comes after the fork flags.
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'orig' }, { fork: true, forkSessionId: 'f', addDir: ['/d'] }).args).toEqual([
      '--resume', 'orig', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', NO_SUBAGENTS_DENY_FLAG, '--fork-session', '--session-id', 'f', '--add-dir=/d',
    ]);
    // codex: --add-dir is a TOP-LEVEL option, so it must precede the `resume` subcommand.
    expect(resumeArgsFor({ agent: 'codex', sessionId: 'u' }, { addDir: ['/d'] }).args).toEqual([
      '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', '--add-dir=/d', 'resume', 'u',
    ]);
    expect(resumeArgsFor({ agent: 'codex', sessionId: 'u' }, { fork: true, addDir: ['/d'] }).args).toEqual([
      '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', '--add-dir=/d', 'fork', 'u',
    ]);
  });

  it('forkBootstrapBody carries the original workspace/plan + cwd, harness null, agent claude', () => {
    expect(
      forkBootstrapBody({ agent: 'claude', sessionId: 'orig', coordOwnerId: 'su-1', id: 7, workspaceId: 'ws9', planSlug: 'my-plan', cwd: '/repo' }),
    ).toEqual({ agent: 'claude', workspace: 'ws9', harness_slug: null, plan_slug: 'my-plan', cwd: '/repo' });
    // Missing optional fields collapse to null.
    expect(forkBootstrapBody({ agent: 'claude', cwd: '/repo' })).toEqual({
      agent: 'claude', workspace: null, harness_slug: null, plan_slug: null, cwd: '/repo',
    });
  });

  it('forkBootstrapBody folds a chosen account so the server re-pins the gateway (byte-identical when omitted)', () => {
    // A tracked fork mints a fresh session, so the account pin is resolved
    // server-side (resolveAccountPin) — the launcher only forwards the chosen id.
    expect(forkBootstrapBody({ agent: 'claude', cwd: '/repo' }, 'aviynw6')).toEqual({
      agent: 'claude', workspace: null, harness_slug: null, plan_slug: null, cwd: '/repo', account: 'aviynw6',
    });
    // No account → NO `account` key at all (byte-identical to the pre-account body).
    expect(forkBootstrapBody({ agent: 'claude', cwd: '/repo' }, null)).not.toHaveProperty('account');
  });

  it('freshSuBootstrapBody forwards launch_context so Codex can fold it into AGENTS.md', () => {
    const body = freshSuBootstrapBody(
      { agent: 'codex', workspace: 'ws1', harness: 'h1', plan: 'p1' },
      { profile: 'engineer', account: 'codex-main', launchContext: '/tmp/kickoff.md' },
    );
    expect(body).toMatchObject({
      agent: 'codex',
      workspace: 'ws1',
      harness_slug: 'h1',
      plan_slug: 'p1',
      profile: 'engineer',
      account: 'codex-main',
      launch_context: '/tmp/kickoff.md',
    });
  });

  it('freshSuBootstrapBody forwards --label so bootstrap-su stamps adv_sessions.label (docs-agent reuse)', () => {
    const body = freshSuBootstrapBody(
      { agent: 'claude', workspace: 'ws1', harness: null, plan: null },
      { label: 'docs-tutor' },
    );
    expect(body.label).toBe('docs-tutor');
    // omitted when not passed (no null noise on the wire)
    const noLabel = freshSuBootstrapBody({ agent: 'claude', workspace: 'ws1', harness: null, plan: null }, {});
    expect('label' in noLabel).toBe(false);
  });

  it('freshSuBootstrapBody records the reconstructed psu launch_argv (WI-1343)', () => {
    const body = freshSuBootstrapBody(
      { agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' },
      parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1']),
    );
    expect(body.launch_argv).toEqual(['psu', '--no-picker', '--agent=claude', '--workspace=ws1', '--harness=h1', '--plan=p1']);
  });

  it('freshSuBootstrapBody sets auto:true for a --fleet launch, and threads --fleet into launch_argv (WI-1343/WI-1356)', () => {
    const body = freshSuBootstrapBody(
      { agent: 'claude', workspace: 'ws1', harness: 'h1', plan: null },
      parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--no-plan', '--fleet=shared-hive-testing']),
    );
    expect(body.auto).toBe(true);
    expect(body.launch_argv).toContain('--fleet=shared-hive-testing');
    expect(body.launch_argv).toContain('--auto');
    expect(body.launch_argv).toContain('--no-plan');
  });

  it('freshSuBootstrapBody omits auto for a non-fleet launch, and honours --no-auto on a fleet launch (WI-1356)', () => {
    const plain = freshSuBootstrapBody(
      { agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' },
      parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1']),
    );
    expect(plain).not.toHaveProperty('auto');
    expect(plain.launch_argv).not.toContain('--auto');

    const optedOut = freshSuBootstrapBody(
      { agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' },
      parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1', '--fleet=x', '--no-auto']),
    );
    expect(optedOut).not.toHaveProperty('auto');
  });

  it('drain-mode P-003: freshSuBootstrapBody forwards mode:drain + auto:true, and records --mode= in launch_argv', () => {
    const body = freshSuBootstrapBody(
      { agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' },
      parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1', '--mode=drain']),
    );
    expect(body.mode).toBe('drain');
    expect(body.auto).toBe(true); // DRAIN implies AUTO — server double-enforces
    expect(body.launch_argv).toContain('--mode=drain');
    expect(body.launch_argv).toContain('--auto');

    // No mode ⇒ the field is absent (byte-identical pre-drain body).
    const plain = freshSuBootstrapBody(
      { agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' },
      parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1']),
    );
    expect(plain).not.toHaveProperty('mode');
  });

  it('agent-allocation P-005: parseArgs takes --seat=<ref>; freshSuBootstrapBody forwards seat + records --seat= in launch_argv', () => {
    // The missing client leg P-006 caught live (2026-07-03): fleet:launch-on-plan
    // emitted --seat=<ref> but parseArgs dropped it, so bootstrap-su never saw
    // body.seat and consumeSeatAtBoot (mig 487) never recorded — the seat cap
    // was delegated but unenforced.
    expect(parseArgs([]).seat).toBeNull();
    expect(parseArgs(['--seat=haiku:low:AUTO']).seat).toBe('haiku:low:AUTO');
    const body = freshSuBootstrapBody(
      { agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' },
      parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1', '--fleet=f1', '--seat=haiku:low:AUTO']),
    );
    expect(body.seat).toBe('haiku:low:AUTO');
    expect(body.launch_argv).toContain('--seat=haiku:low:AUTO');

    // No seat ⇒ the field is absent (byte-identical non-seat body).
    const plain2 = freshSuBootstrapBody(
      { agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' },
      parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1']),
    );
    expect(plain2).not.toHaveProperty('seat');
  });

  it('roleBootstrapBody folds a chosen account into role launches', () => {
    expect(
      roleBootstrapBody({ role: 'worker', agent: 'codex', workspace: 'ws1', harness: 'h1', feature: 'F-001', plan: null, account: 'codex-main' }),
    ).toEqual({
      role: 'worker',
      agent: 'codex',
      workspace: 'ws1',
      harness_slug: 'h1',
      feature: 'F-001',
      plan: null,
      account: 'codex-main',
    });
    expect(roleBootstrapBody({ role: 'worker', agent: 'codex', workspace: 'ws1', harness: 'h1', feature: 'F-001', plan: null })).not.toHaveProperty('account');
  });

  it('forkSeedPaths points at the projects/ subtree of each config dir', () => {
    expect(forkSeedPaths('/orig/cfg', '/fork/cfg')).toEqual({
      src: '/orig/cfg/projects',
      dst: '/fork/cfg/projects',
    });
  });

  it('resumeEnvFor: identity + workspace scope SURVIVE a tracked resume (psu-workspace-scoping fix)', () => {
    // coordOwnerId is re-exported as PAPERCUSP_SID (wake-executor semantics —
    // a fresh SID orphaned the old one's locks/awaits and detached the adv
    // row); workspaceId rides out as PAPERCUSP_WORKSPACE so the MCP url/header
    // carriers re-scope the resumed session.
    expect(
      resumeEnvFor({ agent: 'claude', id: 7, coordOwnerId: 'su-abc', workspaceId: 'ws1' }),
    ).toEqual({
      PAPERCUSP_AGENT: 'claude',
      PAPERCUSP_SID: 'su-abc',
      PAPERCUSP_WORKSPACE: 'ws1',
      PAPERCUSP_ADV_SESSION_ID: '7',
    });
  });

  it('resumeEnvFor: untracked sessions (no adv row) mint a fresh SID and omit absent fields', () => {
    expect(resumeEnvFor({ agent: 'omp' }, { mintSid: () => 'su-fresh' })).toEqual({
      PAPERCUSP_AGENT: 'omp',
      PAPERCUSP_SID: 'su-fresh',
    });
  });

  it('resumeEnvFor: a FORK takes a fresh coord identity + no adv-row link (concurrent-safe)', () => {
    // Even though the source IS a tracked row (coordOwnerId + id present), the fork
    // must NOT inherit its SID or adv id — otherwise it would collide on the still-
    // live original's locks/presence/wakes. Workspace scope still carries over.
    expect(
      resumeEnvFor(
        { agent: 'claude', id: 7, coordOwnerId: 'su-abc', workspaceId: 'ws1' },
        { mintSid: () => 'su-fork', fork: true },
      ),
    ).toEqual({
      PAPERCUSP_AGENT: 'claude',
      PAPERCUSP_SID: 'su-fork',
      PAPERCUSP_WORKSPACE: 'ws1',
    });
  });

  it('resumeAccountPlan: --account is honored in ANY mode (no prompt)', () => {
    // The pin is spawn-env only and dropped on resume; an explicit flag re-applies
    // it directly — both interactive and scripting (--no-picker) modes.
    expect(resumeAccountPlan({ account: 'aviynw6', picker: true })).toEqual({ source: 'flag', account: 'aviynw6', prompt: false });
    expect(resumeAccountPlan({ account: 'aviynw6', picker: false })).toEqual({ source: 'flag', account: 'aviynw6', prompt: false });
  });

  it('resumeAccountPlan: interactive resume PROMPTS; scripting (--no-picker) does NOT (option 1)', () => {
    expect(resumeAccountPlan({ account: null, picker: true })).toEqual({ source: 'prompt', account: null, prompt: true });
    // --no-picker: no surprise prompt in scripts → default credential (byte-identical resume).
    expect(resumeAccountPlan({ account: null, picker: false })).toEqual({ source: 'none', account: null, prompt: false });
  });

  it('buildResumeEnv: resumed psu sessions always carry the agent-session marker', () => {
    const session = { agent: 'claude', id: 7, coordOwnerId: 'su-abc', workspaceId: 'ws1' };
    expect(buildResumeEnv(session)).toEqual({
      ...resumeEnvFor(session),
      PAPERCUSP_AGENT_SESSION: '1',
    });
  });

  it('buildResumeEnv: account env LAYERS onto the resume identity/scope and marker', () => {
    const session = { agent: 'claude', id: 7, coordOwnerId: 'su-abc', workspaceId: 'ws1' };
    // No account → identity/scope exactly match resumeEnvFor; psu still adds
    // the marker that arms hook-level guards for Claude too (WI-3071).
    expect(buildResumeEnv(session)).toEqual({
      ...resumeEnvFor(session),
      PAPERCUSP_AGENT_SESSION: '1',
    });
    // A resolved account env folds on top (the gateway pin the resume would otherwise lose).
    expect(
      buildResumeEnv(session, {
        accountEnv: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788', ANTHROPIC_CUSTOM_HEADERS: 'anthropic-account-id: aviynw6', PAPERCUSP_ACCOUNT_ID: 'aviynw6' }, notice: 'pinned' },
      }),
    ).toEqual({
      PAPERCUSP_AGENT: 'claude',
      PAPERCUSP_SID: 'su-abc',
      PAPERCUSP_WORKSPACE: 'ws1',
      PAPERCUSP_ADV_SESSION_ID: '7',
      PAPERCUSP_AGENT_SESSION: '1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788',
      ANTHROPIC_CUSTOM_HEADERS: 'anthropic-account-id: aviynw6',
      PAPERCUSP_ACCOUNT_ID: 'aviynw6',
    });
  });

  it('buildResumeEnv: the brain path still carries the agent-session marker alongside the account env', () => {
    const session = { agent: 'claude', id: 7, coordOwnerId: 'su-abc', workspaceId: 'ws1' };
    const env = buildResumeEnv(session, { brain: true, accountEnv: { env: { PAPERCUSP_ACCOUNT_ID: 'avi' }, notice: null } });
    expect(env.PAPERCUSP_AGENT_SESSION).toBe('1');
    expect(env.PAPERCUSP_ACCOUNT_ID).toBe('avi');
  });

  it('trackedForkEnvelopeEnv: a TRACKED --fork ALWAYS carries the agent-session marker (WI-3071 regression)', () => {
    // bootstrap-su (server-side) never sets PAPERCUSP_AGENT_SESSION — launchTrackedFork
    // used to spread its envelopeEnv verbatim, so a forked su session ran UNMARKED and
    // invisible to the destructive shared-tree git guard (pretooluse-bash-resource-gate.sh
    // gates git stash/reset --hard/clean -f/checkout . on exactly this var) and the
    // native-scheduler lockout. `git stash` executed unblocked on the shared staging tree
    // from a forked session on 2026-07-05 as a direct result.
    const bootstrapEnvelopeEnv = {
      CLAUDE_CONFIG_DIR: '/home/x/.papercusp/su-claude-homes/session-9',
      PAPERCUSP_SID: 'su-forked',
      PAPERCUSP_WORKSPACE: 'ws1',
    };
    expect(trackedForkEnvelopeEnv(bootstrapEnvelopeEnv)).toEqual({
      ...bootstrapEnvelopeEnv,
      PAPERCUSP_AGENT_SESSION: '1',
    });
    // Never trust the server envelope's own claim — the marker is asserted
    // client-side even if bootstrap-su starts sending something under the key.
    expect(trackedForkEnvelopeEnv({ ...bootstrapEnvelopeEnv, PAPERCUSP_AGENT_SESSION: '0' })).toMatchObject({
      PAPERCUSP_AGENT_SESSION: '1',
    });
  });

  it('GATEWAY_ACCOUNT_HEADER stays in LOCKSTEP with the server ACCOUNT_HEADER (gateway.ts)', () => {
    // The launcher builds the pin env client-side; the header it sets MUST match the one the gateway
    // routes on, or the pin silently no-ops (the 2026-06-19 "routes to the default account" bug).
    expect(GATEWAY_ACCOUNT_HEADER).toBe(ACCOUNT_HEADER);
  });

  it('gatewayPinEnv: mirrors the server gatewaySpawnEnv (base URL + account header + id)', () => {
    const env = gatewayPinEnv('aviynw');
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`${ACCOUNT_HEADER}: aviynw`);
    expect(env.PAPERCUSP_ACCOUNT_ID).toBe('aviynw');
  });

  it('gatewayPinEnv: codex pins are config-file based and only carry the account id in env', () => {
    expect(gatewayPinEnv('codex-main', 'codex')).toEqual({ PAPERCUSP_ACCOUNT_ID: 'codex-main' });
  });

  it('accountRoutingMode: the ONE --account value classifies into the 3 explicit routing modes', () => {
    // account-routing-3-options (owner, 2026-06-30): default / auto / pin — mirrors the server's
    // resolveAccountPin keyword handling (kept in lockstep). Case-insensitive + trimmed.
    for (const v of [undefined, null, '', '  ', 'default', 'DEFAULT', ' none ', 'system', 'System'])
      expect(accountRoutingMode(v)).toBe('default');
    for (const v of ['auto', 'AUTO', ' gateway ', 'Gateway']) expect(accountRoutingMode(v)).toBe('auto');
    // Anything else is a specific pool account id → pin.
    for (const v of ['aviynw6', 'codex-main', 'team-pool-3']) expect(accountRoutingMode(v)).toBe('pin');
  });

  it('gatewayAutoEnv: claude routes through the gateway with NO account pin header (let it auto-select)', () => {
    const env = gatewayAutoEnv('claude');
    // Base URL points at the localhost gateway; crucially NO account header + NO PAPERCUSP_ACCOUNT_ID,
    // so the gateway active()/drain-selects an available account and fails over (vs gatewayPinEnv).
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(env.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
  });

  it('gatewayAutoEnv: non-claude providers get {} (auto-routing wired for claude only — matches resolveAccountPin)', () => {
    expect(gatewayAutoEnv('codex')).toEqual({});
    expect(gatewayAutoEnv('omp')).toEqual({});
  });

  it('codexGatewayConfigPatch inserts root provider selector before tables and replaces prior pin', () => {
    const current = [
      '# existing config',
      'project_doc_max_bytes = 0',
      '',
      '[features]',
      'memory_tool = false',
      '',
      '# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER',
      '[model_providers.papercusp-codex-gateway]',
      'http_headers = { "x-papercusp-account" = "old" }',
      '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER',
      '',
    ].join('\n');
    const next = codexGatewayConfigPatch(current, 'codex-main');
    expect(next.indexOf('model_provider = "papercusp-codex-gateway"')).toBeLessThan(next.indexOf('[features]'));
    expect(next).toContain('base_url = "http://127.0.0.1:8788/v1"');
    expect(next).toContain('http_headers = { "x-papercusp-account" = "codex-main" }');
    expect(next).not.toContain('"old"');
  });

  it('accountPinnable: gates on gatewayOn + pool membership + session-override (mirrors resolveAccountPin)', () => {
    const base = { gatewayOn: true, pool: ['aviynw', 'aviynw2'], excludeAccounts: [], forcedAccounts: [] };
    expect(accountPinnable(base, 'aviynw')).toBe(true);
    expect(accountPinnable({ ...base, gatewayOn: false }, 'aviynw')).toBe(false); // gateway off → no pin
    expect(accountPinnable(base, 'not-in-pool')).toBe(false);
    expect(accountPinnable({ ...base, excludeAccounts: ['aviynw'] }, 'aviynw')).toBe(false);
    expect(accountPinnable({ ...base, forcedAccounts: ['aviynw2'] }, 'aviynw')).toBe(false); // outside allow-list
    expect(accountPinnable({ ...base, forcedAccounts: ['aviynw'] }, 'aviynw')).toBe(true);
    expect(accountPinnable(base, null)).toBe(false);
    expect(accountPinnable(null, 'aviynw')).toBe(false);
  });

  it('accountProviderFromChoices: explicit null provider fails closed instead of falling back from the agent', () => {
    expect(accountProviderFromChoices({ provider: 'claude' }, 'codex')).toBe('claude');
    expect(accountProviderFromChoices({ provider: 'codex' }, 'claude')).toBe('codex');
    expect(accountProviderFromChoices({ provider: null }, 'codex')).toBeNull();
    expect(accountProviderFromChoices({}, 'codex')).toBe('codex');
  });

  it('planValue maps the NO_PLAN sentinel + empties to null', () => {
    expect(planValue(NO_PLAN)).toBeNull();
    expect(planValue('')).toBeNull();
    expect(planValue(null)).toBeNull();
    expect(planValue('real-plan')).toBe('real-plan');
  });

  it('selectionsFromArgs resolves --no-plan to a null plan + passes workspace', () => {
    expect(
      selectionsFromArgs({ agent: 'omp', workspace: 'ws1', harness: 'papercup', plan: null, noPlan: true }),
    ).toEqual({
      agent: 'omp',
      workspace: 'ws1',
      harness: 'papercup',
      plan: null,
    });
  });

  it('selectionsFromArgs keeps --plan when --no-plan is absent; null workspace when omitted', () => {
    expect(selectionsFromArgs({ agent: 'codex', workspace: null, harness: null, plan: 'p', noPlan: false })).toEqual({
      agent: 'codex',
      workspace: null,
      harness: null,
      plan: 'p',
    });
  });

  it('selectionsFromArgs rejects an unknown agent', () => {
    expect(() => selectionsFromArgs({ agent: 'gemini', harness: 'x', plan: null, noPlan: false })).toThrow();
  });

  it('AGENTS lists exactly the three kinds', () => {
    expect(AGENTS).toEqual(['claude', 'omp', 'codex']);
  });

  it('presetsFromArgs: all flags preselect everything (no prompts needed)', () => {
    const p = presetsFromArgs(parseArgs(['--agent=claude', '--workspace=ws2', '--harness=papercup', '--plan=p']));
    expect(p).toMatchObject({
      agent: 'claude',
      workspace: 'ws2',
      harness: 'papercup',
      plan: 'p',
      needAgent: false,
      needWorkspace: false,
      needHarness: false,
      needPlan: false,
    });
  });

  it('presetsFromArgs: no flags → everything needs a prompt', () => {
    const p = presetsFromArgs(parseArgs([]));
    expect(p).toMatchObject({
      agent: null,
      workspace: null,
      harness: null,
      plan: null,
      needAgent: true,
      needWorkspace: true,
      needHarness: true,
      needPlan: true,
    });
  });

  it('presetsFromArgs: partial preselect (agent + workspace) prompts only for harness + plan', () => {
    const p = presetsFromArgs(parseArgs(['--agent=omp', '--workspace=ws2']));
    expect(p.agent).toBe('omp');
    expect(p.workspace).toBe('ws2');
    expect(p.needAgent).toBe(false);
    expect(p.needWorkspace).toBe(false);
    expect(p.needHarness).toBe(true);
    expect(p.needPlan).toBe(true);
  });

  it('presetsFromArgs: --no-plan preselects "no plan" (no plan prompt)', () => {
    const p = presetsFromArgs(parseArgs(['--agent=claude', '--no-plan']));
    expect(p.plan).toBeNull();
    expect(p.needPlan).toBe(false);
  });

  it('presetsFromArgs: rejects a bad --agent', () => {
    expect(() => presetsFromArgs(parseArgs(['--agent=gemini']))).toThrow();
  });

  it('parses --role and --feature', () => {
    const a = parseArgs(['--role=worker', '--feature=F-001', '--harness=papercup', '--agent=claude']);
    expect(a.role).toBe('worker');
    expect(a.feature).toBe('F-001');
  });
});

describe('roleLaunchArgs (interactive role session)', () => {
  const files = { promptFile: '/lc/session-7.md', mcpJsonPath: '/proj/.mcp.json' };

  it('claude: raw claude, role prompt, strict role-scoped MCP, skip perms, scheduler lockout, no-subagent-fanout', () => {
    const { bin, args } = roleLaunchArgs('claude', files);
    expect(bin).toBe('claude');
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', '/lc/session-7.md',
      '--mcp-config', '/proj/.mcp.json',
      '--strict-mcp-config',
      '--permission-mode', 'bypassPermissions',
      NATIVE_SCHEDULER_DENY_FLAG,
      NO_SUBAGENTS_DENY_FLAG,
    ]);
  });

  it('the scheduler lockout literal stays in LOCKSTEP with the canonical TS module (native-scheduler-lockout P-005)', () => {
    // psu-launcher.mjs is a plain-node script that can't import TS, so it
    // duplicates the rendered flag; this pins the copy to the source of truth.
    expect(NATIVE_SCHEDULER_DENY_FLAG).toBe(nativeSchedulerDenyFlag());
  });

  it('the scheduler lockout is one `=` token (the variadic space form would eat following args)', () => {
    expect(NATIVE_SCHEDULER_DENY_FLAG.startsWith('--disallowedTools=')).toBe(true);
    expect(/\s/.test(NATIVE_SCHEDULER_DENY_FLAG)).toBe(false);
  });

  it('the no-subagent-fanout deny carries Task + Agent + Workflow (no-subagent-deny.ts)', () => {
    // psu-launcher.mjs duplicates the rendered flag from the canonical TS source
    // (same lockstep pattern as the scheduler-deny flag above).
    expect(NO_SUBAGENTS_DENY_FLAG).toBe(noSubagentToolsDenyFlag());
    expect(NO_SUBAGENTS_DENY_FLAG.startsWith('--disallowedTools=')).toBe(true);
    expect(/\s/.test(NO_SUBAGENTS_DENY_FLAG)).toBe(false);
    expect(NO_SUBAGENTS_DENY_FLAG).toContain('Task');
    expect(NO_SUBAGENTS_DENY_FLAG).toContain('Agent');
    // Workflow: the separate multi-agent orchestration tool that slipped the deny
    // (a subagents-denied psu --resume session still fanned out through it).
    expect(NO_SUBAGENTS_DENY_FLAG).toContain('Workflow');
  });

  it('role sessions DENY subagent fanout by DEFAULT; allowSubagents:true opts in (owner mandate 2026-07-02)', () => {
    expect(roleLaunchArgs('claude', files).args).toContain(NO_SUBAGENTS_DENY_FLAG);
    expect(roleLaunchArgs('claude', { ...files, replaceClaudeBase: true }).args).toContain(NO_SUBAGENTS_DENY_FLAG);
    expect(roleLaunchArgs('claude', { ...files, allowSubagents: true }).args).not.toContain(NO_SUBAGENTS_DENY_FLAG);
  });

  it('omp: raw omp, role prompt file, yolo approvals (path-discovers .mcp.json)', () => {
    const { bin, args } = roleLaunchArgs('omp', files);
    expect(bin).toBe('omp');
    expect(args).toEqual(['--approval-mode', 'yolo', '--no-lsp', '--append-system-prompt', '/lc/session-7.md']);
  });

  it('omp: loads the coordination extension (-e) when a coordExtPath is supplied (lock + activity bridge)', () => {
    const { args } = roleLaunchArgs('omp', { ...files, coordExtPath: '/h/.papercusp/papercusp-coord.ts' });
    expect(args).toEqual([
      '--approval-mode', 'yolo',
      '--no-lsp',
      '--append-system-prompt', '/lc/session-7.md',
      '-e', '/h/.papercusp/papercusp-coord.ts',
    ]);
  });

  it('omp: omits -e when no coordExtPath is supplied', () => {
    const { args } = roleLaunchArgs('omp', files);
    expect(args).not.toContain('-e');
  });

  it('codex: raw codex, hook-trust + approvals/sandbox bypass (CODEX_HOME via envelopeEnv)', () => {
    const { bin, args } = roleLaunchArgs('codex', files);
    expect(bin).toBe('codex');
    expect(args).toEqual(['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox']);
  });

  it('unknown backend: throws', () => {
    expect(() => roleLaunchArgs('gemini', files)).toThrow();
  });

  // domain-generic-agent-personas-2026-06-17 P-014: REPLACE_CLAUDE_BASE (default-off) — coherent
  // with suLaunchArgs so flipping the flag replaces the base for interactive role sessions too.
  it('replaceClaudeBase OFF (default): claude/omp append (byte-identical to today)', () => {
    expect(roleLaunchArgs('claude', files).args).toContain('--append-system-prompt-file');
    expect(roleLaunchArgs('claude', files).args).not.toContain('--system-prompt-file');
    expect(roleLaunchArgs('omp', files).args).toContain('--append-system-prompt');
    expect(roleLaunchArgs('omp', files).args).not.toContain('--system-prompt');
  });

  it('replaceClaudeBase ON: claude REPLACES the base (--system-prompt-file + --exclude-dynamic), MCP + lockout intact', () => {
    const { args } = roleLaunchArgs('claude', { ...files, replaceClaudeBase: true });
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--system-prompt-file', '/lc/session-7.md',
      '--exclude-dynamic-system-prompt-sections',
      '--mcp-config', '/proj/.mcp.json',
      '--strict-mcp-config',
      '--permission-mode', 'bypassPermissions',
      NATIVE_SCHEDULER_DENY_FLAG,
      NO_SUBAGENTS_DENY_FLAG,
    ]);
    expect(args).not.toContain('--append-system-prompt-file');
  });

  it('replaceClaudeBase ON: omp uses --system-prompt (replace) instead of --append', () => {
    const { args } = roleLaunchArgs('omp', { ...files, coordExtPath: '/h/coord.ts', replaceClaudeBase: true });
    expect(args).toEqual([
      '--approval-mode', 'yolo',
      '--no-lsp',
      '--system-prompt', '/lc/session-7.md',
      '-e', '/h/coord.ts',
    ]);
  });

  it('replaceClaudeBase ON: codex is a no-op (CODEX_HOME AGENTS.md is already the whole prompt)', () => {
    expect(roleLaunchArgs('codex', { ...files, replaceClaudeBase: true }).args).toEqual([
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('agentInvalidForRole accepts claude/omp/codex', () => {
    expect(agentInvalidForRole('claude')).toBe(false);
    expect(agentInvalidForRole('omp')).toBe(false);
    expect(agentInvalidForRole('codex')).toBe(false);
    expect(agentInvalidForRole(null)).toBe(true);
    expect(agentInvalidForRole('gemini')).toBe(true);
  });
});

describe('suLaunchArgs (P-020 raw-CLI su launch, mirrors roleLaunchArgs)', () => {
  const files = { promptFile: '/lc/session-9.md', coordExtPath: '/home/u/.papercusp/papercusp-coord.ts' };

  it('claude: playbook prompt + skip-perms, NO --mcp-config (papercusp-su is user-level)', () => {
    const { bin, args } = suLaunchArgs('claude', files);
    expect(bin).toBe('claude');
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', '/lc/session-9.md',
      '--permission-mode', 'bypassPermissions',
      // Subagent deny is DEFAULT-ON as of the 2026-07-02 owner mandate.
      NO_SUBAGENTS_DENY_FLAG,
    ]);
    // su relies on the user-level papercusp-su MCP (no per-launch --mcp-config),
    // so the user's full toolkit loads (D-005) and the server isn't doubled.
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('claude su: the HUMAN session keeps native SCHEDULERS — NO scheduler-lockout flag (native-scheduler-lockout D-003)', () => {
    const { args } = suLaunchArgs('claude', files);
    // D-003 for SCHEDULERS still holds — assert the scheduler-deny specifically, NOT
    // the mere presence of a --disallowedTools token: the subagent deny is now
    // default-ON (owner mandate 2026-07-02) and adds its own --disallowedTools.
    expect(args).not.toContain(NATIVE_SCHEDULER_DENY_FLAG);
  });

  it('claude su: DENIES the subagent tool by DEFAULT (owner mandate 2026-07-02 — inverted the D-003 carve-out)', () => {
    const { args } = suLaunchArgs('claude', files);
    expect(args).toContain(NO_SUBAGENTS_DENY_FLAG);
  });

  it('claude su: allowSubagents:true opts the human session back IN to the subagent tool (owner mandate 2026-07-02)', () => {
    const { args } = suLaunchArgs('claude', { ...files, allowSubagents: true });
    expect(args).not.toContain(NO_SUBAGENTS_DENY_FLAG);
  });

  it('omp: yolo + playbook prompt + coordination extension (-e, P-021)', () => {
    const { bin, args } = suLaunchArgs('omp', files);
    expect(bin).toBe('omp');
    expect(args).toEqual([
      '--approval-mode', 'yolo',
      '--no-lsp',
      '--append-system-prompt', '/lc/session-9.md',
      '-e', '/home/u/.papercusp/papercusp-coord.ts',
    ]);
  });

  it('omp: omits -e when no coordExtPath is supplied', () => {
    const { args } = suLaunchArgs('omp', { promptFile: '/lc/s.md' });
    expect(args).toEqual(['--approval-mode', 'yolo', '--no-lsp', '--append-system-prompt', '/lc/s.md']);
    expect(args).not.toContain('-e');
  });

  it('codex: hook-trust + approvals/sandbox bypass (CODEX_HOME minted server-side, P-030)', () => {
    const { bin, args } = suLaunchArgs('codex', files);
    expect(bin).toBe('codex');
    expect(args).toEqual(['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox']);
  });

  it('claude: forces --session-id when a nativeSessionId is supplied (resume-by-uuid correlation)', () => {
    const { args } = suLaunchArgs('claude', { promptFile: '/lc/s.md', nativeSessionId: 'uuid-9' });
    // --session-id sits between the appended prompt and the permission mode; it
    // makes `psu --resume uuid-9` match the tracked adv row + resume the EXACT session.
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', '/lc/s.md',
      '--session-id', 'uuid-9',
      '--permission-mode', 'bypassPermissions',
      NO_SUBAGENTS_DENY_FLAG,
    ]);
  });

  it('claude: omits --session-id when no nativeSessionId is given', () => {
    expect(suLaunchArgs('claude', { promptFile: '/lc/s.md' }).args).not.toContain('--session-id');
  });

  it('omp/codex: ignore nativeSessionId (no forced session id on those backends)', () => {
    expect(suLaunchArgs('omp', { promptFile: '/lc/s.md', nativeSessionId: 'uuid-9' }).args).not.toContain('--session-id');
    expect(suLaunchArgs('codex', { promptFile: '/lc/s.md', nativeSessionId: 'uuid-9' }).args).not.toContain('--session-id');
  });

  it('unknown backend: throws', () => {
    expect(() => suLaunchArgs('gemini', files)).toThrow();
  });

  // domain-generic-agent-personas-2026-06-17 P-014: REPLACE_CLAUDE_BASE (default-off).
  it('replaceClaudeBase OFF (default): claude/omp append (byte-identical to today)', () => {
    expect(suLaunchArgs('claude', files).args).toContain('--append-system-prompt-file');
    expect(suLaunchArgs('claude', files).args).not.toContain('--system-prompt-file');
    expect(suLaunchArgs('claude', files).args).not.toContain('--exclude-dynamic-system-prompt-sections');
    expect(suLaunchArgs('omp', files).args).toContain('--append-system-prompt');
    expect(suLaunchArgs('omp', files).args).not.toContain('--system-prompt');
  });

  it('replaceClaudeBase ON: claude REPLACES the base (--system-prompt-file + --exclude-dynamic)', () => {
    const { args } = suLaunchArgs('claude', { ...files, replaceClaudeBase: true });
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--system-prompt-file', '/lc/session-9.md',
      '--exclude-dynamic-system-prompt-sections',
      '--permission-mode', 'bypassPermissions',
      NO_SUBAGENTS_DENY_FLAG,
    ]);
    expect(args).not.toContain('--append-system-prompt-file');
  });

  it('replaceClaudeBase ON: omp uses --system-prompt (replace) instead of --append', () => {
    const { args } = suLaunchArgs('omp', { ...files, replaceClaudeBase: true });
    expect(args).toEqual([
      '--approval-mode', 'yolo',
      '--no-lsp',
      '--system-prompt', '/lc/session-9.md',
      '-e', '/home/u/.papercusp/papercusp-coord.ts',
    ]);
    expect(args).not.toContain('--append-system-prompt');
  });

  it('replaceClaudeBase ON: codex is a no-op (AGENTS.md is already the whole prompt — no Claude base)', () => {
    expect(suLaunchArgs('codex', { ...files, replaceClaudeBase: true }).args).toEqual([
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('replaceClaudeBase ON: claude still forces --session-id when given', () => {
    const { args } = suLaunchArgs('claude', { promptFile: '/lc/s.md', nativeSessionId: 'uuid-9', replaceClaudeBase: true });
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--system-prompt-file', '/lc/s.md',
      '--exclude-dynamic-system-prompt-sections',
      '--session-id', 'uuid-9',
      '--permission-mode', 'bypassPermissions',
      NO_SUBAGENTS_DENY_FLAG,
    ]);
  });
});

describe('normalizeModelSpec (opus/fable → 1M window; owner directive 2026-07-02)', () => {
  it('injects [1m] for a bare opus/fable spec', () => {
    expect(normalizeModelSpec('opus')).toBe('opus[1m]');
    expect(normalizeModelSpec('claude-fable-5')).toBe('claude-fable-5[1m]');
    expect(normalizeModelSpec('fable')).toBe('fable[1m]');
  });
  it('inserts [1m] BEFORE a recognized :effort suffix (so effort still splits out)', () => {
    expect(normalizeModelSpec('claude-fable-5:xhigh')).toBe('claude-fable-5[1m]:xhigh');
    expect(normalizeModelSpec('opus:high')).toBe('opus[1m]:high');
    expect(normalizeModelSpec('opus:max')).toBe('opus[1m]:max');
  });
  it('is idempotent — a spec already carrying [1m] is unchanged', () => {
    expect(normalizeModelSpec('opus[1m]')).toBe('opus[1m]');
    expect(normalizeModelSpec('claude-fable-5[1m]:xhigh')).toBe('claude-fable-5[1m]:xhigh');
  });
  it('injects [1m] for the sonnet-5 family too (its native 1M default is statsig-gated OFF — the marker is the only reliable path); no-op for non-1M families and empty specs', () => {
    expect(normalizeModelSpec('sonnet')).toBe('sonnet[1m]');
    expect(normalizeModelSpec('sonnet:high')).toBe('sonnet[1m]:high');
    expect(normalizeModelSpec('claude-sonnet-5:high')).toBe('claude-sonnet-5[1m]:high');
    expect(normalizeModelSpec('haiku')).toBe('haiku');
    expect(normalizeModelSpec('')).toBe('');
    expect(normalizeModelSpec(undefined)).toBeUndefined();
    expect(normalizeModelSpec(null)).toBeNull();
  });
  it('a non-effort `:` segment is treated as part of the id (marker appended at end)', () => {
    // A bedrock-style id whose tail is not an effort level: [1m] appends, not mid-string.
    expect(normalizeModelSpec('opus-v2:0')).toBe('opus-v2:0[1m]');
  });
  it('parseArgs applies it — a fleet opus/fable launch spec lands normalized', () => {
    expect(parseArgs(['--model=claude-fable-5:xhigh']).model).toBe('claude-fable-5[1m]:xhigh');
    expect(parseArgs(['--model=opus:max']).model).toBe('opus[1m]:max');
    expect(parseArgs(['--model=sonnet:high']).model).toBe('sonnet[1m]:high');
  });
});

describe('autoCompactWindowEnv (P-014 — CC mechanical compaction backstop for [1m] launches)', () => {
  const KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
  /** CC's REAL fire point for a resolved window (binary-verified): output reserve 20000,
   *  default precompute-buffer fraction 0.2 ⇒ compact fires at ≈0.8·(window−20000). */
  const ccFirePoint = (w) => Math.round((w - 20_000) * 0.8);

  it('lockstep soft-limit constants (agent-config-constants COMPACTION_LIMIT_DEFAULT_1M_*_CAP)', () => {
    expect(COMPACTION_LIMIT_1M_LEADER).toBe(400_000);
    expect(COMPACTION_LIMIT_1M_FLEET_MEMBER).toBe(300_000);
  });

  it('fleet MEMBER [1m] → window 470k (fires at the 1.2×300k=360k overshoot envelope)', () => {
    const env = autoCompactWindowEnv('claude', 'sonnet[1m]:high', { fleetMember: true });
    expect(env[KEY]).toBe('470000'); // 1.5·300000 + 20000
    expect(ccFirePoint(Number(env[KEY]))).toBe(1.2 * COMPACTION_LIMIT_1M_FLEET_MEMBER);
  });

  it('leader / solo [1m] → window 620k (fires at the 1.2×400k=480k overshoot envelope)', () => {
    const leader = autoCompactWindowEnv('claude', 'opus[1m]', { fleetMember: false });
    expect(leader[KEY]).toBe('620000'); // 1.5·400000 + 20000
    expect(ccFirePoint(Number(leader[KEY]))).toBe(1.2 * COMPACTION_LIMIT_1M_LEADER);
    // fleetMember defaults to false ⇒ the leader/solo cap
    expect(autoCompactWindowEnv('claude', 'claude-fable-5[1m]:xhigh')[KEY]).toBe('620000');
  });

  it('every resolved window sits inside CC\'s accepted [1e5, 1e6] clamp', () => {
    for (const [spec, fm] of [['sonnet[1m]', true], ['opus[1m]', false]]) {
      const w = Number(autoCompactWindowEnv('claude', spec, { fleetMember: fm })[KEY]);
      expect(w).toBeGreaterThanOrEqual(100_000);
      expect(w).toBeLessThanOrEqual(1_000_000);
    }
  });

  it('NO override for a non-[1m] spec (a ≤200k session already backstops near its 158k soft limit)', () => {
    expect(autoCompactWindowEnv('claude', 'sonnet', { fleetMember: true })).toEqual({});
    expect(autoCompactWindowEnv('claude', 'haiku')).toEqual({});
    expect(autoCompactWindowEnv('claude', 'claude-fable-5')).toEqual({});
  });

  it('NO override for a non-claude agent, or a null/absent spec (set only when we KNOW it is [1m])', () => {
    expect(autoCompactWindowEnv('omp', 'sonnet[1m]', { fleetMember: true })).toEqual({});
    expect(autoCompactWindowEnv('codex', 'opus[1m]')).toEqual({});
    expect(autoCompactWindowEnv('claude', null)).toEqual({});
    expect(autoCompactWindowEnv('claude', undefined)).toEqual({});
  });
});

describe('isFleetMemberLaunch (P-014 — shapes the [1m] soft-limit leg)', () => {
  it('true only for a named-fleet launch whose role is not leader', () => {
    expect(isFleetMemberLaunch({ fleet: 'backlog-clearance', fleetRole: 'member' })).toBe(true);
    expect(isFleetMemberLaunch({ fleet: 'backlog-clearance', fleetRole: 'leader' })).toBe(false);
    expect(isFleetMemberLaunch({ fleet: 'backlog-clearance', fleetRole: null })).toBe(true); // fleet present, not leader
    expect(isFleetMemberLaunch({ fleet: null, fleetRole: null })).toBe(false); // solo
    expect(isFleetMemberLaunch({})).toBe(false);
    expect(isFleetMemberLaunch(undefined)).toBe(false);
  });
});

describe('validateModelSpec + --model guard (WI-1979 — reject a malformed model spec at parse)', () => {
  it('accepts valid aliases, effort specs, full/provider ids, [1m] round-trips, and local ids', () => {
    for (const s of [
      'fable:xhigh', 'opus:max', 'sonnet', 'sonnet:high', 'haiku',
      'opus[1m]:max', 'sonnet[1m]', 'claude-fable-5:xhigh', 'claude-fable-5[1m]',
      'claude-sonnet-5:high', 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'ollama-cc/maxwell1500/ornith-35b:IQ3_M', 'gpt-5-codex', '',
    ]) {
      expect(validateModelSpec(s).ok, s).toBe(true);
    }
  });
  it('accepts an unknown-but-plausible short id that is NOT a close typo (o3 / gpt4 / grok)', () => {
    for (const s of ['o3', 'gpt4', 'grok']) expect(validateModelSpec(s).ok, s).toBe(true);
  });
  it('rejects a hand-typed [1m] marker on a non-family base (the fabel5[1m] incident), with the marker tip + suggestion', () => {
    const r = validateModelSpec('fabel5[1m]');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('do not type it'); // the "[1m] is auto-appended" tip
    expect(r.message).toContain('fable'); // corrective suggestion (Damerau catches the transposition)
  });
  it('rejects a close-typo alias — incl. transpositions — with a "did you mean" suggestion', () => {
    for (const [bad, want] of [
      ['fabel', 'fable'], ['sonet', 'sonnet'], ['sonnet5', 'sonnet'],
      ['opus4', 'opus'], ['opuss', 'opus'], ['fabel5:xhigh', 'fable'],
    ] as const) {
      const r = validateModelSpec(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.message, bad).toContain(want);
    }
  });
  it('rejects the alias-glued-to-version shorthand (sonnet-5 / opus-4.8 / haiku-4) — the common leak that reached the CLI as an unrunnable id', () => {
    for (const [bad, want] of [
      ['sonnet-5', 'sonnet'], ['sonnet-5:high', 'sonnet:high'], ['opus-4.8', 'opus'],
      ['haiku-4', 'haiku'], ['fable-5:xhigh', 'fable:xhigh'], ['opus-4-8', 'opus'], ['sonnet5', 'sonnet'],
    ] as const) {
      const r = validateModelSpec(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.message, bad).toContain(want);
    }
  });
  it('keeps genuine full/versioned ids valid (claude-<fam>-<ver>) — the vendor prefix distinguishes them from the bare-alias shorthand', () => {
    for (const s of ['claude-sonnet-5', 'claude-sonnet-5:high', 'claude-opus-4-8', 'claude-fable-5[1m]']) {
      expect(validateModelSpec(s).ok, s).toBe(true);
    }
  });
  it('parseArgs THROWS the corrective error for --model=fabel5[1m] (covers every launch path)', () => {
    expect(() => parseArgs(['--model=fabel5[1m]'])).toThrow(/fable/);
  });
  it('parseArgs is a no-op on VALID input — a good --model spec still normalizes', () => {
    expect(parseArgs(['--model=fable:xhigh']).model).toBe('fable[1m]:xhigh');
    expect(parseArgs(['--model=opus:max']).model).toBe('opus[1m]:max');
  });
});

describe('validateModelSpec ⟷ validateCloudModelSpec PARITY (WI-1993 drift guard)', () => {
  // node exec's psu-launcher.mjs directly, so it cannot import the operator-core TS twin the
  // fleet:launch-on-plan tool boundary uses (and vice-versa) — same constraint that keeps
  // normalizeModelSpec / DEFAULT_1M_FAMILY_RE in lockstep by convention. This asserts the two
  // copies agree VALUE-FOR-VALUE (ok AND the corrective message) so a change to one that is not
  // mirrored in the other fails CI here, not silently in production.
  const VECTORS = [
    // valid
    'fable:xhigh', 'opus:max', 'sonnet', 'sonnet:high', 'haiku',
    'opus[1m]:max', 'sonnet[1m]', 'claude-fable-5:xhigh', 'claude-fable-5[1m]',
    'claude-sonnet-5:high', 'claude-opus-4-8', 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'ollama-cc/maxwell1500/ornith-35b:IQ3_M', 'gpt-5-codex', '',
    // plausible-unknown (pass)
    'o3', 'gpt4', 'grok',
    // rejected
    'fabel5[1m]', 'fabel', 'sonet', 'sonnet5', 'opus4', 'opuss', 'fabel5:xhigh', 'opus[1m]x',
    // rejected: alias-glued-to-version shorthand (the sonnet-5 leak this guard closes)
    'sonnet-5', 'sonnet-5:high', 'opus-4.8', 'haiku-4', 'fable-5:xhigh', 'opus-4-8',
  ];
  it('the two copies return an identical { ok, message } for every spec', () => {
    for (const s of VECTORS) {
      const a = validateModelSpec(s);
      const b = validateCloudModelSpec(s);
      expect(b.ok, s).toBe(a.ok);
      expect(b.message ?? null, s).toBe(a.message ?? null);
    }
  });
});

describe('cloud model-family/backend coupling (owner Luna→Claude incident 2026-07-10)', () => {
  it('recognizes native Codex and Claude model families', () => {
    expect(cloudModelBackendHint('gpt-5.6-luna:high')).toBe('codex');
    expect(cloudModelBackendHint('gpt-5.6-terra:high')).toBe('codex');
    expect(cloudModelBackendHint('o3')).toBe('codex');
    expect(cloudModelBackendHint('sonnet[1m]:high')).toBe('claude');
    expect(cloudModelBackendHint('claude-fable-5:xhigh')).toBe('claude');
    expect(cloudModelBackendHint('future-provider/model-1')).toBeNull();
  });

  it('infers Codex from the exact Luna spec when --agent is omitted', () => {
    const parsed = parseArgs(['--no-picker', '--model=gpt-5.6-luna:high']);
    expect(parsed.agent).toBe('codex');
    expect(parsed.model).toBe('gpt-5.6-luna:high');
  });

  it('rejects an explicit native backend mismatch regardless of flag order', () => {
    expect(() => parseArgs(['--agent=claude', '--model=gpt-5.6-luna:high'])).toThrow(
      /belongs to the `codex` backend/,
    );
    expect(() => parseArgs(['--model=gpt-5.6-luna:high', '--agent=claude'])).toThrow(
      /belongs to the `codex` backend/,
    );
    expect(() => parseArgs(['--agent=codex', '--model=opus:high'])).toThrow(
      /belongs to the `claude` backend/,
    );
  });

  it('keeps explicit OMP valid for cloud families because OMP is multi-provider', () => {
    expect(validateAgentModelPair('omp', 'gpt-5.6-luna:high')).toEqual({ ok: true });
    expect(parseArgs(['--agent=omp', '--model=gpt-5.6-luna:high']).agent).toBe('omp');
  });
});

describe('suWrapperExtraArgs ⟷ applyRoleModel model:effort CLI-flag PARITY (EI-7138 drift guard)', () => {
  // Extract the flags applyRoleModel APPENDS to a bare `<bin>` baseCmd, as a token
  // array comparable to suWrapperExtraArgs' return shape. Vectors below avoid
  // claude's `[1m]` 1M-family auto-injection (normalizeModelSpec) — a real,
  // INTENTIONAL divergence (psu injects it separately, upstream of
  // suWrapperExtraArgs, in its own parseArgs step; applyRoleModel injects it
  // inline) — by using a non-family model (haiku) so both sides start from the
  // same bare spec and the comparison isolates the model:effort→flag mapping
  // this drift guard actually cares about.
  // codex accepts BOTH `-m` and `--model` (short/long alias pair) — applyRoleModel
  // always emits the long form, suWrapperExtraArgs the short form. Functionally
  // equivalent, not the divergence this guard cares about (the EFFORT handling
  // is), so normalize both to `-m` before comparing.
  function appliedFlags(bin: 'claude' | 'codex' | 'omp', spec: string): string[] {
    const cmd = applyRoleModel(bin, 'x', spec);
    return cmd
      .slice(bin.length)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => (t === '--model' ? '-m' : t));
  }
  const normalize = (args: string[]): string[] => args.map((t) => (t === '--model' ? '-m' : t));

  it('codex: identical argv for every spec vector (the 2026-07-03 effort-drop this ticket tracks)', () => {
    for (const spec of ['gpt-5.5', 'gpt-5.5:low', 'gpt-5.5:high', 'gpt-5.5:xhigh', 'gpt-5.5:max']) {
      expect(appliedFlags('codex', spec), spec).toEqual(normalize(suWrapperExtraArgs('codex', { model: spec })));
    }
  });

  it('claude (non-1M-family spec): identical argv', () => {
    for (const spec of ['haiku', 'haiku:low', 'haiku:high', 'haiku:max', 'anthropic.claude-3-5-sonnet-20241022-v2:0']) {
      expect(appliedFlags('claude', spec), spec).toEqual(normalize(suWrapperExtraArgs('claude', { model: spec })));
    }
  });

  it('omp: identical argv — verbatim passthrough, never split (EI-7138: applyRoleModel used to split it, dropping the effort)', () => {
    for (const spec of ['opus', 'opus:high', 'sonnet:xhigh', 'vendor/model:7b']) {
      expect(appliedFlags('omp', spec), spec).toEqual(normalize(suWrapperExtraArgs('omp', { model: spec })));
    }
  });
});

describe('suWrapperExtraArgs (P-032 omp-parity passthrough)', () => {
  it('parses the new omp-convergence flags', () => {
    // haiku is outside the 1M families so no [1m] injection fires — this
    // passthrough test stays decoupled from the normalization exercised in
    // its own suite above.
    const a = parseArgs(['--no-picker', '--agent=omp', '--model=haiku', '--resume-session=s-7', '--launch-context=/dev/shm/k.md']);
    expect(a.model).toBe('haiku');
    expect(a.resumeSession).toBe('s-7');
    expect(a.launchContext).toBe('/dev/shm/k.md');
  });

  it('omp/claude: --model + -r; codex: -m + resume', () => {
    expect(suWrapperExtraArgs('omp', { model: 'opus', resumeSession: 's-1' })).toEqual(['--model', 'opus', '-r', 's-1']);
    expect(suWrapperExtraArgs('claude', { model: 'sonnet', resumeSession: 's-2' })).toEqual(['--model', 'sonnet', '-r', 's-2']);
    expect(suWrapperExtraArgs('codex', { model: 'gpt-5.5', resumeSession: 's-3' })).toEqual(['-m', 'gpt-5.5', 'resume', 's-3']);
  });

  // The claude CLI takes effort as its own flag — a verbatim `<model>:<effort>` spec
  // silently drops the effort and the session falls back to the box's saved default
  // (the 2026-07-01 sonnet-5:high fleet that came up at xhigh).
  it('claude: splits a recognized `<model>:<effort>` spec into --model + --effort', () => {
    expect(suWrapperExtraArgs('claude', { model: 'claude-sonnet-5:high' })).toEqual(['--model', 'claude-sonnet-5', '--effort', 'high']);
    expect(suWrapperExtraArgs('claude', { model: 'opus:max' })).toEqual(['--model', 'opus', '--effort', 'max']);
    // A non-effort `:` segment (e.g. a bedrock `…-v2:0` id) passes through verbatim.
    expect(suWrapperExtraArgs('claude', { model: 'anthropic.claude-3-5-sonnet-20241022-v2:0' })).toEqual(['--model', 'anthropic.claude-3-5-sonnet-20241022-v2:0']);
    // omp keeps the suffixed spec verbatim — it parses `<model>[:<effort>]` natively.
    expect(suWrapperExtraArgs('omp', { model: 'opus:high' })).toEqual(['--model', 'opus:high']);
  });

  // Same effort-drop class for codex (found 2026-07-03 launching the backlog-clearance
  // codex fleet): codex's `-m` wants a bare id; effort is the config override
  // `-c model_reasoning_effort="…"` with `max` clamped to codex's `xhigh` (mirrors
  // applyRoleModel in harness-invoke-once.ts).
  it('codex: splits a recognized `<model>:<effort>` spec into -m + -c model_reasoning_effort', () => {
    expect(suWrapperExtraArgs('codex', { model: 'gpt-5.5:high' })).toEqual(['-m', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
    expect(suWrapperExtraArgs('codex', { model: 'gpt-5.5:max' })).toEqual(['-m', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"']);
    // bare id stays bare; a non-effort `:` segment passes through verbatim.
    expect(suWrapperExtraArgs('codex', { model: 'gpt-5.5' })).toEqual(['-m', 'gpt-5.5']);
    expect(suWrapperExtraArgs('codex', { model: 'weird:0' })).toEqual(['-m', 'weird:0']);
  });

  it('emits nothing when neither model nor resume is set', () => {
    expect(suWrapperExtraArgs('omp', {})).toEqual([]);
    expect(suWrapperExtraArgs('omp')).toEqual([]);
  });
});

describe('findUntrackedSession (resume a non-psu session by searching the agent stores)', () => {
  const UUID = '0123abcd-1234-5678-9abc-def012345678';
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-stores-')); });
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  it('finds a CLAUDE session by id + recovers cwd from the jsonl (not the dir name)', () => {
    const projDir = join(home, '.claude', 'projects', '-some-dashed-dir');
    mkdirSync(projDir, { recursive: true });
    // The real cwd contains a dash — dir-name decoding would be wrong; the
    // jsonl's "cwd" is authoritative.
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}","cwd":"/home/me/my-repo"}\n`);
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'claude', sessionId: UUID, cwd: '/home/me/my-repo', untracked: true,
    });
  });

  it('finds a CODEX session by id under sessions/YYYY/MM/DD + recovers cwd', () => {
    const dir = join(home, '.codex', 'sessions', '2026', '05', '31');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-05-31T09-00-00-${UUID}.jsonl`), `{"type":"meta","cwd":"/home/me/proj"}\n`);
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'codex', sessionId: UUID, cwd: '/home/me/proj', untracked: true,
    });
  });

  it('EI-155: finds an isolated-config-dir claude session + carries its configDir for the resume', () => {
    // No shared ~/.claude/projects copy — the transcript lives ONLY under the
    // per-session isolated dir (<home>/.papercusp/session-claude/<owner>/projects).
    const owner = 'su-owner-1';
    const configDir = join(home, '.papercusp', 'session-claude', owner);
    const projDir = join(configDir, 'projects', '-iso-dir');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}","cwd":"/home/me/iso-repo"}\n`);
    // EI-9756: a hit here proves psu launched it (only psu creates the isolated
    // per-owner dir structure) — carries psuTracked so resumeFlow skips the
    // misleading "not a tracked psu launch" warning for an ended session that
    // merely fell outside the resumable window.
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'claude', sessionId: UUID, cwd: '/home/me/iso-repo', untracked: true, configDir,
      psuTracked: true,
    });
  });

  it('a non-UUID id → an omp thread name, resumed in the current dir', () => {
    expect(findUntrackedSession('my-thread', { home, cwd: '/here' })).toEqual({
      agent: 'omp', ompThreadId: 'my-thread', cwd: '/here', untracked: true,
    });
  });

  it('returns null for an unknown UUID with no matching file', () => {
    expect(findUntrackedSession(UUID, { home })).toBeNull();
  });

  it('WI-3884: finds a TRACKED codex rollout under su-codex-homes (older than the resumable window) — carries adv id + codexHome + psuTracked', () => {
    // The rollout lives ONLY in the per-session tracked home — the shared
    // ~/.codex store has no copy (tracked launches never write there). This is
    // the owner-hit case: adv row #11582 was outside the 30-row resumable
    // window, so resolveTrackedResumeSession never scanned this home.
    const codexHome = join(home, '.papercusp', 'su-codex-homes', 'session-11582');
    const dir = join(codexHome, 'sessions', '2026', '07', '10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-07-10T14-25-16-${UUID}.jsonl`), `{"type":"meta","cwd":"/home/me/tracked-proj"}\n`);
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'codex', sessionId: UUID, cwd: '/home/me/tracked-proj', untracked: true,
      psuTracked: true, id: 11582, codexHome,
    });
  });

  it('WI-3884: a malformed tracked-home dir name still resolves (adv id null, codexHome kept)', () => {
    const codexHome = join(home, '.papercusp', 'su-codex-homes', 'session-not-a-number');
    const dir = join(codexHome, 'sessions', '2026', '07', '10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-07-10T00-00-00-${UUID}.jsonl`), `{"type":"meta","cwd":"/home/me/odd"}\n`);
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'codex', sessionId: UUID, cwd: '/home/me/odd', untracked: true,
      psuTracked: true, id: null, codexHome,
    });
  });

  it('WI-3884: the shared ~/.codex store wins over the tracked-home scan (a raw session stays a raw resume)', () => {
    const shared = join(home, '.codex', 'sessions', '2026', '07', '10');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, `rollout-2026-07-10T01-00-00-${UUID}.jsonl`), `{"type":"meta","cwd":"/home/me/raw"}\n`);
    const trackedDir = join(home, '.papercusp', 'su-codex-homes', 'session-99', 'sessions', '2026', '07', '10');
    mkdirSync(trackedDir, { recursive: true });
    writeFileSync(join(trackedDir, `rollout-2026-07-10T01-00-00-${UUID}.jsonl`), `{"type":"meta","cwd":"/home/me/tracked"}\n`);
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'codex', sessionId: UUID, cwd: '/home/me/raw', untracked: true,
    });
  });

  it('WI-3884: a CLAUDE store hit wins over a codex tracked-home hit for the same uuid (lookup order pinned)', () => {
    const projDir = join(home, '.claude', 'projects', '-a-dir');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}","cwd":"/home/me/claude-side"}\n`);
    const trackedDir = join(home, '.papercusp', 'su-codex-homes', 'session-7', 'sessions', '2026', '07', '10');
    mkdirSync(trackedDir, { recursive: true });
    writeFileSync(join(trackedDir, `rollout-2026-07-10T01-00-00-${UUID}.jsonl`), `{"type":"meta","cwd":"/home/me/codex-side"}\n`);
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'claude', sessionId: UUID, cwd: '/home/me/claude-side', untracked: true,
    });
  });

  it('WI-3884: a SYMLINKED session dir under su-codex-homes is NOT followed (Dirent.isDirectory is lstat-like)', () => {
    // A rollout reachable ONLY through a symlinked "session-666" must stay
    // invisible — safeReaddir(withFileTypes) reports a symlink as
    // isDirectory()===false, so the scan never recurses through it. Pins the
    // no-follow property the WI-3859 pass established for archive collection.
    const realElsewhere = join(home, 'elsewhere', 'sessions', '2026', '07', '10');
    mkdirSync(realElsewhere, { recursive: true });
    writeFileSync(join(realElsewhere, `rollout-2026-07-10T02-00-00-${UUID}.jsonl`), `{"type":"meta","cwd":"/x"}\n`);
    const root = join(home, '.papercusp', 'su-codex-homes');
    mkdirSync(root, { recursive: true });
    symlinkSync(join(home, 'elsewhere'), join(root, 'session-666'));
    expect(findUntrackedSession(UUID, { home })).toBeNull();
  });

  it('WI-3884: stray files / non-session dirs / homes without sessions/ are skipped without error', () => {
    const root = join(home, '.papercusp', 'su-codex-homes');
    mkdirSync(join(root, 'not-a-session-dir'), { recursive: true }); // wrong prefix
    mkdirSync(join(root, 'session-11'), { recursive: true }); // no sessions/ subdir
    writeFileSync(join(root, 'session-12'), 'a stray FILE, not a dir\n'); // file with the prefix
    const good = join(root, 'session-13', 'sessions', '2026', '07', '10');
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, `rollout-2026-07-10T03-00-00-${UUID}.jsonl`), `{"type":"meta","cwd":"/home/me/ok"}\n`);
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'codex', sessionId: UUID, cwd: '/home/me/ok', untracked: true,
      psuTracked: true, id: 13, codexHome: join(root, 'session-13'),
    });
  });

  it('WI-3884: findTrackedCodexHomeRollout degenerate inputs — null/empty id, missing root, uuid-suffix confusion', () => {
    expect(findTrackedCodexHomeRollout(null as unknown as string, { home })).toBeNull();
    expect(findTrackedCodexHomeRollout('', { home })).toBeNull();
    expect(findTrackedCodexHomeRollout(UUID, { home })).toBeNull(); // no su-codex-homes at all
    // A rollout for a DIFFERENT uuid that merely ENDS with the searched id's
    // tail must not match — the filename match is `-<full id>.jsonl`.
    const dir = join(home, '.papercusp', 'su-codex-homes', 'session-21', 'sessions', '2026', '07', '10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-07-10T04-00-00-ffffffff-ffff-7fff-8fff-${UUID.slice(-12)}.jsonl`), '{"cwd":"/x"}\n');
    expect(findTrackedCodexHomeRollout(UUID, { home })).toBeNull();
  });
});

describe('session-owner index (identity-split fix 2026-07-02 — untracked resume keeps its born SID)', () => {
  const UUID = '0123abcd-1234-5678-9abc-def012345678';
  const FORK_UUID = 'ffffabcd-1234-5678-9abc-def012345678';
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-owners-')); });
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  it('record → recover roundtrips the born coordOwnerId', () => {
    expect(recordSessionOwner(UUID, 'su-born', { home })).toBe(true);
    expect(recoverSessionOwner(UUID, { home })).toBe('su-born');
  });

  it('FIRST WRITE WINS — a later launch under a different SID cannot rebind', () => {
    expect(recordSessionOwner(UUID, 'su-born', { home })).toBe(true);
    expect(recordSessionOwner(UUID, 'su-imposter', { home })).toBe(false);
    expect(recoverSessionOwner(UUID, { home })).toBe('su-born');
  });

  it('never blocks a launch: missing ids are a no-op, misses/corrupt entries recover null', () => {
    expect(recordSessionOwner(null, 'su-x', { home })).toBe(false);
    expect(recordSessionOwner(UUID, null, { home })).toBe(false);
    expect(recoverSessionOwner(UUID, { home })).toBeNull();
    expect(recoverSessionOwner(null, { home })).toBeNull();
    mkdirSync(sessionOwnersRoot(home), { recursive: true });
    writeFileSync(join(sessionOwnersRoot(home), UUID), 'not json\n');
    expect(recoverSessionOwner(UUID, { home })).toBeNull();
  });

  it('carries the adv row id when known (debuggability, not identity)', () => {
    recordSessionOwner(UUID, 'su-born', { home, advSessionId: '42' });
    const raw = JSON.parse(readFileSync(join(sessionOwnersRoot(home), UUID), 'utf8'));
    expect(raw).toMatchObject({ v: 1, ownerId: 'su-born', advSessionId: '42' });
  });

  it('WI-1863: adv-keyed entry resolves an omp launch (no native UUID) to its ownerId', () => {
    // omp launches yield nativeSessionIdFromLaunchArgs=null → the native-id write is a
    // no-op; the launcher ALSO records `adv-<advSessionId>` so a desktop session-<N> is
    // locally resolvable (the 2026-07-03 ornith misdelivery incident).
    expect(recordSessionOwner(nativeSessionIdFromLaunchArgs(['--approval-mode', 'yolo']), 'su-omp-leader', { home })).toBe(false);
    expect(recordSessionOwner('adv-9965', 'su-omp-leader', { home, advSessionId: '9965' })).toBe(true);
    expect(recoverSessionOwner('adv-9965', { home })).toBe('su-omp-leader');
    // first-write-wins holds for adv keys too
    expect(recordSessionOwner('adv-9965', 'su-imposter', { home, advSessionId: '9965' })).toBe(false);
    expect(recoverSessionOwner('adv-9965', { home })).toBe('su-omp-leader');
  });

  it('nativeSessionIdFromLaunchArgs: fresh launch (--session-id) and both resume forms', () => {
    expect(nativeSessionIdFromLaunchArgs(['--session-id', UUID])).toBe(UUID);
    expect(nativeSessionIdFromLaunchArgs([`--session-id=${UUID}`])).toBe(UUID);
    expect(nativeSessionIdFromLaunchArgs(['--resume', UUID, '--dangerously-skip-permissions'])).toBe(UUID);
    expect(nativeSessionIdFromLaunchArgs([`--resume=${UUID}`])).toBe(UUID);
    expect(nativeSessionIdFromLaunchArgs(['resume', UUID])).toBe(UUID); // codex subcommand
  });

  it('nativeSessionIdFromLaunchArgs: a tracked fork binds the FORK id, never the original', () => {
    // launchTrackedFork argv shape: claude --resume <orig> --fork-session --session-id <forkId>
    expect(nativeSessionIdFromLaunchArgs(['--resume', UUID, '--fork-session', '--session-id', FORK_UUID])).toBe(FORK_UUID);
  });

  it('nativeSessionIdFromLaunchArgs: a fork with no forced id binds NOTHING (new id unknowable)', () => {
    expect(nativeSessionIdFromLaunchArgs(['--resume', UUID, '--fork-session'])).toBeNull();
    expect(nativeSessionIdFromLaunchArgs(['fork', UUID])).toBeNull(); // codex fork
  });

  it('nativeSessionIdFromLaunchArgs: non-UUID values and empty argv match nothing', () => {
    expect(nativeSessionIdFromLaunchArgs(['--resume', 'my-omp-thread'])).toBeNull();
    expect(nativeSessionIdFromLaunchArgs([])).toBeNull();
    expect(nativeSessionIdFromLaunchArgs()).toBeNull();
  });

  it('END-TO-END: the untracked-resume path re-attaches the born identity instead of minting', () => {
    // Launch time (runWrapper): the fresh session recorded its binding.
    recordSessionOwner(nativeSessionIdFromLaunchArgs(['--session-id', UUID]), 'su-born', { home });
    // Later, the adv row is gone → findUntrackedSession knows no identity…
    const untracked = { agent: 'claude', sessionId: UUID, cwd: '/x', untracked: true };
    // …but resumeFlow recovers the born owner before resumeEnvFor can mint.
    const born = recoverSessionOwner(untracked.sessionId, { home });
    if (born) (untracked as { coordOwnerId?: string }).coordOwnerId = born;
    expect(resumeEnvFor(untracked, { mintSid: () => 'su-freshly-minted' }).PAPERCUSP_SID).toBe('su-born');
  });
});

describe('mintRecycleArgs (WI-1980 — a cold-loop RECYCLE respawn gets a FRESH --session-id)', () => {
  const UUID = '0123abcd-1234-5678-9abc-def012345678';
  const FRESH = 'ffffabcd-1234-5678-9abc-def012345678';
  const mintId = () => FRESH;

  it('replaces the --session-id VALUE (space form) with a fresh id, preserving everything else', () => {
    const { args, nativeId } = mintRecycleArgs(
      ['claude', '--session-id', UUID, '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'],
      { mintId },
    );
    expect(nativeId).toBe(FRESH);
    expect(args).toEqual([
      'claude', '--session-id', FRESH, '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    ]);
    // The old id must be gone (that collision is the whole bug).
    expect(args).not.toContain(UUID);
  });

  it('replaces the --session-id=<uuid> (equals form) too', () => {
    const { args, nativeId } = mintRecycleArgs(['claude', `--session-id=${UUID}`, '--foo'], { mintId });
    expect(nativeId).toBe(FRESH);
    expect(args).toEqual(['claude', `--session-id=${FRESH}`, '--foo']);
  });

  it('strips warm-resume flags (--resume/--continue/--fork-session) — a recycle is a clean boot', () => {
    // A tracked-fork argv shape carries resume + fork alongside the forced id.
    const { args, nativeId } = mintRecycleArgs(
      ['claude', '--resume', UUID, '--fork-session', '--session-id', UUID, '--add-dir=/d'],
      { mintId },
    );
    expect(nativeId).toBe(FRESH);
    expect(args).toEqual(['claude', '--session-id', FRESH, '--add-dir=/d']);
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--fork-session');
    // The consumed --resume VALUE token is gone too (no dangling uuid).
    expect(args.filter((a) => a === UUID)).toEqual([]);
  });

  it('strips --continue and the --resume=<uuid> equals form', () => {
    const { args } = mintRecycleArgs(['claude', '--continue', `--resume=${UUID}`, '--session-id', UUID], { mintId });
    expect(args).toEqual(['claude', '--session-id', FRESH]);
  });

  it('is a NO-OP (same array ref, nativeId null) when the argv carries no --session-id (e.g. omp)', () => {
    const src = ['omp', '--approval-mode', 'yolo'];
    const out = mintRecycleArgs(src, { mintId });
    expect(out.nativeId).toBeNull();
    expect(out.args).toBe(src); // identity — nothing to rotate, respawn is byte-identical
  });

  it('defaults to a real randomUUID when no mintId is injected (fresh, well-formed, ≠ the old id)', () => {
    const { args, nativeId } = mintRecycleArgs(['claude', '--session-id', UUID]);
    expect(nativeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(nativeId).not.toBe(UUID);
    expect(args).toEqual(['claude', '--session-id', nativeId]);
  });

  it('tolerates empty / missing argv', () => {
    expect(mintRecycleArgs([], { mintId })).toEqual({ args: [], nativeId: null });
    expect(mintRecycleArgs(undefined, { mintId })).toEqual({ args: [], nativeId: null });
  });
});

describe('claudeStoreHasSession (check if claude can resume a specific session)', () => {
  const UUID = '0123abcd-1234-5678-9abc-def012345678';
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-stores-')); });
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  it('returns true when Claude store has the session file', () => {
    const projDir = join(home, '.claude', 'projects', '-some-dir');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it('returns true even if the session file is empty', () => {
    const projDir = join(home, '.claude', 'projects', 'my-proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), '');
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it('searches across multiple project directories', () => {
    // Create session in a different project dir
    const projDir = join(home, '.claude', 'projects', '-other-proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it('returns false when the session file does not exist', () => {
    mkdirSync(join(home, '.claude', 'projects', 'my-proj'), { recursive: true });
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
  });

  it('returns false for null or undefined ids', () => {
    mkdirSync(join(home, '.claude', 'projects', 'my-proj'), { recursive: true });
    expect(claudeStoreHasSession(null, { home })).toBe(false);
    expect(claudeStoreHasSession(undefined, { home })).toBe(false);
    expect(claudeStoreHasSession('', { home })).toBe(false);
  });

  it('returns false when .claude/projects does not exist', () => {
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
  });

  it('EI-155: finds the transcript in the isolated configDir (not the shared store)', () => {
    // The transcript exists ONLY in the per-session isolated config dir.
    const configDir = join(home, '.papercusp', 'session-claude', 'su-owner-2');
    const projDir = join(configDir, 'projects', '-iso');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    // Without the configDir hint, the shared store has nothing → false…
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
    // …with it, the brain transcript-check finds the isolated session → true.
    expect(claudeStoreHasSession(UUID, { home, configDir })).toBe(true);
  });
});

describe('claudeStoreHasSession (a tracked adv row alone does not prove resumability)', () => {
  const UUID = '0c0f59c1-1706-4244-aefc-3d6f0aee2361';
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-brain-')); });
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  it('true when the transcript exists in any project dir', () => {
    const projDir = join(home, '.claude', 'projects', '-some-dir');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}","cwd":"/x"}\n`);
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it('false when no transcript exists — the brain-pane wedge case: a pinned + adv-tracked session whose launch died before its first turn', () => {
    mkdirSync(join(home, '.claude', 'projects', '-some-dir'), { recursive: true });
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
  });

  it('false for a missing store dir or empty id', () => {
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
    expect(claudeStoreHasSession('', { home })).toBe(false);
  });
});

describe('usePtyHost — managed-pty rollout gate (turn-lifecycle-control Phase 3)', () => {
  const tty = { isTTY: true };
  const notTty = { isTTY: false };

  it('is ON by default for an interactive TTY (managed-pty IS the launch path, D-006)', () => {
    // Flipped 2026-06-08 after the feel-check (P-012/P-015). A bare interactive
    // launch now goes through the managed pty.
    expect(PTY_DEFAULT_ON).toBe(true);
    expect(usePtyHost({ env: {}, stdin: tty, stdout: tty })).toBe(true);
  });

  it('still needs a real TTY on BOTH ends — a non-TTY launch keeps the plain spawn', () => {
    // brain dock pane / --no-picker scripts have no terminal to bridge.
    expect(usePtyHost({ env: {}, stdin: notTty, stdout: tty })).toBe(false);
    expect(usePtyHost({ env: {}, stdin: tty, stdout: notTty })).toBe(false);
  });

  it('PAPERCUSP_PSU_NO_PTY=1 is an always-wins kill switch', () => {
    expect(usePtyHost({ env: { PAPERCUSP_PSU_NO_PTY: '1' }, stdin: tty, stdout: tty })).toBe(false);
  });

  it('PAPERCUSP_PSU_PTY=0 opts a single launch out of the default', () => {
    expect(usePtyHost({ env: { PAPERCUSP_PSU_PTY: '0' }, stdin: tty, stdout: tty })).toBe(false);
  });

  it('PAPERCUSP_PSU_PTY=1 is still honored as an explicit enable', () => {
    expect(usePtyHost({ env: { PAPERCUSP_PSU_PTY: '1' }, stdin: tty, stdout: tty })).toBe(true);
  });

  describe('PAPERCUSP_PSU_HEADLESS — a headless fleet member keeps the injectable pty despite no TTY (headless-fleet-launch P-001)', () => {
    it('bypasses the isTTY check so a non-TTY launch STILL takes the managed pty', () => {
      // The whole point: without the pty there is no control socket / discovery file,
      // so wake-executor Channel 3 parks the member forever after one turn.
      expect(usePtyHost({ env: { PAPERCUSP_PSU_HEADLESS: '1' }, stdin: notTty, stdout: notTty })).toBe(true);
      expect(usePtyHost({ env: { PAPERCUSP_PSU_HEADLESS: '1' }, stdin: notTty, stdout: tty })).toBe(true);
    });

    it('does NOT override the PAPERCUSP_PSU_NO_PTY kill switch', () => {
      expect(
        usePtyHost({ env: { PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_NO_PTY: '1' }, stdin: notTty, stdout: notTty }),
      ).toBe(false);
    });

    it('does NOT override an explicit PAPERCUSP_PSU_PTY=0 opt-out', () => {
      expect(
        usePtyHost({ env: { PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_PSU_PTY: '0' }, stdin: notTty, stdout: notTty }),
      ).toBe(false);
    });

    it('is inert when unset — a plain non-TTY launch still keeps the plain spawn', () => {
      expect(usePtyHost({ env: {}, stdin: notTty, stdout: notTty })).toBe(false);
    });
  });
});

describe('sessionHasTranscript (ghost rows — adv-tracked launches that never persisted a turn)', () => {
  const UUID = '0123abcd-1234-5678-9abc-def012345678';
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-ghosts-')); });
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  const writeClaudeTranscript = (configDir) => {
    const projDir = join(configDir, 'projects', '-some-dir');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
  };

  it('claude: TRUE when the transcript lives in the EI-155 isolated config dir (derived from coordOwnerId)', () => {
    const owner = 'su-owner-9';
    writeClaudeTranscript(join(home, '.papercusp', 'session-claude', owner));
    expect(sessionHasTranscript({ agent: 'claude', sessionId: UUID, coordOwnerId: owner }, { home })).toBe(true);
  });

  it('claude: TRUE when the transcript lives in the shared ~/.claude store (pre-EI-155 sessions)', () => {
    writeClaudeTranscript(join(home, '.claude'));
    expect(sessionHasTranscript({ agent: 'claude', sessionId: UUID, coordOwnerId: 'su-other' }, { home })).toBe(true);
  });

  it('claude: FALSE for a ghost — known sessionId, no transcript anywhere (the "No conversation found" row)', () => {
    // The launch materialized the config dir but died before its first turn.
    mkdirSync(join(home, '.papercusp', 'session-claude', 'su-ghost', 'projects'), { recursive: true });
    expect(sessionHasTranscript({ agent: 'claude', sessionId: UUID, coordOwnerId: 'su-ghost' }, { home })).toBe(false);
  });

  it('claude: KEEPS a pre-native-id row (no sessionId — resume falls back to --continue, unverifiable)', () => {
    expect(sessionHasTranscript({ agent: 'claude', sessionId: null, coordOwnerId: 'su-legacy' }, { home })).toBe(true);
  });

  it('claude: an explicit session.configDir (untracked isolated hit) wins over the owner derivation', () => {
    const configDir = join(home, 'elsewhere', 'iso-dir');
    writeClaudeTranscript(configDir);
    expect(sessionHasTranscript({ agent: 'claude', sessionId: UUID, configDir }, { home })).toBe(true);
  });

  it('codex: TRUE when the per-session CODEX_HOME holds the rollout; FALSE when it does not', () => {
    const dir = join(home, '.papercusp', 'su-codex-homes', 'session-42', 'sessions', '2026', '06', '12');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-06-12T09-00-00-${UUID}.jsonl`), `{"type":"meta"}\n`);
    expect(sessionHasTranscript({ agent: 'codex', id: 42, sessionId: UUID }, { home })).toBe(true);
    expect(sessionHasTranscript({ agent: 'codex', id: 43, sessionId: UUID }, { home })).toBe(false);
  });

  it('codex: KEEPS rows it cannot verify (no sessionId → `resume --last`; no row id → no home to check)', () => {
    expect(sessionHasTranscript({ agent: 'codex', id: 42, sessionId: null }, { home })).toBe(true);
    expect(sessionHasTranscript({ agent: 'codex', id: null, sessionId: UUID }, { home })).toBe(true);
  });

  it('omp: always kept (the thread store is not path-indexed here)', () => {
    expect(sessionHasTranscript({ agent: 'omp', ompThreadId: 't-1' }, { home })).toBe(true);
  });
});

describe('WI-3758 — psu --resume model select + last-active model', () => {
  it('modelArgsFor maps a spec onto each backend (and stays in lockstep with suWrapperExtraArgs)', () => {
    // claude: a recognized :effort tail splits into the CLI's own --effort flag.
    expect(modelArgsFor('claude', 'claude-sonnet-5:high')).toEqual(['--model', 'claude-sonnet-5', '--effort', 'high']);
    // …but a non-effort ':' segment (bedrock version) passes through verbatim.
    expect(modelArgsFor('claude', 'anthropic.claude-3-5-sonnet-v2:0')).toEqual(['--model', 'anthropic.claude-3-5-sonnet-v2:0']);
    // codex: bare -m + config-override effort, max clamped to xhigh.
    expect(modelArgsFor('codex', 'gpt-5.5:max')).toEqual(['-m', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"']);
    expect(modelArgsFor('codex', 'gpt-5.5')).toEqual(['-m', 'gpt-5.5']);
    // omp understands the suffixed spec natively.
    expect(modelArgsFor('omp', 'opus:high')).toEqual(['--model', 'opus:high']);
    expect(modelArgsFor('claude', null)).toEqual([]);
    // The wrapper path delegates — a divergence here would resurrect the effort-drop class.
    for (const [agent, spec] of [['claude', 'fable:high'], ['codex', 'gpt-5.5:max'], ['omp', 'opus:low']] as const) {
      expect(suWrapperExtraArgs(agent, { model: spec })).toEqual(modelArgsFor(agent, spec));
    }
  });

  it('resumeArgsFor threads a model into each backend resume — codex flags BEFORE the subcommand', () => {
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'uuid-1' }, { model: 'fable:high' }).args).toEqual([
      '--resume', 'uuid-1', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', NO_SUBAGENTS_DENY_FLAG, '--model', 'fable', '--effort', 'high',
    ]);
    // codex `-m`/`-c` are TOP-LEVEL options — after the `resume` subcommand they'd
    // be parsed as resume's own args and fail the launch.
    expect(resumeArgsFor({ agent: 'codex', sessionId: 'uuid-2' }, { model: 'gpt-5.6-sol:high' }).args).toEqual([
      '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"', 'resume', 'uuid-2',
    ]);
    expect(resumeArgsFor({ agent: 'omp', ompThreadId: 'thr-1' }, { model: 'opus:high' }).args).toEqual([
      '-r', 'thr-1', '--approval-mode', 'yolo', '--model', 'opus:high',
    ]);
    // No model → byte-identical to the pre-WI-3758 args (the agent-default path).
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'uuid-1' }).args).not.toContain('--model');
  });

  describe('lastActiveModelFor (tail-read the session transcript)', () => {
    const UUID = '0123abcd-1234-5678-9abc-def012345678';
    let home = '';
    beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-lastmodel-')); });
    afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

    const writeJsonl = (file: string, lines: unknown[]) => {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    };

    it('claude: the NEWEST assistant model wins; <synthetic> (error events) is skipped', () => {
      const owner = 'su-owner-1';
      const f = join(home, '.papercusp', 'session-claude', owner, 'projects', '-some-dir', `${UUID}.jsonl`);
      writeJsonl(f, [
        { type: 'user', message: { content: 'hi' } },
        { type: 'assistant', message: { model: 'claude-fable-5-20260101', content: [] } },
        { type: 'assistant', message: { model: 'claude-fable-5-20260415', content: [] } },
        { type: 'assistant', message: { model: '<synthetic>', content: [] } },
      ]);
      expect(lastActiveModelFor({ agent: 'claude', sessionId: UUID, coordOwnerId: owner }, { home })).toBe('claude-fable-5-20260415');
    });

    it('codex: the NEWEST turn_context payload.model wins (tracked per-session CODEX_HOME)', () => {
      const f = join(home, '.papercusp', 'su-codex-homes', 'session-42', 'sessions', '2026', '07', '09', `rollout-2026-07-09T22-08-28-${UUID}.jsonl`);
      writeJsonl(f, [
        { type: 'session_meta', payload: { id: UUID, model_provider: 'openai' } },
        { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
        { type: 'turn_context', payload: { model: 'gpt-5.6-lux' } },
        { type: 'response_item', payload: { role: 'assistant' } },
      ]);
      expect(lastActiveModelFor({ agent: 'codex', id: 42, sessionId: UUID }, { home })).toBe('gpt-5.6-lux');
    });

    it('codex: an UNTRACKED session (no adv row id) falls back to the shared ~/.codex store', () => {
      const f = join(home, '.codex', 'sessions', '2026', '07', '10', `rollout-2026-07-10T00-00-00-${UUID}.jsonl`);
      writeJsonl(f, [
        { type: 'session_meta', payload: { id: UUID } },
        { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      ]);
      expect(sessionTranscriptFile({ agent: 'codex', id: null, sessionId: UUID }, { home })).toBe(f);
      expect(lastActiveModelFor({ agent: 'codex', id: null, sessionId: UUID }, { home })).toBe('gpt-5.6-sol');
    });

    it('degrades to null: omp, a missing transcript, and a transcript with no model events', () => {
      expect(lastActiveModelFor({ agent: 'omp', ompThreadId: 't-1' }, { home })).toBe(null);
      expect(lastActiveModelFor({ agent: 'claude', sessionId: UUID, coordOwnerId: 'su-none' }, { home })).toBe(null);
      const owner = 'su-owner-2';
      const f = join(home, '.papercusp', 'session-claude', owner, 'projects', '-d', `${UUID}.jsonl`);
      writeJsonl(f, [{ type: 'user', message: { content: 'hi' } }]);
      expect(lastActiveModelFor({ agent: 'claude', sessionId: UUID, coordOwnerId: owner }, { home })).toBe(null);
    });
  });
});

describe('reportSessionEnded (stamp adv ended_at on child exit — best-effort, never rejects)', () => {
  it('POSTs the row id + exit code to bootstrap-su/session-ended with the bearer', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
    await reportSessionEnded('17', 0, { fetchImpl, operatorUrl: 'http://op:1', token: 'tok-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://op:1/api/agent-mcp/console/bootstrap-su/session-ended');
    expect(calls[0].opts.headers.authorization).toBe('Bearer tok-1');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ advSessionId: 17, exitCode: 0 });
  });

  it('maps a null/undefined exit code to null (signal exits)', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
    await reportSessionEnded(17, undefined, { fetchImpl, operatorUrl: 'http://op:1', token: 't' });
    expect(JSON.parse(calls[0].opts.body)).toEqual({ advSessionId: 17, exitCode: null });
  });

  it('no adv row id → no request (untracked sessions have nothing to stamp)', async () => {
    const calls = [];
    const fetchImpl = async (...a) => { calls.push(a); return { ok: true }; };
    await reportSessionEnded(null, 0, { fetchImpl, operatorUrl: 'http://op:1', token: 't' });
    expect(calls).toHaveLength(0);
  });

  it('swallows transport failures — psu is about to exit; end-stamping must never hold the terminal', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    await expect(
      reportSessionEnded(17, 1, { fetchImpl, operatorUrl: 'http://op:1', token: 't' }),
    ).resolves.toBeUndefined();
  });
});

describe('startSupervisorBeat (WI-3898 P1: the beat self-reports its own pid/host)', () => {
  it('the immediate first beat POSTs { ownerId, pid: process.pid, host: hostname() }', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
    const fakeTimer = { unref: () => {} };
    startSupervisorBeat('su-abc', {
      fetchImpl,
      operatorUrl: 'http://op:1',
      token: 't',
      setIntervalImpl: () => fakeTimer,
    });
    // startSupervisorBeat fires an immediate `void beat()` (fire-and-forget)
    // before returning — flush a microtask so it lands before we assert.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://op:1/api/agent-mcp/console/bootstrap-su/heartbeat');
    const body = JSON.parse(calls[0].opts.body);
    expect(body).toEqual({ ownerId: 'su-abc', pid: process.pid, host: hostname() });
  });

  it('returns null and never beats when ownerId is falsy', () => {
    const calls = [];
    const fetchImpl = async (...a) => { calls.push(a); return { ok: true }; };
    const timer = startSupervisorBeat('', { fetchImpl, setIntervalImpl: () => ({ unref: () => {} }) });
    expect(timer).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('schedules the recurring beat on the injected interval (same pid/host body each tick)', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
    let tickFn;
    const setIntervalImpl = (fn) => { tickFn = fn; return { unref: () => {} }; };
    startSupervisorBeat('su-abc', { fetchImpl, operatorUrl: 'http://op:1', token: 't', setIntervalImpl });
    await new Promise((r) => setTimeout(r, 0)); // the immediate beat
    expect(calls).toHaveLength(1);
    tickFn(); // simulate one interval tick
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].opts.body)).toEqual(JSON.parse(calls[0].opts.body));
  });
});

describe('reportSessionResumed (re-activate adv row on resume — best-effort, never rejects)', () => {
  it('POSTs the row id to bootstrap-su/session-resumed with the bearer', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
    await reportSessionResumed('42', { fetchImpl, operatorUrl: 'http://op:1', token: 'tok-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://op:1/api/agent-mcp/console/bootstrap-su/session-resumed');
    expect(calls[0].opts.headers.authorization).toBe('Bearer tok-1');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ advSessionId: 42 });
  });

  it('no adv row id → no request (untracked resumes have no row to re-activate)', async () => {
    const calls = [];
    const fetchImpl = async (...a) => { calls.push(a); return { ok: true }; };
    await reportSessionResumed(null, { fetchImpl, operatorUrl: 'http://op:1', token: 't' });
    expect(calls).toHaveLength(0);
  });

  it('swallows transport failures — a resume must never wait on or fail from the re-activation', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    await expect(
      reportSessionResumed(42, { fetchImpl, operatorUrl: 'http://op:1', token: 't' }),
    ).resolves.toBeUndefined();
  });
});

// EI-9756 regression guard: "archive a session, then resume it, and assert the
// conversation actually continues" — the report's own requested GUARD. The
// deeper archive/rematerialize byte-fidelity is covered by
// session-archive.test.ts; this pins the CLI-side glue (previously wired but
// completely untested) that psu --resume depends on to recover a session
// whose transcript the archive-at-death lifecycle deletes ~15s after every
// session end (WI-3859 F4) — NOT just a stale/swept one.
describe('tryRematerializeFromArchive (psu --resume self-heals a transcript the archive-at-death hook deleted)', () => {
  it('POSTs sessionId (+ sourceKind when given) and returns the parsed result on ok:true', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return { json: async () => ({ ok: true, sourceKind: 'claude', written: 1, root: '/tmp/restored' }) };
    };
    const r = await tryRematerializeFromArchive('sid-1', 'claude', { fetchImpl, operatorUrl: 'http://op:1', token: 'tok-1' });
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://op:1/api/adv/sessions/rematerialize');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.headers.authorization).toBe('Bearer tok-1');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ sessionId: 'sid-1', sourceKind: 'claude' });
    expect(r).toEqual({ ok: true, sourceKind: 'claude', written: 1, root: '/tmp/restored' });
  });

  it('omits sourceKind when not given (probes all three archive kinds)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push(opts); return { json: async () => ({ ok: true, written: 0 }) }; };
    await tryRematerializeFromArchive('sid-2', null, { fetchImpl, operatorUrl: 'http://op:1', token: 't' });
    expect(JSON.parse(calls[0].body)).toEqual({ sessionId: 'sid-2' });
    errSpy.mockRestore();
  });

  it('no sessionId → no request, returns null', async () => {
    const calls = [];
    const fetchImpl = async (...a) => { calls.push(a); return { json: async () => ({ ok: true }) }; };
    expect(await tryRematerializeFromArchive(null, 'claude', { fetchImpl, operatorUrl: 'http://op:1', token: 't' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('ok:false (not_archived / sha_mismatch / …) → returns null, never throws', async () => {
    const fetchImpl = async () => ({ json: async () => ({ ok: false, reason: 'not_archived' }) });
    expect(await tryRematerializeFromArchive('sid-3', null, { fetchImpl, operatorUrl: 'http://op:1', token: 't' })).toBeNull();
  });

  it('transport failure / unreachable operator → swallowed, returns null (never blocks the fallback not-found error)', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    await expect(
      tryRematerializeFromArchive('sid-4', null, { fetchImpl, operatorUrl: 'http://op:1', token: 't' }),
    ).resolves.toBeNull();
  });

  it('non-JSON / malformed response body → swallowed, returns null', async () => {
    const fetchImpl = async () => ({ json: async () => { throw new SyntaxError('Unexpected token'); } });
    expect(await tryRematerializeFromArchive('sid-5', null, { fetchImpl, operatorUrl: 'http://op:1', token: 't' })).toBeNull();
  });
});

describe('fetchWithResilience (psu connection-retry hardening)', () => {
  // A fake clock advanced by the injected sleep makes retry timing deterministic
  // without real timers or sockets.
  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }
  const connFail = () => { throw new TypeError('fetch failed'); };
  const timeoutErr = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  // Pin the target so these tests never inherit the RUNNER box's real
  // operator.json via the module-level OPERATOR_TARGET default (WI-3271).
  const devTarget = { url: 'http://op', source: 'dev-default', startedAt: null };

  it('rides through a recycle: retries a connection failure on a backoff and returns once the host is back', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => { n += 1; if (n < 3) connFail(); return { ok: true, id: 'live' } as unknown as Response; };
    const res = await fetchWithResilience('http://op/x', {}, {
      fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, connectBudgetMs: 30_000, target: devTarget,
    });
    expect((res as unknown as { id: string }).id).toBe('live');
    expect(n).toBe(3); // two dead-window failures ridden through, third succeeds
  });

  it('exhausts the connect budget then throws "could not reach … after Ns"', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => { n += 1; connFail(); return undefined as unknown as Response; };
    await expect(
      fetchWithResilience('http://op/x', {}, {
        fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, connectBudgetMs: 5_000, target: devTarget,
      }),
    ).rejects.toThrow(/could not reach the operator .* after \d+s/);
    expect(n).toBeGreaterThan(1); // it retried within the budget, not a single shot
  });

  it('announces the connection retry exactly once, not per attempt', async () => {
    const clock = fakeClock();
    const notices: string[] = [];
    const fetchImpl = async () => { connFail(); return undefined as unknown as Response; };
    await fetchWithResilience('http://op/x', {}, {
      fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: (m) => notices.push(m), connectBudgetMs: 6_000, target: devTarget,
    }).catch(() => {});
    expect(notices.filter((m) => /unreachable .* retrying for up to/.test(m))).toHaveLength(1);
  });

  it('caps timeout retries (reachable-but-slow) and throws "did not respond within"', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => { n += 1; timeoutErr(); return undefined as unknown as Response; };
    await expect(
      fetchWithResilience('http://op/x', {}, {
        fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, timeoutRetries: 1, target: devTarget,
      }),
    ).rejects.toThrow(/did not respond within \d+ms/);
    expect(n).toBe(2); // initial attempt + 1 capped retry, then give up
  });

  it('a caller-supplied AbortSignal disables retry (caller owns the lifetime)', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => { n += 1; connFail(); return undefined as unknown as Response; };
    const ac = new AbortController();
    await expect(
      fetchWithResilience('http://op/x', { signal: ac.signal }, {
        fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, connectBudgetMs: 30_000, target: devTarget,
      }),
    ).rejects.toThrow(/could not reach/);
    expect(n).toBe(1); // single attempt — no retry when the caller owns the signal
  });

  // ── WI-3271: dead-desktop fail-fast (the owner's "psu → nothing happened") ──

  it('STALE desktop discovery + refused → fails FAST (~5s, not the 30s budget) with "start the Papercusp app" guidance', async () => {
    const clock = fakeClock();
    // startedAt an hour before the fake clock's origin → record is stale.
    const staleTarget = { url: 'http://127.0.0.1:21487', source: 'discovery', startedAt: -3_600_000 };
    const fetchImpl = async () => { connFail(); return undefined as unknown as Response; };
    await expect(
      fetchWithResilience('http://127.0.0.1:21487/x', {}, {
        fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, connectBudgetMs: 30_000, target: staleTarget,
      }),
    ).rejects.toThrow(/Papercusp app's server isn't running .*Start \(or restart\) the Papercusp desktop app/);
    expect(clock.now()).toBeLessThanOrEqual(6_000); // fast fail — never burned the 30s ride-through
  });

  it('FRESH desktop discovery + refused → keeps the full ride-through (operator plausibly mid-boot), desktop-flavored final error', async () => {
    const clock = fakeClock();
    const freshTarget = { url: 'http://127.0.0.1:21487', source: 'discovery', startedAt: -60_000 }; // 1 min old
    const fetchImpl = async () => { connFail(); return undefined as unknown as Response; };
    await expect(
      fetchWithResilience('http://127.0.0.1:21487/x', {}, {
        fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, connectBudgetMs: 30_000, target: freshTarget,
      }),
    ).rejects.toThrow(/Start \(or restart\) the Papercusp desktop app/);
    expect(clock.now()).toBeGreaterThanOrEqual(30_000); // full budget honored for a mid-restart window
  });

  it('desktop discovery TIMEOUT advice says restart-the-app, never dev-box systemctl', async () => {
    const clock = fakeClock();
    const target = { url: 'http://127.0.0.1:21487', source: 'discovery', startedAt: -60_000 };
    const fetchImpl = async () => { timeoutErr(); return undefined as unknown as Response; };
    const err = await fetchWithResilience('http://127.0.0.1:21487/x', {}, {
      fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, timeoutRetries: 0, target,
    }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/restart the Papercusp desktop app/);
    expect(err?.message).not.toMatch(/systemctl/);
  });

  it('stale-desktop announce notice names the app and the short check window, once', async () => {
    const clock = fakeClock();
    const staleTarget = { url: 'http://127.0.0.1:21487', source: 'discovery', startedAt: -3_600_000 };
    const notices: string[] = [];
    const fetchImpl = async () => { connFail(); return undefined as unknown as Response; };
    await fetchWithResilience('http://127.0.0.1:21487/x', {}, {
      fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: (m) => notices.push(m), connectBudgetMs: 30_000, target: staleTarget,
    }).catch(() => {});
    expect(notices.filter((m) => /Papercusp app's server .* isn't answering .* checking for 5s/.test(m))).toHaveLength(1);
  });

  // ── stale-shell heal (mac VM owner repro 2026-07-07): a dead env-pinned
  //    target fails over to a health-checked live operator instead of burning
  //    the whole budget on a port the terminal window outlived. ──

  const envTarget = { url: 'http://127.0.0.1:59999', source: 'env', startedAt: null };

  it('dead env pin + healthy discovery fallback → switches, adopts, and succeeds on the live operator', async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const fetchImpl = async (u: string) => {
      seen.push(u);
      if (u.startsWith('http://127.0.0.1:59999')) connFail();
      return { ok: true, id: 'live' } as unknown as Response;
    };
    const notices: string[] = [];
    const adopted: Array<{ url: string }> = [];
    const res = await fetchWithResilience('http://127.0.0.1:59999/x', {}, {
      fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: (m) => notices.push(m),
      connectBudgetMs: 30_000, target: envTarget,
      resolveFallback: () => [{ url: 'http://127.0.0.1:21960', source: 'discovery', startedAt: null }],
      onFailover: (t: { url: string }) => adopted.push(t),
    });
    expect((res as unknown as { id: string }).id).toBe('live');
    expect(seen).toContain('http://127.0.0.1:21960/api/health'); // health-gated, not a blind switch
    expect(seen).toContain('http://127.0.0.1:21960/x'); // request rebased onto the live origin
    expect(adopted.map((t) => t.url)).toEqual(['http://127.0.0.1:21960']); // adopted session-wide
    expect(notices.some((m) => /switching/.test(m) && /PAPERCUSP_OPERATOR_URL/.test(m))).toBe(true);
  });

  it('an UNHEALTHY fallback candidate is skipped — no switch, original budget-exhausted failure', async () => {
    const clock = fakeClock();
    const adopted: string[] = [];
    const fetchImpl = async (u: string) => {
      if (u.endsWith('/api/health')) return { ok: false } as unknown as Response; // candidate up but unhealthy
      connFail();
      return undefined as unknown as Response;
    };
    await expect(
      fetchWithResilience('http://127.0.0.1:59999/x', {}, {
        fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {},
        connectBudgetMs: 5_000, target: envTarget,
        resolveFallback: () => [{ url: 'http://127.0.0.1:21960', source: 'discovery', startedAt: null }],
        onFailover: (t: { url: string }) => adopted.push(t.url),
      }),
    ).rejects.toThrow(/PAPERCUSP_OPERATOR_URL \(.*\) refused connections .*`unset PAPERCUSP_OPERATOR_URL`/s);
    expect(adopted).toEqual([]); // never adopted an unhealthy target
  });

  it('failover is attempted exactly ONCE per call, and never for a caller-custom URL outside the target base', async () => {
    const clock = fakeClock();
    let resolves = 0;
    const fetchImpl = async () => { connFail(); return undefined as unknown as Response; };
    await fetchWithResilience('http://127.0.0.1:59999/x', {}, {
      fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {},
      connectBudgetMs: 10_000, target: envTarget,
      resolveFallback: () => { resolves += 1; return []; },
    }).catch(() => {});
    expect(resolves).toBe(1);

    resolves = 0;
    await fetchWithResilience('http://other-host:1234/x', {}, {
      fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {},
      connectBudgetMs: 5_000, target: envTarget,
      resolveFallback: () => { resolves += 1; return []; },
    }).catch(() => {});
    expect(resolves).toBe(0); // custom URL not under target.url — never rebased
  });
});

describe('resolveFallbackOperatorTargets (stale-shell heal candidate ladder)', () => {
  it('lists proxy then discovery (from operator.json) then dev default, excluding the dead URL', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-fallback-'));
    try {
      mkdirSync(join(home, '.papercusp'), { recursive: true });
      writeFileSync(
        join(home, '.papercusp', 'operator.json'),
        JSON.stringify({ httpUrl: 'http://127.0.0.1:21960', startedAt: Date.now() }),
      );
      const out = resolveFallbackOperatorTargets({ env: {}, home, excludeUrls: ['http://127.0.0.1:59999'] });
      expect(out.map((c) => c.source)).toEqual(['proxy', 'discovery', 'dev-default']);
      expect(out[1]!.url).toBe('http://127.0.0.1:21960');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('respects PAPERCUSP_MCP_PROXY=0 (no proxy candidate) and a missing operator.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-fallback-'));
    try {
      const out = resolveFallbackOperatorTargets({ env: { PAPERCUSP_MCP_PROXY: '0' }, home });
      expect(out.map((c) => c.source)).toEqual(['dev-default']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('operator endpoint resolution (desktop vs dev box)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'psu-op-'));
    mkdirSync(join(home, '.papercusp'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const writeOperatorJson = (obj: unknown) =>
    writeFileSync(join(home, '.papercusp', 'operator.json'), JSON.stringify(obj));

  describe('resolveOperatorUrl', () => {
    const noProxy = () => false;

    it('falls back to the dev-box :3070 when no operator.json and no proxy (the dev box)', () => {
      expect(resolveOperatorUrl({ env: {}, home, probe: noProxy })).toBe('http://localhost:3070');
    });

    it('reads the desktop operator httpUrl from operator.json (the shipping bug fix)', () => {
      writeOperatorJson({ httpUrl: 'http://127.0.0.1:24689', port: '24689', token: 'abc' });
      expect(resolveOperatorUrl({ env: {}, home, probe: noProxy })).toBe('http://127.0.0.1:24689');
    });

    it('synthesizes a URL from port when httpUrl is absent', () => {
      writeOperatorJson({ port: '31337', token: 'abc' });
      expect(resolveOperatorUrl({ env: {}, home, probe: noProxy })).toBe('http://127.0.0.1:31337');
    });

    it('PAPERCUSP_OPERATOR_URL env overrides operator.json (explicit wins)', () => {
      writeOperatorJson({ httpUrl: 'http://127.0.0.1:24689' });
      expect(
        resolveOperatorUrl({ env: { PAPERCUSP_OPERATOR_URL: 'http://override:9999' }, home, probe: noProxy }),
      ).toBe('http://override:9999');
    });

    it('falls back to :3070 on a malformed operator.json', () => {
      writeFileSync(join(home, '.papercusp', 'operator.json'), '{ not json');
      expect(resolveOperatorUrl({ env: {}, home, probe: noProxy })).toBe('http://localhost:3070');
    });

    // ── WI-3271: resolveOperatorTarget carries the SOURCE + record age so the
    // connection-failure path can tell a dead desktop from a dev box ──

    it('resolveOperatorTarget: operator.json → source "discovery" with its startedAt', () => {
      writeOperatorJson({ httpUrl: 'http://127.0.0.1:24689', port: 24689, startedAt: 1783377109561 });
      expect(resolveOperatorTarget({ env: {}, home, probe: noProxy })).toEqual({
        url: 'http://127.0.0.1:24689',
        source: 'discovery',
        startedAt: 1783377109561,
      });
    });

    it('resolveOperatorTarget: missing/invalid startedAt stays null (age unknown → no fast-fail)', () => {
      writeOperatorJson({ httpUrl: 'http://127.0.0.1:24689' });
      expect(resolveOperatorTarget({ env: {}, home, probe: noProxy }).startedAt).toBeNull();
    });

    it('resolveOperatorTarget: env override → source "env"; bare dev box → "dev-default"', () => {
      expect(
        resolveOperatorTarget({ env: { PAPERCUSP_OPERATOR_URL: 'http://override:9999' }, home, probe: noProxy }),
      ).toEqual({ url: 'http://override:9999', source: 'env', startedAt: null });
      expect(resolveOperatorTarget({ env: {}, home, probe: noProxy })).toEqual({
        url: 'http://localhost:3070',
        source: 'dev-default',
        startedAt: null,
      });
    });

    // ── WI-1457: the resilient MCP proxy preference (re-cutover hardening) ──

    it('prefers the ACTIVE resilient proxy over direct :3070 on the dev box', () => {
      const probed: number[] = [];
      const url = resolveOperatorUrl({
        env: {},
        home,
        probe: (port: number) => {
          probed.push(port);
          return true;
        },
      });
      expect(url).toBe('http://127.0.0.1:9071');
      expect(probed).toEqual([9071]);
    });

    it('PAPERCUSP_MCP_PROXY=0 opts out without even probing', () => {
      let probes = 0;
      const url = resolveOperatorUrl({
        env: { PAPERCUSP_MCP_PROXY: '0' },
        home,
        probe: () => {
          probes++;
          return true;
        },
      });
      expect(url).toBe('http://localhost:3070');
      expect(probes).toBe(0);
    });

    it('honors PAPERCUSP_MCP_PROXY_PORT for both the probe and the url', () => {
      const probed: number[] = [];
      const url = resolveOperatorUrl({
        env: { PAPERCUSP_MCP_PROXY_PORT: '9171' },
        home,
        probe: (port: number) => {
          probed.push(port);
          return true;
        },
      });
      expect(url).toBe('http://127.0.0.1:9171');
      expect(probed).toEqual([9171]);
    });

    it('WI-3247: active proxy wins over desktop operator.json so child env stays stable across dynamic port restarts', () => {
      writeOperatorJson({ httpUrl: 'http://127.0.0.1:24689' });
      expect(resolveOperatorUrl({ env: {}, home, probe: () => true })).toBe('http://127.0.0.1:9071');
      expect(resolveOperatorTarget({ env: {}, home, probe: () => true })).toEqual({
        url: 'http://127.0.0.1:9071',
        source: 'proxy',
        startedAt: null,
      });
    });

    it('warns (active-but-unrouted) when an explicit :3070 pin bypasses a live proxy — override still wins', () => {
      const warnings: string[] = [];
      const url = resolveOperatorUrl({
        env: { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070' },
        home,
        probe: () => true,
        warn: (m: string) => warnings.push(m),
      });
      expect(url).toBe('http://localhost:3070'); // explicit override is honored
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/WI-1457/);
      expect(warnings[0]).toMatch(/:9071/);
    });

    it('does NOT warn on a :3070 pin when the proxy is down (nothing to route through)', () => {
      const warnings: string[] = [];
      resolveOperatorUrl({
        env: { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070' },
        home,
        probe: noProxy,
        warn: (m: string) => warnings.push(m),
      });
      expect(warnings).toHaveLength(0);
    });
  });

  describe('readToken', () => {
    it('prefers the superuser-token file', () => {
      writeFileSync(join(home, '.papercusp', 'superuser-token'), 'tok-from-file\n');
      writeOperatorJson({ token: 'tok-from-operator-json' });
      expect(readToken({ home })).toBe('tok-from-file');
    });

    it('falls back to operator.json.token when superuser-token is absent (fresh desktop)', () => {
      writeOperatorJson({ httpUrl: 'http://127.0.0.1:24689', token: 'tok-from-operator-json' });
      expect(readToken({ home })).toBe('tok-from-operator-json');
    });

    it('returns empty string when neither source exists (dev-box open operator)', () => {
      expect(readToken({ home })).toBe('');
    });
  });
});

describe('default-account Claude OAuth token inheritance (psu-login-inherit / macOS keychain trap)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'psu-claude-oauth-'));
    mkdirSync(join(home, '.papercusp'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const TOKEN = 'sk-ant-oat01-EXAMPLE-token-value';

  describe('store / read round-trip', () => {
    it('reads null when no token is stored', () => {
      expect(readStoredClaudeOAuthToken({ home })).toBeNull();
    });

    it('persists the token 0600 and reads it back trimmed', () => {
      const p = storeClaudeOAuthToken(`  ${TOKEN}\n`, { home });
      expect(p).toBe(claudeOAuthTokenPath({ home }));
      expect(readStoredClaudeOAuthToken({ home })).toBe(TOKEN);
      // 0600 — owner-only (the file holds a long-lived credential).
      expect(statSync(p).mode & 0o777).toBe(0o600);
    });

    it('refuses to store an empty token', () => {
      expect(() => storeClaudeOAuthToken('   ', { home })).toThrow(/empty/i);
    });
  });

  describe('applyDefaultClaudeOAuthToken — when it injects', () => {
    it('injects CLAUDE_CODE_OAUTH_TOKEN for a default-account claude launch', () => {
      storeClaudeOAuthToken(TOKEN, { home });
      const env: Record<string, string> = {};
      applyDefaultClaudeOAuthToken('claude-su', env, { home });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    });

    it('injects on a RAW claude resume (bin `claude`) and an absolute path', () => {
      storeClaudeOAuthToken(TOKEN, { home });
      for (const bin of ['claude', '/Users/x/.papercusp/bin/claude', '/usr/lib/p/bin/claude-su']) {
        const env: Record<string, string> = {};
        applyDefaultClaudeOAuthToken(bin, env, { home });
        expect(env.CLAUDE_CODE_OAUTH_TOKEN, bin).toBe(TOKEN);
      }
    });
  });

  describe('applyDefaultClaudeOAuthToken — when it stays a no-op (env byte-identical)', () => {
    it('does nothing when no token is stored (keychain/file login as before)', () => {
      const env: Record<string, string> = {};
      applyDefaultClaudeOAuthToken('claude-su', env, { home });
      expect(env).toEqual({});
    });

    it('skips non-claude backends (codex/omp authenticate by their own file creds)', () => {
      storeClaudeOAuthToken(TOKEN, { home });
      for (const bin of ['codex-su', 'codex', 'omp-su', 'omp', '/path/to/codex']) {
        const env: Record<string, string> = {};
        applyDefaultClaudeOAuthToken(bin, env, { home });
        expect(env.CLAUDE_CODE_OAUTH_TOKEN, bin).toBeUndefined();
      }
    });

    it('skips when an inference-gateway account is pinned (ANTHROPIC_BASE_URL set)', () => {
      storeClaudeOAuthToken(TOKEN, { home });
      const env: Record<string, string> = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' };
      applyDefaultClaudeOAuthToken('claude-su', env, { home });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('respects an explicit user token/key already in the env', () => {
      storeClaudeOAuthToken(TOKEN, { home });
      for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
        const env: Record<string, string> = { [key]: 'user-supplied' };
        applyDefaultClaudeOAuthToken('claude-su', env, { home });
        // never overwrite what the user explicitly set
        expect(env[key]).toBe('user-supplied');
        if (key !== 'CLAUDE_CODE_OAUTH_TOKEN') expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      }
    });
  });

  describe('parseArgs — credential maintenance commands', () => {
    it('parses --set-claude-token (bare, prompts for a paste)', () => {
      const a = parseArgs(['--set-claude-token']);
      expect(a.setClaudeToken).toBe(true);
      expect(a.setClaudeTokenValue).toBeNull();
    });

    it('parses the inline --set-claude-token=<token> scripting form', () => {
      const a = parseArgs([`--set-claude-token=${TOKEN}`]);
      expect(a.setClaudeToken).toBe(true);
      expect(a.setClaudeTokenValue).toBe(TOKEN);
    });

    it('parses --clear-claude-token', () => {
      expect(parseArgs(['--clear-claude-token']).clearClaudeToken).toBe(true);
    });
  });
});

// fleet-recolor-and-color-hardening P-005: the launcher derives a fleet slug
// CLIENT-side (psu-launcher.mjs — a plain-node script that can't import the TS
// store) and the server RE-DERIVES it authoritatively (agent-fleets-store.ts).
// The two carry a "MIRRORS … keep in sync" comment but no guard, so a divergence
// would silently mislabel the picker's new-fleet preview. Pin them identical.
describe('effectiveAutoMode (WI-1356 fleet-auto-mode)', () => {
  it('defaults AUTO ON for a --fleet launch (member has no human at the keyboard)', () => {
    expect(effectiveAutoMode(parseArgs(['--fleet=x']))).toBe(true);
  });
  it('is OFF for a plain (non-fleet) launch', () => {
    expect(effectiveAutoMode(parseArgs(['--no-picker', '--agent=claude']))).toBe(false);
  });
  it('--auto forces it on even without a fleet; --no-auto forces it off even with a fleet', () => {
    expect(effectiveAutoMode(parseArgs(['--auto']))).toBe(true);
    expect(effectiveAutoMode(parseArgs(['--fleet=x', '--no-auto']))).toBe(false);
  });
});

// WI-1408 (fleet-join-startup-assertion): the direct-member-launch client path
// (`psu --fleet=<slug>`) — bootstrap-su/-role already hard-fail (409) a fleet
// join that failed to resolve server-side, which `api()` surfaces as a thrown
// Error before `assertFleetJoined` even runs. This is the defense-in-depth
// guard for the OTHER failure mode: a response that comes back `status: 'ok'`
// but with `fleetSlug` still null — the exact "recolours the terminal but
// never persists membership" bug the fix exists to prevent.
describe('assertFleetJoined (WI-1408 fleet-join-startup-assertion)', () => {
  it('no fleet requested ⇒ never throws, whatever the response carries', () => {
    expect(() => assertFleetJoined(null, {})).not.toThrow();
    expect(() => assertFleetJoined(undefined, { fleetSlug: null })).not.toThrow();
  });

  it('fleet requested + response carries a non-null fleetSlug ⇒ passes silently', () => {
    expect(() => assertFleetJoined('shared-hive-testing', { fleetSlug: 'shared-hive-testing', fleetRole: 'member' })).not.toThrow();
  });

  it('fleet requested (join) but response fleetSlug is null ⇒ throws — never a silent unfleeted launch', () => {
    expect(() => assertFleetJoined('shared-hive-testing', { fleetSlug: null })).toThrow(/shared-hive-testing/);
  });

  it('fleet requested via a fresh --fleet-name create but response fleetSlug is null ⇒ throws', () => {
    expect(() => assertFleetJoined('My New Fleet', { fleetSlug: null })).toThrow(/My New Fleet/);
  });

  // Staging-launcher / release-server skew: a pre-WI-1408 operator registers the
  // membership (env + pending-fleet row) but does not echo `fleetSlug` at all.
  // Killing the member then is wrong (the 2026-07-01 10-member wipeout) — the
  // hard-fail is reserved for a server that SPEAKS the field and says null.
  it('fleet requested but the response predates the fleetSlug field entirely ⇒ warns, does not throw', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => assertFleetJoined('shared-hive-testing', {})).not.toThrow();
      expect(() => assertFleetJoined('shared-hive-testing', { status: 'ok', fleetNotice: 'joined fleet shared-hive-testing as member.' })).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('predates the fleetSlug field'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('psuLaunchArgvRecord (WI-1343 launch_argv reconstruction)', () => {
  it('reconstructs the canonical psu invocation from resolved selections', () => {
    const args = parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1']);
    expect(psuLaunchArgvRecord({ agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' }, args)).toEqual([
      'psu', '--no-picker', '--agent=claude', '--workspace=ws1', '--harness=h1', '--plan=p1',
    ]);
  });
  it('emits --no-plan when no plan is bound', () => {
    const args = parseArgs(['--no-picker', '--agent=omp', '--harness=h1', '--no-plan']);
    const argv = psuLaunchArgvRecord({ agent: 'omp', workspace: null, harness: 'h1', plan: null }, args);
    expect(argv).toContain('--no-plan');
    expect(argv).not.toContain('--workspace=null');
  });
  it('captures fleet, account, profile, context-size, model, add-dir and passthrough', () => {
    const args = parseArgs([
      '--no-picker', '--agent=claude', '--harness=h1', '--plan=p1',
      '--fleet=shared-hive-testing', '--account=acct1', '--profile=power',
      '--context-size=full', '--model=opus', '--add-dir=/x', '--', '--verbose',
    ]);
    const argv = psuLaunchArgvRecord({ agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' }, args);
    // opus normalizes to opus[1m] at parse — the recorded relaunch argv must carry
    // the marker so a re-launch reproduces the 1M window (owner directive 2026-07-02).
    expect(argv).toEqual(expect.arrayContaining([
      '--fleet=shared-hive-testing', '--account=acct1', '--profile=power',
      '--context-size=full', '--model=opus[1m]', '--add-dir=/x', '--auto', '--', '--verbose',
    ]));
  });
  it('derives --fleet from a picker-entered fleet NAME', () => {
    const args = parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1']);
    args.fleetName = 'My New Fleet';
    const argv = psuLaunchArgvRecord({ agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' }, args);
    expect(argv).toContain(`--fleet=${storeFleetSlugFromName('My New Fleet')}`);
  });
  it('captures --allow-subagents (owner mandate 2026-07-02); omitted when not opted in (deny is the default)', () => {
    const withFlag = parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1', '--allow-subagents']);
    expect(psuLaunchArgvRecord({ agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' }, withFlag)).toContain('--allow-subagents');
    const withoutFlag = parseArgs(['--no-picker', '--agent=claude', '--harness=h1', '--plan=p1']);
    expect(psuLaunchArgvRecord({ agent: 'claude', workspace: 'ws1', harness: 'h1', plan: 'p1' }, withoutFlag)).not.toContain('--allow-subagents');
  });
});

describe('fleetSlugFromName client/server parity', () => {
  const NAMES = [
    'Ops Team',
    'k-epochs',
    '  Trailing/Leading  ',
    'UPPER CASE NAME',
    'weird!!!chars@@@here',
    'émoji ✨ and àccents',
    '---only-dashes---',
    '!!!',
    'a'.repeat(80),
    'mixed_Under-scores and.dots',
    'single',
  ];
  it.each(NAMES)('derives the same slug for %j on client + server', (name) => {
    expect(launcherFleetSlugFromName(name)).toBe(storeFleetSlugFromName(name));
  });
});

// fleet-recolor-and-color-hardening P-004: the psu picker shows a color swatch
// per fleet (from /options' resolved scheme). hexToRgb + colorSwatch are the pure
// rendering helpers.
describe('picker color swatch (fleet-color-schemes)', () => {
  it('hexToRgb parses #rrggbb (with or without #), case-insensitively', () => {
    expect(hexToRgb('#166534')).toEqual([22, 101, 52]);
    expect(hexToRgb('166534')).toEqual([22, 101, 52]);
    expect(hexToRgb('#FFFFFF')).toEqual([255, 255, 255]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
  });
  it('hexToRgb returns null for malformed input', () => {
    expect(hexToRgb('')).toBeNull();
    expect(hexToRgb('#fff')).toBeNull();
    expect(hexToRgb('nope')).toBeNull();
    expect(hexToRgb(null)).toBeNull();
    expect(hexToRgb(undefined)).toBeNull();
  });
  it('colorSwatch builds a truecolor 48;2 background cell from a scheme bg', () => {
    expect(colorSwatch({ bg: '#166534', fg: '#dcfce7', cursor: '#86efac' })).toBe('\x1b[48;2;22;101;52m  \x1b[0m ');
  });
  it('colorSwatch is empty (graceful) when there is no/invalid color', () => {
    expect(colorSwatch(null)).toBe('');
    expect(colorSwatch(undefined)).toBe('');
    expect(colorSwatch({ bg: 'not-a-hex' })).toBe('');
    expect(colorSwatch({})).toBe('');
  });
  it('schemeNameInAccent renders the name in the cursor accent (truecolor fg), plain on bad color', () => {
    // The scheme-picker row label: the name in the scheme's cursor accent.
    expect(schemeNameInAccent({ name: 'forest', cursor: '#86efac' })).toBe('\x1b[38;2;134;239;172mforest\x1b[0m');
    // Unparseable/absent color → plain name (still selectable, just uncolored).
    expect(schemeNameInAccent({ name: 'forest', cursor: 'nope' })).toBe('forest');
    expect(schemeNameInAccent(null)).toBe('');
    expect(schemeNameInAccent({ name: 'x' })).toBe('x');
  });
});

describe('launch preflight guards (context-trimming-tiers P-016 / P-018)', () => {
  it('assertLaunchPersona: missing / absent / tiny prompt files fail LOUD; a real one returns its size', () => {
    expect(() => assertLaunchPersona(null)).toThrow(/no persona prompt file/i);
    expect(() => assertLaunchPersona('/nonexistent/persona.md')).toThrow(/missing\/unreadable/);
    const dir = mkdtempSync(join(tmpdir(), 'psu-p016-'));
    const tiny = join(dir, 'tiny.md');
    writeFileSync(tiny, '# stub');
    expect(() => assertLaunchPersona(tiny)).toThrow(/did not render\/append/);
    const real = join(dir, 'real.md');
    writeFileSync(real, 'x'.repeat(5_000));
    expect(assertLaunchPersona(real)).toBe(5_000);
    rmSync(dir, { recursive: true, force: true });
  });

  it('preflightWindowGuard: warn ≥35%, refuse ≥60%, [1m] widens the window', () => {
    // trimmed baseline 55k + ~13.5k persona ≈ 68.5k of 200k ≈ 34% → ok
    const ok = preflightWindowGuard({ personaBytes: 50_000, contextSize: 'trimmed', model: 'haiku' });
    expect(ok.level).toBe('ok');
    // full baseline 152k + ~28k persona ≈ 180k of 200k = 90% → refuse
    const refuse = preflightWindowGuard({ personaBytes: 105_000, contextSize: 'full', model: 'haiku' });
    expect(refuse.level).toBe('refuse');
    // same on a [1m] window → 18% → ok
    const wide = preflightWindowGuard({ personaBytes: 105_000, contextSize: 'full', model: 'haiku[1m]' });
    expect(wide.level).toBe('ok');
    // trimmed + a big persona lands the warn band (55k + 27k ≈ 82k = 41%)
    const warn = preflightWindowGuard({ personaBytes: 100_000, contextSize: 'trimmed', model: 'haiku' });
    expect(warn.level).toBe('warn');
  });

  it('preflightWindowGuard: default-1M families (sonnet-5 incl. the bare alias, opus, fable) get the 1M window without [1m]', () => {
    for (const model of ['claude-sonnet-5:high', 'sonnet:medium', 'sonnet', 'opus:high', 'claude-fable-5:xhigh']) {
      const g = preflightWindowGuard({ personaBytes: 105_000, contextSize: 'full', model });
      expect(g.window).toBe(1_000_000);
      expect(g.level).toBe('ok');
    }
    // versioned sonnet ≤4.x stays on the conservative 200k window
    expect(preflightWindowGuard({ personaBytes: 105_000, contextSize: 'full', model: 'claude-sonnet-4-6:high' }).window).toBe(200_000);
  });

  it('runLaunchPreflight: refuse throws with the --force pointer; force downgrades to a warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psu-p018-'));
    const persona = join(dir, 'persona.md');
    writeFileSync(persona, 'x'.repeat(105_000));
    expect(() =>
      runLaunchPreflight({ promptFile: persona, contextSize: 'full', model: 'haiku', force: false }),
    ).toThrow(/--force/);
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = runLaunchPreflight({ promptFile: persona, contextSize: 'full', model: 'haiku', force: true });
    expect(g.level).toBe('refuse');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('parseArgs: --persona-tier + --force parse (P-017/P-018)', () => {
    expect(parseArgs([]).personaTier).toBeNull();
    expect(parseArgs(['--persona-tier=fleet']).personaTier).toBe('fleet');
    expect(parseArgs([]).force).toBe(false);
    expect(parseArgs(['--force']).force).toBe(true);
  });
});

describe('--launched-by (solo-launch-provenance)', () => {
  it('parseArgs captures --launched-by=<ownerId>', async () => {
    const { parseArgs } = await import('../scripts/psu-launcher.mjs');
    const a = parseArgs(['--no-picker', '--agent=claude', '--launched-by=su-94b69875-x']);
    expect(a.launchedBy).toBe('su-94b69875-x');
    expect(parseArgs([]).launchedBy).toBeNull();
  });

  it('freshSuBootstrapBody forwards launched_by so bootstrap-su can bake provenance', async () => {
    const { parseArgs, freshSuBootstrapBody } = await import('../scripts/psu-launcher.mjs');
    const args = parseArgs(['--no-picker', '--agent=claude', '--launched-by=su-abc']);
    const body = freshSuBootstrapBody({ agent: 'claude', workspace: 'w', harness: 'h', plan: null }, args);
    expect(body.launched_by).toBe('su-abc');
    // and omitted entirely when absent (server treats absent as null)
    const bare = freshSuBootstrapBody({ agent: 'claude', workspace: 'w', harness: 'h', plan: null }, parseArgs(['--no-picker', '--agent=claude']));
    expect('launched_by' in bare).toBe(false);
  });

  it('psuLaunchArgvRecord round-trips --launched-by (WI-1343 reconstruction)', async () => {
    const { parseArgs, psuLaunchArgvRecord } = await import('../scripts/psu-launcher.mjs');
    const args = parseArgs(['--no-picker', '--agent=claude', '--launched-by=su-abc']);
    const argv = psuLaunchArgvRecord({ agent: 'claude', workspace: 'w', harness: 'h', plan: null }, args);
    expect(argv).toContain('--launched-by=su-abc');
  });
});

describe('setupReminderLines — pre-TUI "setup unfinished" nudge (owner batch #5)', () => {
  it('returns null when setup is complete (stage done) — no nag', () => {
    expect(setupReminderLines('done')).toBeNull();
  });
  it('returns null when the stage is unknown (probe failed / operator unreachable)', () => {
    // A failed/timed-out probe resolves to null — never nag on no signal.
    expect(setupReminderLines(null)).toBeNull();
    expect(setupReminderLines(undefined)).toBeNull();
    expect(setupReminderLines('')).toBeNull();
  });
  it('nudges for every not-done concierge stage, naming BOTH `papercusp setup` and `papercusp tutorial`', () => {
    for (const stage of ['pick', 'install', 'login', 'embeddings', 'handoff']) {
      const lines = setupReminderLines(stage);
      expect(lines, stage).not.toBeNull();
      const text = lines.join('\n');
      expect(text, stage).toContain('papercusp setup');
      expect(text, stage).toContain('papercusp tutorial');
      // States the WHY (locked functionality) so the nudge is actionable, not noise.
      expect(text.toLowerCase(), stage).toContain('locked');
    }
  });
});

// psu-resume-relogin (owner-reported 2026-07-12): a default-account `psu --resume`
// re-heals the isolated CLAUDE_CONFIG_DIR's .credentials.json to the global CLI
// login before spawn — the fresh-launch mirror invariant that a raw resume skipped,
// which made a resumed session "launch logged out" once its in-session OAuth refresh
// forked the symlink into a stale real file.
describe('rehealResumeCredentials (psu-resume-relogin)', () => {
  let home: string;
  const CREDS = (exp: number) => JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: exp } });
  const globalOf = () => join(home, '.claude', '.credentials.json');
  const sessCredOf = (dir: string) => join(dir, '.credentials.json');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'reheal-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** A fresh isolated session dir under `home` (so afterEach cleans it). */
  function makeSessionDir(): string {
    return mkdtempSync(join(home, 'sess-'));
  }

  it('re-points a stale real-file fork at the newer global via symlink', () => {
    writeFileSync(globalOf(), CREDS(2000)); // reconciler keeps the global newest
    const dir = makeSessionDir();
    writeFileSync(sessCredOf(dir), CREDS(1000)); // stale in-session fork
    rehealResumeCredentials(dir, { home });
    expect(lstatSync(sessCredOf(dir)).isSymbolicLink()).toBe(true);
    expect(realpathSync(sessCredOf(dir))).toBe(realpathSync(globalOf()));
    expect(claudeCredExpiresAt(sessCredOf(dir))).toBe(2000); // resolves to the live token
  });

  it('leaves a healthy symlink-to-global untouched (idempotent)', () => {
    writeFileSync(globalOf(), CREDS(2000));
    const dir = makeSessionDir();
    symlinkSync(globalOf(), sessCredOf(dir));
    const before = readlinkSync(sessCredOf(dir));
    rehealResumeCredentials(dir, { home });
    expect(lstatSync(sessCredOf(dir)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(sessCredOf(dir))).toBe(before);
  });

  it('re-points a dangling symlink at the global', () => {
    writeFileSync(globalOf(), CREDS(2000));
    const dir = makeSessionDir();
    symlinkSync(join(home, '.claude', 'gone.json'), sessCredOf(dir)); // dangling
    rehealResumeCredentials(dir, { home });
    expect(realpathSync(sessCredOf(dir))).toBe(realpathSync(globalOf()));
  });

  it('creates the symlink when the session dir has no credential file', () => {
    writeFileSync(globalOf(), CREDS(2000));
    const dir = makeSessionDir();
    rehealResumeCredentials(dir, { home });
    expect(realpathSync(sessCredOf(dir))).toBe(realpathSync(globalOf()));
  });

  it('promotes a strictly-newer session fork to the global, then symlinks (newest-wins)', () => {
    writeFileSync(globalOf(), CREDS(1000)); // global stale (reconciler lagged)
    const dir = makeSessionDir();
    writeFileSync(sessCredOf(dir), CREDS(3000)); // session refreshed most recently
    rehealResumeCredentials(dir, { home });
    expect(claudeCredExpiresAt(globalOf())).toBe(3000); // promoted so global stays canonical
    expect(realpathSync(sessCredOf(dir))).toBe(realpathSync(globalOf()));
    expect(claudeCredExpiresAt(sessCredOf(dir))).toBe(3000);
  });

  it('is a no-op (no throw) when there is no global credential file (API-key box)', () => {
    const dir = makeSessionDir();
    writeFileSync(sessCredOf(dir), CREDS(1000)); // no global written
    expect(() => rehealResumeCredentials(dir, { home })).not.toThrow();
    expect(lstatSync(sessCredOf(dir)).isSymbolicLink()).toBe(false); // left as-is, nothing to mirror
  });

  it('claudeCredExpiresAt reads expiresAt and returns -1 on unreadable/missing', () => {
    const dir = makeSessionDir();
    const p = sessCredOf(dir);
    writeFileSync(p, CREDS(4242));
    expect(claudeCredExpiresAt(p)).toBe(4242);
    expect(claudeCredExpiresAt(join(dir, 'nope.json'))).toBe(-1);
  });
});
