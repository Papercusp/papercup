/**
 * WI-41021 — THE BULK-RESOLVE KILL SWITCH MUST NOT BE INVERTED.
 *
 * The rule this file pins, in one line: **the flag gates ACTING, never STOPPING.**
 *
 * It is a recurrence guard for a specific, well-intentioned mistake. The flag
 * originally gated the whole HTTP handler, above the op parse, and an in-code
 * comment defended that as extra safety: "Gating the whole handler (not just
 * `start`) also keeps the owner ops off, so a run cannot be driven while the
 * feature is disabled." It reads as the cautious choice, and it was exactly
 * backwards:
 *
 *   - Every owner op routes through that handler, so a blanket gate also 404'd
 *     `op:'stop'`. Flipping the kill switch TOOK AWAY the owner's kill button.
 *   - It bought nothing, because the resolver never drives a run through that
 *     route. It uses inbox:bulk-run-*, which had ZERO flag references — so the
 *     agent kept full authority to read its manifest and report terminal
 *     outcomes on the owner's inbox after the feature was turned off.
 *
 * Flag-off was therefore the worst of both worlds: the owner could not stop the
 * run, and the agent could not be stopped. Both halves are pinned below, because
 * either one alone re-inverts the switch.
 *
 * The tool-level tests are BEHAVIOURAL (they call the real handlers with the flag
 * forced off and assert the store was never written). The route-level test is
 * structural — the handler needs a whole server context to invoke — but it
 * asserts on the ORDER of real source constructs, which is the property that
 * actually broke, and it is written to fail on the specific regression rather
 * than on any edit to the file.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLAGS } from '@papercusp/flags';
import { initFlagBackend } from '@papercusp/flags/server';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const getRun = vi.fn();
const getRunItems = vi.fn();
const reportOutcomes = vi.fn();
const settleRunPhase = vi.fn();
const setRunPhase = vi.fn();
const getActiveRun = vi.fn();

vi.mock('../attention/bulk-run-store', () => ({
  getRun: (...a: unknown[]) => getRun(...a),
  getRunItems: (...a: unknown[]) => getRunItems(...a),
  reportOutcomes: (...a: unknown[]) => reportOutcomes(...a),
  settleRunPhase: (...a: unknown[]) => settleRunPhase(...a),
  setRunPhase: (...a: unknown[]) => setRunPhase(...a),
  getActiveRun: (...a: unknown[]) => getActiveRun(...a),
}));

// Identity is resolved before the flag check and is not what is under test here
// — a real resolver always carries one. Stubbing it keeps these cases about the
// kill switch; identity enforcement has its own coverage.
vi.mock('../agent-tools/coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test-resolver', label: 'test resolver' }),
}));

const RUN_ID = 'run-kill-switch-test';

/** Parse the single JSON text block these tools return. */
function body(res: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

async function tools() {
  return await import('../agent-tools/inbox/bulk-run');
}

describe('WI-41021 — the flag gates ACTING, never STOPPING (agent verbs)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initFlagBackend(null);
    getRun.mockResolvedValue({
      runId: RUN_ID,
      phase: 'running',
      totalItems: 1,
      autoResolved: 0,
      recommended: 0,
      skipped: 0,
      failed: 0,
      filterSnapshot: {},
      requestedBy: 'owner',
    });
    // No pending rows: keeps the manifest off the live-actions path, which would
    // pull in the whole attention source stack for no gain here.
    getRunItems.mockResolvedValue([]);
    settleRunPhase.mockResolvedValue({ runId: RUN_ID, phase: 'review' });
  });

  afterEach(() => {
    setFlagOverridesForTest(null);
  });

  it('manifest reports the run as STOPPED when the owner turns the feature off mid-run', async () => {
    setFlagOverridesForTest({ [FLAGS.INBOX_BULK_RESOLVE]: false });
    const { bulkRunManifest } = await tools();

    const res = body(await bulkRunManifest.handler({ runId: RUN_ID }, {} as never));

    // The run row itself is still 'running' — this stop comes from the FLAG.
    // It must reach the resolver through the same `stopped` bit it already
    // obeys, or a flag flip is a signal nothing is listening for.
    expect(res.stopped, 'flag OFF must present the run as stopped').toBe(true);
    expect(res.featureDisabled).toBe(true);

    // Deliberately NOT a refusal: a refused manifest read leaves the resolver
    // blind, and a blind resolver keeps acting on stale item state.
    expect(res.ok).toBe(true);
  });

  it('manifest does NOT report a healthy run as stopped when the feature is on', async () => {
    setFlagOverridesForTest({ [FLAGS.INBOX_BULK_RESOLVE]: true });
    const { bulkRunManifest } = await tools();

    const res = body(await bulkRunManifest.handler({ runId: RUN_ID }, {} as never));

    // The calibration case. Without it, a `stopped` bit that is hardcoded true
    // — or a helper that always fails closed — would pass the test above while
    // making the feature permanently unusable.
    expect(res.stopped).toBe(false);
    expect(res.featureDisabled).toBe(false);
  });

  it('report REFUSES and writes NOTHING when the feature is off', async () => {
    setFlagOverridesForTest({ [FLAGS.INBOX_BULK_RESOLVE]: false });
    const { bulkRunReport } = await tools();

    const res = body(
      await bulkRunReport.handler(
        { runId: RUN_ID, itemId: 'item-1', outcome: 'skipped', error: 'stopping' },
        {} as never,
      ),
    );

    expect(res.ok).toBe(false);
    expect(res.refused).toBe('feature_disabled');
    expect(res.wrote).toBe(0);
    // The whole point: no write reached the store. A refusal that still wrote
    // would be a worse failure than no guard at all, because the run record and
    // the owner's belief about it would silently diverge.
    expect(reportOutcomes).not.toHaveBeenCalled();
  });

  it('report distinguishes a flag flip from an owner Stop', async () => {
    setFlagOverridesForTest({ [FLAGS.INBOX_BULK_RESOLVE]: false });
    const { bulkRunReport } = await tools();

    const res = body(
      await bulkRunReport.handler(
        { runId: RUN_ID, itemId: 'item-1', outcome: 'skipped', error: 'stopping' },
        {} as never,
      ),
    );

    // Both refusals stop the resolver identically, but an operator reading a log
    // has to be able to tell WHICH happened without guessing — they have
    // different causes and different fixes.
    expect(res.refused).not.toBe('run_not_accepting_reports');
    expect(res.flag).toBe(FLAGS.INBOX_BULK_RESOLVE);
  });

  it('settle is NOT gated — a run can always finish cleanly', async () => {
    setFlagOverridesForTest({ [FLAGS.INBOX_BULK_RESOLVE]: false });
    const { bulkRunSettle } = await tools();

    const res = body(await bulkRunSettle.handler({ runId: RUN_ID }, {} as never));

    // Gating settle would strand every in-flight run in `running` forever — the
    // same inversion as gating Stop, one level down. If someone "fixes" the
    // inconsistency by adding a flag check to settle to match its siblings,
    // this fails.
    expect(res.ok).toBe(true);
    expect(settleRunPhase).toHaveBeenCalled();
  });
});

describe('WI-41021 — the owner route never gates its own Stop', () => {
  const src = readFileSync(
    join(REPO_ROOT, 'packages/operator-core/lib/endpoint-route/routes/admin/attention-bulk-resolve.ts'),
    'utf8',
  );
  const handlerStart = src.indexOf('async function handler(');
  const handler = src.slice(handlerStart, src.indexOf('\nconst route = defineTool(', handlerStart));

  it('parses the op BEFORE consulting the flag', () => {
    // This ordering IS the fix. While the gate sat above the op parse it could
    // not distinguish "stop" from "start", so it necessarily gated both.
    const opParse = handler.indexOf("body.op === 'string'");
    const flagGate = handler.indexOf('gateApiRoute(req, FLAGS.INBOX_BULK_RESOLVE)');

    expect(opParse).toBeGreaterThan(-1);
    expect(flagGate).toBeGreaterThan(-1);
    expect(flagGate).toBeGreaterThan(opParse);
  });

  it('exempts the stop ops from the flag gate', () => {
    // Assert on the real construct, not on comment prose: STOP_OPS must exist,
    // must contain 'stop', and the gate must be conditional on it.
    const stopOps = handler.match(/const STOP_OPS = new Set\(\[([^\]]*)\]\)/);
    expect(stopOps, 'STOP_OPS set not found — was the exemption removed?').toBeTruthy();
    expect(stopOps![1]).toContain("'stop'");

    expect(handler).toMatch(/if \(!STOP_OPS\.has\(op\)\) \{[\s\S]*?gateApiRoute\(req, FLAGS\.INBOX_BULK_RESOLVE\)/);
  });

  it('still gates start, and still runs CSRF before everything', () => {
    // The calibration case for the route half: proving Stop is reachable is
    // only meaningful alongside proof that `start` — which LAUNCHES A REAL
    // HEADLESS AGENT — is still gated, and that loosening the gate did not
    // disturb the EI-100 CSRF ordering guard.
    const csrf = handler.indexOf('requireAllowedOriginOr403(req)');
    const flagGate = handler.indexOf('gateApiRoute(req, FLAGS.INBOX_BULK_RESOLVE)');
    const firstMutation = handler.indexOf('createRun({');

    expect(csrf).toBeGreaterThan(-1);
    expect(flagGate).toBeGreaterThan(csrf);
    expect(firstMutation).toBeGreaterThan(flagGate);
  });
});
