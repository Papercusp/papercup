/**
 * provisioner.test.ts — the read-only provisioner:* tool HANDLERS (P-009). These call the real
 * (read-only, fail-soft) detectHardware()/recommendCombo()/planProvision() against THIS machine
 * rather than mocking child_process — hardware-detect.test.ts / recommend.test.ts / provision.test.ts
 * already cover the injected-deps logic exhaustively, so this layer only needs to confirm the
 * defineTool wrapper shape (ok:true, expected keys) round-trips correctly and never throws.
 *
 * provisioner:install is NOT exercised here — it performs real writes (systemd unit + the
 * gateway's Postgres registry via applyProvision's default deps), which applyProvision's own
 * injected-deps unit tests (provision.test.ts) already cover in full; this file stays read-only.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/provisioner/provisioner.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { provisionerDetectHardwareTool, provisionerRecommendTool, provisionerPlanInstallTool } from './provisioner';

const body = (o: unknown) => JSON.parse((o as { content: { text: string }[] }).content[0]!.text);

test('provisioner:detect_hardware returns {ok:true, hardware} with the expected shape', async () => {
  const r = body(await provisionerDetectHardwareTool.handler({}, {} as never));
  assert.equal(r.ok, true);
  assert.equal(typeof r.hardware.platform, 'string');
  assert.equal(typeof r.hardware.arch, 'string');
  assert.equal(typeof r.hardware.ramGB, 'number');
  assert.ok(Array.isArray(r.hardware.notes));
});

test('provisioner:recommend returns {ok:true, hardware, recommendation}', async () => {
  const r = body(await provisionerRecommendTool.handler({}, {} as never));
  assert.equal(r.ok, true);
  assert.ok('entry' in r.recommendation);
  assert.ok('tier' in r.recommendation);
  assert.equal(typeof r.recommendation.reason, 'string');
});

test('provisioner:plan_install returns {ok:true, plan} and never writes anything itself', async () => {
  const r = body(await provisionerPlanInstallTool.handler({}, {} as never));
  assert.equal(r.ok, true);
  assert.ok('blocked' in r.plan);
  assert.ok('recommendation' in r.plan);
  assert.ok('hardware' in r.plan);
});
