// @vitest-environment node
/**
 * psu-pty-host.test.ts — pure-logic unit tests for the managed-pty host
 * (turn-lifecycle-control Phase 3, P-012/P-013). The real-pty round-trip
 * (spawn → socket-inject → cleanup) lives in psu-pty-host.integration.test.ts.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import {
  sanitizeKey,
  socketPathFor,
  metaPathFor,
  encodeControl,
  decodeControl,
  controlBytes,
  controlWrites,
  controlWritesForAgent,
  contextClearCommandForAgent,
  coldResetModeForAgent,
  respawnTerminalHandoffBytes,
  makeScrollbackGuard,
  headlessClaudeOnboardingEnabled,
  headlessClaudeOnboardingStartupMs,
  HEADLESS_CLAUDE_KICKOFF_READY_TIMEOUT_MS,
  headlessClaudeKickoffReadiness,
  makeHeadlessClaudeOnboardingStateMachine,
  startupOutputReady,
  freshChildPromptReady,
  claudeResumeCompactionStartupMs,
  claudeResumeCompactionRecoveryMs,
  makeClaudeResumeCompactionRecoveryStateMachine,
  clearSettleMs,
  resetWritesForAgent,
  submitVerifyQuietMs,
  fireSessionCompactedEvent,
  SESSION_COMPACTED_EMIT_ENTRY,
  fleetOscFromEnv,
  turnSubmitCrDelayForAgent,
  makeIdleGate,
  makeComposerWedgeDetector,
  shouldBreakComposerWedge,
  makeOwnerComposerGate,
  makeOwnerInputDetector,
  makeFreshChildOwnerInterruptionDetector,
  makeActivityTracker,
  makeAgentBusyGate,
  codexCarryTurnCompleted,
  codexLatestTurnCompleted,
  makeCarryRearmController,
  makeSubmitVerifier,
  submitExhaustionTerminatesHost,
  submitVerificationFailureReason,
  quotaLimitBannerVisible,
  quotaLimitBannerMatch,
  quotaLineIsUsageAdvisory,
  quotaBannerPatternsForAgent,
  makeQuotaBlockDetector,
  verifyNativeTurnStartWithRetry,
  findNativeTranscriptMarker,
  observeKickoffModelTurnStart,
  carryTurnProofRequiresNativeId,
  shouldRetryCarryOnFreshEpoch,
  signalNameFromCode,
  resolveTeardownSignal,
  reapDetachedPtyScopeResidue,
  shouldReapDetachedPtyScopeResidue,
  turnCoalesceKey,
  renderCoalescedTurn,
  makeTurnCoalescer,
  injectTurn,
  decodeDeliveryId,
  decodeQuotaRecovery,
  makeDeliveryDedup,
  DELIVERY_DEDUP_TTL_MS,
  makeInjectMutex,
  makeStaleFireGuard,
  isCarryRespawnStale,
  isCarryRespawnSuperseded,
  shouldDeferWakeForPendingRespawn,
  ACTIVITY_PERSIST_MS,
  MAX_CONTROL_PAYLOAD_BYTES,
  controlPayloadWithinLimit,
  KICKOFF_PROOF_PATH_ENV,
  KICKOFF_PROOF_TOKEN_ENV,
  publishKickoffProofReceipt,
  hashHostScript,
  hostCodeStaleness,
  LOADED_HOST_CODE_VERSION,
  PSU_REEXEC_EXIT_CODE,
  reexecExitCodeFrom,
  shouldAdoptHostCode,
  interactiveAdoptionOptIn,
  handoffPathFor,
  writeHostHandoff,
  readHostHandoff,
  readHostHandoffForParentPid,
  PSU_PTY_DIR,
  pidLooksLikePsuHost,
  findLiveHostFor,
  duplicateHostAdmission,
  hostIdleMs,
  eventLogPathForOwner,
  appendHostEvent,
  sharedDrillLedgerPath,
  appendSharedDrillLedgerEvent,
  stripAnsi,
  makeHeadlessLogNormalizer,
  createHeadlessNormalizedLogWriter,
  mcpServerRowStatus,
  mcpDialogRowSelected,
  mcpConnectedVerdict,
  runMcpReconnectMacro,
  shutdownRefusalReason,
} from '../scripts/psu-pty-host.mjs';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import { join as pathJoin } from 'node:path';
import net from 'node:net';
import { oscRecolorSequence, COLOR_SCHEMES } from '@papercusp/operator-core/lib/console-color-schemes';
import { buildConsoleOneliner } from '@papercusp/operator-core/lib/console-spawn';

describe('sanitizeKey', () => {
  it('passes SID-shaped ids through unchanged', () => {
    expect(sanitizeKey('su-a4bf457e-6f4a-4ee1-8682-8da0749c701b')).toBe(
      'su-a4bf457e-6f4a-4ee1-8682-8da0749c701b',
    );
  });
  it('escapes path-traversal + separators (no escaping the dir)', () => {
    expect(sanitizeKey('su/../../etc/passwd')).toBe('su_.._.._etc_passwd');
    expect(sanitizeKey('a b\tc')).toBe('a_b_c');
  });
  it('bounds length + tolerates empty/undefined', () => {
    expect(sanitizeKey('x'.repeat(500)).length).toBe(200);
    expect(sanitizeKey('')).toBe('unknown');
    // @ts-expect-error exercising the undefined path
    expect(sanitizeKey(undefined)).toBe('unknown');
  });
});

describe('socketPathFor / metaPathFor', () => {
  it('derive sibling .sock / .json paths under PSU_PTY_DIR', () => {
    expect(socketPathFor('su-x')).toBe(`${PSU_PTY_DIR}/su-x.sock`);
    expect(metaPathFor('su-x')).toBe(`${PSU_PTY_DIR}/su-x.json`);
  });
});

describe('publishKickoffProofReceipt (detached plain-launch proof)', () => {
  it('atomically replaces a parent-owned placeholder with a persisted native proof', () => {
    if (typeof process.getuid !== 'function') return;
    const root = nodeFs.mkdtempSync(pathJoin(nodeOs.tmpdir(), 'psu-kickoff-proof-'));
    const path = pathJoin(root, 'proof.json');
    const token = 'a'.repeat(48);
    try {
      nodeFs.writeFileSync(path, '', { mode: 0o600 });
      nodeFs.chmodSync(path, 0o600);
      expect(publishKickoffProofReceipt(
        { persisted: true, nativeRef: '/tmp/native-session.jsonl', reason: null },
        { [KICKOFF_PROOF_PATH_ENV]: path, [KICKOFF_PROOF_TOKEN_ENV]: token },
      )).toEqual({ published: true });
      expect(JSON.parse(nodeFs.readFileSync(path, 'utf8'))).toEqual({
        token,
        persisted: true,
        nativeRef: '/tmp/native-session.jsonl',
        reason: null,
      });
      expect(nodeFs.statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes a negative receipt for an unavailable native proof and refuses a symlink placeholder', () => {
    if (typeof process.getuid !== 'function') return;
    const root = nodeFs.mkdtempSync(pathJoin(nodeOs.tmpdir(), 'psu-kickoff-proof-negative-'));
    const path = pathJoin(root, 'proof.json');
    const target = pathJoin(root, 'target.json');
    const token = 'b'.repeat(48);
    try {
      nodeFs.writeFileSync(path, '', { mode: 0o600 });
      nodeFs.chmodSync(path, 0o600);
      expect(publishKickoffProofReceipt(
        { persisted: false, nativeRef: null, reason: 'unsupported-backend' },
        { [KICKOFF_PROOF_PATH_ENV]: path, [KICKOFF_PROOF_TOKEN_ENV]: token },
      )).toEqual({ published: true });
      expect(JSON.parse(nodeFs.readFileSync(path, 'utf8'))).toMatchObject({
        token,
        persisted: false,
        nativeRef: null,
        reason: 'unsupported-backend',
      });

      nodeFs.writeFileSync(target, '', { mode: 0o600 });
      nodeFs.chmodSync(target, 0o600);
      nodeFs.unlinkSync(path);
      nodeFs.symlinkSync(target, path);
      expect(publishKickoffProofReceipt(
        { persisted: true, nativeRef: '/tmp/native-session.jsonl' },
        { [KICKOFF_PROOF_PATH_ENV]: path, [KICKOFF_PROOF_TOKEN_ENV]: token },
      )).toMatchObject({ published: false, reason: 'kickoff-proof-receipt-publish-failed' });
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('control wire protocol (v1)', () => {
  it('uses a byte-accurate bounded UTF-8 payload ceiling', () => {
    const prefix = '🧭';
    const prefixBytes = Buffer.byteLength(prefix, 'utf8');
    const exact = `${prefix}${'x'.repeat(MAX_CONTROL_PAYLOAD_BYTES - prefixBytes)}`;
    expect(Buffer.byteLength(exact, 'utf8')).toBe(MAX_CONTROL_PAYLOAD_BYTES);
    expect(controlPayloadWithinLimit(exact)).toBe(true);
    expect(controlPayloadWithinLimit(`${exact}x`)).toBe(false);
  });

  it('turn envelope → idle-gated, CR-terminated turn', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello' }));
    expect(d).toEqual({ mode: 'turn', data: 'hello', gated: true });
    expect(controlBytes(d)).toBe('hello\r');
  });
  it('raw envelope → immediate, verbatim bytes (force interrupt)', () => {
    const d = decodeControl(encodeControl({ mode: 'raw', data: '\x03' })); // Ctrl-C
    expect(d).toEqual({ mode: 'raw', data: '\x03', gated: false });
    expect(controlBytes(d)).toBe('\x03');
  });
  it('Esc force interrupt round-trips', () => {
    expect(controlBytes(decodeControl(encodeControl({ mode: 'raw', data: '\x1b' })))).toBe('\x1b');
  });
  it('osc envelope → immediate, verbatim recolor bytes (terminal display, not the agent)', () => {
    const osc = '\x1b]11;#581c87\x07';
    const d = decodeControl(encodeControl({ mode: 'osc', data: osc }));
    expect(d).toEqual({ mode: 'osc', data: osc, gated: false });
  });
  it('reset (RESET-CONTEXT) envelope → GATED cold verb carrying the fresh-context carry-note', () => {
    // su-cold-auto-mode P-004a: gated:true so the host defers it to a settled turn
    // (P-006 clean-boundary), exactly like a wake turn — never fired mid-turn.
    const d = decodeControl(encodeControl({ mode: 'reset', data: 'carry-note body' }));
    expect(d).toEqual({ mode: 'reset', data: 'carry-note body', gated: true });
  });
  it('recycle envelope → GATED cold verb carrying the fresh-context carry-note', () => {
    const d = decodeControl(encodeControl({ mode: 'recycle', data: 'carry-note body' }));
    expect(d).toEqual({ mode: 'recycle', data: 'carry-note body', gated: true });
  });
  it('carry-respawn envelope → GATED lifecycle verb with distinct launch context', () => {
    const d = decodeControl(
      JSON.stringify({
        v: 1,
        mode: 'carry-respawn',
        data: 'successor first prompt',
        systemPromptAddendum: 'deterministic carry',
      }),
    );
    expect(d).toEqual({
      mode: 'carry-respawn',
      data: 'successor first prompt',
      systemPromptAddendum: 'deterministic carry',
      drillId: '',
      sessionClass: '',
      gated: true,
    });
  });
  it('carry-respawn preserves additive P-020 drill correlation for the host ledger', () => {
    const d = decodeControl(
      JSON.stringify({
        v: 1,
        mode: 'carry-respawn',
        data: '⟦carry-drill:d-1⟧',
        systemPromptAddendum: 'deterministic carry',
        drillId: 'd-1',
        sessionClass: 'claude-su',
      }),
    );
    expect(d).toEqual({
      mode: 'carry-respawn',
      data: '⟦carry-drill:d-1⟧',
      systemPromptAddendum: 'deterministic carry',
      drillId: 'd-1',
      sessionClass: 'claude-su',
      gated: true,
    });
  });
  it('reset/recycle with no data → gated verb with an empty carry (bare reset)', () => {
    expect(decodeControl(encodeControl({ mode: 'reset' }))).toEqual({ mode: 'reset', data: '', gated: true });
    expect(decodeControl(encodeControl({ mode: 'recycle' }))).toEqual({ mode: 'recycle', data: '', gated: true });
  });
  it('compact envelope → GATED verb carrying the carry-note (data) + the /compact focus (WI-1804)', () => {
    // The operator's injectIntoHost sends focus as a distinct envelope field; decode it back.
    const d = decodeControl(JSON.stringify({ v: 1, mode: 'compact', data: 'continue here', focus: 'keep identity' }));
    expect(d).toEqual({ mode: 'compact', data: 'continue here', focus: 'keep identity', gated: true });
  });
  it('compact with no data/focus → gated verb with empty carry + empty focus (bare compact)', () => {
    expect(decodeControl(JSON.stringify({ v: 1, mode: 'compact' }))).toEqual({
      mode: 'compact',
      data: '',
      focus: '',
      gated: true,
    });
  });
  it('a non-envelope payload is a legacy idle-gated turn (psupty back-compat)', () => {
    const d = decodeControl('just some text');
    expect(d).toEqual({ mode: 'turn', data: 'just some text', gated: true });
    expect(controlBytes(d)).toBe('just some text\r');
  });
  it('an unknown/garbage JSON object falls back to a legacy turn', () => {
    const d = decodeControl('{"v":2,"mode":"weird"}');
    expect(d.mode).toBe('turn');
    expect(d.gated).toBe(true);
  });

  // WI-5510: the fire-identity fields ({fireNumber, routineId}) a loop-fire wake
  // stamps onto the envelope so the delivery-side STALE-FIRE GUARD can tell a
  // superseded delivery from a fresh one. Round-trip through encode/decode for
  // every gated verb that carries them (turn/reset/recycle/carry-respawn).
  it('turn envelope round-trips fireNumber + routineId (WI-5510)', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello', fireNumber: 3, routineId: 'r-1' }));
    expect(d).toEqual({ mode: 'turn', data: 'hello', gated: true, fireNumber: 3, routineId: 'r-1' });
  });
  it('reset/recycle envelopes round-trip fireNumber + routineId (WI-5510)', () => {
    expect(decodeControl(encodeControl({ mode: 'reset', data: 'note', fireNumber: 2, routineId: 'r-2' }))).toEqual({
      mode: 'reset', data: 'note', gated: true, fireNumber: 2, routineId: 'r-2',
    });
    expect(decodeControl(encodeControl({ mode: 'recycle', data: 'note', fireNumber: 5, routineId: 'r-3' }))).toEqual({
      mode: 'recycle', data: 'note', gated: true, fireNumber: 5, routineId: 'r-3',
    });
  });
  it('carry-respawn envelope round-trips fireNumber + routineId alongside its own fields (WI-5510)', () => {
    const d = decodeControl(
      JSON.stringify({
        v: 1,
        mode: 'carry-respawn',
        data: 'successor prompt',
        systemPromptAddendum: 'carry',
        fireNumber: 7,
        routineId: 'r-4',
      }),
    );
    expect(d).toEqual({
      mode: 'carry-respawn',
      data: 'successor prompt',
      systemPromptAddendum: 'carry',
      drillId: '',
      sessionClass: '',
      gated: true,
      fireNumber: 7,
      routineId: 'r-4',
    });
  });
  it('a pre-WI-5510 sender (no fireNumber/routineId) decodes with neither field set — no regression', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello' }));
    expect(d).toEqual({ mode: 'turn', data: 'hello', gated: true });
    expect('fireNumber' in d).toBe(false);
    expect('routineId' in d).toBe(false);
  });
  it('malformed fire-identity fields (wrong type, zero/negative fireNumber, empty routineId) are dropped, not passed through', () => {
    const d = decodeControl(
      JSON.stringify({ v: 1, mode: 'turn', data: 'x', fireNumber: 0, routineId: '' }),
    );
    expect('fireNumber' in d).toBe(false);
    expect('routineId' in d).toBe(false);
    const d2 = decodeControl(
      JSON.stringify({ v: 1, mode: 'turn', data: 'x', fireNumber: 'not-a-number', routineId: 42 }),
    );
    expect('fireNumber' in d2).toBe(false);
    expect('routineId' in d2).toBe(false);
  });
  it('osc/raw/mcp-reconnect (ungated or identity-agnostic verbs) never carry fire identity', () => {
    expect(decodeControl(encodeControl({ mode: 'raw', data: '\x03', fireNumber: 1, routineId: 'r' }))).toEqual({
      mode: 'raw', data: '\x03', gated: false,
    });
  });

  // EI-153: the addressed-recipient assertion ({ownerId}) a sender rides on the
  // envelope so the RECEIVING host can refuse a message meant for a different
  // agent (see injectIntoHost's `ownerId` doc + the server handler's misdelivery
  // guard). Round-trip through encode/decode for every mode — unlike fire
  // identity (loop-wake-only), ownerId is a universal misdelivery guard so every
  // mode carries it.
  it('turn envelope round-trips ownerId (EI-153)', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello', ownerId: 'su-aaa' }));
    expect(d).toEqual({ mode: 'turn', data: 'hello', gated: true, ownerId: 'su-aaa' });
  });
  it('reset/recycle/carry-respawn/raw/osc/mcp-reconnect envelopes round-trip ownerId (EI-153)', () => {
    expect(decodeControl(encodeControl({ mode: 'reset', data: 'note', ownerId: 'su-bbb' }))).toEqual({
      mode: 'reset', data: 'note', gated: true, ownerId: 'su-bbb',
    });
    expect(decodeControl(encodeControl({ mode: 'recycle', data: 'note', ownerId: 'su-bbb' }))).toEqual({
      mode: 'recycle', data: 'note', gated: true, ownerId: 'su-bbb',
    });
    expect(
      decodeControl(
        JSON.stringify({ v: 1, mode: 'carry-respawn', data: 'p', systemPromptAddendum: 'c', ownerId: 'su-ccc' }),
      ),
    ).toEqual({
      mode: 'carry-respawn', data: 'p', systemPromptAddendum: 'c', drillId: '', sessionClass: '',
      gated: true, ownerId: 'su-ccc',
    });
    expect(decodeControl(encodeControl({ mode: 'raw', data: '\x03', ownerId: 'su-ddd' }))).toEqual({
      mode: 'raw', data: '\x03', gated: false, ownerId: 'su-ddd',
    });
    expect(decodeControl(encodeControl({ mode: 'osc', data: '\x1b]11;#000\x07', ownerId: 'su-eee' }))).toEqual({
      mode: 'osc', data: '\x1b]11;#000\x07', gated: false, ownerId: 'su-eee',
    });
    expect(decodeControl(encodeControl({ mode: 'mcp-reconnect', data: 'papercusp-su', ownerId: 'su-fff' }))).toEqual({
      mode: 'mcp-reconnect', data: 'papercusp-su', gated: true, ownerId: 'su-fff',
    });
  });
  it('a pre-EI-153 sender (no ownerId) decodes with the field unset — no regression', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello' }));
    expect('ownerId' in d).toBe(false);
  });
  it('a malformed ownerId (wrong type, empty string) is dropped, not passed through', () => {
    const d = decodeControl(JSON.stringify({ v: 1, mode: 'turn', data: 'x', ownerId: '' }));
    expect('ownerId' in d).toBe(false);
    const d2 = decodeControl(JSON.stringify({ v: 1, mode: 'turn', data: 'x', ownerId: 42 }));
    expect('ownerId' in d2).toBe(false);
  });
  it('the legacy non-envelope payload never carries an ownerId', () => {
    const d = decodeControl('just some text');
    expect('ownerId' in d).toBe(false);
  });
});

// EI-19311270129974785: `deliveryId` (the sender's durable event_wake_deliveries.id)
// rides the envelope for every mode that can go through the gated pipeline (a delivery
// row exists) — turn/reset/recycle/carry-respawn — so the host can dedup a retry of an
// already-accepted delivery. Round-trip through encode/decode for each of those modes,
// mirroring the ownerId coverage above (raw/osc/compact/mcp-reconnect are one-shot,
// non-delivery calls and deliberately do not carry it).
describe('decodeDeliveryId (EI-19311270129974785)', () => {
  it('turn envelope round-trips deliveryId', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello', deliveryId: '35092' }));
    expect(d).toEqual({ mode: 'turn', data: 'hello', gated: true, deliveryId: '35092' });
  });
  it('reset/recycle/carry-respawn envelopes round-trip deliveryId', () => {
    expect(decodeControl(encodeControl({ mode: 'reset', data: 'note', deliveryId: '1' }))).toEqual({
      mode: 'reset', data: 'note', gated: true, deliveryId: '1',
    });
    expect(decodeControl(encodeControl({ mode: 'recycle', data: 'note', deliveryId: '2' }))).toEqual({
      mode: 'recycle', data: 'note', gated: true, deliveryId: '2',
    });
    expect(
      decodeControl(
        JSON.stringify({ v: 1, mode: 'carry-respawn', data: 'p', systemPromptAddendum: 'c', deliveryId: '3' }),
      ),
    ).toEqual({
      mode: 'carry-respawn', data: 'p', systemPromptAddendum: 'c', drillId: '', sessionClass: '',
      gated: true, deliveryId: '3',
    });
  });
  it('a pre-fix sender (no deliveryId) decodes with the field unset — no regression', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello' }));
    expect('deliveryId' in d).toBe(false);
  });
  it('a malformed deliveryId (wrong type, empty string) is dropped, not passed through', () => {
    const d = decodeControl(JSON.stringify({ v: 1, mode: 'turn', data: 'x', deliveryId: '' }));
    expect('deliveryId' in d).toBe(false);
    const d2 = decodeControl(JSON.stringify({ v: 1, mode: 'turn', data: 'x', deliveryId: 42 }));
    expect('deliveryId' in d2).toBe(false);
  });
  it('one-shot raw/osc/mcp-reconnect calls never carry a deliveryId (no delivery row to dedup)', () => {
    expect('deliveryId' in decodeControl(encodeControl({ mode: 'raw', data: '\x03', deliveryId: 'x' }))).toBe(false);
    expect('deliveryId' in decodeControl(encodeControl({ mode: 'osc', data: '\x1b]11;#000\x07', deliveryId: 'x' }))).toBe(
      false,
    );
    expect(
      'deliveryId' in decodeControl(encodeControl({ mode: 'mcp-reconnect', data: 'papercusp-su', deliveryId: 'x' })),
    ).toBe(false);
  });
});

/**
 * makeDeliveryDedup (EI-19311270129974785): the "a single wake delivery is
 * re-attempted 4x and injects 3 duplicate agent turns" bug. Root cause: the host's
 * own ack-write-back to the client is best-effort (a slow/errored write, or the
 * client's own ack-wait timing out, both look identical to "the host never got it"),
 * but the host is ALREADY unstoppably committed to running the gated delivery once
 * it decided to accept — so a client retry with the SAME delivery id must be
 * recognized and short-circuited, never re-run as a fresh, unrelated request.
 */
describe('makeDeliveryDedup (EI-19311270129974785)', () => {
  it('keeps an early accepted delivery pending until its pipeline settles, then permits a failed retry', () => {
    const d = makeDeliveryDedup();

    d.markPending('pending-1');
    expect(d.state('pending-1')).toBe('pending');
    expect(d.isDuplicate('pending-1')).toBe(true);

    d.clearPending('pending-1');
    expect(d.state('pending-1')).toBeNull();
    expect(d.isDuplicate('pending-1')).toBe(false);
  });

  it('keeps a completed delivery deduped after the pipeline settles successfully', () => {
    const d = makeDeliveryDedup();

    d.markPending('complete-1');
    d.markCompleted('complete-1');
    expect(d.state('complete-1')).toBe('completed');
    expect(d.isDuplicate('complete-1')).toBe(true);
  });

  it('a fresh id is not a duplicate; marking it accepted makes the NEXT check a duplicate', () => {
    const d = makeDeliveryDedup();
    expect(d.isDuplicate('35092')).toBe(false);
    d.markAccepted('35092');
    expect(d.isDuplicate('35092')).toBe(true);
    // Re-checking (the sweep path) does not itself clear the entry.
    expect(d.isDuplicate('35092')).toBe(true);
  });
  it('an absent/empty id is never a duplicate and marking it is a no-op — callers never need to branch', () => {
    const d = makeDeliveryDedup();
    expect(d.isDuplicate(undefined)).toBe(false);
    expect(d.isDuplicate('')).toBe(false);
    d.markAccepted(undefined);
    d.markAccepted('');
    expect(d.size()).toBe(0);
  });
  it('different ids are tracked independently', () => {
    const d = makeDeliveryDedup();
    d.markAccepted('a');
    expect(d.isDuplicate('a')).toBe(true);
    expect(d.isDuplicate('b')).toBe(false);
  });
  it('an accepted id expires after its TTL — a genuinely new delivery reusing an old id (in practice never happens; ids are monotonic) is not wedged forever', () => {
    let t = 1_000_000;
    const d = makeDeliveryDedup({ ttlMs: 1000, now: () => t });
    d.markAccepted('x');
    expect(d.isDuplicate('x')).toBe(true);
    t += 999;
    expect(d.isDuplicate('x')).toBe(true); // still within TTL
    t += 2;
    expect(d.isDuplicate('x')).toBe(false); // expired
  });
  it('the sweep is opportunistic: an expired entry is evicted (size drops) on the next isDuplicate call', () => {
    let t = 0;
    const d = makeDeliveryDedup({ ttlMs: 100, now: () => t });
    d.markAccepted('a');
    d.markAccepted('b');
    expect(d.size()).toBe(2);
    t = 200; // both now expired
    d.isDuplicate('anything'); // triggers the sweep as a side effect
    expect(d.size()).toBe(0);
  });
  it('DELIVERY_DEDUP_TTL_MS is comfortably longer than the client retry envelope it must outlive', () => {
    // markDeliveryFailed's backoff caps at 10min (store.ts backoffMs: min(5s*2^attempts, 10min));
    // this TTL must exceed any realistic total retry-storm duration so a legitimate late
    // retry is always still deduped, while staying bounded so the map doesn't grow forever.
    expect(DELIVERY_DEDUP_TTL_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});

describe('quota recovery envelope identity (measured-agent-productivity P-004)', () => {
  const valid = {
    operationId: '4102',
    ownerId: 'su-quota-owner',
    startedAtMs: 1_788_790_000_000,
  };

  it('admits only a descriptor whose durable operation and owner match the envelope', () => {
    const decoded = decodeControl(encodeControl({
      mode: 'recycle',
      data: 'resume exact wake',
      ownerId: valid.ownerId,
      deliveryId: valid.operationId,
      quotaRecovery: valid,
    }));
    expect(decoded).toMatchObject({ mode: 'recycle', quotaRecovery: valid });
    expect(decodeQuotaRecovery({
      ownerId: valid.ownerId,
      deliveryId: valid.operationId,
      quotaRecovery: valid,
    })).toEqual({ quotaRecovery: valid });
  });

  it.each([
    ['mutated operation', { ...valid, operationId: '4103' }],
    ['mutated owner', { ...valid, ownerId: 'su-other-owner' }],
    ['missing timestamp', { ...valid, startedAtMs: 0 }],
  ])('%s cannot acquire quota-recovery authority', (_label, quotaRecovery) => {
    const decoded = decodeControl(encodeControl({
      mode: 'recycle',
      data: 'resume exact wake',
      ownerId: valid.ownerId,
      deliveryId: valid.operationId,
      quotaRecovery,
    }));
    expect(decoded).not.toHaveProperty('quotaRecovery');
  });
});

describe('makeStaleFireGuard (WI-5510 — delivery-side dead-man switch against a superseded fire)', () => {
  it('admits + commits a fresh (routineId, fireNumber) pair, then drops an equal or older one for the same routine', () => {
    const g = makeStaleFireGuard();
    expect(g.admit('r-1', 2)).toEqual({ admit: true, lastDelivered: 0 });
    // A later, HIGHER fire admits and advances the high-water mark.
    expect(g.admit('r-1', 3)).toEqual({ admit: true, lastDelivered: 2 });
    // A stale/duplicate (<=) delivery for the SAME routine is dropped without mutating state.
    expect(g.admit('r-1', 3)).toEqual({ admit: false, lastDelivered: 3 });
    expect(g.admit('r-1', 1)).toEqual({ admit: false, lastDelivered: 3 });
  });

  it('is scoped by routineId — a fresh loop instance (new routineId) always admits at fire #1, unaffected by an OLD loop higher count', () => {
    const g = makeStaleFireGuard();
    expect(g.admit('r-old', 9)).toEqual({ admit: true, lastDelivered: 0 });
    // loop:end + re-arm gets a NEW routineId; its fire #1 is never mistaken as
    // stale relative to r-old's fire #9.
    expect(g.admit('r-new', 1)).toEqual({ admit: true, lastDelivered: 0 });
    expect(g.size()).toBe(2);
  });

  it('a message with no routineId or no fireNumber always admits and never touches state (pre-WI-5510 / non-loop senders)', () => {
    const g = makeStaleFireGuard();
    expect(g.admit(undefined, 5)).toEqual({ admit: true, lastDelivered: null });
    expect(g.admit('r-1', undefined)).toEqual({ admit: true, lastDelivered: null });
    expect(g.admit(null, null)).toEqual({ admit: true, lastDelivered: null });
    expect(g.size()).toBe(0);
  });

  it('the exact WI-5510 repro: an earlier fire that finally clears its gate wait AFTER a later fire already delivered is dropped', () => {
    const g = makeStaleFireGuard();
    // Fire #2 wins its gate race first and delivers.
    expect(g.admit('r-1', 2).admit).toBe(true);
    // Fire #1 (decided BEFORE #2, but stuck at the busy/idle gate) finally clears
    // and would otherwise flush a stale, already-superseded wake mid-turn.
    const verdict = g.admit('r-1', 1);
    expect(verdict).toEqual({ admit: false, lastDelivered: 2 });
  });
});

describe('isCarryRespawnStale (EI-18109211232286833 — age-based carry-respawn dead-man switch)', () => {
  it('admits (not stale) a message received well within the max age', () => {
    const now = 1_000_000;
    expect(isCarryRespawnStale(now - 1_000, { maxAgeMs: 600_000, now })).toBe(false);
  });

  it('is stale once elapsed time strictly exceeds maxAgeMs', () => {
    const now = 1_000_000;
    expect(isCarryRespawnStale(now - 600_001, { maxAgeMs: 600_000, now })).toBe(true);
  });

  it('is exactly-at-the-boundary NOT stale (strictly greater-than, not >=)', () => {
    const now = 1_000_000;
    expect(isCarryRespawnStale(now - 600_000, { maxAgeMs: 600_000, now })).toBe(false);
  });

  it('a message with no receivedAtMs (pre-fix sender / non-carry-respawn caller) is never stale — opt-in guard', () => {
    expect(isCarryRespawnStale(undefined, { maxAgeMs: 600_000, now: 1_000_000 })).toBe(false);
    expect(isCarryRespawnStale(null, { maxAgeMs: 600_000, now: 1_000_000 })).toBe(false);
  });

  it('defaults maxAgeMs to the module constant (30 minutes — WI-5623) and now to the real clock when omitted', () => {
    // WI-5623 raised the default 10m→30m so a re-polling production respawn
    // survives long enough to catch the session's next idle/recycle boundary
    // (fleet bug-drain members recycle ~every 22-33min); a >30-min-busy session
    // is pathological and stale-drops to the hard-wall watchdog.
    const justNow = Date.now();
    expect(isCarryRespawnStale(justNow)).toBe(false);
    expect(isCarryRespawnStale(justNow - 20 * 60_000)).toBe(false); // 20m < 30m ⇒ still fresh
    expect(isCarryRespawnStale(justNow - 31 * 60_000)).toBe(true); // 31m > 30m ⇒ stale
  });
});

describe('isCarryRespawnSuperseded (EI-18665672258948707 — a later respawn already fired on this host)', () => {
  it('is NOT superseded when the host has never respawned (lastRespawnAtMs falsy)', () => {
    expect(isCarryRespawnSuperseded(1_000, 0)).toBe(false);
    expect(isCarryRespawnSuperseded(1_000, undefined)).toBe(false);
    expect(isCarryRespawnSuperseded(1_000, null)).toBe(false);
  });

  it('is NOT superseded when the message with no receivedAtMs (opt-in guard, same convention as isCarryRespawnStale)', () => {
    expect(isCarryRespawnSuperseded(undefined, 5_000)).toBe(false);
    expect(isCarryRespawnSuperseded(null, 5_000)).toBe(false);
  });

  it('is NOT superseded when the message was received AFTER the last respawn (it is the newer one)', () => {
    expect(isCarryRespawnSuperseded(5_000, 1_000)).toBe(false);
  });

  it('is NOT superseded at exact equality (a message received at the same instant as the last respawn is not "later")', () => {
    expect(isCarryRespawnSuperseded(5_000, 5_000)).toBe(false);
  });

  it('IS superseded when a respawn already fired AFTER the message was received — the exact EI-18665672258948707 repro (a queued carry-respawn outlived a later, real respawn)', () => {
    const receivedAtMs = 1_000; // this envelope arrived first...
    const lastRespawnAtMs = 2_000; // ...but a DIFFERENT respawn already delivered since then
    expect(isCarryRespawnSuperseded(receivedAtMs, lastRespawnAtMs)).toBe(true);
  });

  it('is orthogonal to age: a FRESH (well within maxAgeMs) message can still be superseded', () => {
    const now = 1_000_000;
    const receivedAtMs = now - 5_000; // 5s old — nowhere near the 30-minute staleness cap
    const lastRespawnAtMs = now - 1_000; // a respawn fired 1s ago, after this message arrived
    expect(isCarryRespawnStale(receivedAtMs, { maxAgeMs: 1_800_000, now })).toBe(false);
    expect(isCarryRespawnSuperseded(receivedAtMs, lastRespawnAtMs)).toBe(true);
  });
});

describe('shouldDeferWakeForPendingRespawn (EI-18679681961154136 — a wake must not starve a pending carry-respawn re-arm)', () => {
  it('defers a wake `turn` when a carry-respawn re-arm is pending', () => {
    expect(shouldDeferWakeForPendingRespawn('turn', 1)).toBe(true);
    expect(shouldDeferWakeForPendingRespawn('turn', 2)).toBe(true);
  });

  it('does NOT defer a wake `turn` when no respawn is pending', () => {
    expect(shouldDeferWakeForPendingRespawn('turn', 0)).toBe(false);
  });

  it('never defers a non-turn mode, even with a respawn pending — reset/recycle/mcp-reconnect are explicit operator actions, not routine wakes', () => {
    expect(shouldDeferWakeForPendingRespawn('reset', 1)).toBe(false);
    expect(shouldDeferWakeForPendingRespawn('recycle', 1)).toBe(false);
    expect(shouldDeferWakeForPendingRespawn('carry-respawn', 1)).toBe(false);
    expect(shouldDeferWakeForPendingRespawn('mcp-reconnect', 1)).toBe(false);
    expect(shouldDeferWakeForPendingRespawn('raw', 1)).toBe(false);
    expect(shouldDeferWakeForPendingRespawn('osc', 1)).toBe(false);
  });
});

describe('controlWrites — a turn submits via a SEPARATE delayed CR (paste-detector fix)', () => {
  it('a turn is TWO steps: the text now, then the submit CR after a delay', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    expect(controlWrites(d, 150)).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 150 },
    ]);
    // The CR is its OWN step — never concatenated onto the text (which the TUI's
    // paste detector would swallow as a literal newline → unsubmitted turn).
    const steps = controlWrites(d, 150);
    expect(steps[0].data).not.toContain('\r');
    expect(steps[1]).toEqual({ data: '\r', delayMs: 150 });
  });
  it('a raw (force-interrupt) message is ONE immediate verbatim write — no CR appended', () => {
    const ctrlC = decodeControl(encodeControl({ mode: 'raw', data: '\x03' }));
    expect(controlWrites(ctrlC)).toEqual([{ data: '\x03', delayMs: 0 }]);
  });
  it('an osc (recolor) message is ONE immediate verbatim write — no CR, no gate', () => {
    const d = decodeControl(encodeControl({ mode: 'osc', data: '\x1b]11;#166534\x07' }));
    expect(controlWrites(d)).toEqual([{ data: '\x1b]11;#166534\x07', delayMs: 0 }]);
  });
  it('the total bytes still match controlBytes (text + CR), just delivered in two writes', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello' }));
    expect(controlWrites(d).map((s) => s.data).join('')).toBe(controlBytes(d));
  });
});

describe('turnSubmitCrDelayForAgent', () => {
  it('keeps Claude/OMP on the existing submit delay', () => {
    expect(turnSubmitCrDelayForAgent('claude', {})).toBe(150);
    expect(turnSubmitCrDelayForAgent('omp', {})).toBe(150);
    expect(turnSubmitCrDelayForAgent('', {})).toBe(150);
  });
  it('uses a longer Codex settle so injected coord turns submit after paste handling clears', () => {
    expect(turnSubmitCrDelayForAgent('codex', {})).toBe(500);
    expect(turnSubmitCrDelayForAgent(' CODEX ', {})).toBe(500);
  });
  it('allows a Codex-specific override without changing Claude', () => {
    const env = {
      PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '175',
      PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '650',
    };
    expect(turnSubmitCrDelayForAgent('codex', env)).toBe(650);
    expect(turnSubmitCrDelayForAgent('claude', env)).toBe(175);
  });
  it('ignores invalid delay overrides', () => {
    const env = {
      PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: 'nope',
      PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '-1',
    };
    expect(turnSubmitCrDelayForAgent('codex', env)).toBe(500);
    expect(turnSubmitCrDelayForAgent('claude', env)).toBe(150);
  });
});

describe('controlWritesForAgent', () => {
  it('keeps Claude turns on the normal two-step paste-safe write plan', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    expect(controlWritesForAgent(d, 'claude', {})).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 150 },
    ]);
  });
  it('submits OMP with terminal Enter bytes and one bounded resubmit', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    expect(controlWritesForAgent(d, 'omp', {})).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 150 },
      { data: '\r', delayMs: 300 },
    ]);
    // A real OMP 16.x acceptance run acknowledged an LF submit while writing
    // no transcript record. Enter on a pty is CR; never regress to LF here.
    expect(controlWritesForAgent(d, 'omp', {}).some((step) => step.data === '\n')).toBe(false);
  });
  it('lets the OMP resubmit delay be tuned without changing its initial settle', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    expect(
      controlWritesForAgent(d, 'omp', {
        PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '225',
        PAPERCUSP_PSU_PTY_OMP_RESUBMIT_CR_MS: '475',
      }),
    ).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 225 },
      { data: '\r', delayMs: 475 },
    ]);
  });
  it('adds a Codex-only redundant delayed submit CR for text left in the compose box', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    expect(controlWritesForAgent(d, 'codex', {})).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 500 },
      { data: '\r', delayMs: 300 },
    ]);
  });
  it('lets Codex submit and resubmit delays be tuned independently', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    const env = {
      PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '800',
      PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS: '450',
    };
    expect(controlWritesForAgent(d, 'codex', env)).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 800 },
      { data: '\r', delayMs: 450 },
    ]);
  });
  it('does not add submit bytes to raw control messages for any backend', () => {
    const d = decodeControl(encodeControl({ mode: 'raw', data: '\x03' }));
    expect(controlWritesForAgent(d, 'codex', {})).toEqual([{ data: '\x03', delayMs: 0 }]);
  });
  it('does not add submit bytes to osc (recolor) messages for any backend', () => {
    const d = decodeControl(encodeControl({ mode: 'osc', data: '\x1b]11;#000000\x07' }));
    expect(controlWritesForAgent(d, 'codex', {})).toEqual([{ data: '\x1b]11;#000000\x07', delayMs: 0 }]);
  });
});

// su-cold-auto-mode P-004a: RESET-CONTEXT drops the grown transcript in place
// (keep the process + MCP warm) then opens the fresh context on the carry-note.
// The write plan = the backend's context-clear command, then the carry as a
// normal paste-safe turn whose first keystroke waits for the clear to settle.
describe('contextClearCommandForAgent (RESET-CONTEXT clear command)', () => {
  it('Claude / OMP clear in place with /clear (process + MCP stay warm)', () => {
    expect(contextClearCommandForAgent('claude')).toBe('/clear');
    expect(contextClearCommandForAgent('omp')).toBe('/clear');
    expect(contextClearCommandForAgent('')).toBe('/clear');
    // @ts-expect-error exercising the undefined path
    expect(contextClearCommandForAgent(undefined)).toBe('/clear');
  });
  it('Codex starts a fresh conversation with /new', () => {
    expect(contextClearCommandForAgent('codex')).toBe('/new');
    expect(contextClearCommandForAgent(' CODEX ')).toBe('/new');
  });
});

// WI-41386. A recycle puts two CLI processes in ONE terminal back to back.
// claude and codex both render into the PRIMARY buffer and both start drawing
// at whatever cursor position they inherit (measured: a claude successor's
// first bytes carry no newline, no CUP and no ED; codex additionally asks with
// ESC[6n). A predecessor killed inside claude's `\r ESC[<N>A` rewind window
// leaves that cursor a whole frame HIGH, so the successor's banner overwrote
// the last screenful of the owner's scrollback on every restart. These assert
// the handoff bytes that make an overwrite structurally impossible.
describe('respawnTerminalHandoffBytes (WI-41386 respawn terminal handoff)', () => {
  it('anchors past the predecessor: parks on the last row, then CRLF, so the terminal SCROLLS instead of overwriting', () => {
    const bytes = respawnTerminalHandoffBytes({ rows: 40, separator: false });
    // absolute park at the bottom row — everything the predecessor drew is then
    // strictly ABOVE the cursor and can only move up into scrollback.
    expect(bytes).toContain('\x1b[40;1H');
    expect(bytes.endsWith('\r\n')).toBe(true);
    expect(bytes.indexOf('\x1b[40;1H')).toBeLessThan(bytes.lastIndexOf('\r\n'));
  });

  it('still guarantees a fresh line when the terminal height is unknown', () => {
    // No rows ⇒ no absolute park, but a CRLF still lands the successor on a
    // virgin line rather than on top of the predecessor's last row.
    const bytes = respawnTerminalHandoffBytes({ rows: undefined, separator: false });
    expect(bytes).not.toMatch(/\x1b\[\d+;1H/);
    expect(bytes.endsWith('\r\n')).toBe(true);
    for (const bogus of [0, 1, NaN, Infinity]) {
      expect(respawnTerminalHandoffBytes({ rows: bogus, separator: false })).not.toMatch(
        /\x1b\[\d+;1H/,
      );
    }
  });

  it('NEVER emits RIS (ESC c) or an erase-display — those would destroy the scrollback it exists to save', () => {
    const bytes = respawnTerminalHandoffBytes({ rows: 40 });
    expect(bytes).not.toContain('\x1bc'); // RIS — full reset, erases scrollback
    expect(bytes).not.toMatch(/\x1b\[[0-3]?J/); // ED in any form
  });

  it('rescues a terminal a SIGKILLed omp stranded on the alternate screen', () => {
    // omp is the one backend that runs on the alt screen (?1049h). Killed hard
    // it never emits ?1049l, and the successor then paints invisibly.
    expect(respawnTerminalHandoffBytes({ rows: 40 })).toContain('\x1b[?1049l');
  });

  it('undoes the modes a child killed mid-frame never reset', () => {
    const bytes = respawnTerminalHandoffBytes({ rows: 40 });
    expect(bytes).toContain('\x1b[?25h'); // cursor visible again
    expect(bytes).toContain('\x1b[0m'); // no inherited colour/bold
    expect(bytes).toContain('\x1b[r'); // full-height scroll region
    expect(bytes).toContain('\x1b[?7h'); // autowrap back on
    expect(bytes).toContain('\x1b[?2004l'); // bracketed paste off
    // mouse reporting off — otherwise the terminal spews on every mouse move
    for (const mode of ['1000', '1002', '1003', '1006']) {
      expect(bytes).toContain(`\x1b[?${mode}l`);
    }
  });

  it('restores BEFORE it anchors, so leaving the alt screen cannot undo the park', () => {
    const bytes = respawnTerminalHandoffBytes({ rows: 40, separator: false });
    expect(bytes.indexOf('\x1b[?1049l')).toBeLessThan(bytes.indexOf('\x1b[40;1H'));
  });

  it('emits the restart separator by default and omits it on request', () => {
    expect(respawnTerminalHandoffBytes({ rows: 40 })).toContain('session restarted');
    expect(respawnTerminalHandoffBytes({ rows: 40, separator: false })).not.toContain(
      'session restarted',
    );
    // the marker must land AFTER the anchoring CRLF, on its own fresh line
    const withMarker = respawnTerminalHandoffBytes({ rows: 40 });
    expect(withMarker.indexOf('\x1b[40;1H')).toBeLessThan(withMarker.indexOf('session restarted'));
  });

  it('is backend-agnostic: it takes no agent, so claude/codex/omp cannot drift apart', () => {
    // The bug is a property of the TERMINAL handoff, not of any one CLI, and
    // codex routes EVERY cold reset through this recycle path
    // (coldResetModeForAgent), so a per-backend branch here would be a
    // regression waiting to happen.
    expect(respawnTerminalHandoffBytes.length).toBeLessThanOrEqual(1);
    const a = respawnTerminalHandoffBytes({ rows: 40 });
    const b = respawnTerminalHandoffBytes({ rows: 40 });
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

// WI-41386, the omp half. omp emits ESC[3J ("erase saved lines" = delete the
// terminal's SCROLLBACK) at byte offset 20 of its boot stream — ~25k bytes
// BEFORE it switches to the alternate screen at offset 25,242 — so it wipes the
// owner's primary-buffer history on every boot. Measured: an omp boot destroyed
// 25 of 60 marker lines in a 40-row pane; with this guard, 0. No host-side
// cursor anchoring can help, because the CHILD issues the erase.
describe('makeScrollbackGuard (WI-41386 child → terminal scrollback guard)', () => {
  it('drops ESC[3J — the only erase that deletes history rather than the screen', () => {
    const g = makeScrollbackGuard();
    expect(g.filter('before\x1b[3Jafter')).toBe('beforeafter');
    expect(g.filter('\x1b[?3J')).toBe('');
  });

  it('passes the visible-screen erases every TUI legitimately needs', () => {
    const g = makeScrollbackGuard();
    // 2J/1J/0J/bare J erase the DISPLAY, never the scrollback — untouched.
    for (const seq of ['\x1b[2J', '\x1b[1J', '\x1b[0J', '\x1b[J']) {
      expect(g.filter(`x${seq}y`)).toBe(`x${seq}y`);
    }
    // and unrelated CSI with a 3 in it must not be mistaken for an erase
    expect(g.filter('\x1b[3m\x1b[30m\x1b[3A\x1b[13J')).toBe('\x1b[3m\x1b[30m\x1b[3A\x1b[13J');
  });

  it('survives an escape SPLIT across pty chunks — the boundary a naive filter misses', () => {
    // A pty delivers arbitrary byte runs; ESC[3J can arrive in two pieces.
    for (const cut of [1, 2, 3]) {
      const g = makeScrollbackGuard();
      const seq = '\x1b[3J';
      const first = g.filter('head' + seq.slice(0, cut));
      const second = g.filter(seq.slice(cut) + 'tail');
      expect(first + second).toBe('headtail');
    }
  });

  it('does not swallow ordinary bytes that merely follow an ESC', () => {
    const g = makeScrollbackGuard();
    const out = g.filter('a\x1b[2Jb') + g.filter('c');
    expect(out).toBe('a\x1b[2Jbc');
  });

  it('bounds what it holds back, so a stream ending mid-escape cannot strand output', () => {
    const g = makeScrollbackGuard();
    // a long run of digits can never complete an ESC[<params>3J within the cap
    const long = '\x1b[' + '1'.repeat(64);
    expect(g.filter(`visible${long}`).startsWith('visible')).toBe(true);
    // flush returns anything still held rather than losing it
    const g2 = makeScrollbackGuard();
    g2.filter('tail\x1b[');
    expect(g2.flush()).toBe('\x1b[');
  });

  it('flush never re-emits a held erase sequence', () => {
    const g = makeScrollbackGuard();
    g.filter('x\x1b[3');
    expect(g.filter('J')).toBe('');
    expect(g.flush()).toBe('');
  });

  it('is per-child state: a fresh guard cannot inherit a dead child’s partial escape', () => {
    const dying = makeScrollbackGuard();
    dying.filter('orphan\x1b[3'); // killed mid-sequence, tail held
    const fresh = makeScrollbackGuard();
    expect(fresh.filter('J done')).toBe('J done');
  });
});

describe('makeHeadlessClaudeOnboardingStateMachine (EI-21382897362160495)', () => {
  it('enables only for the explicit headless Claude launch', () => {
    expect(headlessClaudeOnboardingEnabled({ PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_AGENT: 'claude' })).toBe(true);
    expect(headlessClaudeOnboardingEnabled({ PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_AGENT: 'CLAUDE' })).toBe(true);
    expect(headlessClaudeOnboardingEnabled({ PAPERCUSP_PSU_HEADLESS: '1', PAPERCUSP_AGENT: 'codex' })).toBe(false);
    expect(headlessClaudeOnboardingEnabled({ PAPERCUSP_PSU_HEADLESS: '0', PAPERCUSP_AGENT: 'claude' })).toBe(false);
    expect(headlessClaudeOnboardingEnabled({ PAPERCUSP_AGENT: 'claude' })).toBe(false);
  });

  it('advances theme then Security notes once even when prompts cross output chunks', () => {
    let clock = 1_000;
    const machine = makeHeadlessClaudeOnboardingStateMachine({
      now: () => clock,
      startupMs: 5_000,
    });

    expect(machine.observe('Welcome to Claude Code\nChoose your preferred t')).toMatchObject({
      action: 'none',
      phase: 'theme',
    });
    expect(machine.observe('heme\n\u001b[32mDark mode\u001b[0m')).toMatchObject({
      action: 'submit',
      prompt: 'theme',
      phase: 'security',
    });

    // The security screen must be observed after the first CR; matching output
    // that was already in the theme chunk would send both CRs at once.
    expect(machine.observe('Security n')).toMatchObject({ action: 'none', phase: 'security' });
    expect(machine.observe('otes\nPress Enter to continue')).toMatchObject({
      action: 'submit',
      prompt: 'security',
      phase: 'complete',
    });
    expect(machine.observe('Security notes\nPress Enter')).toMatchObject({ action: 'none', phase: 'complete' });
    expect(machine.status()).toMatchObject({ phase: 'complete', active: false, complete: true });
    clock += 1_000;
  });

  it('accepts a standalone composer when no onboarding wizard appeared', () => {
    const machine = makeHeadlessClaudeOnboardingStateMachine({ now: () => 1_000, startupMs: 5_000 });
    expect(machine.observe('Claude Code startup banner')).toMatchObject({ phase: 'theme', active: true });
    expect(machine.observe('\n❯\n')).toMatchObject({
      action: 'ready',
      phase: 'complete',
      active: false,
      complete: true,
    });
  });

  it('expires the startup actuator and stops answering after the bounded window', () => {
    let clock = 10_000;
    const machine = makeHeadlessClaudeOnboardingStateMachine({ now: () => clock, startupMs: 100 });
    expect(machine.status()).toMatchObject({ phase: 'theme', expiresAt: 10_100 });
    clock = 10_100;
    expect(machine.observe('Choose a theme: Dark mode')).toMatchObject({ action: 'expired', phase: 'expired' });
    expect(machine.observe('Security notes\nPress Enter')).toMatchObject({ action: 'none', phase: 'expired' });
    expect(machine.status()).toMatchObject({ active: false, expired: true });
  });

  it('uses a positive environment override and ignores invalid startup windows', () => {
    expect(headlessClaudeOnboardingStartupMs({ PAPERCUSP_PSU_HEADLESS_ONBOARDING_STARTUP_MS: '4500' })).toBe(4_500);
    expect(headlessClaudeOnboardingStartupMs({ PAPERCUSP_PSU_HEADLESS_ONBOARDING_STARTUP_MS: '0' })).toBe(30_000);
    expect(headlessClaudeOnboardingStartupMs({ PAPERCUSP_PSU_HEADLESS_ONBOARDING_STARTUP_MS: 'nope' })).toBe(30_000);
  });
});

describe('fresh headless Claude kickoff composer gate', () => {
  it('does not treat generic startup output or an onboarding option row as editor readiness', () => {
    expect(startupOutputReady('claude', 'Welcome to Claude Code')).toBe(false);
    expect(startupOutputReady('claude', '❯ 1. Choose a theme')).toBe(false);
    expect(startupOutputReady('claude', '\n❯\n')).toBe(true);
    expect(freshChildPromptReady('claude', '❯ 1. Choose a theme')).toBe(false);
  });

  it('recognizes the current Claude placeholder composer without accepting a menu row', () => {
    const observedFrame = '\x1b[38;5;244m────────────────\x1b[39m\r\n' +
      '❯\u00a0Try "how do I log an error?"\r\n' +
      '\x1b[38;5;246m◐ medium · /effort\x1b[39m';
    expect(freshChildPromptReady('claude', observedFrame)).toBe(true);
    expect(startupOutputReady('claude', observedFrame)).toBe(true);
    expect(headlessClaudeKickoffReadiness({
      enabled: true, requireInitialOutput: true,
      promptReady: freshChildPromptReady('claude', observedFrame),
    })).toBe('composer-ready');
    expect(freshChildPromptReady('claude', '❯ 1. Resume from summary')).toBe(false);
    expect(freshChildPromptReady('claude', '❯ Try again')).toBe(false);
  });

  it('waits for the composer during a fresh headless launch and keeps the ordinary gate elsewhere', () => {
    expect(headlessClaudeKickoffReadiness({
      enabled: true,
      requireInitialOutput: true,
      promptReady: false,
    })).toBe('wait-for-composer');
    expect(headlessClaudeKickoffReadiness({
      enabled: true,
      requireInitialOutput: true,
      promptReady: true,
    })).toBe('composer-ready');
    expect(headlessClaudeKickoffReadiness({
      enabled: false,
      requireInitialOutput: true,
      promptReady: false,
    })).toBe('ordinary-gate');
    expect(HEADLESS_CLAUDE_KICKOFF_READY_TIMEOUT_MS).toBe(20_000);
  });
});

describe('makeClaudeResumeCompactionRecoveryStateMachine (EI-21540586187946540)', () => {
  const MENU =
    'Autocompact is thrashing\n' +
    '1. Resume from summary (recommended)\n' +
    '2. Resume full session as-is\n' +
    "3. Don't ask again";

  it('selects the safe summary choice once across ANSI and chunk boundaries, then requires a later composer prompt', () => {
    let clock = 1_000;
    const machine = makeClaudeResumeCompactionRecoveryStateMachine({
      now: () => clock,
      startupMs: 5_000,
      recoveryMs: 5_000,
    });

    expect(machine.observe(`\u001b[31m${MENU.slice(0, 31)}`)).toMatchObject({
      action: 'none',
      phase: 'watching',
    });
    const selected = machine.observe(`${MENU.slice(31)}\u001b[0m`);
    expect(selected).toMatchObject({
      action: 'select-summary',
      phase: 'awaiting-prompt',
      ready: false,
      selectedSummary: true,
    });

    // The selected menu row can itself contain a `❯`; it is not the composer.
    expect(machine.observe('\n❯ 1. Resume from summary (recommended)\n')).toMatchObject({
      action: 'none',
      phase: 'awaiting-prompt',
      ready: false,
    });
    expect(machine.observe('\n\u001b[32m')).toMatchObject({ action: 'none', phase: 'awaiting-prompt' });
    expect(machine.observe('❯\u001b[0m \n')).toMatchObject({
      action: 'ready',
      phase: 'ready',
      ready: true,
      awaitingPrompt: false,
    });
    expect(machine.observe(MENU)).toMatchObject({ action: 'none', phase: 'ready' });
    clock += 1_000;
  });

  it('expires a selected recovery instead of authorizing a kickoff without a standalone prompt', () => {
    let clock = 10_000;
    const machine = makeClaudeResumeCompactionRecoveryStateMachine({
      now: () => clock,
      startupMs: 5_000,
      recoveryMs: 100,
    });
    expect(machine.observe(MENU)).toMatchObject({ action: 'select-summary', phase: 'awaiting-prompt' });
    clock = 10_099;
    expect(machine.tick()).toMatchObject({ action: 'none', phase: 'awaiting-prompt', timedOut: false });
    clock = 10_100;
    expect(machine.tick()).toMatchObject({ action: 'expired', phase: 'timed-out', timedOut: true, ready: false });
    expect(machine.observe('\n❯\n')).toMatchObject({ action: 'none', phase: 'timed-out', ready: false });
  });

  it('uses positive environment overrides and ignores invalid recovery windows', () => {
    expect(claudeResumeCompactionStartupMs({ PAPERCUSP_PSU_PTY_RESUME_COMPACTION_STARTUP_MS: '4500' })).toBe(4_500);
    expect(claudeResumeCompactionRecoveryMs({ PAPERCUSP_PSU_PTY_RESUME_COMPACTION_RECOVERY_MS: '7000' })).toBe(7_000);
    expect(claudeResumeCompactionStartupMs({ PAPERCUSP_PSU_PTY_RESUME_COMPACTION_STARTUP_MS: '0' })).toBe(30_000);
    expect(claudeResumeCompactionRecoveryMs({ PAPERCUSP_PSU_PTY_RESUME_COMPACTION_RECOVERY_MS: 'nope' })).toBe(30_000);
  });
});

describe('coldResetModeForAgent (backend-aware cold reset)', () => {
  it('routes Codex to a hard recycle because /new cannot cut the long-lived process context', () => {
    expect(coldResetModeForAgent('codex')).toBe('recycle');
    expect(coldResetModeForAgent(' CODEX ')).toBe('recycle');
  });

  it('keeps Claude and OMP on the in-place reset path', () => {
    expect(coldResetModeForAgent('claude')).toBe('reset');
    expect(coldResetModeForAgent('omp')).toBe('reset');
    expect(coldResetModeForAgent('')).toBe('reset');
  });
});

describe('submitVerifyQuietMs (WI-2975 — decoupled from OUTPUT_QUIET_MS)', () => {
  it('defaults to 6000ms; env override wins; a bad override falls back', () => {
    expect(submitVerifyQuietMs({})).toBe(6_000);
    expect(submitVerifyQuietMs({ PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '9000' })).toBe(9_000);
    expect(submitVerifyQuietMs({ PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: 'nope' })).toBe(6_000);
    expect(submitVerifyQuietMs({ PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS: '-5' })).toBe(6_000);
  });

  it('is a DIFFERENT default than the busy-gate\'s OUTPUT_QUIET_MS (1500ms) — the WI-2975 fix is precisely that these no longer share one value', () => {
    expect(submitVerifyQuietMs({})).not.toBe(1_500);
    expect(submitVerifyQuietMs({})).toBeGreaterThan(1_500);
  });
});

describe('fireSessionCompactedEvent (event-await P-103 — the detached emit bridge)', () => {
  const okChild = () => ({ on: () => {}, unref: () => {} });

  it('spawns the detached tsx emit CLI with owner + focus + successor native id', () => {
    const spawnFn = vi.fn(() => okChild());
    const child = fireSessionCompactedEvent('su-94b69', 'keep the plan', {
      spawnFn,
      existsFn: () => true,
      entry: '/x/emit-session-compacted.ts',
      nativeId: 'successor-native-id',
    });
    expect(child).not.toBeNull();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('npx');
    expect(args).toEqual([
      'tsx',
      '/x/emit-session-compacted.ts',
      'su-94b69',
      'keep the plan',
      'successor-native-id',
    ]);
    // detached + fully silenced so a spawn failure can never touch the live session
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('is a NO-OP (never spawns) until the CLI entry exists — safe to ship the wire before the CLI', () => {
    const spawnFn = vi.fn(() => okChild());
    const out = fireSessionCompactedEvent('su-94b69', 'f', { spawnFn, existsFn: () => false });
    expect(out).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('no-ops on a missing ownerId (never emit an unkeyed event)', () => {
    const spawnFn = vi.fn(() => okChild());
    expect(fireSessionCompactedEvent('', 'f', { spawnFn, existsFn: () => true })).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('coerces a null/undefined focus to an empty-string argv (never passes "undefined")', () => {
    const spawnFn = vi.fn(() => okChild());
    fireSessionCompactedEvent('su-x', undefined, { spawnFn, existsFn: () => true, entry: '/e.ts' });
    expect(spawnFn.mock.calls[0][1]).toEqual(['tsx', '/e.ts', 'su-x', '', '']);
  });

  it('FAIL-SOFT: a spawn that throws is swallowed (returns null, never propagates into the session)', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('npx not found');
    });
    expect(() => fireSessionCompactedEvent('su-x', 'f', { spawnFn, existsFn: () => true, entry: '/e.ts' })).not.toThrow();
    expect(fireSessionCompactedEvent('su-x', 'f', { spawnFn, existsFn: () => true, entry: '/e.ts' })).toBeNull();
  });

  it('the default emit-CLI entry is a sibling .ts of the host script', () => {
    expect(SESSION_COMPACTED_EMIT_ENTRY).toMatch(/scripts[/\\]emit-session-compacted\.ts$/);
  });
});

describe('clearSettleMs (RESET-CONTEXT repaint budget)', () => {
  it('defaults to 1500ms and honours a session-env override', () => {
    expect(clearSettleMs({})).toBe(1500);
    expect(clearSettleMs({ PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS: '800' })).toBe(800);
  });
  it('ignores an invalid override', () => {
    expect(clearSettleMs({ PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS: 'nope' })).toBe(1500);
    expect(clearSettleMs({ PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS: '-5' })).toBe(1500);
  });
});

describe('resetWritesForAgent (RESET-CONTEXT write plan)', () => {
  it('Claude: /clear + submit, then the carry turn after the settle', () => {
    const d = decodeControl(encodeControl({ mode: 'reset', data: 'CARRY' }));
    expect(resetWritesForAgent(d, 'claude', {})).toEqual([
      { data: '/clear', delayMs: 0 }, // type the clear command
      { data: '\r', delayMs: 150 }, //   submit it (claude CR delay)
      { data: 'CARRY', delayMs: 1500 }, // carry text — waits for the clear to repaint
      { data: '\r', delayMs: 150 }, //   submit the carry turn
    ]);
  });
  it('routes through controlWritesForAgent (reset dispatches to the reset plan)', () => {
    const d = decodeControl(encodeControl({ mode: 'reset', data: 'CARRY' }));
    expect(controlWritesForAgent(d, 'claude', {})).toEqual(resetWritesForAgent(d, 'claude', {}));
  });
  it('Codex: /new clear + the codex double-submit carry turn', () => {
    const d = decodeControl(encodeControl({ mode: 'reset', data: 'CARRY' }));
    expect(resetWritesForAgent(d, 'codex', {})).toEqual([
      { data: '/new', delayMs: 0 },
      { data: '\r', delayMs: 500 }, // codex submit delay
      { data: 'CARRY', delayMs: 1500 }, // carry text after the settle
      { data: '\r', delayMs: 500 }, // codex submit
      { data: '\r', delayMs: 300 }, // codex redundant resubmit
    ]);
  });
  it('an empty carry ⇒ a bare clear (no opening turn)', () => {
    const d = decodeControl(encodeControl({ mode: 'reset', data: '' }));
    expect(resetWritesForAgent(d, 'claude', {})).toEqual([
      { data: '/clear', delayMs: 0 },
      { data: '\r', delayMs: 150 },
    ]);
  });
  it('honours a custom clear-settle override', () => {
    const d = decodeControl(encodeControl({ mode: 'reset', data: 'CARRY' }));
    const steps = resetWritesForAgent(d, 'claude', { PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS: '600' });
    expect(steps[2]).toEqual({ data: 'CARRY', delayMs: 600 });
  });
});

describe('fleetOscFromEnv (launch-time fleet recolor)', () => {
  it('builds OSC 10/11/12 from the PAPERCUSP_FLEET_* env vars (matches oscRecolorSequence)', () => {
    expect(
      fleetOscFromEnv({
        PAPERCUSP_FLEET_BG: '#581c87',
        PAPERCUSP_FLEET_FG: '#f5e8ff',
        PAPERCUSP_FLEET_CURSOR: '#d8b4fe',
      }),
    ).toBe('\x1b]10;#f5e8ff\x07\x1b]11;#581c87\x07\x1b]12;#d8b4fe\x07');
  });
  it('returns null when no fleet bg is set — the no-fleet session keeps its profile default', () => {
    expect(fleetOscFromEnv({})).toBeNull();
    expect(fleetOscFromEnv({ PAPERCUSP_FLEET_FG: '#ffffff' })).toBeNull();
  });
  it('bg alone is enough; fg + cursor are optional', () => {
    expect(fleetOscFromEnv({ PAPERCUSP_FLEET_BG: '#166534' })).toBe('\x1b]11;#166534\x07');
  });
});

// fleet-recolor-and-color-hardening P-003: the OSC 10/11/12 recolor bytes are
// hand-written in THREE places that the source comments say must stay "in
// lockstep" — console-color-schemes.oscRecolorSequence (operator-core raw bytes),
// psu-pty-host.fleetOscFromEnv (this file's inline copy), and console-spawn's
// shell prelude (the bee / capability:terminal path, reached via
// buildConsoleOneliner). This guard fails the moment any of the three drifts on
// an OSC number or a color value, for ANY catalog scheme.
describe('OSC emitter drift guard (the 3 fleet-color emitters must agree)', () => {
  // Extract every OSC 10/11/12 color directive ("]1N;#rrggbb") from a string —
  // works on the raw-byte sequences AND the shell `printf '\033]1N;#rrggbb\007'`
  // form. Returns { '10': fg, '11': bg, '12': cursor }.
  function oscColorMap(s: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of s.matchAll(/\]1([012]);(#[0-9a-fA-F]{6})/g)) out[`1${m[1]}`] = m[2].toLowerCase();
    return out;
  }

  it('all three emitters produce the same OSC 10/11/12 colors for every catalog scheme', () => {
    for (const s of COLOR_SCHEMES) {
      const expected = { '10': s.fg, '11': s.bg, '12': s.cursor };
      // 1. operator-core raw bytes (the canonical recolor sequence)
      expect(oscColorMap(oscRecolorSequence(s))).toEqual(expected);
      // 2. psu-pty-host's inline copy from env — MUST be byte-identical to #1
      expect(
        fleetOscFromEnv({
          PAPERCUSP_FLEET_BG: s.bg,
          PAPERCUSP_FLEET_FG: s.fg,
          PAPERCUSP_FLEET_CURSOR: s.cursor,
        }),
      ).toBe(oscRecolorSequence(s));
      // 3. the console-spawn shell prelude (bee / capability:terminal window)
      const oneliner = buildConsoleOneliner('/x', {}, 'true', {
        mode: 'console',
        planSlug: null,
        label: null,
        scheme: s,
      });
      expect(oscColorMap(oneliner)).toEqual(expected);
    }
  });
});

describe('makeIdleGate (P-013 mid-keystroke safety)', () => {
  it('is idle immediately when nothing was ever typed', () => {
    const g = makeIdleGate({ idleMs: 100, now: () => 1000 });
    expect(g.remainingIdleMs(1000)).toBe(0);
  });
  it('reports the remaining wait right after a keystroke, then idle', () => {
    let t = 1000;
    const g = makeIdleGate({ idleMs: 100, now: () => t });
    g.touch(); // typed at t=1000
    expect(g.remainingIdleMs(1000)).toBe(100); // must wait the full window
    expect(g.remainingIdleMs(1050)).toBe(50); // halfway
    expect(g.remainingIdleMs(1100)).toBe(0); // window elapsed → idle
    expect(g.remainingIdleMs(1200)).toBe(0); // stays idle
  });
  it('waitIdle resolves immediately when already idle', async () => {
    const g = makeIdleGate({ idleMs: 50, capMs: 1000 });
    const r = await g.waitIdle();
    expect(r.deferred).toBe(false);
  });
  it('waitIdle defers a write while typing continues, bounded by capMs', async () => {
    // Tiny idle window + tiny cap: never goes idle (we keep "typing" via a clock
    // that always advances less than idleMs since the last touch) → cap fires.
    let t = 0;
    const g = makeIdleGate({ idleMs: 1_000_000, capMs: 30, now: () => (t += 10) });
    const r = await g.waitIdle();
    expect(r.deferred).toBe(true);
    expect(r.reason).toBe('idle-cap');
  });
});

describe('makeOwnerComposerGate (EI-20199370837439455 staged-input safety)', () => {
  it('ignores complete terminal reply sequences instead of inventing owner text', () => {
    const g = makeOwnerComposerGate({ capMs: 100 });

    // Codex asks the terminal for cursor/device state; replies arrive on the
    // same stdin stream as human keystrokes. The old parser stopped at `[`, so
    // each payload below left phantom text pending and blocked carry-respawn.
    g.observe('\u001b[12;40R'); // cursor-position report
    g.observe('\u001b[?1;2c'); // device-attributes report
    g.observe('\u001b[200~\u001b[201~'); // bracketed-paste markers
    g.observe('\u001bOP'); // SS3 key report
    g.observe('\u001b]0;terminal title\u0007'); // OSC + BEL
    g.observe('\u001b]0;terminal title\u001b\\'); // OSC + ST

    expect(g.hasPending()).toBe(false);
    expect(g.pendingLength()).toBe(0);

    // The control-sequence filter must not weaken the actual safety contract.
    g.observe('owner text');
    expect(g.hasPending()).toBe(true);
    expect(g.pendingLength()).toBe(10);
  });

  it('clears staged state when the old child is replaced', () => {
    const g = makeOwnerComposerGate({ capMs: 100 });
    g.observe('draft for the old child');
    expect(g.hasPending()).toBe(true);

    // recycleChild calls this only after the old child has exited. Its editor
    // no longer exists, so retaining this bit would falsely block every wake
    // sent to the fresh successor.
    g.markSubmitted();
    expect(g.hasPending()).toBe(false);
    expect(g.pendingLength()).toBe(0);

    // Normal protection remains armed for actual text in the new child.
    g.observe('new draft');
    expect(g.hasPending()).toBe(true);
  });

  /**
   * WI-38156. The test above enumerated the families that had bitten us (CSI,
   * OSC, SS3) rather than the closed ECMA-48 set, so DCS stayed unhandled — and
   * the bug recurred the moment a TUI asked gnome-terminal for its version.
   * These cases pin the WHOLE set, and use bytes captured from a live terminal
   * rather than bytes reconstructed from the spec.
   */
  describe('string-type control sequences (WI-38156 DCS/APC/PM/SOS)', () => {
    // Captured 2026-08-12 from a real gnome-terminal (VTE 7600) by writing the
    // query and reading the raw reply back off the pty:
    //   XTVERSION `ESC [ > 0 q`  ->  1b50 3e7c 5654 4528 3736 3030 29 1b5c
    const VTE_XTVERSION_REPLY = '\u001bP>|VTE(7600)\u001b\\';
    const VTE_DA3_REPLY = '\u001bP!|7E565445\u001b\\';
    const VTE_DECRQSS_REPLY = '\u001bP0$r\u001b\\';

    it('does not invent owner text from the live VTE XTVERSION reply', () => {
      const g = makeOwnerComposerGate({ capMs: 100 });
      g.observe(VTE_XTVERSION_REPLY);
      // The regression counted `>|VTE(7600)` as 11 characters of owner text,
      // which nothing could clear, so every wake deferred with owner-input-cap.
      expect(g.pendingLength()).toBe(0);
      expect(g.hasPending()).toBe(false);
    });

    it('ignores every string-sequence family, terminated by ST or BEL', () => {
      const g = makeOwnerComposerGate({ capMs: 100 });
      for (const reply of [
        VTE_XTVERSION_REPLY,
        VTE_DA3_REPLY,
        VTE_DECRQSS_REPLY,
        '\u001b_Gi=1,a=q;OK\u001b\\', // APC  (kitty graphics)
        '\u001b^status message\u001b\\', // PM
        '\u001bXsome string\u001b\\', // SOS
        '\u001b]11;rgb:0000/0000/0000\u0007', // OSC terminated by BEL
      ]) {
        g.observe(reply);
      }
      expect(g.pendingLength()).toBe(0);
      expect(g.hasPending()).toBe(false);
    });

    it('ignores replies split across chunk boundaries, one byte at a time', () => {
      // A pty read can split anywhere. A parser that resynchronises only on a
      // whole chunk counts the tail of a sequence as text.
      const g = makeOwnerComposerGate({ capMs: 100 });
      for (const ch of `${VTE_XTVERSION_REPLY}${VTE_DA3_REPLY}`) g.observe(ch);
      expect(g.pendingLength()).toBe(0);
      expect(g.hasPending()).toBe(false);
    });

    it('still stages real owner text that arrives after a reply', () => {
      const g = makeOwnerComposerGate({ capMs: 100 });
      g.observe(VTE_XTVERSION_REPLY);
      g.observe('put yourself on auto mode');
      expect(g.hasPending()).toBe(true);
      expect(g.pendingLength()).toBe(25);
      g.observe('\r');
      expect(g.hasPending()).toBe(false);
    });

    it('reports staged-line age and owner quiet time so a wedge is falsifiable', () => {
      let clock = 1_000;
      const g = makeOwnerComposerGate({ capMs: 100, now: () => clock });

      // A terminal reply must leave NO trace: nothing staged, and no evidence
      // that an owner byte was ever seen.
      g.observe(VTE_XTVERSION_REPLY);
      expect(g.pendingAgeMs()).toBe(0);
      expect(g.ownerQuietMs()).toBe(Infinity);

      g.observe('hi');
      clock += 60_000;
      expect(g.pendingAgeMs()).toBe(60_000);
      expect(g.ownerQuietMs()).toBe(60_000);

      g.observe('\u0015'); // Ctrl-U cancels the line
      expect(g.pendingAgeMs()).toBe(0);
    });
  });

  /**
   * WI-38156, second defect: onStdin stamped idleGate/lastInputAt/owner-presence
   * before classifying the bytes, so a terminal's own reply forged owner
   * presence — and because shutdownRefusalReason treats any lastInputAt > 0 as
   * 'human-attended' permanently, every bridged agent session became
   * un-shutdownable by tooling.
   */
  describe('makeOwnerInputDetector (terminal replies are not owner presence)', () => {
    it('rejects terminal-authored string sequences', () => {
      const d = makeOwnerInputDetector();
      expect(d.sawOwnerInput('\u001bP>|VTE(7600)\u001b\\')).toBe(false);
      expect(d.sawOwnerInput('\u001b]11;rgb:0000/0000/0000\u0007')).toBe(false);
    });

    it('rejects a reply even when it is split one byte per read', () => {
      const d = makeOwnerInputDetector();
      const seen = [...'\u001bP>|VTE(7600)\u001b\\'].map((c) => d.sawOwnerInput(c));
      expect(seen.some(Boolean)).toBe(false);
    });

    it('does not let ambiguous terminal replies cancel a fresh carry, while real input still does', () => {
      const d = makeFreshChildOwnerInterruptionDetector();
      expect(d.sawOwnerInput('\u001b[12;40R')).toBe(false); // cursor-position reply
      expect(d.sawOwnerInput('\u001b[?1;2c')).toBe(false); // device-attributes reply
      expect(d.sawOwnerInput('\u001bOP')).toBe(false); // ambiguous SS3 reply/key
      expect(d.sawOwnerInput('owner draft')).toBe(true);
      expect(d.sawOwnerInput('\r')).toBe(true);
      expect(d.sawOwnerInput('\u0003')).toBe(true);
    });

    it('keeps the fresh-carry interruption detector stateful across split terminal replies', () => {
      const d = makeFreshChildOwnerInterruptionDetector();
      const seen = [...'\u001b[12;40R'].map((c) => d.sawOwnerInput(c));
      expect(seen.some(Boolean)).toBe(false);
    });

    it('never fires for a line the owner is actually editing', () => {
      // The whole point is to stay silent while a person types. Each defer here
      // sees a DIFFERENT length, which is what a human looks like.
      const d = makeComposerWedgeDetector({ minDefers: 3, minQuietMs: 1_000 });
      for (const pendingLength of [4, 5, 6, 7, 8, 9]) {
        expect(d.note({ pendingLength, ownerQuietMs: 60_000 })).toBeNull();
      }
    });

    it('stays silent while the owner is merely slow', () => {
      const d = makeComposerWedgeDetector({ minDefers: 3, minQuietMs: 300_000 });
      // Unchanged line, but bytes arrived recently — they stepped away for a
      // moment, they did not vanish.
      expect(d.note({ pendingLength: 11, ownerQuietMs: 2_000 })).toBeNull();
      expect(d.note({ pendingLength: 11, ownerQuietMs: 9_000 })).toBeNull();
      expect(d.note({ pendingLength: 11, ownerQuietMs: 30_000 })).toBeNull();
    });

    it('reports a phantom line: unchanged length, no owner byte ever seen', () => {
      // This is the shape of the live incident — a constant 11-char staged line
      // (VTE's `>|VTE(7600)`) deferring every wake with no keystroke behind it.
      const d = makeComposerWedgeDetector({ minDefers: 3, minQuietMs: 300_000 });
      expect(d.note({ pendingLength: 11, ownerQuietMs: Infinity })).toBeNull();
      expect(d.note({ pendingLength: 11, ownerQuietMs: Infinity })).toBeNull();
      const report = d.note({ pendingLength: 11, ownerQuietMs: Infinity, pendingAgeMs: 7_200_000 });
      expect(report).toMatchObject({
        pendingLength: 11,
        consecutiveDefers: 3,
        ownerQuietMs: null,
        ownerBytesEverSeen: false,
        pendingAgeMs: 7_200_000,
      });
    });

    it('reports once per episode, then re-arms when the line changes', () => {
      const d = makeComposerWedgeDetector({ minDefers: 2, minQuietMs: 1_000 });
      expect(d.note({ pendingLength: 11, ownerQuietMs: Infinity })).toBeNull();
      expect(d.note({ pendingLength: 11, ownerQuietMs: Infinity })).not.toBeNull();
      // A wedged host must not log this on every single wake.
      expect(d.note({ pendingLength: 11, ownerQuietMs: Infinity })).toBeNull();
      expect(d.note({ pendingLength: 11, ownerQuietMs: Infinity })).toBeNull();
      // A new staged line is a new episode and may be reported again.
      expect(d.note({ pendingLength: 12, ownerQuietMs: Infinity })).toBeNull();
      expect(d.note({ pendingLength: 12, ownerQuietMs: Infinity })).not.toBeNull();
    });

    it('also catches a REAL owner who walked away mid-line', () => {
      // Not a false positive: the agent is just as stuck, so this is worth
      // saying out loud even though a human really did type the line.
      const d = makeComposerWedgeDetector({ minDefers: 2, minQuietMs: 300_000 });
      expect(d.note({ pendingLength: 24, ownerQuietMs: 900_000 })).toBeNull();
      expect(d.note({ pendingLength: 24, ownerQuietMs: 960_000 })).toMatchObject({
        ownerBytesEverSeen: true,
        ownerQuietMs: 960_000,
      });
    });
  });

  describe('shouldBreakComposerWedge: the actuator the detector never had (WI-38257)', () => {
    // Thresholds match the shipped defaults so these cases describe real
    // behaviour, not a tuning that only exists in the test.
    const T = { minAgeMs: 90_000, minQuietMs: 90_000 };

    it('CLEARS the 2026-08-12 incident, using its verbatim ledger numbers', () => {
      // The row that ended the episode, from the host event log:
      //   {"reason":"owner-input-cap","pendingLength":53,
      //    "pendingAgeMs":112057,"ownerQuietMs":102321}
      // Every wake deferred against this and the agent took no turn at all until
      // a human typed. If this case ever returns false again, that strand is back.
      expect(
        shouldBreakComposerWedge({ pending: true, pendingAgeMs: 112_057, ownerQuietMs: 102_321 }, T),
      ).toBe(true);
    });

    it('would have fired BEFORE the human had to intervene', () => {
      // The owner broke the strand by typing at ~112s. Recovery is only worth
      // anything if it beats the person it is meant to spare, so assert the
      // earlier sample clears too — the one 31s before they gave up.
      expect(
        shouldBreakComposerWedge({ pending: true, pendingAgeMs: 95_000, ownerQuietMs: 91_000 }, T),
      ).toBe(true);
    });

    it('does NOT fire on the sample where the detector was still correct to wait', () => {
      // Same episode, 30s earlier: age 80.9s, quiet 71.2s. Still inside the
      // grace, so the answer must be "keep waiting" — this is the falsifying
      // control that proves the predicate is reading its inputs and not just
      // returning true for anything with a staged line.
      expect(
        shouldBreakComposerWedge({ pending: true, pendingAgeMs: 80_900, ownerQuietMs: 71_164 }, T),
      ).toBe(false);
    });

    it('never touches a line someone is actually typing into', () => {
      // Old line, but a keystroke arrived two seconds ago: a person is there.
      expect(
        shouldBreakComposerWedge({ pending: true, pendingAgeMs: 600_000, ownerQuietMs: 2_000 }, T),
      ).toBe(false);
    });

    it('never fires when nothing is staged', () => {
      expect(
        shouldBreakComposerWedge({ pending: false, pendingAgeMs: 999_999, ownerQuietMs: Infinity }, T),
      ).toBe(false);
    });

    it('clears a pure phantom as soon as it is old enough', () => {
      // ownerQuietMs is Infinity when no owner byte was EVER seen, which
      // satisfies any quiet threshold — so a phantom waits only on age.
      expect(
        shouldBreakComposerWedge({ pending: true, pendingAgeMs: 90_000, ownerQuietMs: Infinity }, T),
      ).toBe(true);
      expect(
        shouldBreakComposerWedge({ pending: true, pendingAgeMs: 89_999, ownerQuietMs: Infinity }, T),
      ).toBe(false);
    });

    it('is NOT gated on "no owner byte was ever seen" — the guard that would have missed the incident', () => {
      // Recorded because it was my first design and the ledger falsified it:
      // the real incident had ownerQuietMs=102321, i.e. FINITE, so owner-
      // classified bytes had arrived. A never-saw-a-byte guard would have sat
      // out the very event it was written for.
      const finiteQuiet = { pending: true, pendingAgeMs: 112_057, ownerQuietMs: 102_321 };
      expect(finiteQuiet.ownerQuietMs).toBeLessThan(Infinity);
      expect(shouldBreakComposerWedge(finiteQuiet, T)).toBe(true);
    });
  });

  describe('shouldBreakComposerWedge: the wake-loss fallback (EI-20287339148365013)', () => {
    const T = { minAgeMs: 90_000, minQuietMs: 90_000, maxDefers: 5 };

    it('breaks the wedge that ran 259 minutes because its measurements were ABSENT', () => {
      // The verbatim shape of every row those hosts emitted — measured across
      // ten ledgers in ~/.papercusp/psu-pty on 2026-08-12:
      //   {"kind":"turn-deferred-for-owner-input","reason":"owner-input-cap",
      //    "pendingLength":11}
      // No pendingAgeMs, no ownerQuietMs: the fields did not exist in the code
      // those hosts were running. Destructuring then yields pendingAgeMs = 0,
      // the age guard fails, and the old predicate returns false FOREVER. Worst
      // observed strand: 259 minutes with no turn taken.
      const absent = { pending: true, consecutiveDefers: 5 };
      expect('pendingAgeMs' in absent).toBe(false);
      expect('ownerQuietMs' in absent).toBe(false);
      expect(shouldBreakComposerWedge(absent, T)).toBe(true);
    });

    it('still waits below the deferral budget — the control that proves it reads the count', () => {
      // Same absent-measurement shape, one defer short. If this returned true
      // the fallback would be "break any staged line", which is not a guard.
      expect(shouldBreakComposerWedge({ pending: true, consecutiveDefers: 4 }, T)).toBe(false);
      expect(shouldBreakComposerWedge({ pending: true, consecutiveDefers: 5 }, T)).toBe(true);
    });

    it('fires when a repeating machine emitter holds ownerQuietMs below threshold', () => {
      // The proxy failure the timing rule cannot see: bytes classified as text
      // reset the quiet window, so a terminal reply family the scanner does not
      // recognise — the exact bug that staged these lines — makes the host look
      // permanently attended. Timing rule alone says wait; wake-loss says break.
      const emitterHeld = { pending: true, pendingAgeMs: 3_600_000, ownerQuietMs: 2_000 };
      expect(shouldBreakComposerWedge(emitterHeld, T)).toBe(false);
      expect(shouldBreakComposerWedge({ ...emitterHeld, consecutiveDefers: 5 }, T)).toBe(true);
    });

    it('never fires on an unstaged line, however many defers are claimed', () => {
      expect(
        shouldBreakComposerWedge({ pending: false, consecutiveDefers: 9_999 }, T),
      ).toBe(false);
    });

    it('leaves the pre-existing timing behaviour intact when no count is supplied', () => {
      // Callers that predate the fallback pass no consecutiveDefers. It must
      // default to 0 (never break on the new path) so the only behaviour change
      // is strictly additive — the incident sample still clears on timing alone.
      expect(
        shouldBreakComposerWedge({ pending: true, pendingAgeMs: 112_057, ownerQuietMs: 102_321 }, T),
      ).toBe(true);
      expect(
        shouldBreakComposerWedge({ pending: true, pendingAgeMs: 80_900, ownerQuietMs: 71_164 }, T),
      ).toBe(false);
    });
  });

  describe('makeComposerWedgeDetector: the count the breaker depends on', () => {
    it('keeps counting after note() has gone quiet for the episode', () => {
      // note() reports once per staged line and returns null forever after, so
      // the running count became invisible to the caller at exactly the point
      // the episode got worse. The breaker reads the accessor, not the report.
      const d = makeComposerWedgeDetector({ minDefers: 3, minQuietMs: 1_000 });
      const sample = { pendingLength: 11, ownerQuietMs: 300_000, pendingAgeMs: 300_000 };
      d.note(sample);
      d.note(sample);
      expect(d.note(sample)).not.toBeNull(); // the one-shot report
      expect(d.note(sample)).toBeNull(); // reported already — silent from here
      expect(d.consecutiveDefers()).toBe(4); // …but still counting
      d.note(sample);
      expect(d.consecutiveDefers()).toBe(5);
    });

    it('resets the count when the line moves, which is what keeps it off a person', () => {
      // This is the whole reason the fallback is safe to fire without a clock:
      // a human's staged line changes length as they type, so their count can
      // never accumulate toward the break. Only a line nobody is editing does.
      const d = makeComposerWedgeDetector({ minDefers: 3, minQuietMs: 300_000 });
      d.note({ pendingLength: 11 });
      d.note({ pendingLength: 11 });
      expect(d.consecutiveDefers()).toBe(2);
      d.note({ pendingLength: 12 }); // a keystroke landed
      expect(d.consecutiveDefers()).toBe(1);
    });
  });

  describe('makeOwnerInputDetector: real keystrokes still count', () => {
    it('still accepts real keystrokes, including navigation keys', () => {
      // Deliberately conservative: CSI/SS3 are ambiguous (a human pressing Left
      // and a cursor-position reply are the same bytes), so they keep counting
      // as owner input exactly as before this fix.
      expect(makeOwnerInputDetector().sawOwnerInput('hello')).toBe(true);
      expect(makeOwnerInputDetector().sawOwnerInput('\u001b[D')).toBe(true);
      expect(makeOwnerInputDetector().sawOwnerInput('\u001bOP')).toBe(true);
      expect(makeOwnerInputDetector().sawOwnerInput('\r')).toBe(true);
    });
  });

  it('keeps quiet owner text pending until an explicit submit or cancel', () => {
    const g = makeOwnerComposerGate({ capMs: 100 });
    g.observe('put yourself on auto mode');
    expect(g.hasPending()).toBe(true);
    expect(g.pendingLength()).toBeGreaterThan(0);

    g.observe('\b'.repeat(30));
    expect(g.hasPending()).toBe(false);

    g.observe('continue');
    g.observe('\u0015'); // Ctrl-U: kill the current line.
    expect(g.hasPending()).toBe(false);
  });

  it('unblocks a gated wake when the owner submits the staged line', async () => {
    const g = makeOwnerComposerGate({ capMs: 1000 });
    g.observe('owner text');
    const waiting = g.waitClear();
    g.observe('\r');
    await expect(waiting).resolves.toEqual({ deferred: false });
    expect(g.hasPending()).toBe(false);
  });

  it('bounds a parked owner line instead of wedging the host forever', async () => {
    const g = makeOwnerComposerGate({ capMs: 20 });
    g.observe('owner text');
    await expect(g.waitClear()).resolves.toEqual({ deferred: true, reason: 'owner-input-cap' });
  });
});

/**
 * makeActivityTracker (liveness-hardening P-006/P-007): the output-side
 * sibling of makeIdleGate. lastOutputAt fresh = the agent is emitting RIGHT
 * NOW (a generating TUI repaints constantly); lastActivityAt = max(in, out).
 * Annotate-only (plan D-002) — display/triage, never claim release.
 */
describe('Codex carry completion boundary', () => {
  it('accepts only this post-request completed turn in the configured native home', async () => {
    const root = nodeFs.mkdtempSync(pathJoin(nodeOs.tmpdir(), 'codex-carry-boundary-'));
    const sessions = pathJoin(root, 'sessions');
    nodeFs.mkdirSync(sessions);
    const path = pathJoin(sessions, 'rollout.jsonl');
    const receivedAtMs = Date.now() - 1000;
    const row = (type: string, at = Date.now()) => JSON.stringify({
      type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type, turn_id: 'turn-1' },
    }) + '\n';
    const probe = () => codexCarryTurnCompleted({ agent: 'codex', env: { CODEX_HOME: root },
      transcriptPath: path, receivedAtMs });
    try {
      nodeFs.writeFileSync(path, row('task_complete', receivedAtMs - 1));
      expect(probe()).toBe(false);
      nodeFs.writeFileSync(path, row('task_started') + row('task_complete'));
      expect(probe()).toBe(true);
      const gate = makeAgentBusyGate({ lastOutputAt: Date.now, quietMs: 1000, capMs: 50 });
      expect(await gate.waitAtPrompt(undefined, probe)).toMatchObject({ deferred: false, boundary: 'native-turn-complete' });
      nodeFs.appendFileSync(path, row('task_started'));
      expect(probe()).toBe(false);
      expect(await gate.waitAtPrompt(undefined, probe)).toMatchObject({ deferred: true });
      nodeFs.writeFileSync(path, row('task_complete') + '{"type":');
      expect(probe()).toBe(false);
      const outside = pathJoin(root, 'outside.jsonl');
      nodeFs.writeFileSync(outside, row('task_complete'));
      expect(codexCarryTurnCompleted({ agent: 'codex', env: { CODEX_HOME: root },
        transcriptPath: outside, receivedAtMs })).toBe(false);
      nodeFs.writeFileSync(path, row('task_complete'));
      expect(codexCarryTurnCompleted({ agent: 'claude', env: { CODEX_HOME: root },
        transcriptPath: path, receivedAtMs })).toBe(false);
    } finally { nodeFs.rmSync(root, { recursive: true, force: true }); }
  });

  it('carries the exact source transcript through the existing control envelope', () => {
    expect(decodeControl(encodeControl({ mode: 'carry-respawn', data: 'resume',
      sourceTranscriptPath: '/fixture/sessions/current.jsonl' }))).toMatchObject({
      mode: 'carry-respawn', gated: true, sourceTranscriptPath: '/fixture/sessions/current.jsonl',
    });
  });

  it('follows the newest Codex rollout and fences out a completion older than the latest submit', async () => {
    const root = nodeFs.mkdtempSync(pathJoin(nodeOs.tmpdir(), 'codex-warm-boundary-'));
    const sessions = pathJoin(root, 'sessions', '2026', '09', '12');
    nodeFs.mkdirSync(sessions, { recursive: true });
    const oldPath = pathJoin(sessions, 'rollout-old.jsonl');
    const currentPath = pathJoin(sessions, 'rollout-current.jsonl');
    const now = Date.now();
    const row = (type: string, at: number, turn = 'turn-1') => JSON.stringify({
      type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type, turn_id: turn },
    }) + '\n';
    const probe = (floor = 0) => codexLatestTurnCompleted({
      agent: 'codex', env: { CODEX_HOME: root }, completedAtOrAfterMs: floor,
    });
    try {
      nodeFs.writeFileSync(oldPath, row('task_complete', now - 5_000, 'old'));
      nodeFs.writeFileSync(currentPath, row('task_started', now - 1_000, 'current'));
      nodeFs.utimesSync(oldPath, new Date(now - 5_000), new Date(now - 5_000));
      nodeFs.utimesSync(currentPath, new Date(now - 1_000), new Date(now - 1_000));
      expect(probe()).toBe(false);

      nodeFs.appendFileSync(currentPath, row('task_complete', now - 500, 'current'));
      expect(probe()).toBe(true);
      expect(probe(now - 250)).toBe(false);

      const gate = makeAgentBusyGate({ lastOutputAt: Date.now, quietMs: 1_000, capMs: 50 });
      await expect(gate.waitAtPrompt(undefined, () => probe())).resolves.toMatchObject({
        deferred: false, boundary: 'native-turn-complete',
      });
    } finally { nodeFs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('makeActivityTracker (P-006 mid-turn activity)', () => {
  it('starts with null activity (never seen)', () => {
    const a = makeActivityTracker({ now: () => 123 });
    expect(a.snapshot()).toEqual({ lastInputAt: null, lastOutputAt: null, lastActivityAt: null });
  });

  it('tracks input and output independently; lastActivityAt is the max', () => {
    let t = 100;
    const a = makeActivityTracker({ now: () => t });
    a.touchInput();
    t = 250;
    a.touchOutput();
    expect(a.snapshot()).toEqual({ lastInputAt: 100, lastOutputAt: 250, lastActivityAt: 250 });
    t = 400;
    a.touchInput();
    expect(a.snapshot().lastActivityAt).toBe(400);
    expect(a.snapshot().lastOutputAt).toBe(250);
  });

  it('output alone marks the session active (the heads-down generating case)', () => {
    let t = 7;
    const a = makeActivityTracker({ now: () => t });
    a.touchOutput();
    expect(a.snapshot()).toEqual({ lastInputAt: null, lastOutputAt: 7, lastActivityAt: 7 });
  });

  it('persist cadence is coarse (≥5s) so the pty bridge never becomes an fs hot loop', () => {
    expect(ACTIVITY_PERSIST_MS).toBeGreaterThanOrEqual(5_000);
  });
});

/**
 * makeAgentBusyGate (coord-wake-mid-turn-2026-06-30): the mid-turn inject gate —
 * the OUTPUT-side sibling of makeIdleGate. A wake `turn` (text + CR) written into
 * a TUI that is still GENERATING wedges the turn (needs ESC) — the multi-recipient
 * `coord:send {wake:'required'}` broadcast hang. This gate holds the inject until
 * the agent is back at its prompt (its pty output has been quiet for quietMs), and
 * DROPS the live inject if the agent stays busy past capMs (the durable inbox
 * message stands for the next turn). The pty output stream is the mid-turn signal.
 */
describe('makeAgentBusyGate (mid-turn inject safety)', () => {
  it('quietForMs reports how long the agent output has been quiet', () => {
    let lastOut = 1000;
    const g = makeAgentBusyGate({ lastOutputAt: () => lastOut, now: () => lastOut });
    expect(g.quietForMs(1000)).toBe(0); // just emitted
    expect(g.quietForMs(1300)).toBe(300); // 300ms of quiet since
  });

  it('treats "never emitted" (lastOutputAt 0) as quiet/at-prompt', () => {
    // A fresh idle session that has produced no output yet is at its prompt —
    // quietForMs is the full epoch, far past any quietMs, so a wake injects now.
    const g = makeAgentBusyGate({ lastOutputAt: () => 0, now: () => 5000, quietMs: 100 });
    expect(g.quietForMs()).toBe(5000);
  });

  it('waitAtPrompt resolves immediately (not deferred) when output is already quiet', async () => {
    // Output last seen at t=0, clock at t=5000, quiet window 100 → 5000ms of quiet
    // ≫ 100 → inject now, no deferral.
    const g = makeAgentBusyGate({ lastOutputAt: () => 0, now: () => 5000, quietMs: 100, capMs: 1000 });
    const r = await g.waitAtPrompt();
    expect(r.deferred).toBe(false);
  });

  it('rechecks after queued PTY output drains before accepting the quiet boundary', async () => {
    // EI-22806311344295685: Node runs an expired timer before the poll/check
    // phase that can deliver an already-buffered node-pty onData callback. A
    // single timestamp read at the quiet threshold can therefore be stale and
    // release a wake into a child that is still emitting. Queue the output
    // update for that next phase; the gate must not settle until the NEW output
    // has itself been quiet for the full window.
    let lastOut = Date.now() - 1_000;
    const g = makeAgentBusyGate({ lastOutputAt: () => lastOut, quietMs: 30, capMs: 500 });
    const queuedOutput = new Promise<void>((resolve) => {
      setImmediate(() => {
        lastOut = Date.now();
        resolve();
      });
    });

    let settled = false;
    const result = g.waitAtPrompt().then((value) => {
      settled = true;
      return value;
    });

    await queuedOutput;
    expect(settled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(await result).toEqual({ deferred: false });
  });

  it('waitAtPrompt DEFERS (drops the live inject) when the agent stays busy past capMs', async () => {
    // The agent is perpetually "emitting" (lastOutputAt tracks the advancing clock,
    // so quietForMs stays ~0 < quietMs) → it never reaches the prompt → cap fires.
    // Mirrors the makeIdleGate cap test: an advancing clock + the real min-10ms
    // setTimeout pace the loop to the deadline. This is the anti-wedge guarantee —
    // a busy turn is NEVER written into; the wake falls back to the durable inbox.
    let t = 0;
    const g = makeAgentBusyGate({
      lastOutputAt: () => t, // last output is always "now" → never quiet
      quietMs: 1_000_000,
      capMs: 30,
      now: () => (t += 10),
    });
    const r = await g.waitAtPrompt();
    expect(r.deferred).toBe(true);
    expect(r.reason).toBe('agent-busy');
  });

  // EI-19480099650947832: `busy-gate-expired` on its own is an unfalsifiable
  // verdict. A carry-respawn re-polled for 14 minutes on 2026-08-04 and every
  // durable row said only that it expired — leaving no way to tell a genuinely
  // busy agent (longest quiet gap ≈ 0ms, something redrawing the pty
  // continuously) from a near-miss (gap just under the threshold, i.e. quietMs
  // is too tight). Those two have OPPOSITE fixes and the distinction cannot be
  // reconstructed after the fact, so the gate now reports what it measured.
  describe('a defer carries the evidence for WHY it expired', () => {
    it('reports the LONGEST quiet window observed, and the threshold it was judged against', async () => {
      // The agent is quiet for exactly 40ms at every poll — far short of the
      // 500ms threshold, so it correctly defers, but 40ms is diagnostic gold:
      // it says "genuinely busy", not "we missed it by a hair".
      let t = 0;
      const g = makeAgentBusyGate({
        lastOutputAt: () => t - 40,
        quietMs: 500,
        capMs: 200,
        now: () => (t += 25),
      });
      const r = await g.waitAtPrompt();
      expect(r.deferred).toBe(true);
      expect(r.maxQuietForMs).toBe(40);
      expect(r.quietMs).toBe(500);
    });

    it('CONTROL — a NEAR-MISS is distinguishable from genuinely busy by that same field', async () => {
      // Same shape, but the agent goes quiet for 490ms of a 500ms threshold.
      // Identical `deferred:true` / `reason:'agent-busy'` verdict; the ONLY
      // thing separating it from the case above is maxQuietForMs.
      let t = 0;
      const g = makeAgentBusyGate({
        lastOutputAt: () => t - 490,
        quietMs: 500,
        capMs: 200,
        now: () => (t += 25),
      });
      const r = await g.waitAtPrompt();
      expect(r.deferred).toBe(true);
      expect(r.maxQuietForMs).toBe(490);
    });

    it('a NON-deferred (at-prompt) resolution is unchanged — no evidence fields, no behavior change', async () => {
      const g = makeAgentBusyGate({ lastOutputAt: () => 0, now: () => 5000, quietMs: 100, capMs: 1000 });
      const r = await g.waitAtPrompt();
      expect(r.deferred).toBe(false);
      expect(r.reason).toBeUndefined();
    });
  });

  // WI-1872 (1): the compaction completion-wait needs a DIFFERENT (generous)
  // cap than the gate's own construction-time capMs (sized for a wake turn) —
  // waitAtPrompt(overrideCapMs) lets one gate instance serve both budgets.
  // (Small millisecond scale throughout, mirroring the existing DEFERS test
  // above — the fake `now()` advances in fixed 10ms ticks per call, and each
  // loop iteration's setTimeout is a REAL wait sized off the FAKE deadline
  // delta, so a large capMs here would balloon into a very slow real test.)
  it('waitAtPrompt(overrideCapMs) uses the override instead of the gate\'s own capMs', async () => {
    let t = 0;
    const g = makeAgentBusyGate({
      lastOutputAt: () => t, // perpetually busy
      quietMs: 1_000_000,
      capMs: 20, // the gate's OWN (small) cap — must be ignored here
      now: () => (t += 10),
    });
    const r = await g.waitAtPrompt(80); // a larger override
    expect(r.deferred).toBe(true);
    expect(r.reason).toBe('agent-busy');
    expect(t).toBeGreaterThanOrEqual(80); // ran the OVERRIDE budget, not the 20ms one
  });

  it('waitAtPrompt() with no override still uses the gate\'s own capMs (back-compat)', async () => {
    let t = 0;
    const g = makeAgentBusyGate({
      lastOutputAt: () => t,
      quietMs: 1_000_000,
      capMs: 20,
      now: () => (t += 10),
    });
    const r = await g.waitAtPrompt();
    expect(r.deferred).toBe(true);
    expect(t).toBeLessThan(80); // stayed close to the small 20ms cap, not the 80ms override
  });

  // WI-1872 (2): the START-RACE fix — waitUntilBusy resolves the moment output
  // goes busy, instead of a blind fixed delay that can race a slow-to-emit
  // compaction summarizer.
  describe('waitUntilBusy (WI-1872 (2) — bounded wait for the agent to go busy)', () => {
    it('resolves { started:true } as soon as output is observed busy', async () => {
      let t = 0;
      let busyAt = 50; // output goes busy at t=50
      const g = makeAgentBusyGate({
        lastOutputAt: () => (t >= busyAt ? t : 0),
        quietMs: 5, // "busy" = quiet-for < 5ms
        now: () => (t += 10),
      });
      const r = await g.waitUntilBusy(1000);
      expect(r.started).toBe(true);
      expect(t).toBeGreaterThanOrEqual(busyAt);
    });

    it('falls back to { started:false } after capMs when busy is never observed', async () => {
      let t = 0;
      const g = makeAgentBusyGate({
        lastOutputAt: () => 0, // never emits — always reads as quiet/at-prompt
        quietMs: 5,
        now: () => (t += 10),
      });
      const r = await g.waitUntilBusy(30);
      expect(r.started).toBe(false);
    });
  });
});

/**
 * makeSubmitVerifier (WI-2930): the POST-submit sibling of makeAgentBusyGate. An
 * injected submit's CR can be swallowed (paste-settle race; a compact/reset carry
 * typed into a briefly-locked TUI) — the turn text then sits staged in the
 * composer and the session parks until a human presses Enter (the ~6h Snippets
 * stall). The verifier polls output activity after the final CR and writes one
 * bare resubmit CR at each QUIET observation — a bare CR on an empty idle
 * composer is a no-op, so redundant resubmits are harmless.
 */
describe('makeSubmitVerifier (WI-2930 verify-and-resubmit)', () => {
  /** Deterministic rig: `sleep` ADVANCES the fake clock; output/input are
   *  functions of the current fake time. CRs record the time they were sent. */
  function rig({
    output,
    input,
    quotaBlocked,
    pollMs = 100,
    polls = 4,
    maxResubmits = 3,
    quietMs = 50,
    writeCr,
    onExhausted,
  }: {
    output: (t: number) => number;
    input?: (t: number) => number;
    quotaBlocked?: (t: number) => boolean;
    pollMs?: number;
    polls?: number;
    maxResubmits?: number;
    quietMs?: number;
    writeCr?: () => void;
    onExhausted?: (details: {
      polls: number;
      resubmits: number;
      outputObservedAfterResubmit: boolean;
    }) => void;
  }) {
    let t = 0;
    const crs: number[] = [];
    const resubmitCalls: number[] = [];
    const exhaustedCalls: Array<{
      polls: number;
      resubmits: number;
      outputObservedAfterResubmit: boolean;
    }> = [];
    const v = makeSubmitVerifier({
      lastOutputAt: () => output(t),
      lastInputAt: input ? () => input(t) : undefined,
      isQuotaBlocked: quotaBlocked ? () => quotaBlocked(t) : undefined,
      writeCr: writeCr ?? (() => crs.push(t)),
      quietMs,
      pollMs,
      polls,
      maxResubmits,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      onResubmit: (n: number) => resubmitCalls.push(n),
      onExhausted: (details) => {
        exhaustedCalls.push(details);
        onExhausted?.(details);
      },
    });
    return { v, crs, resubmitCalls, exhaustedCalls };
  }

  it('a submitted turn (output flowing at every poll) needs no resubmit', async () => {
    // The turn is running: last output always "just now".
    const { v, crs } = rig({ output: (t) => t });
    const r = await v.verify();
    expect(r).toEqual({ polls: 4, resubmits: 0, aborted: null, exhausted: false });
    expect(crs).toEqual([]);
  });

  it('a swallowed CR (output stays quiet) is resubmitted, capped at maxResubmits', async () => {
    // Nothing ever starts: output frozen at 0 → every poll observes quiet.
    const { v, crs, resubmitCalls } = rig({ output: () => 0, polls: 6, maxResubmits: 3 });
    const r = await v.verify();
    expect(r.resubmits).toBe(3);
    expect(r.aborted).toBeNull();
    expect(crs).toHaveLength(3);
    expect(resubmitCalls).toEqual([1, 2, 3]);
  });

  it('reports exhaustion once when the bounded CR window ends without output', async () => {
    const { v, crs, exhaustedCalls } = rig({ output: () => 0, polls: 4, maxResubmits: 2 });
    const r = await v.verify();
    expect(r.exhausted).toBe(true);
    expect(crs).toEqual([100, 200]);
    expect(exhaustedCalls).toEqual([
      {
        polls: 2,
        resubmits: 2,
        outputObservedAfterResubmit: false,
      },
    ]);
  });

  it('stops resubmitting once a resubmit takes (output starts flowing)', async () => {
    // Quiet at poll 1 (t=100) → one CR; from t=150 the turn is running.
    const { v, crs, exhaustedCalls } = rig({ output: (t) => (t >= 150 ? t : 0) });
    const r = await v.verify();
    expect(r.resubmits).toBe(1);
    expect(crs).toEqual([100]);
    expect(exhaustedCalls).toEqual([]);
  });

  it('covers the compact trap: busy residual output first, THEN the quiet reveal', async () => {
    // Residual compaction output until t=250 (looks "submitted"), then quiet —
    // the staged carry is only revealed late; the verifier still catches it
    // because it never early-exits on a busy observation.
    const { v, crs } = rig({ output: (t) => (t <= 250 ? t : 250), polls: 6 });
    const r = await v.verify();
    // polls at t=100..200 busy; from t=300 on, quiet grows past quietMs → CRs.
    expect(r.resubmits).toBeGreaterThan(0);
    expect(crs[0]).toBeGreaterThan(250);
  });

  it('aborts (and stops writing) the moment a HUMAN keystroke lands mid-window', async () => {
    // Quiet throughout, but the human types at t=150 — the verifier must never
    // fight a human who is editing the staged line.
    const { v, crs } = rig({ output: () => 0, input: (t) => (t >= 150 ? t : 0), polls: 6 });
    const r = await v.verify();
    expect(r.aborted).toBe('human-input');
    expect(crs).toEqual([100]); // the one pre-abort resubmit only
  });

  it('quota wall present at submission aborts without a retry or fatal exhaustion', async () => {
    const { v, crs, exhaustedCalls } = rig({ output: () => 0, quotaBlocked: () => true });
    expect(await v.verify()).toMatchObject({ aborted: 'quota-blocked', resubmits: 0 });
    expect(crs).toEqual([]);
    expect(exhaustedCalls).toEqual([]);
  });

  it('quota wall arriving after the last retry wins over exhaustion', async () => {
    const { v, crs, exhaustedCalls } = rig({
      output: () => 0,
      quotaBlocked: (t) => t >= 200,
      maxResubmits: 1,
    });
    expect(await v.verify()).toMatchObject({ aborted: 'quota-blocked', resubmits: 1 });
    expect(crs).toEqual([100]);
    expect(exhaustedCalls).toEqual([]);
  });

  it('quota recovery allows a later verifier to submit normally', async () => {
    let blocked = true;
    const { v, crs } = rig({ output: () => 0, quotaBlocked: () => blocked, maxResubmits: 1 });
    expect((await v.verify()).aborted).toBe('quota-blocked');
    blocked = false;
    expect(await v.verify()).toMatchObject({ aborted: null, resubmits: 1, exhausted: true });
    expect(crs).toHaveLength(1);
  });

  it('WI-2975: an ordinary silent "thinking" gap spanning a poll boundary no longer misfires at the new, decoupled default quietMs — but WOULD have under the old (reused OUTPUT_QUIET_MS=1500) default', async () => {
    // Production-realistic pollMs (5000ms, the real SUBMIT_VERIFY_POLL_MS default).
    // The submitted turn genuinely starts, but produces no output at all for the
    // first 5.5s (a normal thinking/network-latency gap that straddles the first
    // 5s poll) before flowing continuously from then on.
    const output = (t: number) => (t >= 5_500 ? t : 0);

    // OLD behavior (bug): reusing the busy-gate's short 1500ms threshold reads
    // that ordinary gap as "nothing happened" at the first poll and resubmits.
    const old = rig({ output, pollMs: 5_000, polls: 3, quietMs: 1_500 });
    const rOld = await old.v.verify();
    expect(rOld.resubmits).toBeGreaterThan(0);

    // NEW behavior (fixed): the verifier's own, larger, decoupled quiet bar
    // (matching the new SUBMIT_VERIFY_QUIET_MS default of 6000ms) recognizes the
    // same gap as ordinary turn latency — zero spurious resubmits.
    const fresh = rig({ output, pollMs: 5_000, polls: 3, quietMs: 6_000 });
    const rNew = await fresh.v.verify();
    expect(rNew.resubmits).toBe(0);
    expect(fresh.crs).toEqual([]);
  });

  it('a writeCr throw (child exited mid-verify) never rejects', async () => {
    const { v } = rig({
      output: () => 0,
      writeCr: () => {
        throw new Error('child gone');
      },
    });
    await expect(v.verify()).resolves.toMatchObject({ aborted: null });
  });

  it('maps every non-success verifier verdict to a stable delivery reason (WI-42318)', () => {
    expect(submitVerificationFailureReason({ exhausted: true, aborted: null })).toBe(
      'submit-verification-exhausted',
    );
    expect(submitVerificationFailureReason({ exhausted: false, aborted: 'human-input' })).toBe(
      'submit-verification-aborted-human-input',
    );
    expect(submitVerificationFailureReason({ exhausted: false, aborted: null })).toBeNull();
  });

  // WI-1378748 regression guard. WI-41044 made EVERY submit-verify exhaustion
  // SIGTERM the host. A wake inject's only evidence is "the pty stayed quiet",
  // which a RATE-LIMITED agent produces indefinitely while perfectly alive — so
  // a coord broadcast into a quota-walled fleet killed live agents mid-work en
  // masse (measured 2026-08-30: 160 hosts, 102 of them on a `turn inject`).
  // A wake is a notification; it may never be host-fatal. If this flips back to
  // an unconditional true, that outage returns.
  it('WI-1378748: a wake inject exhaustion is never host-fatal, a startup submit still is', () => {
    // The two labels the control socket emits for a coord wake (`${msg.mode} inject`).
    expect(submitExhaustionTerminatesHost('turn inject')).toBe(false);
    expect(submitExhaustionTerminatesHost('reset inject')).toBe(false);

    // The startup submits WI-41044 was actually written for: a session that
    // never took its first turn is useless, so tearing it down is correct.
    expect(submitExhaustionTerminatesHost('launch kickoff')).toBe(true);
    expect(submitExhaustionTerminatesHost('recycle carry-note')).toBe(true);
    expect(submitExhaustionTerminatesHost('session-port seed')).toBe(true);

    // Label matching must not be defeated by casing/padding drift at the call site.
    expect(submitExhaustionTerminatesHost('  Turn Inject  ')).toBe(false);

    // Fail CLOSED for an unknown/missing label: an unrecognised submit keeps the
    // WI-41044 teardown rather than silently inheriting the wake exemption.
    expect(submitExhaustionTerminatesHost('some future submit')).toBe(true);
    expect(submitExhaustionTerminatesHost(undefined)).toBe(true);
  });
});

// WI-1386682 (1): the residual half of WI-1378748. That item stopped a wake
// exhaustion from being host-fatal; it did not stop the host from reading a
// rate-limited (quota-walled) agent's silence as "at its ordinary prompt".
describe('quotaLimitBannerVisible (WI-1386682 (1) — usage-wall text detector)', () => {
  it('recognizes the weekly-limit wording', () => {
    expect(quotaLimitBannerVisible("You've hit your weekly limit.")).toBe(true);
    expect(quotaLimitBannerVisible('WEEKLY LIMIT reached')).toBe(true);
  });

  it('recognizes the 5-hour-limit wording', () => {
    expect(quotaLimitBannerVisible('Your 5-hour limit has been reached.')).toBe(true);
  });

  it('recognizes generic "usage limit" wording', () => {
    expect(quotaLimitBannerVisible('You have reached your usage limit for this period.')).toBe(true);
  });

  it('recognizes the Claude Fable model-limit wall', () => {
    const wall =
      "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
    expect(quotaLimitBannerVisible(wall, 'claude')).toBe(true);
    expect(quotaLimitBannerMatch(wall, 'claude').excerpt).toContain('Fable 5 limit');
    const detector = makeQuotaBlockDetector({ agent: 'claude' });
    expect(detector.observe(wall)).toBe('detected');
    expect(detector.isBlocked()).toBe(true);
  });

  it('recognizes a limit/resets pairing on the same line', () => {
    expect(quotaLimitBannerVisible('Rate limit — resets at 3:00pm')).toBe(true);
    expect(quotaLimitBannerVisible('limit resetting shortly')).toBe(true);
  });

  it('does not match ordinary TUI output', () => {
    expect(quotaLimitBannerVisible('Welcome back! Continuing where you left off.')).toBe(false);
    expect(quotaLimitBannerVisible('$ npm test\n42 passed')).toBe(false);
    expect(quotaLimitBannerVisible('')).toBe(false);
    expect(quotaLimitBannerVisible(undefined)).toBe(false);
  });

  it('survives ANSI styling around the matched phrase', () => {
    expect(quotaLimitBannerVisible('\x1b[31mweekly limit\x1b[0m reached')).toBe(true);
  });
});

describe('makeQuotaBlockDetector (WI-1386682 (1)/(2) — quota-wall ring-buffer detector)', () => {
  it('ignores resumed history until submit, then preserves a current wall across later input', () => {
    const d = makeQuotaBlockDetector({ agent: 'codex', deferUntilSubmit: true });
    const wall = "You've hit your usage limit.";
    expect(d.observe(wall)).toBeNull();
    d.observeInput('\x1b[200~old transcript\n\x1b[201~');
    d.observeInput('\x1b[1;1R');
    expect(d.observe(wall)).toBeNull();
    expect(d.isBlocked()).toBe(false);
    d.observeInput('\r');
    expect(d.observe('Ready for the new request')).toBeNull();
    expect(d.observe("You've hit your ")).toBeNull();
    expect(d.observe('usage limit.')).toBe('detected');
    d.observeInput('\r');
    expect(d.isBlocked()).toBe(true);
    d.reset();
    expect(d.observe(wall)).toBeNull();
    d.observeInput('\n');
    expect(d.observe(wall)).toBe('detected');
  });

  it('publishes the current quota episode and clears it on recovery or recycle', () => {
    let now = 1000;
    const d = makeQuotaBlockDetector({ agent: 'codex', capBytes: 128, now: () => now });
    expect(d.snapshot()).toEqual({ quotaBlocked: false, quotaBlockedSinceMs: null });
    d.observe("You've hit your usage limit.");
    expect(d.snapshot()).toEqual({ quotaBlocked: true, quotaBlockedSinceMs: 1000 });
    now = 2000;
    d.observe(' still waiting');
    expect(d.snapshot().quotaBlockedSinceMs).toBe(1000);
    d.observe('healthy output '.repeat(20));
    expect(d.snapshot()).toEqual({ quotaBlocked: false, quotaBlockedSinceMs: null });
    d.observe('Usage limit reached');
    expect(d.snapshot()).toEqual({ quotaBlocked: true, quotaBlockedSinceMs: 2000 });
    d.reset();
    expect(d.snapshot()).toEqual({ quotaBlocked: false, quotaBlockedSinceMs: null });
  });
  it('starts unblocked and stays unblocked on ordinary output', () => {
    const d = makeQuotaBlockDetector();
    expect(d.isBlocked()).toBe(false);
    expect(d.observe('$ echo hi\nhi\n')).toBeNull();
    expect(d.observe('more ordinary output')).toBeNull();
    expect(d.isBlocked()).toBe(false);
  });

  it('transitions to detected exactly once when the banner appears, even across repeated redraws', () => {
    const d = makeQuotaBlockDetector();
    expect(d.observe("You've hit your weekly limit.")).toBe('detected');
    expect(d.isBlocked()).toBe(true);
    // A static wall screen commonly repaints the SAME text (cursor moves,
    // color resets) — that must not re-fire the transition every chunk.
    expect(d.observe("You've hit your weekly limit.")).toBeNull();
    expect(d.observe('')).toBeNull();
    expect(d.isBlocked()).toBe(true);
  });

  it('recognizes the banner even when split across two onData chunks', () => {
    const d = makeQuotaBlockDetector();
    expect(d.observe('You have hit your weekly ')).toBeNull();
    expect(d.observe('limit.')).toBe('detected');
    expect(d.isBlocked()).toBe(true);
  });

  it('clears once enough genuinely new output evicts the banner from the window (clear-on-output rule)', () => {
    const d = makeQuotaBlockDetector({ capBytes: 20 });
    expect(d.observe('weekly limit')).toBe('detected'); // 12 chars, fits in the 20-char window
    expect(d.isBlocked()).toBe(true);
    // Push the banner text out of the bounded tail with real new content.
    expect(d.observe('x'.repeat(20))).toBe('cleared');
    expect(d.isBlocked()).toBe(false);
  });

  it('does not clear on the very next chunk when the banner is still within the window', () => {
    const d = makeQuotaBlockDetector({ capBytes: 8_192 });
    expect(d.observe('weekly limit')).toBe('detected');
    // A handful of small redraw bytes (far short of the 8_192 window) must not
    // evict the still-visible banner — a real wall keeps showing it.
    expect(d.observe('\x1b[0m')).toBeNull();
    expect(d.isBlocked()).toBe(true);
  });

  it('reset() returns to a fresh, un-walled state regardless of history', () => {
    const d = makeQuotaBlockDetector();
    d.observe('weekly limit reached');
    expect(d.isBlocked()).toBe(true);
    d.reset();
    expect(d.isBlocked()).toBe(false);
    // A fresh child's first bytes must not be read against the old wall text.
    expect(d.observe('ordinary boot output')).toBeNull();
    expect(d.isBlocked()).toBe(false);
  });
});

// WI-2140984: the quota-wall patterns are CLAUDE COPY, and the host used to
// match them against every pty. A codex child paints ordinary chrome that hits
// them, so healthy headless codex fleet members were read as walled and every
// turn/reset was deferred — permanently, because repainted chrome refills the
// ring buffer as fast as it is evicted. Measured 2026-09-02: two members logged
// one quota-block-detected then 110 turn-deferred-quota-blocked with ZERO
// clears while the account read util7d 0.03 with no 429s.
//
// The fixtures below are VERBATIM strings taken from the shipped codex binary
// (`strings .../vendor/x86_64-unknown-linux-musl/bin/codex`), not paraphrases —
// that is what makes this a regression test rather than a restatement of the
// patterns.
describe('quota-wall banner patterns are scoped per agent (WI-2140984)', () => {
  // Ordinary, non-wall codex UI chrome. The first is a slash-command
  // DESCRIPTION from the command palette.
  const CODEX_CHROME = [
    'view account usage or use a usage limit reset',
    ' Consumes usage limits faster',
    'Goal hit usage limits (/goal resume)',
    'No usage limit resets available.',
    'Usage limit resets',
    'Your usage does not need a reset right now.',
  ];

  // Codex's REAL wall copy — these must still block.
  const CODEX_WALL = [
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits",
    "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus),",
    'Usage limit reached',
    "You've reached your workspace credit limit",
    'Your workspace is out of credits. Ask your workspace owner to add more. Notify owner?',
  ];

  it('reads codex chrome as NOT walled', () => {
    for (const chrome of CODEX_CHROME) {
      expect(quotaLimitBannerVisible(chrome, 'codex')).toBe(false);
    }
  });

  it('still recognizes codex own wall copy', () => {
    for (const wall of CODEX_WALL) {
      expect(quotaLimitBannerVisible(wall, 'codex')).toBe(true);
    }
  });

  // The calibration case: these SAME chrome strings DO match the claude set.
  // Without this the test above would pass just as well against a detector
  // that had been broken to match nothing at all.
  it('confirms the claude pattern set is what mis-fired on that chrome', () => {
    const hits = CODEX_CHROME.filter((c) => quotaLimitBannerVisible(c, 'claude'));
    expect(hits.length).toBeGreaterThan(0);
    expect(quotaLimitBannerVisible('view account usage or use a usage limit reset', 'claude')).toBe(
      true,
    );
  });

  it('keeps claude behaviour unchanged for an explicit or absent agent', () => {
    for (const agent of ['claude', '', undefined]) {
      expect(quotaLimitBannerVisible("You've hit your weekly limit.", agent)).toBe(true);
      expect(quotaLimitBannerVisible('Welcome back!', agent)).toBe(false);
    }
    expect(quotaBannerPatternsForAgent('claude')).toEqual(quotaBannerPatternsForAgent(undefined));
  });

  it('gives an UNKNOWN agent no patterns rather than another product copy', () => {
    expect(quotaBannerPatternsForAgent('omp')).toEqual([]);
    expect(quotaLimitBannerVisible("You've hit your weekly limit.", 'omp')).toBe(false);
  });

  it('reports which pattern matched and the text around it', () => {
    const hit = quotaLimitBannerMatch('some scrollback\nUsage limit reached\nmore', 'codex');
    expect(hit.matched).toBe(true);
    expect(hit.pattern).toContain('usage limit reached');
    expect(hit.excerpt).toContain('Usage limit reached');
    const miss = quotaLimitBannerMatch('nothing to see', 'codex');
    expect(miss).toEqual({ matched: false, pattern: null, excerpt: null });
  });

  it('does not treat Claude\'s percentage-used usage advisory as a quota wall', () => {
    const advisory =
      "You've used 75% of your weekly limit · resets Sep 17, 7am (America/New_York)";
    expect(quotaLineIsUsageAdvisory(advisory)).toBe(true);
    expect(quotaLimitBannerMatch(advisory, 'claude')).toEqual({
      matched: false,
      pattern: null,
      excerpt: null,
    });
    const d = makeQuotaBlockDetector({ agent: 'claude' });
    expect(d.observe(advisory)).toBeNull();
    expect(d.isBlocked()).toBe(false);
  });

  it('still detects a real Claude wall when an advisory shares the screen', () => {
    const advisory =
      "You've used 75% of your weekly limit · resets Sep 17, 7am (America/New_York)";
    const wall = "You've hit your weekly limit. Please try again after the reset.";
    const screen = `${advisory}\n${wall}`;
    const hit = quotaLimitBannerMatch(screen, 'claude');
    expect(hit.matched).toBe(true);
    expect(hit.excerpt).toContain(wall);
    const d = makeQuotaBlockDetector({ agent: 'claude' });
    expect(d.observe(screen)).toBe('detected');
    expect(d.isBlocked()).toBe(true);
  });

  it('never blocks a codex session that only ever repaints chrome', () => {
    const d = makeQuotaBlockDetector({ agent: 'codex' });
    // This is the shape that bricked the members: the same chrome, redrawn.
    for (let i = 0; i < 50; i += 1) {
      expect(d.observe(`${CODEX_CHROME.join(' ')}\x1b[0m`)).toBeNull();
    }
    expect(d.isBlocked()).toBe(false);
  });

  it('exposes lastMatch() so a detected row can name what it saw', () => {
    const d = makeQuotaBlockDetector({ agent: 'codex' });
    expect(d.lastMatch()).toEqual({ matched: false, pattern: null, excerpt: null });
    expect(d.observe('Usage limit reached')).toBe('detected');
    expect(d.lastMatch().excerpt).toContain('Usage limit reached');
    d.reset();
    expect(d.lastMatch()).toEqual({ matched: false, pattern: null, excerpt: null });
  });

  it('a codex detector still blocks on a real wall, and clears on real churn', () => {
    const d = makeQuotaBlockDetector({ agent: 'codex', capBytes: 64 });
    expect(d.observe('Usage limit reached')).toBe('detected');
    expect(d.isBlocked()).toBe(true);
    expect(d.observe('x'.repeat(64))).toBe('cleared');
    expect(d.isBlocked()).toBe(false);
  });
});

describe('findNativeTranscriptMarker (fresh row provenance)', () => {
  const scratch = nodeFs.mkdtempSync(pathJoin(nodeOs.tmpdir(), 'kickoff-marker-freshness-'));
  afterAll(() => nodeFs.rmSync(scratch, { recursive: true, force: true }));

  it('rejects an old marker row even when unrelated fresh metadata updates the transcript file', () => {
    const claudeConfig = pathJoin(scratch, 'claude-home');
    const transcript = pathJoin(claudeConfig, 'projects', 'session', 'conversation.jsonl');
    nodeFs.mkdirSync(pathJoin(claudeConfig, 'projects', 'session'), { recursive: true });
    const marker = '⟦turn-origin:fleet-kickoff nonce:0123456789abcdef⟧';
    const sinceMs = Date.now() - 1_000;
    const staleUser = {
      type: 'user',
      timestamp: new Date(sinceMs - 60_000).toISOString(),
      message: { role: 'user', content: marker },
    };
    const unrelatedFreshMetadata = {
      type: 'mode',
      timestamp: new Date().toISOString(),
      mode: 'auto',
    };
    nodeFs.writeFileSync(transcript, `${JSON.stringify(staleUser)}\n${JSON.stringify(unrelatedFreshMetadata)}\n`);

    // The transcript's mtime is recent, but the matching provenance row is old.
    expect(nodeFs.statSync(transcript).mtimeMs).toBeGreaterThanOrEqual(sinceMs);
    expect(findNativeTranscriptMarker({
      agent: 'claude',
      env: { CLAUDE_CONFIG_DIR: claudeConfig },
      marker,
      sinceMs,
      home: scratch,
    })).toBeNull();

    const freshUser = {
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: marker },
    };
    nodeFs.writeFileSync(transcript, `${JSON.stringify(staleUser)}\n${JSON.stringify(unrelatedFreshMetadata)}\n${JSON.stringify(freshUser)}\n`);
    expect(findNativeTranscriptMarker({
      agent: 'claude',
      env: { CLAUDE_CONFIG_DIR: claudeConfig },
      marker,
      sinceMs,
      home: scratch,
    })).toBe(transcript);
  });
});

describe('verifyNativeTurnStartWithRetry (EI-216539 execution-backed kickoff)', () => {
  const tagged =
    '⟦turn-origin:fleet-kickoff nonce:0123456789abcdef⟧\nStart the fleet lane now';

  it('accepts first-pass native persistence without another CR', async () => {
    const waitForMarker = vi.fn().mockResolvedValue({
      persisted: true,
      nativeRef: '/tmp/codex-session.jsonl',
    });
    const writeCr = vi.fn();
    await expect(
      verifyNativeTurnStartWithRetry({
        agent: 'codex',
        text: tagged,
        sinceMs: 100,
        waitForMarker,
        writeCr,
      }),
    ).resolves.toEqual({
      persisted: true,
      nativeRef: '/tmp/codex-session.jsonl',
      retried: false,
      reason: null,
    });
    expect(waitForMarker).toHaveBeenCalledTimes(1);
    expect(writeCr).not.toHaveBeenCalled();
  });

  it('accepts Codex fresh-thread proof without a native id while other backends stay fail-closed', async () => {
    const waitForMarker = vi.fn().mockResolvedValue({
      persisted: true,
      nativeRef: '/tmp/codex-fresh-thread.jsonl',
    });
    expect(carryTurnProofRequiresNativeId('codex')).toBe(false);
    expect(carryTurnProofRequiresNativeId('claude')).toBe(true);
    expect(carryTurnProofRequiresNativeId('omp')).toBe(true);
    await expect(
      verifyNativeTurnStartWithRetry({
        agent: 'codex',
        text: tagged,
        sinceMs: 100,
        nativeId: null,
        requireNativeId: carryTurnProofRequiresNativeId('codex'),
        waitForMarker,
      }),
    ).resolves.toEqual({
      persisted: true,
      nativeRef: '/tmp/codex-fresh-thread.jsonl',
      retried: false,
      reason: null,
    });
    expect(waitForMarker).toHaveBeenCalledWith(expect.objectContaining({ nativeId: null }));
  });

  it('retries one raw CR and accepts only the second native proof', async () => {
    const waitForMarker = vi
      .fn()
      .mockResolvedValueOnce({ persisted: false, nativeRef: null })
      .mockResolvedValueOnce({ persisted: true, nativeRef: '/tmp/after-cr.jsonl' });
    const writeCr = vi.fn();
    const onRetry = vi.fn();
    await expect(
      verifyNativeTurnStartWithRetry({
        agent: 'codex',
        text: tagged,
        sinceMs: 100,
        waitForMarker,
        writeCr,
        onRetry,
      }),
    ).resolves.toEqual({
      persisted: true,
      nativeRef: '/tmp/after-cr.jsonl',
      retried: true,
      reason: null,
    });
    expect(waitForMarker).toHaveBeenCalledTimes(2);
    expect(writeCr).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('never certifies PTY repaint when both native proofs miss', async () => {
    const waitForMarker = vi.fn().mockResolvedValue({ persisted: false, nativeRef: null });
    const writeCr = vi.fn();
    await expect(
      verifyNativeTurnStartWithRetry({
        agent: 'codex',
        text: tagged,
        sinceMs: 100,
        waitForMarker,
        writeCr,
      }),
    ).resolves.toEqual({
      persisted: false,
      nativeRef: null,
      retried: true,
      reason: 'native-turn-marker-timeout',
    });
    expect(waitForMarker).toHaveBeenCalledTimes(2);
    expect(writeCr).toHaveBeenCalledTimes(1);
  });

  it('fails closed before any transcript read when provenance or required native id is missing', async () => {
    const waitForMarker = vi.fn();
    const writeCr = vi.fn();
    await expect(
      verifyNativeTurnStartWithRetry({
        agent: 'codex',
        text: 'untagged kickoff',
        sinceMs: 100,
        waitForMarker,
        writeCr,
      }),
    ).resolves.toMatchObject({
      persisted: false,
      retried: false,
      reason: 'missing-leading-turn-origin',
    });
    await expect(
      verifyNativeTurnStartWithRetry({
        agent: 'codex',
        text: tagged,
        sinceMs: 100,
        requireNativeId: true,
        waitForMarker,
        writeCr,
      }),
    ).resolves.toMatchObject({
      persisted: false,
      retried: false,
      reason: 'missing-native-id',
    });
    expect(waitForMarker).not.toHaveBeenCalled();
    expect(writeCr).not.toHaveBeenCalled();
  });
});

describe('shouldRetryCarryOnFreshEpoch (WI-10001987)', () => {
  it('retries only transient production failures within the bound', () => {
    expect(shouldRetryCarryOnFreshEpoch({ reason: 'never-settled' })).toBe(true);
    expect(shouldRetryCarryOnFreshEpoch({ reason: 'no-startup-ready-marker-last-resort-failed' })).toBe(true);
    expect(shouldRetryCarryOnFreshEpoch({
      reason: 'turn-start-unverified',
      proofReason: 'native-turn-marker-timeout',
    })).toBe(true);
    expect(shouldRetryCarryOnFreshEpoch({
      reason: 'turn-start-unverified',
      proofReason: 'missing-native-id',
    })).toBe(false);
    expect(shouldRetryCarryOnFreshEpoch({ reason: 'fresh-child-owner-input' })).toBe(false);
    expect(shouldRetryCarryOnFreshEpoch({ reason: 'never-settled', drillId: 'drill-1' })).toBe(false);
    expect(shouldRetryCarryOnFreshEpoch({
      reason: 'never-settled',
      retryCount: 1,
      maxRetries: 1,
    })).toBe(false);
  });
});

describe('same-source turn coalescing (compaction-continuity-hardening P-001a)', () => {
  const wake = (n: number) =>
    `🔁 Loop wake (every ~120s after each turn settles). You are continuing toward: goal G\n\ndetails for wake #${n}`;

  describe('turnCoalesceKey', () => {
    it('keys on the first non-empty line — stable across wakes of the same loop', () => {
      expect(turnCoalesceKey(wake(1))).toBe(turnCoalesceKey(wake(9)));
      expect(turnCoalesceKey('\n\n  first real line\nrest')).toBe('first real line');
    });
    it('distinct sources get distinct keys', () => {
      expect(turnCoalesceKey(wake(1))).not.toBe(turnCoalesceKey('owner: please check the deploy'));
    });

    it('uses a loop instance id so numbered short-form fires share one key', () => {
      expect(turnCoalesceKey('Loop wake #1 — short form', 'routine-1')).toBe(
        turnCoalesceKey('Loop wake #9 — short form', 'routine-1'),
      );
      expect(turnCoalesceKey('Loop wake #1 — short form', 'routine-1')).not.toBe(
        turnCoalesceKey('Loop wake #1 — short form', 'routine-2'),
      );
    });
    it('caps the key and tolerates empty/undefined', () => {
      expect(turnCoalesceKey('x'.repeat(1000)).length).toBe(300);
      expect(turnCoalesceKey('')).toBe('');
      expect(turnCoalesceKey(undefined)).toBe('');
    });

    // WI-2141436 hole #4: routineId alone has no owner component. These pin the
    // ownerId-aware behavior added as defense-in-depth around a socket-identity
    // collision combined with an unaddressed (ownerId-less) arrival.
    it('folds ownerId into the key: same routine/text, different owners never collide', () => {
      const a = turnCoalesceKey('Loop wake #1 — short form', 'routine-1', 'su-aaa');
      const b = turnCoalesceKey('Loop wake #1 — short form', 'routine-1', 'su-bbb');
      expect(a).not.toBe(b);
      // and the SAME owner still coalesces across fires, exactly as before
      expect(a).toBe(turnCoalesceKey('Loop wake #9 — short form', 'routine-1', 'su-aaa'));
    });
    it('folds ownerId into the text-only key path too (no routineId)', () => {
      const a = turnCoalesceKey('owner: please check the deploy', undefined, 'su-aaa');
      const b = turnCoalesceKey('owner: please check the deploy', undefined, 'su-bbb');
      expect(a).not.toBe(b);
    });
    it('omitting ownerId reproduces the pre-existing (owner-less) key exactly — backward compatible', () => {
      expect(turnCoalesceKey('Loop wake #1 — short form', 'routine-1', undefined)).toBe(
        turnCoalesceKey('Loop wake #1 — short form', 'routine-1'),
      );
      expect(turnCoalesceKey('x'.repeat(1000), undefined, undefined).length).toBe(300);
    });
  });

  describe('renderCoalescedTurn', () => {
    it('folded=0 → the text verbatim (the common single-wake path is byte-identical)', () => {
      expect(renderCoalescedTurn('text', 0)).toBe('text');
    });
    it('folded>0 → ONE annotated delivery telling the agent not to treat them as separate wakes', () => {
      const out = renderCoalescedTurn('text', 8);
      expect(out).toContain('text');
      expect(out).toContain('8 duplicate queued wakes were coalesced');
      expect(out).toContain('treat this as a single wake');
    });
  });

  describe('makeTurnCoalescer', () => {
    it('first arrival becomes the waiter; later same-key arrivals FOLD (newest text wins)', () => {
      const c = makeTurnCoalescer();
      expect(c.admit('k', wake(1))).toBe(false); // waiter
      expect(c.admit('k', wake(2))).toBe(true); // folded
      expect(c.admit('k', wake(3))).toBe(true); // folded
      const claimed = c.claim('k');
      expect(claimed).toEqual({ data: wake(3), folded: 2 });
      expect(c.size()).toBe(0);
    });

    it('preserves the newest loop fire identity when numbered fires fold', () => {
      const c = makeTurnCoalescer();
      expect(c.admit('loop-fire:r-1', 'Loop wake #1', { routineId: 'r-1', fireNumber: 1 })).toBe(false);
      expect(c.admit('loop-fire:r-1', 'Loop wake #9', { routineId: 'r-1', fireNumber: 9 })).toBe(true);
      expect(c.claim('loop-fire:r-1')).toEqual({
        data: 'Loop wake #9',
        folded: 1,
        metadata: { routineId: 'r-1', fireNumber: 9 },
      });
    });

    it('refreshes a pending same-delivery waiter without counting a second logical fire (EI-21428742689578243)', () => {
      const c = makeTurnCoalescer();
      const key = 'loop-fire:r-1';
      expect(c.admit(key, 'stale checkpoint; age=900s', { routineId: 'r-1', fireNumber: 4 })).toBe(false);

      expect(c.refresh(key, 'fresh checkpoint; age=2s', { routineId: 'r-1', fireNumber: 4 })).toBe(true);
      expect(c.claim(key)).toEqual({
        data: 'fresh checkpoint; age=2s',
        folded: 0,
        metadata: { routineId: 'r-1', fireNumber: 4 },
      });

      // Once the waiter has claimed its slot, a late retry cannot recreate it.
      expect(c.refresh(key, 'too late')).toBe(false);
      expect(c.size()).toBe(0);
    });

    it('does not let an older same-delivery retry roll back a newer folded fire', () => {
      const c = makeTurnCoalescer();
      const key = 'loop-fire:r-1';
      expect(c.admit(key, 'fire 4 snapshot', { routineId: 'r-1', fireNumber: 4 })).toBe(false);
      expect(c.admit(key, 'fire 5 snapshot', { routineId: 'r-1', fireNumber: 5 })).toBe(true);

      // Fire 4's durable delivery id is still pending at the host and can retry
      // after fire 5 folded. Its retry must not replace the newer logical fire.
      expect(c.refresh(key, 'fire 4 retry with a newer read', { routineId: 'r-1', fireNumber: 4 })).toBe(false);
      expect(c.claim(key)).toEqual({
        data: 'fire 5 snapshot',
        folded: 1,
        metadata: { routineId: 'r-1', fireNumber: 5 },
      });
    });

    it('different keys wait independently (no cross-source folding)', () => {
      const c = makeTurnCoalescer();
      expect(c.admit('a', 'A1')).toBe(false);
      expect(c.admit('b', 'B1')).toBe(false);
      expect(c.claim('a')).toEqual({ data: 'A1', folded: 0 });
      expect(c.claim('b')).toEqual({ data: 'B1', folded: 0 });
    });

    it('claim clears the slot: a later arrival starts a FRESH cycle (no folding into a dead waiter)', () => {
      const c = makeTurnCoalescer();
      c.admit('k', wake(1));
      c.claim('k'); // delivery (or defer/error) cleared it
      expect(c.admit('k', wake(2))).toBe(false); // new waiter, not folded
    });

    it('claim is idempotent — the error-path double-claim is a safe no-op', () => {
      const c = makeTurnCoalescer();
      c.admit('k', wake(1));
      expect(c.claim('k')).not.toBeNull();
      expect(c.claim('k')).toBeNull();
    });

    it('the measured 9× scenario: 9 stacked wakes → ONE delivery annotated with 8 folds', () => {
      const c = makeTurnCoalescer();
      const key = turnCoalesceKey(wake(1));
      expect(c.admit(key, wake(1))).toBe(false);
      for (let n = 2; n <= 9; n++) expect(c.admit(key, wake(n))).toBe(true);
      const claimed = c.claim(key)!;
      const delivered = renderCoalescedTurn(claimed.data, claimed.folded);
      expect(claimed.folded).toBe(8);
      expect(delivered).toContain('details for wake #9'); // newest wins
      expect(delivered).toContain('8 duplicate queued wakes were coalesced');
    });
  });
});

/**
 * injectTurn (WI-2141436 hole #1): had NO ownerId param at all — an
 * envelope-less write with no addressed-recipient assertion. A lightweight
 * echo server (no real psu host) is enough to verify the ENVELOPE this
 * function actually puts on the wire; the receiver's EI-153 misdelivery guard
 * itself is covered elsewhere (this only proves the sender now carries the
 * identity that guard checks).
 */
describe('injectTurn ownerId envelope (WI-2141436 hole #1)', () => {
  function withEchoServer(fn: (sock: string, received: () => Buffer[]) => Promise<void>) {
    return async () => {
      const dir = nodeFs.mkdtempSync(pathJoin(nodeOs.tmpdir(), 'psu-pty-inject-test-'));
      const sock = pathJoin(dir, 'h.sock');
      const chunks: Buffer[] = [];
      const server = net.createServer((conn) => {
        conn.on('data', (d) => chunks.push(d));
        conn.on('end', () => conn.end());
      });
      await new Promise<void>((resolve) => server.listen(sock, resolve));
      try {
        await fn(sock, () => chunks);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          nodeFs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    };
  }

  it(
    'passing ownerId puts it on the wire, decodable by the receiver',
    withEchoServer(async (sock, received) => {
      const ok = await injectTurn(sock, 'hello', 'su-target-owner');
      expect(ok).toBe(true);
      const decoded = decodeControl(Buffer.concat(received()));
      expect(decoded.mode).toBe('turn');
      expect(decoded.data).toBe('hello');
      expect((decoded as { ownerId?: string }).ownerId).toBe('su-target-owner');
    }),
  );

  it(
    'omitting ownerId still works (legacy call) and carries none — the pre-fix, still-a-hole shape',
    withEchoServer(async (sock, received) => {
      const ok = await injectTurn(sock, 'hello');
      expect(ok).toBe(true);
      const decoded = decodeControl(Buffer.concat(received()));
      expect(decoded.mode).toBe('turn');
      expect((decoded as { ownerId?: string }).ownerId).toBeUndefined();
    }),
  );
});

/**
 * makeInjectMutex (EI-8822): serializes the GATED-inject critical section within a
 * host so two injects freed at the same clean boundary — a coord wake `turn` and a
 * session:request-compaction `/compact` — can never both pass the at-prompt gate
 * and interleave their bytes into one pty input line (which concatenates the
 * second's text after the first, so the CLI reads "<wake…>/compact <focus>" as
 * prose, not a command, and the compaction silently never runs).
 */
describe('makeInjectMutex (EI-8822 — gated-inject serialization)', () => {
  it('the second acquirer does NOT enter its critical section until the first releases', async () => {
    const m = makeInjectMutex();
    const events: string[] = [];

    const r1 = await m.acquire(); // holder 1 has the lock
    events.push('1:enter');

    // Holder 2 tries to acquire while holder 1 still holds it.
    let entered2 = false;
    const p2 = m.acquire().then((r2) => {
      entered2 = true;
      events.push('2:enter');
      return r2;
    });

    // Let any pending microtasks flush — holder 2 must STILL be blocked.
    await Promise.resolve();
    await Promise.resolve();
    expect(entered2).toBe(false);
    expect(events).toEqual(['1:enter']);

    events.push('1:release');
    r1(); // free the lock → holder 2 unblocks
    const r2 = await p2;
    expect(entered2).toBe(true);
    r2();
    // The critical sections never overlapped: 1 fully done before 2 began.
    expect(events).toEqual(['1:enter', '1:release', '2:enter']);
  });

  it('the two gated injects (a wake turn + a /compact) run write-sequences that never interleave', async () => {
    // Model the exact race: both injects are released at the same clean boundary
    // and each writes its bytes as a short sequence. Without the mutex, the two
    // sequences interleave into one line ("<wake>/compact"); with it, one whole
    // sequence completes before the other starts.
    const m = makeInjectMutex();
    const line: string[] = [];
    // A gated inject writes its text, yields (a paste-settle delay), then its CR.
    const gatedInject = async (label: string, text: string) => {
      const release = await m.acquire();
      try {
        line.push(`${label}:${text}`);
        await Promise.resolve(); // the delay between text and submit CR
        await Promise.resolve();
        line.push(`${label}:CR`);
      } finally {
        release();
      }
    };
    // Fire both "at the same time" (same clean boundary).
    await Promise.all([gatedInject('wake', 'do X'), gatedInject('compact', '/compact focus')]);
    // Each inject's text and CR are adjacent — never split by the other's write.
    const wakeText = line.indexOf('wake:do X');
    const wakeCr = line.indexOf('wake:CR');
    const compactText = line.indexOf('compact:/compact focus');
    const compactCr = line.indexOf('compact:CR');
    expect(wakeCr).toBe(wakeText + 1); // wake text immediately followed by its CR
    expect(compactCr).toBe(compactText + 1); // compact text immediately followed by its CR
    // And one whole inject completes before the other begins (no interleave).
    const wakeFirst = wakeText < compactText;
    expect(line).toEqual(
      wakeFirst
        ? ['wake:do X', 'wake:CR', 'compact:/compact focus', 'compact:CR']
        : ['compact:/compact focus', 'compact:CR', 'wake:do X', 'wake:CR'],
    );
  });

  it('preserves FIFO order across three waiters', async () => {
    const m = makeInjectMutex();
    const order: number[] = [];
    const run = async (n: number) => {
      const release = await m.acquire();
      order.push(n);
      await Promise.resolve();
      release();
    };
    // Enqueue in order; each acquire() chains onto the prior tail (FIFO).
    const p1 = run(1);
    const p2 = run(2);
    const p3 = run(3);
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a throwing critical section still releases the lock (the finally contract) — the queue never wedges', async () => {
    const m = makeInjectMutex();
    const order: string[] = [];
    // Holder 1 throws AFTER acquiring but releases in its finally (as the handler does).
    const p1 = (async () => {
      const release = await m.acquire();
      try {
        order.push('1');
        throw new Error('inject blew up (child exited mid-inject)');
      } finally {
        release();
      }
    })();
    await expect(p1).rejects.toThrow('inject blew up');
    // The next inject must still be able to acquire — no permanent wedge.
    const release2 = await m.acquire();
    order.push('2');
    release2();
    expect(order).toEqual(['1', '2']);
  });

  // EI-22123519641932348: the watchdog. Every OTHER gate/verify step in the
  // gated-delivery pipeline is independently time-capped; `acquire()`'s own
  // `await prev` was the one unbounded wait, matching a live ~6h total-silence
  // incident (a wedged holder that never reached its `finally` release left
  // every later gated inject queued behind it, forever, with zero trace).
  // warnMs/forceReleaseMs are tiny real ms here (this file's own convention —
  // no fake timers anywhere in it) so these run fast without waiting out the
  // multi-minute production defaults.
  describe('watchdog (EI-22123519641932348 — a wedged holder must not wedge the queue forever)', () => {
    it('does NOT fire onStuck, and behaves exactly like the unwatched mutex, when nothing is stuck', async () => {
      const onStuck = vi.fn();
      const m = makeInjectMutex({ warnMs: 10_000, forceReleaseMs: 20_000, onStuck });
      const release1 = await m.acquire();
      release1();
      const release2 = await m.acquire();
      release2();
      expect(onStuck).not.toHaveBeenCalled();
    });

    it('fires onStuck({phase:"warn"}) once past warnMs while still genuinely waiting — and does NOT proceed', async () => {
      const onStuck = vi.fn();
      const m = makeInjectMutex({ warnMs: 15, forceReleaseMs: 10_000, onStuck });
      const release1 = await m.acquire(); // holder 1 never releases in this test
      let entered2 = false;
      const p2 = m.acquire().then((r2) => {
        entered2 = true;
        return r2;
      });
      // Wait past warnMs but nowhere near forceReleaseMs.
      await new Promise((r) => setTimeout(r, 40));
      expect(onStuck).toHaveBeenCalledWith(expect.objectContaining({ phase: 'warn' }));
      expect(onStuck).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'force-release' }));
      // The warn is advisory only — holder 2 must still be genuinely blocked.
      expect(entered2).toBe(false);
      // Clean up: release holder 1 so holder 2 (and the test process) can settle.
      release1();
      const release2 = await p2;
      expect(entered2).toBe(true);
      release2();
    });

    it('force-releases past forceReleaseMs so a wedged (never-released) holder cannot wedge the queue forever', async () => {
      const onStuck = vi.fn();
      const m = makeInjectMutex({ warnMs: 10, forceReleaseMs: 30, onStuck });
      const order: string[] = [];
      await m.acquire(); // holder 1 acquires and — deliberately, to model the bug — NEVER releases
      order.push('1:enter');
      const release2 = await m.acquire(); // must NOT hang forever
      order.push('2:enter');
      release2();
      expect(order).toEqual(['1:enter', '2:enter']);
      expect(onStuck).toHaveBeenCalledWith(expect.objectContaining({ phase: 'warn' }));
      expect(onStuck).toHaveBeenCalledWith(expect.objectContaining({ phase: 'force-release' }));
    });

    it('a wedged holder that eventually DOES call release() late is a harmless no-op — the queue keeps working normally', async () => {
      const onStuck = vi.fn();
      const m = makeInjectMutex({ warnMs: 10, forceReleaseMs: 20, onStuck });
      const release1 = await m.acquire();
      const release2 = await m.acquire(); // force-releases past 20ms
      // The original holder calls its release LATE, after being force-passed.
      expect(() => release1()).not.toThrow();
      release2();
      // The mutex must still serialize correctly for everyone AFTER the wedge —
      // a THIRD acquire chains off holder 2's tail, never off the stale `prev`.
      const order: string[] = [];
      const release3 = await m.acquire();
      order.push('3:enter');
      let entered4 = false;
      const p4 = m.acquire().then((r4) => {
        entered4 = true;
        order.push('4:enter');
        return r4;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(entered4).toBe(false); // still properly serialized post-wedge
      release3();
      const release4 = await p4;
      release4();
      expect(order).toEqual(['3:enter', '4:enter']);
    });

    it('a disabled watchdog (0/Infinity) never fires onStuck and never changes ordinary blocking behavior', async () => {
      const onStuck = vi.fn();
      const m = makeInjectMutex({ warnMs: 0, forceReleaseMs: Infinity, onStuck });
      const release1 = await m.acquire();
      let entered2 = false;
      const p2 = m.acquire().then((r2) => {
        entered2 = true;
        return r2;
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(entered2).toBe(false); // no force-release ever fires
      expect(onStuck).not.toHaveBeenCalled();
      release1();
      const release2 = await p2;
      release2();
    });
  });
});

describe('WI-3455 — pidLooksLikePsuHost (host-side identity check, mirrors psu-pty-discovery)', () => {
  it('accepts a psu-launcher / psu-pty-host cmdline, rejects unrelated processes', () => {
    expect(pidLooksLikePsuHost(123, () => 'node /x/scripts/psu-launcher.mjs --resume abc')).toBe(true);
    expect(pidLooksLikePsuHost(123, () => 'node /x/scripts/psu-pty-host.mjs')).toBe(true);
    expect(pidLooksLikePsuHost(123, () => 'nginx: worker process')).toBe(false);
    expect(pidLooksLikePsuHost(0, () => 'node psu-launcher.mjs')).toBe(false);
  });
  it('an unreadable cmdline rejects on Linux (pid vanished/zombie), fails open only without /proc', () => {
    const hasProc = nodeFs.existsSync('/proc');
    expect(pidLooksLikePsuHost(123, () => null)).toBe(!hasProc);
  });
});

describe('every child.write() control byte is an ESCAPE, never a literal (EI-20287339148365013)', () => {
  // The file has carried a prose warning about this since WI-38257: a literal
  // control byte "is invisible in review and is exactly what a patch, an editor
  // or a copy-paste silently drops", degrading child.write('\u0015') to
  // child.write('') — which still clears our MODEL while the real composer
  // keeps its text, so the next injected turn appends to owner text. That is
  // the precise corruption the composer gate exists to prevent, reintroduced by
  // the code meant to fix it.
  //
  // The prose was not enough: writing the respawn clear below, I emitted a
  // literal 0x15 anyway, and it rendered as an ordinary quoted string in every
  // view I had. Only a byte-level read caught it. So this asserts the property
  // mechanically instead of asking the next author to be more careful.
  const SOURCE = nodeFs.readFileSync(new URL('../scripts/psu-pty-host.mjs', import.meta.url), 'utf8');

  it('has at least two write sites to check — the guard must not pass by finding nothing', () => {
    // A regex that silently stops matching would make this whole block vacuous.
    const sites = SOURCE.split('\n').filter((l) => l.includes('child?.write('));
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  it('never passes a raw control character to child.write()', () => {
    const offenders: string[] = [];
    SOURCE.split('\n').forEach((line, i) => {
      const arg = /child\?\.write\((.*)\)/.exec(line)?.[1];
      if (!arg) return;
      if ([...arg].some((c) => c.charCodeAt(0) < 0x20)) offenders.push(`line ${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  it('CONTROL: the same check DOES flag a literal byte, so a green here means something', () => {
    // Falsifiability without mutating the shared tree (the sweep would commit a
    // mutant): run the identical predicate over a synthetic line instead.
    const mutant = `child?.write('${String.fromCharCode(21)}');`;
    const arg = /child\?\.write\((.*)\)/.exec(mutant)?.[1] ?? '';
    expect([...arg].some((c) => c.charCodeAt(0) < 0x20)).toBe(true);
    // …and the escape form it should have been must pass the same predicate.
    const good = String.raw`child?.write('\u0015');`;
    const goodArg = /child\?\.write\((.*)\)/.exec(good)?.[1] ?? '';
    expect([...goodArg].some((c) => c.charCodeAt(0) < 0x20)).toBe(false);
  });
});

describe("resume finalization uses concrete initial pty spawn evidence", () => {
  const SOURCE = nodeFs.readFileSync(
    new URL("../scripts/psu-pty-host.mjs", import.meta.url),
    "utf8",
  );
  const initialSpawn = SOURCE.slice(
    SOURCE.indexOf("  let child;\n"),
    SOURCE.indexOf("  // RECYCLE state", SOURCE.indexOf("  let child;\n")),
  );

  it("invokes onSpawn only after the initial pty.spawn succeeds", () => {
    const spawn = initialSpawn.indexOf("child = spawnChild();");
    const spawnFailure = initialSpawn.indexOf("} catch (e) {", spawn);
    const acknowledgement = initialSpawn.indexOf(
      "const acknowledgement = onSpawn();",
    );

    expect(spawn).toBeGreaterThan(-1);
    expect(spawnFailure).toBeGreaterThan(spawn);
    expect(acknowledgement).toBeGreaterThan(spawnFailure);
  });

  it("does not re-finalize on later recycle spawns", () => {
    expect(initialSpawn.match(/onSpawn\(\)/g)).toHaveLength(1);
  });
});

describe('hostIdleMs — the fact the resume guard never reported (EI-20289007209260909)', () => {
  // The measured husk. A headless session whose kickoff said "acknowledge and
  // stop" did exactly that, then held its socket and identity for 4h15m while
  // the guard called it "STILL LIVE in another window" and coord:presence
  // called the same session `ended`. Both were locally correct; neither
  // reported the deciding fact, so the owner could not tell what was true.
  const NOW = Date.parse('2026-08-12T22:43:00Z');

  it('reports the 178-minute idle the owner had to dig for by hand', () => {
    const meta = {
      startedAt: Date.parse('2026-08-12T18:26:54Z'),
      lastOutputAt: Date.parse('2026-08-12T19:45:15Z'),
    };
    const idle = hostIdleMs(meta, NOW);
    expect(Math.round((idle as number) / 60_000)).toBe(178);
  });

  it('takes the MOST RECENT stamp, not the first one present', () => {
    // startedAt is always set and is always the oldest; reading it in
    // preference to a later stamp would report every busy host as ancient.
    const meta = {
      startedAt: Date.parse('2026-08-12T18:26:54Z'),
      lastOutputAt: Date.parse('2026-08-12T22:42:30Z'),
      lastInputAt: Date.parse('2026-08-12T22:00:00Z'),
    };
    expect(hostIdleMs(meta, NOW)).toBe(30_000);
  });

  it('returns null when NO stamp is readable — absent evidence is not idleness', () => {
    // The safe direction here is the OPPOSITE of the composer breaker's, and
    // that asymmetry is the whole point: breaking a phantom line costs a line
    // nobody was typing, while waving a resume past a genuinely live host
    // boots a second one onto its discovery key and strands it (WI-3455).
    expect(hostIdleMs({}, NOW)).toBeNull();
    expect(hostIdleMs(undefined as never, NOW)).toBeNull();
    expect(hostIdleMs({ startedAt: 0 }, NOW)).toBeNull();
    expect(hostIdleMs({ lastOutputAt: Number.NaN }, NOW)).toBeNull();
  });

  it('never returns a negative age when a stamp is ahead of the clock', () => {
    // Clock skew between the writing host and the reading launcher would
    // otherwise render as "idle -3m", which reads as a bug in the guard.
    expect(hostIdleMs({ lastOutputAt: NOW + 180_000 }, NOW)).toBe(0);
  });

  it('reports a busy host as busy', () => {
    expect(hostIdleMs({ lastActivityAt: NOW - 1_200 }, NOW)).toBe(1_200);
  });
});

describe('WI-3455 — findLiveHostFor (the launcher resume-of-live guard read)', () => {
  const fs = nodeFs;
  const mkOwner = () => `su-flhf-utest-${process.pid}-${Math.floor(performance.now() * 1000)}`;
  const writeMetaFile = (ownerId: string, meta: Record<string, unknown>) => {
    fs.mkdirSync(PSU_PTY_DIR, { recursive: true });
    fs.writeFileSync(metaPathFor(ownerId), JSON.stringify(meta));
  };
  const cleanup = (ownerId: string) => {
    for (const p of [metaPathFor(ownerId), socketPathFor(ownerId)]) {
      try { fs.unlinkSync(p); } catch { /* absent is fine */ }
    }
  };

  it('returns the meta for a live, identity-verified host whose sock exists', () => {
    const ownerId = mkOwner();
    try {
      fs.mkdirSync(PSU_PTY_DIR, { recursive: true }); // PSU_PTY_DIR may not exist yet on a fresh box
      fs.writeFileSync(socketPathFor(ownerId), ''); // stand-in for the bound node
      writeMetaFile(ownerId, { ownerId, pid: process.pid, sock: socketPathFor(ownerId) });
      const hit = findLiveHostFor(ownerId, { verifyIdentity: () => true });
      expect(hit?.pid).toBe(process.pid);
    } finally { cleanup(ownerId); }
  });

  it('returns null on: missing file, recorded-owner mismatch, dead pid, failed identity, missing sock', () => {
    const ownerId = mkOwner();
    try {
      expect(findLiveHostFor(ownerId)).toBeNull(); // no file

      fs.mkdirSync(PSU_PTY_DIR, { recursive: true }); // PSU_PTY_DIR may not exist yet on a fresh box
      fs.writeFileSync(socketPathFor(ownerId), '');
      writeMetaFile(ownerId, { ownerId: 'su-someone-else', pid: process.pid, sock: socketPathFor(ownerId) });
      expect(findLiveHostFor(ownerId, { verifyIdentity: () => true })).toBeNull(); // EI-151 mismatch

      writeMetaFile(ownerId, { ownerId, pid: 999_999_999, sock: socketPathFor(ownerId) });
      expect(findLiveHostFor(ownerId, { verifyIdentity: () => true })).toBeNull(); // dead pid

      writeMetaFile(ownerId, { ownerId, pid: process.pid, sock: socketPathFor(ownerId) });
      expect(findLiveHostFor(ownerId, { verifyIdentity: () => false })).toBeNull(); // not a psu host

      fs.unlinkSync(socketPathFor(ownerId));
      expect(findLiveHostFor(ownerId, { verifyIdentity: () => true })).toBeNull(); // sock gone
    } finally { cleanup(ownerId); }
  });
});

describe('managed carry P-003 — duplicate PTY-host startup admission', () => {
  const ownerId = 'su-duplicate-owner';
  const live = { ownerId, pid: 4567 };

  it('refuses another live identity-verified host for the same logical owner', () => {
    expect(
      duplicateHostAdmission(ownerId, live, {
        currentPid: 1234,
        isAlive: () => true,
        verifyIdentity: () => true,
      }),
    ).toEqual({ admitted: false, reason: 'live-duplicate-host', ownerId, pid: 4567 });
  });

  it.each([
    ['missing record', null, true, true, 1234],
    ['owner mismatch', { ownerId: 'su-other', pid: 4567 }, true, true, 1234],
    ['same host process', live, true, true, 4567],
    ['dead process', live, false, true, 1234],
    ['PID reused by non-host', live, true, false, 1234],
  ])('admits %s', (_label, meta, alive, identity, currentPid) => {
    expect(
      duplicateHostAdmission(ownerId, meta, {
        currentPid,
        isAlive: () => alive,
        verifyIdentity: () => identity,
      }).admitted,
    ).toBe(true);
  });
});

describe('appendHostEvent / eventLogPathForOwner (EI-10412 — durable lifecycle-verb outcome log)', () => {
  const fs = nodeFs;
  const os = nodeOs;
  const join = pathJoin;
  // The host's stderr is the owner's terminal, so a dropped compact carry-note
  // used to leave ZERO durable trace (the 2026-07-12 epidemic: 10 lost
  // auto-continuations across 7 agents, reconstructed via transcript
  // archaeology). These rows are the one-file answer to "did the carry get
  // typed, and if not why".
  it('appends one JSONL row per event and returns true', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'psu-events-'));
    try {
      expect(appendHostEvent('su-test-owner', 'compact-submitted', { carry: true }, dir)).toBe(true);
      expect(
        appendHostEvent('su-test-owner', 'compact-carry-dropped', { reason: 'compaction-still-running' }, dir),
      ).toBe(true);
      const rows = fs
        .readFileSync(eventLogPathForOwner('su-test-owner', dir), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ kind: 'compact-submitted', carry: true });
      expect(rows[1]).toMatchObject({ kind: 'compact-carry-dropped', reason: 'compaction-still-running' });
      expect(typeof rows[0].ts).toBe('string');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('front-truncates (oldest rows dropped, newest kept) once the log exceeds the size cap', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'psu-events-'));
    try {
      const p = eventLogPathForOwner('su-cap', dir);
      // Pre-seed a log just over the 256KB cap with identifiable rows.
      const filler = Array.from({ length: 3000 }, (_, i) =>
        JSON.stringify({ ts: 'old', kind: 'filler', i, pad: 'x'.repeat(64) }),
      ).join('\n');
      fs.writeFileSync(p, filler + '\n');
      expect(fs.statSync(p).size).toBeGreaterThan(256 * 1024);
      expect(appendHostEvent('su-cap', 'compact-carry-delivered', { attempts: 1 }, dir)).toBe(true);
      const after = fs.readFileSync(p, 'utf8');
      expect(fs.statSync(p).size).toBeLessThan(256 * 1024);
      const rows = after.trim().split('\n').map((l) => JSON.parse(l)); // every surviving line still parses (no half row at the cut)
      expect(rows.at(-1)).toMatchObject({ kind: 'compact-carry-delivered', attempts: 1 });
      expect(rows[0].kind).toBe('filler');
      expect(rows[0].i).toBeGreaterThan(1000); // oldest rows were the ones dropped
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('is fail-soft: an unwritable dir returns false, never throws', () => {
    expect(appendHostEvent('su-x', 'compact-submitted', {}, '/nonexistent-root-dir/nope')).toBe(false);
  });
});

describe('appendSharedDrillLedgerEvent (EI-12655 — host-side mirror into the shared drill ledger)', () => {
  const fs = nodeFs;
  const os = nodeOs;
  const join = pathJoin;
  // The tool side (cold-boot-drill-live.ts) writes only requested/queued into
  // carry-drills.events.jsonl; every host-side outcome previously lived ONLY in
  // the per-owner log — so op:'report' saw perClass:[] even after real drills.
  it('appends ColdBootDrillLedgerEvent-shaped rows ({ ts, kind, ownerId, ...extra }) into the SHARED file', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'psu-drill-ledger-'));
    try {
      expect(
        appendSharedDrillLedgerEvent(
          'su-a',
          'carry-drill-respawned',
          { drillId: 'd-1', sessionClass: 'gateway-claude-headless', nativeId: 'n-1' },
          dir,
        ),
      ).toBe(true);
      expect(
        appendSharedDrillLedgerEvent(
          'su-b',
          'carry-drill-carry-dropped',
          { drillId: 'd-2', sessionClass: 'gateway-claude-headless', reason: 'busy-gate-expired', capMs: 180_000 },
          dir,
        ),
      ).toBe(true);
      const p = sharedDrillLedgerPath(dir);
      expect(p.endsWith('carry-drills.events.jsonl')).toBe(true); // the SAME file the tool side reads
      const rows = fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toHaveLength(2); // both owners share ONE roll-up file
      expect(rows[0]).toMatchObject({ kind: 'carry-drill-respawned', ownerId: 'su-a', drillId: 'd-1', nativeId: 'n-1' });
      expect(rows[1]).toMatchObject({ kind: 'carry-drill-carry-dropped', ownerId: 'su-b', reason: 'busy-gate-expired' });
      expect(typeof rows[0].ts).toBe('string');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('front-truncates past the 1MB cap, keeping newest rows and whole lines', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'psu-drill-ledger-'));
    try {
      const p = sharedDrillLedgerPath(dir);
      const filler = Array.from({ length: 9000 }, (_, i) =>
        JSON.stringify({ ts: 'old', kind: 'filler', i, pad: 'x'.repeat(96) }),
      ).join('\n');
      fs.writeFileSync(p, filler + '\n');
      expect(fs.statSync(p).size).toBeGreaterThan(1024 * 1024);
      expect(appendSharedDrillLedgerEvent('su-cap', 'carry-drill-carry-delivered', { drillId: 'd-9' }, dir)).toBe(true);
      expect(fs.statSync(p).size).toBeLessThan(1024 * 1024);
      const rows = fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows.at(-1)).toMatchObject({ kind: 'carry-drill-carry-delivered', drillId: 'd-9' });
      expect(rows[0].kind).toBe('filler');
      expect(rows[0].i).toBeGreaterThan(1000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('is fail-soft: an unwritable dir returns false, never throws', () => {
    expect(appendSharedDrillLedgerEvent('su-x', 'carry-drill-respawned', {}, '/nonexistent-root-dir/nope')).toBe(false);
  });
});

describe('mcp-reconnect macro (mcp-transport-resilience P-003, 2026-07-13)', () => {
  describe('stripAnsi', () => {
    it('strips CSI/OSC/simple-ESC and normalizes carriage returns', () => {
      const raw = '\x1b[2K\x1b[1G\x1b[36m❯ 1. papercusp-su\x1b[39m  \x1b]0;title\x07connected\r\n';
      expect(stripAnsi(raw)).toBe('❯ 1. papercusp-su  connected\n');
    });
    it('drops other control chars but keeps newlines and tabs', () => {
      expect(stripAnsi('a\x07b\tc\nd')).toBe('ab\tc\nd');
    });
  });

  describe('headless normalized log sidecar (EI-22062652981611226)', () => {
    it('carries split ANSI sequences across chunks, splits CR redraw frames, and keeps CRLF to one newline', () => {
      const normalizer = makeHeadlessLogNormalizer({ maxLineBytes: 64 });

      expect(normalizer.push('\x1b[36mCod')).toBe('');
      expect(normalizer.push('ex\x1b[0m\r')).toBe('Codex\n');
      expect(normalizer.push('\nnext\r\nlast')).toBe('next\n');
      expect(normalizer.flush()).toBe('last\n');
    });

    it('chunks a giant frame by UTF-8 bytes without splitting a Unicode code point', () => {
      const normalizer = makeHeadlessLogNormalizer({ maxLineBytes: 5 });
      const output = normalizer.push('a🙂b');
      expect(output).toBe(`a🙂\n`);
      expect(normalizer.flush()).toBe('b\n');
      expect(Buffer.byteLength('a🙂', 'utf8')).toBeLessThanOrEqual(5);
    });

    it('writes a bounded, owner-only companion and closes idempotently', () => {
      const root = nodeFs.mkdtempSync(pathJoin(nodeOs.tmpdir(), 'psu-normalized-log-'));
      const path = pathJoin(root, 'member.normalized.log');
      try {
        const writer = createHeadlessNormalizedLogWriter(path, {
          maxLineBytes: 64,
          maxBytes: 32,
          maxWriteBytes: 8,
        });
        expect(writer.enabled).toBe(true);
        writer.push(`\x1b[31m${'x'.repeat(100)}`);
        writer.close();
        writer.close();

        expect(nodeFs.existsSync(path)).toBe(true);
        // The writer permits at most one bounded write chunk beyond the
        // retained tail before trimming; it must never retain the whole frame.
        expect(nodeFs.statSync(path).size).toBeLessThanOrEqual(32 + 8);
        expect(nodeFs.statSync(path).mode & 0o777).toBe(0o600);
        expect(nodeFs.readFileSync(path, 'utf8')).not.toMatch(/\x1b/);
      } finally {
        nodeFs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('mcpServerRowStatus', () => {
    it('null when the row does not name the server', () => {
      expect(mcpServerRowStatus('  2. playwright  connected', 'papercusp-su')).toBeNull();
    });
    it('connected on a healthy list row; "disconnected" never reads as connected', () => {
      expect(mcpServerRowStatus('❯ 1. papercusp-su  ✔ connected', 'papercusp-su')).toBe('connected');
      expect(mcpServerRowStatus('❯ 1. papercusp-su  ✘ disconnected', 'papercusp-su')).toBe('not-connected');
      expect(mcpServerRowStatus('  1. papercusp-su  failed · needs authentication', 'papercusp-su')).toBe('not-connected');
      expect(mcpServerRowStatus('  1. papercusp-su  connecting…', 'papercusp-su')).toBe('not-connected');
    });
    it('unknown when the row names the server without a status marker', () => {
      expect(mcpServerRowStatus('papercusp-su', 'papercusp-su')).toBe('unknown');
    });
  });

  describe('mcpDialogRowSelected', () => {
    it('true only when the ❯ cursor precedes the matched content on the freshest row', () => {
      const frame1 = '❯ 1. papercusp-su  failed\n  2. playwright  connected';
      expect(mcpDialogRowSelected(frame1, (l: string) => l.includes('papercusp-su'))).toBe(true);
      expect(mcpDialogRowSelected(frame1, (l: string) => l.includes('playwright'))).toBe(false);
    });
    it('the LAST matching line (freshest repaint) wins', () => {
      const twoFrames =
        '❯ 1. papercusp-su  failed\n  2. playwright  connected\n' +
        '  1. papercusp-su  failed\n❯ 2. playwright  connected';
      expect(mcpDialogRowSelected(twoFrames, (l: string) => l.includes('papercusp-su'))).toBe(false);
    });
  });

  describe('mcpConnectedVerdict', () => {
    it('list shape: decisive off the row naming the server', () => {
      expect(mcpConnectedVerdict('❯ 1. papercusp-su  ✔ connected', 'papercusp-su')).toBe(true);
      expect(mcpConnectedVerdict('❯ 1. papercusp-su  ✘ failed', 'papercusp-su')).toBe(false);
    });
    it('detail shape: a bare Status line is decisive (name on its own header line)', () => {
      expect(mcpConnectedVerdict('papercusp-su\nStatus: ✔ connected', 'papercusp-su')).toBe(true);
      expect(mcpConnectedVerdict('papercusp-su\nStatus: ✘ failed', 'papercusp-su')).toBe(false);
      expect(mcpConnectedVerdict('papercusp-su\nStatus: connecting…', 'papercusp-su')).toBe(false);
    });
    it("another server's connected row is NOT a verdict for the target", () => {
      expect(mcpConnectedVerdict('  2. playwright  ✔ connected', 'papercusp-su')).toBe(false);
    });
  });

  describe('runMcpReconnectMacro against a scripted fake TUI', () => {
    /** A minimal /mcp dialog state machine painting realistic frames (list rows =
     *  name+status on ONE line; detail = name header + separate Status line). */
    function makeFakeTui(servers: Array<{ name: string; status: string }>, opts: { reconnectWorks?: boolean } = {}) {
      let out = '';
      let pending = '';
      let view: 'idle' | 'list' | 'detail' = 'idle';
      let cursor = 0;
      let detailCursor = 0;
      let escapes = 0;
      const paintList = () => {
        out +=
          '\nManage MCP servers\n' +
          servers.map((s, i) => `${i === cursor ? '❯ ' : '  '}${i + 1}. ${s.name}  ${s.status}`).join('\n') +
          '\n';
      };
      const paintDetail = () => {
        const s = servers[cursor];
        const rows = ['View tools', 'Reconnect', 'Back'];
        out +=
          `\n${s.name}\nStatus: ${s.status}\n` +
          rows.map((r, i) => `${i === detailCursor ? '❯ ' : '  '}${r}`).join('\n') +
          '\n';
      };
      const write = (b: string) => {
        if (b === '\x1b') {
          escapes += 1;
          view = 'idle';
          return;
        }
        if (b === '\x1b[B') {
          if (view === 'list') {
            cursor = Math.min(cursor + 1, servers.length - 1);
            paintList();
          } else if (view === 'detail') {
            detailCursor = Math.min(detailCursor + 1, 2);
            paintDetail();
          }
          return;
        }
        if (b === '\r') {
          if (view === 'idle' && pending.trim() === '/mcp') {
            pending = '';
            view = 'list';
            cursor = 0;
            paintList();
          } else if (view === 'list') {
            view = 'detail';
            detailCursor = 0;
            paintDetail();
          } else if (view === 'detail' && detailCursor === 1) {
            if (opts.reconnectWorks !== false) servers[cursor].status = '✔ connected';
            paintDetail();
          }
          return;
        }
        pending += b;
      };
      return { write, read: () => out, reset: () => { out = ''; }, escapes: () => escapes };
    }

    const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2)));

    it('heals a failed server end-to-end (open → select → reconnect → connected)', async () => {
      const tui = makeFakeTui([
        { name: 'playwright', status: '✔ connected' },
        { name: 'papercusp-su', status: '✘ failed' },
      ]);
      const result = await runMcpReconnectMacro({
        serverName: 'papercusp-su',
        write: tui.write,
        readTap: tui.read,
        resetTap: tui.reset,
        sleep: fastSleep,
        crDelayMs: 1,
        settleMs: 1,
        paintBudgetMs: 500,
        reconnectBudgetMs: 500,
      });
      expect(result).toEqual({ ok: true, step: 'done', detail: 'connected verdict observed' });
      expect(tui.escapes()).toBeGreaterThanOrEqual(2); // closed out
    });

    it('no-ops fast when the target is already connected (benign watchdog misfire)', async () => {
      const tui = makeFakeTui([{ name: 'papercusp-su', status: '✔ connected' }]);
      const result = await runMcpReconnectMacro({
        serverName: 'papercusp-su',
        write: tui.write,
        readTap: tui.read,
        resetTap: tui.reset,
        sleep: fastSleep,
        crDelayMs: 1,
        settleMs: 1,
        paintBudgetMs: 500,
        reconnectBudgetMs: 500,
      });
      expect(result.ok).toBe(true);
      expect(result.step).toBe('already-connected');
    });

    it('fail-soft: dialog never paints → Esc out with step open-dialog', async () => {
      const dead = { write: () => {}, read: () => '', reset: () => {} };
      const result = await runMcpReconnectMacro({
        serverName: 'papercusp-su',
        write: dead.write,
        readTap: dead.read,
        resetTap: dead.reset,
        sleep: fastSleep,
        crDelayMs: 1,
        settleMs: 1,
        paintBudgetMs: 60,
        reconnectBudgetMs: 60,
      });
      expect(result.ok).toBe(false);
      expect(result.step).toBe('open-dialog');
    });

    it('fail-soft: reconnect action does not heal → await-connected failure', async () => {
      const tui = makeFakeTui(
        [{ name: 'papercusp-su', status: '✘ failed' }],
        { reconnectWorks: false },
      );
      const result = await runMcpReconnectMacro({
        serverName: 'papercusp-su',
        write: tui.write,
        readTap: tui.read,
        resetTap: tui.reset,
        sleep: fastSleep,
        crDelayMs: 1,
        settleMs: 1,
        paintBudgetMs: 500,
        reconnectBudgetMs: 120,
      });
      expect(result.ok).toBe(false);
      expect(result.step).toBe('await-connected');
    });

    it('decodeControl accepts the new mode, gated like a turn', () => {
      const decoded = decodeControl(encodeControl({ mode: 'mcp-reconnect', data: 'papercusp-su' }));
      expect(decoded).toEqual({ mode: 'mcp-reconnect', data: 'papercusp-su', gated: true });
    });
  });
});

describe('makeCarryRearmController (EI-12754 — one-shot re-arm for busy-gate-refused drills)', () => {
  const DRILL_MSG = {
    mode: 'carry-respawn',
    data: '⟦carry-drill:d-77⟧ first prompt',
    systemPromptAddendum: '## Identity\nownerId: su-r',
    drillId: 'd-77',
    sessionClass: 'gateway-claude-headless',
  };

  function makeHarness({
    promptResults = [{ deferred: false }],
    recycleError = null,
    waitIdle,
    maxProductionAttempts,
  } = {}) {
    const events = [];
    const recycles = [];
    const order = [];
    let releases = 0;
    let promptCalls = 0;
    const controller = makeCarryRearmController({
      acquireInject: async () => {
        order.push('acquire');
        return () => {
          releases += 1;
          order.push('release');
        };
      },
      waitIdle: waitIdle
        ? async () => {
            order.push('idle');
          }
        : null,
      waitAtPrompt: async (capMs) => {
        order.push('prompt');
        const result = promptResults[Math.min(promptCalls, promptResults.length - 1)];
        promptCalls += 1;
        return { capMs, ...result };
      },
      recycle: async (data, opts) => {
        order.push('recycle');
        recycles.push({ data, opts });
        if (recycleError) throw recycleError;
      },
      emitEvent: (kind, extra) => events.push({ kind, ...extra }),
      capMs: 1234,
      ...(maxProductionAttempts === undefined ? {} : { maxProductionAttempts }),
    });
    const settle = async () => {
      // The scheduled retry is fire-and-forget; drain the microtask/timer queue.
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    };
    return { controller, events, recycles, order, settle, releaseCount: () => releases };
  }

  it('queues one retry, emits the durable rearm-queued row, and recycles at the settled prompt', async () => {
    const h = makeHarness();
    expect(h.controller.schedule(DRILL_MSG)).toBe('queued');
    expect(h.events[0]).toMatchObject({
      kind: 'carry-drill-rearm-queued',
      drillId: 'd-77',
      sessionClass: 'gateway-claude-headless',
      reason: 'busy-gate-expired',
      capMs: 1234,
    });
    await h.settle();
    expect(h.recycles).toEqual([
      {
        data: DRILL_MSG.data,
        opts: {
          systemPromptAddendum: DRILL_MSG.systemPromptAddendum,
          drillId: 'd-77',
          sessionClass: 'gateway-claude-headless',
        },
      },
    ]);
    // The retry re-acquired the SAME gated-inject mutex and released it after.
    expect(h.order).toEqual(['acquire', 'prompt', 'recycle', 'release']);
    expect(h.releaseCount()).toBe(1);
    // No terminal drop was emitted — recycle()'s own delivered/dropped events own the outcome.
    expect(h.events.filter((e) => e.kind === 'carry-drill-carry-dropped')).toEqual([]);
    expect(h.controller.pendingCount()).toBe(0);
  });

  it('a retry that ALSO defers drops terminally with rearmed:true and never recycles', async () => {
    const h = makeHarness({ promptResults: [{ deferred: true }] });
    expect(h.controller.schedule(DRILL_MSG)).toBe('queued');
    await h.settle();
    expect(h.recycles).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({
      kind: 'carry-drill-carry-dropped',
      drillId: 'd-77',
      reason: 'busy-gate-expired',
      rearmed: true,
    });
    expect(h.releaseCount()).toBe(1);
    expect(h.controller.pendingCount()).toBe(0);
  });

  it('a duplicate schedule while the retry is pending returns duplicate and emits nothing new', async () => {
    // Hold the retry at the prompt gate forever so the first schedule stays pending.
    const h = makeHarness({ promptResults: [] });
    const never = new Promise(() => {});
    const controller = makeCarryRearmController({
      acquireInject: async () => () => {},
      waitAtPrompt: () => never,
      recycle: async () => {},
      emitEvent: (kind, extra) => h.events.push({ kind, ...extra }),
      capMs: 1234,
    });
    expect(controller.schedule(DRILL_MSG)).toBe('queued');
    expect(controller.schedule(DRILL_MSG)).toBe('duplicate');
    expect(controller.pendingCount()).toBe(1);
    expect(h.events.filter((e) => e.kind === 'carry-drill-rearm-queued')).toHaveLength(1);
  });

  // EI-19480099650947832: a PRODUCTION (non-drill) respawn arriving while an
  // earlier one is still re-polling used to be terminally DROPPED as a
  // duplicate — keeping the OLDER carry (already failing, and destined to age
  // out at CARRY_RESPAWN_MAX_AGE_MS) and discarding the FRESHER one the agent
  // had just built. Measured live on 2026-08-04: `respawn-carry-dropped
  // {reason:'busy-gate-expired', capMs:180000, rearmed:true}` at 00:38:29 while
  // the re-poll queued at 00:28:00 ran on fruitlessly for another 14 minutes.
  describe('a production respawn SUPERSEDES a pending re-poll (never dropped as a duplicate)', () => {
    const PROD_A = {
      mode: 'carry-respawn',
      data: 'FIRST carry — built at T0',
      systemPromptAddendum: '## Identity\nownerId: su-p (T0)',
    };
    const PROD_B = {
      mode: 'carry-respawn',
      data: 'SECOND carry — built at T1, strictly fresher',
      systemPromptAddendum: '## Identity\nownerId: su-p (T1)',
    };

    type RearmEvent = { kind: string; [k: string]: unknown };
    type RecycleCall = { data: unknown; opts: { systemPromptAddendum?: unknown; [k: string]: unknown } };
    type RearmMsg = { mode: string; data: string; systemPromptAddendum: string; drillId?: string };

    const drain = async (): Promise<void> => {
      for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r));
    };

    it('schedule() returns superseded, keeps ONE pending entry, and emits no terminal drop', () => {
      const events: RearmEvent[] = [];
      const never = new Promise<{ deferred: boolean }>(() => {});
      const controller = makeCarryRearmController({
        acquireInject: async () => () => {},
        waitAtPrompt: () => never,
        recycle: async () => {},
        emitEvent: (kind: string, extra: Record<string, unknown>) => events.push({ kind, ...extra }),
        capMs: 1234,
      });
      expect(controller.schedule(PROD_A)).toBe('queued');
      expect(controller.schedule(PROD_B)).toBe('superseded');
      // One pending re-poll, not two — and nothing was terminally dropped.
      expect(controller.pendingCount()).toBe(1);
      expect(events.filter((e: RearmEvent) => e.kind === 'respawn-rearm-queued')).toHaveLength(1);
      expect(events.filter((e: RearmEvent) => e.kind === 'respawn-carry-dropped')).toEqual([]);
    });

    it('the in-flight re-poll delivers the FRESHER carry, not the one it was scheduled with', async () => {
      const events: RearmEvent[] = [];
      const recycles: RecycleCall[] = [];
      let ctl: ReturnType<typeof makeCarryRearmController> | null = null;
      let promptCalls = 0;
      ctl = makeCarryRearmController({
        acquireInject: async () => () => {},
        waitAtPrompt: async () => {
          promptCalls += 1;
          if (promptCalls === 1) {
            // The agent is still mid-turn on the first window. In that exact
            // gap the agent calls session:request-compaction AGAIN.
            expect(ctl?.schedule(PROD_B)).toBe('superseded');
            return { deferred: true };
          }
          return { deferred: false };
        },
        recycle: async (data: unknown, opts: Record<string, unknown>) => {
          recycles.push({ data, opts });
        },
        emitEvent: (kind: string, extra: Record<string, unknown>) => events.push({ kind, ...extra }),
        capMs: 1234,
      });
      expect(ctl.schedule(PROD_A)).toBe('queued');
      await drain();
      expect(recycles).toHaveLength(1);
      // THE ASSERTION THAT MATTERS: the newer carry document is what got cut in,
      // and the stale one was never delivered.
      expect(recycles[0].data).toBe(PROD_B.data);
      expect(recycles[0].opts.systemPromptAddendum).toBe(PROD_B.systemPromptAddendum);
      expect(events.filter((e: RearmEvent) => e.kind === 'respawn-carry-dropped')).toEqual([]);
      expect(ctl.pendingCount()).toBe(0);
    });

    it('a supersede landing DURING the wait that then succeeds is still the one delivered', async () => {
      // The narrow race: `latest` is read once before waitAtPrompt, but a
      // supersede can land at ANY await — including the one about to resolve
      // NOT-deferred. Reading the pre-wait value at the delivery point would cut
      // in the older carry with a fresher one already in hand.
      const events: RearmEvent[] = [];
      const recycles: RecycleCall[] = [];
      let ctl: ReturnType<typeof makeCarryRearmController> | null = null;
      ctl = makeCarryRearmController({
        acquireInject: async () => () => {},
        waitAtPrompt: async () => {
          ctl?.schedule(PROD_B); // arrives DURING this wait
          return { deferred: false }; // ...which then succeeds on the SAME attempt
        },
        recycle: async (data: unknown, opts: Record<string, unknown>) => {
          recycles.push({ data, opts });
        },
        emitEvent: (kind: string, extra: Record<string, unknown>) => events.push({ kind, ...extra }),
        capMs: 1234,
      });
      expect(ctl.schedule(PROD_A)).toBe('queued');
      await drain();
      expect(recycles).toHaveLength(1);
      expect(recycles[0].data).toBe(PROD_B.data);
      expect(recycles[0].opts.systemPromptAddendum).toBe(PROD_B.systemPromptAddendum);
    });

    it('CONTROL — a DRILL still dedupes terminally (its whole point is the one scheduled shot)', () => {
      const events: RearmEvent[] = [];
      const never = new Promise<{ deferred: boolean }>(() => {});
      const controller = makeCarryRearmController({
        acquireInject: async () => () => {},
        waitAtPrompt: () => never,
        recycle: async () => {},
        emitEvent: (kind: string, extra: Record<string, unknown>) => events.push({ kind, ...extra }),
        capMs: 1234,
      });
      expect(controller.schedule(DRILL_MSG)).toBe('queued');
      expect(controller.schedule(DRILL_MSG)).toBe('duplicate');
    });

    it('staleness is re-checked against the SUPERSEDING message, so a fresh retry is not killed by the old one', async () => {
      const events: RearmEvent[] = [];
      const recycles: RecycleCall[] = [];
      let ctl: ReturnType<typeof makeCarryRearmController> | null = null;
      let promptCalls = 0;
      // isStale reports TRUE for the original carry and FALSE for the fresher
      // one — the whole reason superseding is worth doing.
      ctl = makeCarryRearmController({
        acquireInject: async () => () => {},
        waitAtPrompt: async () => {
          promptCalls += 1;
          if (promptCalls === 1) {
            ctl?.schedule(PROD_B);
            return { deferred: true };
          }
          return { deferred: false };
        },
        recycle: async (data: unknown, opts: Record<string, unknown>) => {
          recycles.push({ data, opts });
        },
        emitEvent: (kind: string, extra: Record<string, unknown>) => events.push({ kind, ...extra }),
        capMs: 1234,
        isStale: (msg: RearmMsg) => msg.data === PROD_A.data,
      });
      expect(ctl.schedule(PROD_A)).toBe('queued');
      await drain();
      expect(recycles).toHaveLength(1);
      expect(recycles[0].data).toBe(PROD_B.data);
      expect(events.filter((e: RearmEvent) => e.kind === 'respawn-carry-dropped')).toEqual([]);
    });
  });

  it('a recycle error drops terminally with reason rearm-error and still releases the mutex', async () => {
    const h = makeHarness({ recycleError: new Error('argv exploded') });
    expect(h.controller.schedule(DRILL_MSG)).toBe('queued');
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({
      kind: 'carry-drill-carry-dropped',
      drillId: 'd-77',
      reason: 'rearm-error',
      rearmed: true,
      detail: 'argv exploded',
    });
    expect(h.releaseCount()).toBe(1);
    expect(h.controller.pendingCount()).toBe(0);
  });

  it('honors the human-keystroke idle gate (bridged tty) before the busy gate', async () => {
    const h = makeHarness({ waitIdle: true });
    h.controller.schedule(DRILL_MSG);
    await h.settle();
    expect(h.order).toEqual(['acquire', 'idle', 'prompt', 'recycle', 'release']);
  });

  // WI-5368: a message with NO drillId is a PRODUCTION (non-drill) carry-respawn
  // — the session:request-compaction path every real agent uses. This used to
  // be silently dropped here (schedule() unconditionally returned 'duplicate'
  // for an empty drillId, and the call site only invoked schedule() at all when
  // msg.drillId was set) — a busy-gate-deferred real compaction request left
  // ZERO durable trace and NO retry, even though the tool had already told the
  // calling agent `respawn:true`. It must now queue + retry exactly like a drill.
  const NON_DRILL_MSG = {
    mode: 'carry-respawn',
    data: 'continue + re-orient note',
    systemPromptAddendum: '## Identity\nownerId: su-r',
  };

  it('queues one retry for a non-drill (production) carry-respawn, emits respawn-rearm-queued, and recycles at the settled prompt', async () => {
    const h = makeHarness();
    expect(h.controller.schedule(NON_DRILL_MSG)).toBe('queued');
    expect(h.events[0]).toMatchObject({
      kind: 'respawn-rearm-queued',
      mode: 'carry-respawn',
      reason: 'busy-gate-expired',
      capMs: 1234,
    });
    expect(h.events[0].drillId).toBeUndefined();
    await h.settle();
    expect(h.recycles).toEqual([
      {
        data: NON_DRILL_MSG.data,
        opts: {
          systemPromptAddendum: NON_DRILL_MSG.systemPromptAddendum,
          drillId: '',
          sessionClass: '',
        },
      },
    ]);
    expect(h.order).toEqual(['acquire', 'prompt', 'recycle', 'release']);
    expect(h.events.filter((e) => e.kind === 'respawn-carry-dropped')).toEqual([]);
    expect(h.controller.pendingCount()).toBe(0);
  });

  // WI-5623: a PRODUCTION respawn is a MUST-DELIVER — it RE-POLLS across
  // successive busy-gate windows instead of dropping after one retry. A drill
  // stays one-shot. (The old behavior — drop after one defer — meant 0/22
  // production deliveries: autonomous/headless sessions are near-continuously
  // busy and rarely present the 1.5s idle window inside a single window, so the
  // respawn dropped before the session's next idle/recycle boundary and the
  // session ran to the hard context wall.)
  it('WI-5623: a permanently-busy non-drill respawn keeps re-polling without a production stale-drop', async () => {
    // A gate that remains in-flight models a genuinely busy session without
    // spinning the test event loop. The production controller must keep this
    // request pending rather than applying an age/attempt terminal drop.
    const events: RearmEvent[] = [];
    const controller = makeCarryRearmController({
      acquireInject: async () => () => {},
      waitAtPrompt: () => new Promise(() => {}),
      recycle: async () => {},
      emitEvent: (kind: string, extra: Record<string, unknown>) => events.push({ kind, ...extra }),
    });
    expect(controller.schedule(NON_DRILL_MSG)).toBe('queued');
    await new Promise((r) => setImmediate(r));
    expect(controller.pendingCount()).toBe(1);
    expect(events.filter((e) => e.kind === 'respawn-carry-dropped')).toEqual([]);
  });

  it('production stale checks are ignored while drill stale checks remain terminal', async () => {
    const h = makeHarness({ promptResults: [{ deferred: false }] });
    const controller = makeCarryRearmController({
      acquireInject: async () => () => {},
      waitAtPrompt: async () => ({ deferred: false }),
      recycle: async (data, opts) => h.recycles.push({ data, opts }),
      emitEvent: (kind, extra) => h.events.push({ kind, ...extra }),
      capMs: 1234,
      isStale: () => true,
    });
    expect(controller.schedule(NON_DRILL_MSG)).toBe('queued');
    await h.settle();
    expect(h.recycles).toHaveLength(1);
    expect(h.events.filter((e) => e.kind === 'respawn-carry-dropped')).toEqual([]);
  });

  it('WI-5623: a non-drill respawn deferred a few windows then IDLE delivers (re-poll catches the idle boundary); a drill in the same scenario stays one-shot and drops', async () => {
    // Busy for two windows, then the agent idles on the third.
    const h = makeHarness({ promptResults: [{ deferred: true }, { deferred: true }, { deferred: false }] });
    expect(h.controller.schedule(NON_DRILL_MSG)).toBe('queued');
    await h.settle();
    expect(h.recycles).toHaveLength(1);
    expect(h.order.filter((o) => o === 'prompt').length).toBe(3);
    expect(h.events.filter((e) => e.kind === 'respawn-carry-dropped')).toEqual([]);
    expect(h.controller.pendingCount()).toBe(0);

    // Same gate sequence, but a DRILL: ONE shot only — it defers on window 1 and
    // drops (a drill is a test, not a must-deliver), never reaching the idle window.
    const d = makeHarness({ promptResults: [{ deferred: true }, { deferred: true }, { deferred: false }] });
    expect(d.controller.schedule(DRILL_MSG)).toBe('queued');
    await d.settle();
    expect(d.recycles).toEqual([]);
    expect(d.order.filter((o) => o === 'prompt').length).toBe(1);
    expect(d.events.at(-1)).toMatchObject({ kind: 'carry-drill-carry-dropped', rearmed: true });
  });

  // EI-19480099650947832 — THIS TEST USED TO ASSERT `'duplicate'` HERE, i.e. it
  // PINNED the defect: a second production respawn arriving while the first was
  // still re-polling was terminally dropped by the caller, keeping the older,
  // already-failing carry and discarding the fresher one the agent had just
  // built. The shared non-drill key is still correct (two production respawns
  // collapse to ONE pending re-poll — that part never changed); what changed is
  // that the collapse now keeps the NEWER payload instead of the older one.
  it('a second non-drill schedule while one is pending SUPERSEDES it (one pending entry, newer carry kept)', () => {
    const h = makeHarness({ promptResults: [] });
    const controller = makeCarryRearmController({
      acquireInject: async () => () => {},
      waitAtPrompt: () => new Promise(() => {}),
      recycle: async () => {},
      emitEvent: (kind, extra) => h.events.push({ kind, ...extra }),
      capMs: 1234,
    });
    expect(controller.schedule(NON_DRILL_MSG)).toBe('queued');
    expect(controller.schedule(NON_DRILL_MSG)).toBe('superseded');
    expect(controller.pendingCount()).toBe(1);
    expect(h.events.filter((e) => e.kind === 'respawn-rearm-queued')).toHaveLength(1);
    // Never terminal — nothing is dropped on a supersede.
    expect(h.events.filter((e) => e.kind === 'respawn-carry-dropped')).toEqual([]);
  });

  it('a drill and a non-drill retry can be pending at the same time (independent keys)', () => {
    const h = makeHarness({ promptResults: [] });
    expect(h.controller.schedule(DRILL_MSG)).toBe('queued');
    expect(h.controller.schedule(NON_DRILL_MSG)).toBe('queued');
    expect(h.controller.pendingCount()).toBe(2);
  });

  // EI-18109211232286833: the retry itself can run for up to `capMs` (2x the
  // live-inject cap by default), so a message that was still fresh when
  // schedule() was first called can cross the staleness threshold DURING the
  // re-arm's own wait — isStale is re-checked right before recycle(), not
  // only at schedule() time.
  describe('isStale re-check (EI-18109211232286833)', () => {
    it('a drill retry found stale right before recycling drops terminally with reason carry-stale and never recycles', async () => {
      const events = [];
      const recycles = [];
      const controller = makeCarryRearmController({
        acquireInject: async () => () => {},
        waitAtPrompt: async () => ({ deferred: false }),
        recycle: async (data, opts) => recycles.push({ data, opts }),
        emitEvent: (kind, extra) => events.push({ kind, ...extra }),
        capMs: 1234,
        isStale: () => true,
      });
      expect(controller.schedule(DRILL_MSG)).toBe('queued');
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
      expect(recycles).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        kind: 'carry-drill-carry-dropped',
        drillId: 'd-77',
        reason: 'carry-stale',
        rearmed: true,
      });
      expect(controller.pendingCount()).toBe(0);
    });

    it('a retry found NOT stale recycles normally — isStale defaults to always-false, preserving every prior test unchanged', async () => {
      const h = makeHarness();
      // makeHarness never passes isStale — asserting the default still recycles
      // guards against a default flip silently breaking every caller above.
      expect(h.controller.schedule(NON_DRILL_MSG)).toBe('queued');
      await h.settle();
      expect(h.recycles).toHaveLength(1);
    });
  });

  // EI-18681914950138372: beginFirstAttempt/endFirstAttempt close the
  // starvation gap that shouldDeferWakeForPendingRespawn's ORIGINAL fix
  // (EI-18679681961154136, `pending`/schedule()) left open — the entire
  // window between a carry-respawn's ACCEPTANCE and its first busy-gate wait
  // TIMING OUT, during which `pending` was still empty and a fresh wake sailed
  // through the guard unfiltered. See makeCarryRearmController's `inFlight` doc
  // comment for the exact mechanics this reproduces at the unit level (the
  // host-level FIFO-mutex race itself is covered by psu-pty-host-turn's
  // integration suite).
  describe('beginFirstAttempt / endFirstAttempt (EI-18681914950138372 — the pre-retry starvation gap)', () => {
    it('pendingCount() is 0 before beginFirstAttempt, >0 immediately after — the exact moment shouldDeferWakeForPendingRespawn must start protecting', () => {
      const h = makeHarness();
      expect(h.controller.pendingCount()).toBe(0);
      expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(false);

      h.controller.beginFirstAttempt(NON_DRILL_MSG);

      expect(h.controller.pendingCount()).toBe(1);
      expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(true);
    });

    it('endFirstAttempt clears it back to 0 (the successful-delivery / dropped-without-retry path — schedule() never runs)', () => {
      const h = makeHarness();
      h.controller.beginFirstAttempt(NON_DRILL_MSG);
      expect(h.controller.pendingCount()).toBe(1);

      h.controller.endFirstAttempt(NON_DRILL_MSG);

      expect(h.controller.pendingCount()).toBe(0);
      expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(false);
    });

    it('pendingCount() never dips to 0 across the begin->schedule->end handoff (the exact sequence the host follows on a busy-gate defer)', () => {
      // Mirrors the real call order at the host's control-socket handler:
      // beginFirstAttempt() at message acceptance, then — only if the first
      // busy-gate wait times out — schedule() for the retry, THEN
      // endFirstAttempt() once runGatedDelivery's outer promise settles.
      const h = makeHarness({ promptResults: [] }); // never resolves — retry stays pending
      h.controller.beginFirstAttempt(NON_DRILL_MSG);
      expect(h.controller.pendingCount()).toBe(1); // in-flight, no retry yet

      expect(h.controller.schedule(NON_DRILL_MSG)).toBe('queued');
      expect(h.controller.pendingCount()).toBe(2); // BOTH sets hold the key momentarily — never < 1

      h.controller.endFirstAttempt(NON_DRILL_MSG);
      expect(h.controller.pendingCount()).toBe(1); // retry's own `pending` entry still covers it
      expect(shouldDeferWakeForPendingRespawn('turn', h.controller.pendingCount())).toBe(true);
    });

    it('endFirstAttempt is idempotent — a second call (e.g. a defensive re-clear) is a harmless no-op', () => {
      const h = makeHarness();
      h.controller.beginFirstAttempt(NON_DRILL_MSG);
      h.controller.endFirstAttempt(NON_DRILL_MSG);
      h.controller.endFirstAttempt(NON_DRILL_MSG);
      expect(h.controller.pendingCount()).toBe(0);
    });

    it('a drill and a non-drill first-attempt track independently, same as the retry-phase `pending` set', () => {
      const h = makeHarness();
      h.controller.beginFirstAttempt(DRILL_MSG);
      h.controller.beginFirstAttempt(NON_DRILL_MSG);
      expect(h.controller.pendingCount()).toBe(2);

      h.controller.endFirstAttempt(DRILL_MSG);
      expect(h.controller.pendingCount()).toBe(1);
      h.controller.endFirstAttempt(NON_DRILL_MSG);
      expect(h.controller.pendingCount()).toBe(0);
    });
  });
});

/**
 * WI-6638 — the SHUTDOWN guard. This is the only thing standing between "close a
 * finished agent's tab" and "close the window the owner is typing in", so it is
 * tested for the REFUSING direction first: both human guards must hold even under
 * `force`, which exists only to waive the mid-turn check.
 *
 * Why the guard lives here rather than in a reaper: measured 2026-08-03,
 * `findIdleLiveSessions()` returns 0 for this entire cohort — every psu session
 * classifies driveMode:'responsive' and is excluded by the
 * queen-fleet-authority-boundary ruling (P-001/D-001) before `terminalWindowAlive`
 * is ever consulted. No system reaper may kill these sessions; only the session
 * itself may exit.
 */
describe('shutdownRefusalReason (WI-6638)', () => {
  const AGENT_LAUNCHED = { launchedBy: 'su-abc123', lastInputAt: 0, agentQuietMs: 60_000 };

  it('accepts a quiet, agent-launched session that no human has ever typed into', () => {
    expect(shutdownRefusalReason(AGENT_LAUNCHED)).toBeNull();
  });

  it('REFUSES a session with no PAPERCUSP_LAUNCHED_BY — a human started it by hand', () => {
    expect(shutdownRefusalReason({ ...AGENT_LAUNCHED, launchedBy: '' })).toBe('not-agent-launched');
    expect(shutdownRefusalReason({ ...AGENT_LAUNCHED, launchedBy: '   ' })).toBe('not-agent-launched');
    // Absent entirely (an older host, or a field that never got written) must read
    // as human-launched — the refusing direction.
    expect(shutdownRefusalReason({ lastInputAt: 0, agentQuietMs: 60_000 })).toBe('not-agent-launched');
    expect(shutdownRefusalReason()).toBe('not-agent-launched');
  });

  it('EI-21560080116530508: accepts a structurally headless fleet member without legacy launch provenance', () => {
    expect(
      shutdownRefusalReason({
        launchedBy: '',
        headless: true,
        fleetSlug: 'nonp2p-bug-drain',
        lastInputAt: 0,
        agentQuietMs: 60_000,
      }),
    ).toBeNull();
  });

  it('EI-21560080116530508: fleet membership alone never weakens an interactive session guard', () => {
    expect(
      shutdownRefusalReason({
        launchedBy: '',
        headless: false,
        fleetSlug: 'nonp2p-bug-drain',
        lastInputAt: 0,
        agentQuietMs: 60_000,
      }),
    ).toBe('not-agent-launched');
    expect(
      shutdownRefusalReason({
        launchedBy: '',
        headless: true,
        fleetSlug: '',
        lastInputAt: 0,
        agentQuietMs: 60_000,
      }),
    ).toBe('not-agent-launched');
  });

  it('REFUSES a session a human has EVER typed into, however long ago', () => {
    expect(shutdownRefusalReason({ ...AGENT_LAUNCHED, lastInputAt: 1 })).toBe('human-attended');
    expect(shutdownRefusalReason({ ...AGENT_LAUNCHED, lastInputAt: Date.now() })).toBe('human-attended');
  });

  it('REFUSES mid-turn (agent still emitting) unless force waives it', () => {
    const busy = { ...AGENT_LAUNCHED, agentQuietMs: 10 };
    expect(shutdownRefusalReason(busy)).toBe('agent-busy');
    expect(shutdownRefusalReason({ ...busy, force: true })).toBeNull();
  });

  it('force NEVER waives either human guard — that is the whole safety property', () => {
    expect(shutdownRefusalReason({ ...AGENT_LAUNCHED, launchedBy: '', force: true })).toBe(
      'not-agent-launched',
    );
    expect(shutdownRefusalReason({ ...AGENT_LAUNCHED, lastInputAt: 5, force: true })).toBe(
      'human-attended',
    );
    // Both wrong at once still refuses (and names the structural one first).
    expect(
      shutdownRefusalReason({ launchedBy: '', lastInputAt: 5, agentQuietMs: 1, force: true }),
    ).toBe('not-agent-launched');
  });

  it('treats a never-seen-output child as quiet, not as permanently busy', () => {
    // makeAgentBusyGate returns now() when it has never observed output, so a fresh
    // host must not be un-shutdownable forever.
    expect(shutdownRefusalReason({ ...AGENT_LAUNCHED, agentQuietMs: Date.now() })).toBeNull();
  });
});

describe('decodeControl mode:shutdown (WI-6638)', () => {
  it('decodes an UNGATED shutdown carrying its reason and force flag', () => {
    const decoded = decodeControl(
      JSON.stringify({ v: 1, mode: 'shutdown', data: 'fleet wound down', force: true }),
    );
    expect(decoded).toMatchObject({
      mode: 'shutdown',
      data: 'fleet wound down',
      force: true,
      // Ungated on purpose: the gates schedule a FUTURE turn, and the premise of a
      // shutdown is that there will not be one.
      gated: false,
    });
  });

  it('defaults force to false — force must be opted into explicitly', () => {
    const decoded = decodeControl(JSON.stringify({ v: 1, mode: 'shutdown', data: '' }));
    expect(decoded).toMatchObject({ mode: 'shutdown', force: false });
    // A truthy-but-not-true value must not enable it either.
    const sneaky = decodeControl(JSON.stringify({ v: 1, mode: 'shutdown', data: '', force: 'yes' }));
    expect(sneaky).toMatchObject({ force: false });
  });
});

describe('resolveTeardownSignal — the signal that ACTUALLY arrived (WI-10001504)', () => {
  // SIGINT/SIGTERM/SIGHUP all land in ONE handler in the host, so hardcoding 'SIGHUP'
  // there discarded the most diagnostic fact about a session death. MEASURED 2026-09-15:
  // two psu sessions (su-9ab60223 @19:55:03.322Z, su-66826cba @20:07:13.129Z) died to an
  // external SIGTERM and BOTH were recorded as SIGHUP, leaving the sender hunt with no
  // durable signal to start from and burning hours across several agents.

  it('preserves the signal that arrived instead of collapsing it to SIGHUP', () => {
    expect(resolveTeardownSignal('SIGTERM')).toBe('SIGTERM');
    expect(resolveTeardownSignal('SIGINT')).toBe('SIGINT');
    expect(resolveTeardownSignal('SIGHUP')).toBe('SIGHUP');
  });

  it('falls back to SIGHUP only when no signal name was supplied', () => {
    // The fallback must stay a LAST resort and must never be null: an unnamed teardown
    // is still a KILL, and null would restore the "clean voluntary exit" misreading.
    expect(resolveTeardownSignal(undefined)).toBe('SIGHUP');
    expect(resolveTeardownSignal(null)).toBe('SIGHUP');
    expect(resolveTeardownSignal('')).toBe('SIGHUP');
    // A number is node-pty's exit shape, not a received-signal name.
    expect(resolveTeardownSignal(15)).toBe('SIGHUP');
  });

  it('CONTROL: the pre-fix hardcoded implementation fails the assertions above', () => {
    // Falsifiability control, kept permanently in-file (a guard that has never failed is
    // a guard that has not been tested). `hardcoded` is verbatim what the host did before
    // WI-10001504. It must NOT satisfy the preserve-the-signal assertion — otherwise that
    // assertion would pass against the very defect it exists to catch.
    const hardcoded = (_receivedSignal: unknown) => 'SIGHUP';
    expect(hardcoded('SIGTERM')).not.toBe(resolveTeardownSignal('SIGTERM'));
    // ...while still AGREEING on the fallback, which proves these tests discriminate the
    // specific discarded-signal defect rather than merely detecting "something changed".
    expect(hardcoded(undefined)).toBe(resolveTeardownSignal(undefined));
  });
});

describe('signalNameFromCode — the evidence a session was KILLED (WI-38054)', () => {
  // node-pty reports a signal death as { exitCode: 0, signal: N }. The 0 is a
  // placeholder, not a status, so this number is the ONLY thing that can stop a killed
  // session being recorded as a clean voluntary exit. MEASURED in this tree:
  //     kill(pid, 'SIGHUP')  ->  {"exitCode":0,"signal":1}

  it('names the real signals rather than storing an unreadable number', () => {
    expect(signalNameFromCode(1)).toBe('SIGHUP');
    expect(signalNameFromCode(9)).toBe('SIGKILL');
    expect(signalNameFromCode(15)).toBe('SIGTERM');
  });

  it('returns null when there was no signal — a clean exit must not acquire one', () => {
    // The fix is worthless if it over-fires: a normal exit tagged with a signal name
    // would make every ordinary session look reaped — the same wrong answer, pointed
    // the other way.
    expect(signalNameFromCode(0)).toBeNull();
    expect(signalNameFromCode(undefined)).toBeNull();
    expect(signalNameFromCode(null)).toBeNull();
    expect(signalNameFromCode(NaN)).toBeNull();
    expect(signalNameFromCode(-1)).toBeNull();
    expect(signalNameFromCode('SIGHUP')).toBeNull(); // already a name, not node-pty's shape
  });

  it('never DISCARDS an unrecognised signal number', () => {
    // Returning null here would silently restore "looks like a clean exit" for any
    // platform signal this Node build cannot name. Keep the evidence, unnamed.
    expect(signalNameFromCode(9999)).toBe('SIG9999');
  });
});

describe('detached session-scope cleanup (EI-20349478936631977)', () => {
  const SCOPE =
    '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/' +
    'app-org.gnome.Terminal.slice/vte-spawn-dead.scope';

  it('reaps a setsid child retained by an inactive/dead VTE scope while preserving the host ancestry', () => {
    // The systemd unit state is intentionally absent: the production defect was
    // ActiveState=inactive/SubState=dead while cgroup.procs still held PID 200.
    // Reading kernel membership rather than `systemctl stop` is the fix.
    const files = new Map<string, string>([
      ['/proc/100/cgroup', '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-dead.scope\n'],
      ['/proc/100/stat', '100 (psu-launcher) S 50 0 0 0'],
      ['/proc/50/stat', '50 (psu-shim) S 1 0 0 0'],
      ['/proc/1/stat', '1 (systemd) S 0 0 0 0'],
      [`${SCOPE}/cgroup.procs`, '50\n100\n200\n'],
    ]);
    const killed: Array<[number, string]> = [];
    const result = reapDetachedPtyScopeResidue({
      selfPid: 100,
      platform: 'linux',
      readText: (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`missing fixture ${path}`);
        return value;
      },
      readDir: () => [],
      kill: (pid: number, signal: string) => {
        killed.push([pid, signal]);
        return true;
      },
    });

    expect(killed).toEqual([[200, 'SIGKILL']]);
    expect(result).toMatchObject({
      scopeDir: SCOPE,
      protectedPids: [1, 50, 100],
      killedPids: [200],
      failedPids: [],
      skippedReason: null,
    });
  });

  it('reaps detached descendants from an enrolled headless pc scope only when managed-scope ownership is explicit', () => {
    const scope =
      '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/papercusp.slice/' +
      'papercusp-agent.slice/papercusp-agent-session.slice/pc-abc123--fleet-member.scope';
    const files = new Map<string, string>([
      ['/proc/100/cgroup', `0::${scope.replace('/sys/fs/cgroup', '')}\n`],
      ['/proc/100/stat', '100 (psu-pty-host) S 50 0 0 0'],
      ['/proc/50/stat', '50 (headless-launcher) S 1 0 0 0'],
      ['/proc/1/stat', '1 (systemd) S 0 0 0 0'],
      [`${scope}/cgroup.procs`, '50\n100\n200\n'],
    ]);
    const killed: number[] = [];
    const readText = (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing fixture ${path}`);
      return value;
    };

    expect(
      reapDetachedPtyScopeResidue({
        selfPid: 100,
        platform: 'linux',
        readText,
        readDir: () => [],
        kill: (pid: number) => killed.push(pid),
      }).skippedReason,
    ).toBe('not-in-dedicated-session-scope');
    expect(killed).toEqual([]);

    const result = reapDetachedPtyScopeResidue({
      selfPid: 100,
      platform: 'linux',
      readText,
      readDir: () => [],
      allowManagedScope: true,
      kill: (pid: number) => killed.push(pid),
    });
    expect(killed).toEqual([200]);
    expect(result).toMatchObject({ scopeDir: scope, protectedPids: [1, 50, 100], killedPids: [200] });
  });

  it('refuses to sweep a shared service cgroup', () => {
    const killed: number[] = [];
    const result = reapDetachedPtyScopeResidue({
      selfPid: 100,
      platform: 'linux',
      readText: (path: string) => {
        if (path === '/proc/100/cgroup') return '0::/user.slice/papercup-dev-api.service\n';
        throw new Error(`unexpected read ${path}`);
      },
      readDir: () => [],
      kill: (pid: number) => killed.push(pid),
    });
    expect(killed).toEqual([]);
    expect(result.skippedReason).toBe('not-in-dedicated-session-scope');
  });

  it('runs only for a genuine end of an agent-launched interactive session', () => {
    expect(
      shouldReapDetachedPtyScopeResidue({
        bridgeTty: true,
        launchedBy: 'su-parent',
        reexecRequested: null,
      }),
    ).toBe(true);
    expect(shouldReapDetachedPtyScopeResidue({ bridgeTty: false, launchedBy: 'su-parent' })).toBe(false);
    expect(shouldReapDetachedPtyScopeResidue({ bridgeTty: false, headless: true, launchedBy: 'su-parent' })).toBe(true);
    expect(shouldReapDetachedPtyScopeResidue({ bridgeTty: true, launchedBy: '' })).toBe(false);
    expect(
      shouldReapDetachedPtyScopeResidue({
        bridgeTty: true,
        launchedBy: 'su-parent',
        reexecRequested: { code: 87 },
      }),
    ).toBe(false);
  });
});

describe('host-code staleness (WI-38292 — a respawn replaces the child, never this host)', () => {
  // Tier-2 falsifiability (repo rule): the subject is a FILE read by path, so every
  // mutation below happens on a COPY outside the checkout. Nothing here writes to the
  // shared tree, so there is no git-sync sweep race and no restore to get wrong.
  const scratch = nodeFs.mkdtempSync(pathJoin(nodeOs.tmpdir(), 'wi38292-'));
  afterAll(() => nodeFs.rmSync(scratch, { recursive: true, force: true }));

  const write = (name: string, body: string) => {
    const p = pathJoin(scratch, name);
    nodeFs.writeFileSync(p, body);
    return p;
  };

  it('captures the version of the host source THIS process loaded', () => {
    // Calibration: the frozen constant must equal a fresh hash of the real file.
    // Without this the controls below could pass while the constant is garbage.
    expect(LOADED_HOST_CODE_VERSION).toMatch(/^[0-9a-f]{64}$/);
    expect(hashHostScript()).toBe(LOADED_HOST_CODE_VERSION);
  });

  it('hashes identical content identically and different content differently', () => {
    const a = write('a.mjs', 'export const x = 1;\n');
    const b = write('b.mjs', 'export const x = 1;\n');
    const c = write('c.mjs', 'export const x = 2;\n');
    expect(hashHostScript(a)).toBe(hashHostScript(b));
    expect(hashHostScript(a)).not.toBe(hashHostScript(c));
  });

  it('reports NOT stale while the on-disk file still matches what was loaded', () => {
    const p = write('same.mjs', 'export const same = true;\n');
    const loaded = hashHostScript(p)!;
    expect(hostCodeStaleness({ loaded, path: p })).toMatchObject({ stale: false, loaded });
  });

  it('DETECTS the reported bug: the file on disk moved on after this host loaded it', () => {
    // The live reproduction — host booted 13:08, fix committed 14:02, host kept
    // executing the pre-fix code. This is the control that must go red if the
    // comparison is ever weakened to always-false.
    const p = write('drift.mjs', 'export const before = true;\n');
    const loaded = hashHostScript(p)!;
    nodeFs.writeFileSync(p, 'export const after = true;\n'); // the deployed fix lands
    const verdict = hostCodeStaleness({ loaded, path: p });
    expect(verdict.stale).toBe(true);
    expect(verdict.loaded).toBe(loaded);
    expect(verdict.onDisk).not.toBe(loaded);
  });

  it('degrades an UNREADABLE file to "not stale" rather than a warning storm', () => {
    // Fail-soft: a transient fs error must not make a working respawn path noisy.
    const verdict = hostCodeStaleness({ loaded: 'a'.repeat(64), path: pathJoin(scratch, 'nope.mjs') });
    expect(verdict).toMatchObject({ stale: false, onDisk: null });
  });

  it('never claims staleness when the loaded version is unknown', () => {
    const p = write('unknown.mjs', 'export const x = 3;\n');
    expect(hostCodeStaleness({ loaded: null, path: p }).stale).toBe(false);
  });
});

describe('host-code ADOPTION handshake (WI-38292 increment 2)', () => {
  // Detection alone leaves the session running old code. Adoption exits so the
  // psu shim's loop re-runs the launcher — which is only safe when something
  // will actually re-run it, so the handshake is the load-bearing part.
  const ADVERTISED = { PAPERCUSP_PSU_REEXEC: '87', PAPERCUSP_PSU_REEXEC_PPID: '4242' };

  it('reads the shim\'s advertised re-exec code when the advertiser is our own parent', () => {
    expect(reexecExitCodeFrom(ADVERTISED, 4242)).toBe(87);
  });

  it('refuses every environment that did NOT advertise the loop — exiting under one of these kills the session', () => {
    // Each of these is a real launch shape: an old shim still on `exec node`, an
    // operator-spawned headless member, a packaged CLI wrapper, `node
    // psu-launcher.mjs` run by hand. None of them would re-run us.
    for (const env of [
      {},
      { ...ADVERTISED, PAPERCUSP_PSU_REEXEC: '' },
      { ...ADVERTISED, PAPERCUSP_PSU_REEXEC: 'yes' },
      { ...ADVERTISED, PAPERCUSP_PSU_REEXEC: '0' },
      { ...ADVERTISED, PAPERCUSP_PSU_REEXEC: '-1' },
      { ...ADVERTISED, PAPERCUSP_PSU_REEXEC: '256' },
      { ...ADVERTISED, PAPERCUSP_PSU_REEXEC: '87.5' },
    ]) {
      expect(reexecExitCodeFrom(env, 4242)).toBeNull();
    }
  });

  it('refuses an INHERITED advertisement — that loop was promised to somebody else', () => {
    // Environment variables reach every descendant, so an agent running `psu`
    // from inside a psu terminal — or anything the CLI child spawns — sees a real
    // shim's promise addressed to a DIFFERENT process. Acting on it exits into
    // nobody: the loop that would re-run us belongs to another process entirely.
    expect(reexecExitCodeFrom(ADVERTISED, 9999)).toBeNull();
    // An advertisement that cannot be ATTRIBUTED is not an advertisement.
    expect(reexecExitCodeFrom({ PAPERCUSP_PSU_REEXEC: '87' }, 4242)).toBeNull();
    expect(reexecExitCodeFrom({ ...ADVERTISED, PAPERCUSP_PSU_REEXEC_PPID: 'bash' }, 4242)).toBeNull();
  });

  it('honours the kill switch even when the shim advertises the loop', () => {
    expect(reexecExitCodeFrom({ ...ADVERTISED, PAPERCUSP_PSU_HOST_ADOPT: '0' }, 4242)).toBeNull();
  });

  it('never re-execs an interactive PTY during carry-respawn', () => {
    const onReexec = () => {};
    expect(shouldAdoptHostCode({ onReexec, reexecCode: 87, bridgeTty: true })).toBe(false);
    expect(shouldAdoptHostCode({ onReexec, reexecCode: 87, bridgeTty: false })).toBe(true);
    expect(shouldAdoptHostCode({ onReexec: null, reexecCode: 87, bridgeTty: false })).toBe(false);
  });

  // P-009 / D-008. Interactive adoption stays OFF by default because the host owns the
  // pty the human is looking at; the opt-in exists for an operator who accepts that.
  it('adopts on an interactive PTY only under the explicit operator opt-in', () => {
    const onReexec = () => {};
    const base = { onReexec, reexecCode: 87, bridgeTty: true };
    // Default is unchanged — the opt-in must be opt-IN, not a behaviour flip.
    expect(shouldAdoptHostCode(base)).toBe(false);
    expect(shouldAdoptHostCode({ ...base, allowInteractive: false })).toBe(false);
    expect(shouldAdoptHostCode({ ...base, allowInteractive: true })).toBe(true);
  });

  it('cannot opt INTO adoption without a re-exec loop (the hard-exit configuration)', () => {
    // The whole hazard warnMissingReexecLoop exists to flag: with no loop, an adoption
    // is a hard exit that destroys the screen. The opt-in must not be able to reach it,
    // or enabling a convenience silently arms a session-killer.
    expect(
      shouldAdoptHostCode({ onReexec: null, reexecCode: 87, bridgeTty: true, allowInteractive: true }),
    ).toBe(false);
    expect(
      shouldAdoptHostCode({ onReexec: () => {}, reexecCode: null, bridgeTty: true, allowInteractive: true }),
    ).toBe(false);
    // ...and the same for a headless host, so the loop requirement is not TTY-specific.
    expect(
      shouldAdoptHostCode({ onReexec: null, reexecCode: 87, bridgeTty: false, allowInteractive: true }),
    ).toBe(false);
  });

  it('reads the interactive opt-in from the environment, defaulting OFF', () => {
    expect(interactiveAdoptionOptIn({})).toBe(false);
    expect(interactiveAdoptionOptIn({ PAPERCUSP_PSU_PTY_ADOPT_INTERACTIVE: '0' })).toBe(false);
    // Only the exact '1' enables it — a stray 'true'/'yes' must not silently arm a
    // re-exec of the owner's live TUI.
    expect(interactiveAdoptionOptIn({ PAPERCUSP_PSU_PTY_ADOPT_INTERACTIVE: 'true' })).toBe(false);
    expect(interactiveAdoptionOptIn({ PAPERCUSP_PSU_PTY_ADOPT_INTERACTIVE: '1' })).toBe(true);
  });

  it('leaves the session-compacted announcement to the successor launcher', () => {
    const src = nodeFs.readFileSync(
      new URL('../scripts/psu-pty-host.mjs', import.meta.url),
      'utf8',
    );
    const adoption = src.indexOf('if (!quotaRecovery && shouldAdoptHostCode');
    const cleanup = src.indexOf('reexecRequested = {', adoption);
    const adoptionBody = src.slice(adoption, cleanup);
    expect(adoption).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(adoption);
    expect(adoptionBody).not.toContain('fireSessionCompactedEvent(');
    expect(adoptionBody).toContain('The launcher successor owns the adoption report');
  });

  it('pins the exit code to the shim generator\'s copy', () => {
    // The two cannot import each other: this file is bare ESM run by `node`, the
    // generator is TypeScript. A drift here means the host exits with a code the
    // shim treats as an ordinary failure — the session would simply end.
    const generator = nodeFs.readFileSync(
      new URL('../../../packages/operator-core/lib/desktop-install/papercusp-files.ts', import.meta.url),
      'utf8',
    );
    const declared = /PSU_REEXEC_EXIT_CODE\s*=\s*(\d+)/.exec(generator);
    expect(declared, 'papercusp-files.ts must declare PSU_REEXEC_EXIT_CODE').toBeTruthy();
    expect(Number(declared![1])).toBe(PSU_REEXEC_EXIT_CODE);
  });
});

describe('host handoff record (WI-38292 increment 2)', () => {
  // The successor is spawned by the shim's bash loop, not by the dying host, so
  // the orders cannot ride the environment — they go through a file, and that
  // file is the only thing standing between a carry and a bare prompt.
  const owner = `wi38292-handoff-${process.pid}`;
  const orders = { mode: 'carry-respawn', args: ['--session-id', 'fresh', '--append-system-prompt-file', '/tmp/carry.md'] };
  afterAll(() => {
    try { nodeFs.unlinkSync(handoffPathFor(owner)); } catch { /* already consumed */ }
  });

  /** Read as the real successor does: the writer has already exited. Stated
   *  explicitly because the record is written by THIS live process, and a
   *  still-alive writer is (correctly) refused. */
  const readAsSuccessor = (id: string, opts: Record<string, unknown> = {}) =>
    readHostHandoff(id, { isAlive: () => false, ...opts });

  it('round-trips the successor\'s marching orders', () => {
    expect(writeHostHandoff(owner, orders)).toBe(handoffPathFor(owner));
    expect(readAsSuccessor(owner)).toMatchObject({ ...orders, ownerId: owner, fromPid: process.pid });
  });

  it('records and resolves the shim parent rendezvous key', () => {
    writeHostHandoff(owner, { ...orders, advSessionId: 42, codexHome: '/tmp/codex-home' });
    expect(readHostHandoffForParentPid(process.ppid, { isAlive: () => false })).toMatchObject({
      ...orders,
      advSessionId: 42,
      codexHome: '/tmp/codex-home',
      ownerId: owner,
      parentPid: process.ppid,
    });
  });

  it('is SINGLE-SHOT — a crashed successor must not have the same carry replayed into every later launch', () => {
    writeHostHandoff(owner, orders);
    expect(readAsSuccessor(owner)).toBeTruthy();
    expect(readAsSuccessor(owner)).toBeNull();
  });

  it('returns null when there is no handoff at all — the ordinary cold launch', () => {
    expect(readAsSuccessor(`${owner}-never-written`)).toBeNull();
  });

  it('refuses (but still consumes) orders from a host that is STILL ALIVE', () => {
    // We are not that host's successor: it is running and owns the session. Acting
    // on its argv would boot a second child against a live discovery key. The
    // default liveness probe is the real one, so this also covers the case that
    // matters most — the writer being this very process.
    writeHostHandoff(owner, orders);
    expect(readHostHandoff(owner)).toBeNull();
    expect(nodeFs.existsSync(handoffPathFor(owner))).toBe(false);
  });

  it('refuses orders that went stale — their rotated session id is no longer accepted', () => {
    writeHostHandoff(owner, orders);
    expect(readAsSuccessor(owner, { now: () => Date.now() + 10 * 60_000 })).toBeNull();
  });

  it('refuses a record naming a different owner, or carrying no argv at all', () => {
    writeHostHandoff(owner, { ...orders, ownerId: 'someone-else' });
    expect(readAsSuccessor(owner)).toBeNull();
    writeHostHandoff(owner, { mode: 'recycle', args: [] });
    expect(readAsSuccessor(owner)).toBeNull();
  });

  it('writes owner-only (0600) — the carry is this session\'s prompt material', () => {
    writeHostHandoff(owner, orders);
    expect(nodeFs.statSync(handoffPathFor(owner)).mode & 0o777).toBe(0o600);
    readAsSuccessor(owner);
  });
});

describe('observeKickoffModelTurnStart (WI-2140591 — a marker proves SUBMISSION, not EXECUTION)', () => {
  /**
   * Drives the helper with a scripted output timeline instead of real timers:
   * `outputs` is the value `lastOutputAt()` returns at each successive poll.
   */
  const runWith = (outputs: number[], opts: Record<string, unknown> = {}) => {
    // outputs[0] is the BASELINE read (before any wait); outputs[N] is what the
    // Nth poll observes. `waits` doubles as the poll counter, so an early return
    // is visible as a short budget rather than only as a `polls` value.
    let poll = -1;
    const waits: number[] = [];
    return {
      waits,
      result: observeKickoffModelTurnStart({
        lastOutputAt: () => outputs[poll + 1] ?? 0,
        wait: async (ms: number) => { waits.push(ms); poll += 1; },
        pollMs: 5_000,
        polls: 6,
        ...opts,
      }),
    };
  };

  it('reports the turn started as soon as new output appears, without burning the budget', async () => {
    // baseline 1000; the second poll sees new bytes.
    const run = runWith([1_000, 1_000, 2_500, 3_000, 4_000, 5_000, 6_000]);
    await expect(run.result).resolves.toMatchObject({
      started: true,
      observed: true,
      polls: 2,
      reason: null,
    });
    // Stopped early: 2 waits, not the full 6.
    expect(run.waits).toHaveLength(2);
  });

  it('reports a stall when the ENTIRE budget elapses with zero new output', async () => {
    // The live failure: the marker persisted, then codex gave up at the sampling
    // layer and the pty never produced another byte.
    const run = runWith([1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000]);
    await expect(run.result).resolves.toMatchObject({
      started: false,
      observed: true,
      polls: 6,
      budgetMs: 30_000,
      reason: 'no-model-output-after-kickoff',
    });
    expect(run.waits).toEqual([5_000, 5_000, 5_000, 5_000, 5_000, 5_000]);
  });

  it('accepts native post-marker activity that completed before the PTY baseline was sampled', async () => {
    const nativeTurnActivity = vi.fn(() => ({ available: true, started: true }));
    const run = runWith([1_000, 1_000], { nativeTurnActivity });
    await expect(run.result).resolves.toMatchObject({
      started: true,
      observed: true,
      polls: 0,
      reason: null,
    });
    expect(nativeTurnActivity).toHaveBeenCalledTimes(1);
    expect(run.waits).toHaveLength(0);
  });

  it('does not treat PTY-only output as turn activity when the native transcript is authoritative', async () => {
    const run = runWith([1_000, 2_500, 3_000], {
      nativeTurnActivity: () => ({ available: true, started: false }),
      pollMs: 5,
      polls: 2,
    });
    await expect(run.result).resolves.toMatchObject({
      started: false,
      observed: true,
      polls: 2,
      reason: 'no-native-turn-activity-after-kickoff',
    });
    expect(run.waits).toHaveLength(2);
  });

  it('does NOT flag a healthy SHORT turn that produced output and then went quiet', async () => {
    // The false positive a "is the output quiet NOW?" predicate would produce:
    // the agent answered immediately and returned to an idle prompt. Keying on
    // new-output-since-baseline is what makes this a pass.
    const run = runWith([1_000, 4_000, 4_000, 4_000, 4_000, 4_000, 4_000]);
    await expect(run.result).resolves.toMatchObject({ started: true, polls: 1 });
  });

  it('fails SAFE when the observation is disabled — never reports a stall it did not observe', async () => {
    for (const disabled of [{ polls: 0 }, { pollMs: 0 }]) {
      const run = runWith([1_000, 1_000], disabled);
      await expect(run.result).resolves.toMatchObject({
        started: true,
        observed: false,
        polls: 0,
        budgetMs: 0,
        reason: 'observation-disabled',
      });
      // Nothing was awaited, so a disabled budget costs no launch latency.
      expect(run.waits).toHaveLength(0);
    }
  });

  it('treats a missing/NaN output clock as no-output rather than crashing the launch path', async () => {
    const result = await observeKickoffModelTurnStart({
      lastOutputAt: () => undefined as unknown as number,
      wait: async () => {},
      pollMs: 1_000,
      polls: 2,
    });
    expect(result).toMatchObject({ started: false, observed: true, polls: 2 });
  });
});

describe('makeCarryRearmController — R-1 deferral→outcome join key (rubric rev 8, su-091ad703 finding 5)', () => {
  // Before this, a re-armed `turn` whose performDelivery returned
  // delivered:false settled with NO terminal row, and no row carried an id —
  // so "N queued, M delivered" could not see one abandoned deferral among
  // hundreds of deliveries. These pin: every production re-arm reaches exactly
  // one terminal row, and that row names every delivery id it settles.
  type Ev = { kind: string; [k: string]: any };
  const TERMINAL = new Set(['wake-rearm-delivered', 'wake-rearm-dropped']);

  function harness({
    promptResults = [{ deferred: false }] as Array<{ deferred: boolean }>,
    deliver = async (): Promise<{ delivered: boolean; reason?: string }> => ({ delivered: true }),
  } = {}) {
    const events: Ev[] = [];
    let promptCalls = 0;
    const controller = makeCarryRearmController({
      acquireInject: async () => () => {},
      waitAtPrompt: async () => {
        const r = promptResults[Math.min(promptCalls, promptResults.length - 1)];
        promptCalls += 1;
        return r;
      },
      recycle: async () => {},
      performDelivery: deliver,
      emitEvent: (kind: string, extra: Record<string, unknown>) => events.push({ kind, ...extra }),
      capMs: 10,
    });
    const drain = async () => {
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
    };
    return { controller, events, drain };
  }

  /** Every queued deliveryId must appear in EXACTLY one terminal row. */
  function unjoined(events: Ev[]): string[] {
    const queued = events.filter((e) => e.kind === 'wake-rearm-queued').map((e) => String(e.deliveryId));
    const settled = events.filter((e) => TERMINAL.has(e.kind)).flatMap((e) => (e.deliveryIds ?? []) as string[]);
    return queued.filter((id) => settled.filter((s) => s === id).length !== 1);
  }

  it('a delivered re-arm emits wake-rearm-delivered naming the delivery id', async () => {
    const h = harness();
    expect(h.controller.schedule({ mode: 'turn', data: 'wake', deliveryId: 'd-1' })).toBe('queued');
    expect(h.events[0]).toMatchObject({ kind: 'wake-rearm-queued', mode: 'turn', deliveryId: 'd-1' });
    await h.drain();
    const terminal = h.events.filter((e) => TERMINAL.has(e.kind));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ kind: 'wake-rearm-delivered', reason: 'delivered', deliveryIds: ['d-1'] });
    expect(unjoined(h.events)).toEqual([]);
  });

  it('an UNDELIVERED re-arm is no longer silent: it emits wake-rearm-dropped with the verifier reason', async () => {
    const h = harness({ deliver: async () => ({ delivered: false, reason: 'exhausted' }) });
    h.controller.schedule({ mode: 'turn', data: 'wake', deliveryId: 'd-2' });
    await h.drain();
    const terminal = h.events.filter((e) => TERMINAL.has(e.kind));
    expect(terminal).toEqual([
      expect.objectContaining({ kind: 'wake-rearm-dropped', reason: 'exhausted', deliveryIds: ['d-2'] }),
    ]);
    expect(unjoined(h.events)).toEqual([]);
  });

  it('a supersede folds the later id into the SAME terminal row, so both join', async () => {
    const h = harness({ promptResults: [{ deferred: true }, { deferred: false }] });
    expect(h.controller.schedule({ mode: 'turn', data: 'a', deliveryId: 'd-a' })).toBe('queued');
    expect(h.controller.schedule({ mode: 'turn', data: 'b', deliveryId: 'd-b' })).toBe('superseded');
    await h.drain();
    const terminal = h.events.filter((e) => TERMINAL.has(e.kind));
    expect(terminal).toHaveLength(1);
    expect([...terminal[0].deliveryIds].sort()).toEqual(['d-a', 'd-b']);
  });

  it('carry-respawn keeps its verbatim kinds — no wake-rearm-delivered row is invented for it', async () => {
    const h = harness();
    h.controller.schedule({ mode: 'carry-respawn', data: 'carry', deliveryId: 'd-c' });
    await h.drain();
    expect(h.events.map((e) => e.kind)).toEqual(['respawn-rearm-queued']);
  });

  it('CONTROL: the join check is not vacuous — a queued id with no terminal row is reported', () => {
    expect(unjoined([{ kind: 'wake-rearm-queued', deliveryId: 'lost' }])).toEqual(['lost']);
  });
});
