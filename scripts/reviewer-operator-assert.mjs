#!/usr/bin/env node
// WI-10007029: request/response controls for the existing isolated Tauri verifier.
// Responses may contain credentials. Log labels/statuses only; keep the QR private.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';

export function reviewerContext(env) {
  const workspaceId = env.PAPERCUSP_WORKSPACE_ID;
  if (env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1' ||
      !/^verify-tauri-isolated-\d+$/.test(workspaceId ?? '') ||
      env.PAPERCUSP_WORKSPACE !== workspaceId) {
    throw new Error('Reviewer controls require the verified disposable workspace');
  }
  const port = Number(env.VERIFY_TAURI_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Reviewer controls require the isolated operator port');
  }
  const publicUrl = new URL(env.MOBILE_DESKTOP_PUBLIC_URL);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password ||
      publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') {
    throw new Error('Reviewer controls require a credential-free HTTPS origin');
  }
  return { workspaceId, local: `http://127.0.0.1:${port}`, publicOrigin: publicUrl.origin,
    mintBody: JSON.stringify({ workspaceId }) };
}

export async function runPairingControls({ env, fetchImpl = fetch, log = console.log, now = Date.now() }) {
  const ctx = reviewerContext(env);
  const request = async (label, origin, path, expected, body) => {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body } : {}),
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`${label}: transport failed`);
    }
    log(`REVIEWER: ${label} status=${response.status} expected=${expected}`);
    if (response.status !== expected) throw new Error(`${label}: unexpected HTTP status`);
    return response;
  };
  await request('local health', ctx.local, '/api/health', 200);
  // A schema-valid local mint proves that the exact payload reaches the handler
  // and names a real isolated workspace BEFORE remote refusal is measured.
  const mint = await request('local mint preflight', ctx.local,
    '/api/device/desktop/mint-pair-token', 200, ctx.mintBody);
  let payload;
  try { payload = await mint.json(); } catch { throw new Error('Local mint returned invalid JSON'); }
  if (payload?.qrPayload?.workspaceId !== ctx.workspaceId ||
      payload?.qrPayload?.server !== ctx.publicOrigin ||
      typeof payload?.qrPayload?.pairToken !== 'string' || !payload.qrPayload.pairToken ||
      !Number.isFinite(Date.parse(payload?.expiresAt)) || Date.parse(payload.expiresAt) <= now) {
    throw new Error('Local mint returned an invalid isolated pairing payload');
  }
  await request('local admin preflight', ctx.local, '/api/admin/tasks/inventory', 200);
  await request('tunnel health', ctx.publicOrigin, '/api/health', 200);
  await request('tunnel device without token', ctx.publicOrigin, '/api/device/operator/cards', 401);
  await request('tunnel mint refusal', ctx.publicOrigin,
    '/api/device/desktop/mint-pair-token', 403, ctx.mintBody);
  await request('tunnel admin refusal', ctx.publicOrigin, '/api/admin/tasks/inventory', 403);
  return payload;
}

export async function seedReviewer({ env, invoke }) {
  reviewerContext(env); // Refuse ALL writes before constructing a tool call.
  const content = 'Sanitized demonstration content. No customer data or cloud-availability claim.';
  const calls = [
    ['plans:new', { harness: 'papercusp', workspaceId: env.PAPERCUSP_WORKSPACE_ID,
      slug: 'reviewer-demo', title: 'Plan a small product update',
      status: 'draft', content: `## Now\n${content}\n\n## Background\nReview the draft, implement the update, and verify the result.` }],
    ['work_items:create', { harness: 'papercusp', kind: 'change', state: 'open',
      title: 'Review the next product update', body: content }],
    ['fleet:create', { name: 'Product update team', description: content }],
    ['conversation:append', { role: 'user', source: 'text_typed', text: 'What is ready for my review?' }],
    ['conversation:append', { role: 'assistant', source: 'text_typed',
      text: 'The product update draft is ready. You can review the plan and the work item in your Inbox.' }],
  ];
  for (const [name, args] of calls) await invoke(name, args);
}

export async function verifyReviewerReadback({ env, fetchImpl = fetch, log = console.log }) {
  const ctx = reviewerContext(env);
  const request = async (label, origin, path, options = {}) => {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new Error(`${label}: transport failed`); }
    log(`REVIEWER: ${label} status=${response.status} expected=200`);
    if (response.status !== 200) throw new Error(`${label}: unexpected HTTP status`);
    try { return await response.json(); }
    catch { throw new Error(`${label}: invalid JSON`); }
  };
  const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  // Use a DIFFERENT one-use token so readback does not consume the native QR.
  const minted = await request('readback mint', ctx.local,
    '/api/device/desktop/mint-pair-token', post({ workspaceId: ctx.workspaceId }));
  if (minted?.qrPayload?.workspaceId !== ctx.workspaceId ||
      minted?.qrPayload?.server !== ctx.publicOrigin ||
      typeof minted?.qrPayload?.pairToken !== 'string' || !minted.qrPayload.pairToken) {
    throw new Error('Readback mint returned an invalid isolated pairing payload');
  }
  const paired = await request('readback pair', ctx.publicOrigin, '/api/device/pair',
    post({ pairToken: minted.qrPayload.pairToken }));
  if (paired?.workspaceId !== ctx.workspaceId ||
      typeof paired?.deviceToken !== 'string' || !paired.deviceToken) {
    throw new Error('Readback pairing returned an invalid isolated device');
  }
  const auth = { headers: { authorization: `Bearer ${paired.deviceToken}` } };
  const plans = await request('seeded plans readback', ctx.publicOrigin, '/api/device/plans', auth);
  if (!plans?.plans?.some(p => p.slug === 'reviewer-demo' && p.title === 'Plan a small product update')) {
    throw new Error('Seeded plan is absent from the paired device feed');
  }
  const inbox = await request('seeded Inbox readback', ctx.publicOrigin, '/api/device/attention', auth);
  if (!inbox?.workItems?.some(w => w.kind === 'change' && w.state === 'open' &&
      w.title === 'Review the next product update')) {
    throw new Error('Seeded work item is absent from the paired Inbox feed');
  }
  const chat = await request('seeded chat readback', ctx.publicOrigin,
    '/api/device/operator/conversation', auth);
  if (!chat?.turns?.some(t => t.role === 'user' && t.text === 'What is ready for my review?') ||
      !chat?.turns?.some(t => t.role === 'assistant' && t.text ===
        'The product update draft is ready. You can review the plan and the work item in your Inbox.')) {
    throw new Error('Seeded conversation is absent from the paired chat feed');
  }
  log('REVIEWER: sanitized Plans, Inbox and chat readback passed');
}

function invokeIsolated(env, name, args) {
  const ctx = reviewerContext(env);
  if (!env.PAPERCUSP_HOME) throw new Error('Isolated tool call requires its private home');
  const tokenFile = resolve(env.PAPERCUSP_HOME, 'superuser-token');
  // Explicit endpoint/token/workspace prevent the CLI's shared-host recovery
  // and ambient proxy configuration from sending a seed to a live workspace.
  const child = spawnSync('ptool', [`--url=${ctx.local}`, `--token-file=${tokenFile}`,
    `--workspace=${ctx.workspaceId}`, name, '--json', '-'], {
    input: JSON.stringify({ ...args, payloadTier: 'full' }), encoding: 'utf8',
    timeout: 60_000, maxBuffer: 2_000_000,
    env: { ...env, PAPERCUSP_MCP_TOKEN_FILE: tokenFile, PAPERCUSP_OPERATOR_BASE: ctx.local,
      PAPERCUSP_OPERATOR_URL: ctx.local, PAPERCUSP_MCP_PROXY_BASE: '' },
  });
  if (child.error || child.status !== 0) throw new Error(`Isolated seed tool failed: ${name}`);
  let result;
  try { result = JSON.parse(child.stdout); } catch { throw new Error(`Invalid seed receipt: ${name}`); }
  if (result?.ok === false || result?.isError || result?.data?.ok === false) {
    throw new Error(`Isolated seed tool refused: ${name}`);
  }
  console.log(`REVIEWER: sanitized seed accepted tool=${name}`);
}

const MOBILE_REPO = 'Papercusp/papercup-rust-mobile';
function ghChecked(args, input) {
  const child = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 2_000_000,
    timeout: args[0] === 'run' && args[1] === 'watch' ? 65 * 60_000 : 60_000 });
  if (child.error || child.status !== 0) throw new Error(`Native capture command failed: ${args[0]} ${args[1]}`);
  return child.stdout;
}

export function nativeCapturePreflight(env, run = ghChecked) {
  if (!env.REVIEWER_MOBILE_REF || !/^[a-f0-9]{40}$/.test(env.REVIEWER_MOBILE_SHA ?? '')) {
    throw new Error('Native capture requires an explicit mobile ref and exact candidate SHA');
  }
  const secrets = JSON.parse(run(['secret', 'list', '-R', MOBILE_REPO, '--json', 'name']));
  if (secrets.some(s => s.name === 'PAPERCUP_PAIR_PAYLOAD')) {
    throw new Error('Existing pairing secret belongs to another attempt; refusing to overwrite it');
  }
  const sha = run(['api', `repos/${MOBILE_REPO}/commits/${encodeURIComponent(env.REVIEWER_MOBILE_REF)}`,
    '--jq', '.sha']).trim();
  if (sha !== env.REVIEWER_MOBILE_SHA) throw new Error('Native capture ref does not match the exact candidate SHA');
  return sha;
}

export function validatePairedSummary(summary) {
  if (summary?.passedTests !== 1 || summary?.failedTests !== 0 || summary?.skippedTests !== 0) {
    throw new Error('Paired native evidence requires one pass, zero failures and zero skips');
  }
}

function readPairedSummary(root) {
  const found = [];
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === 'ci-paired-ui-summary.json') found.push(path);
    }
  };
  visit(root);
  if (found.length !== 1) throw new Error('Native artifact must contain exactly one paired UI summary');
  return JSON.parse(readFileSync(found[0], 'utf8'));
}

export async function captureNative({ env, payload, run = ghChecked, readSummary = readPairedSummary,
  now = () => Date.now(), delay = ms => new Promise(ok => setTimeout(ok, ms)) }) {
  const ctx = reviewerContext(env);
  if (payload?.qrPayload?.workspaceId !== ctx.workspaceId) throw new Error('Capture payload is outside the isolated workspace');
  const sha = nativeCapturePreflight(env, run);
  const output = env.REVIEWER_OUTPUT_DIR;
  if (!output) throw new Error('Native capture requires its private evidence directory');
  const requestedAt = now();
  let installed = false, runId = null, completed = false;
  try {
    // The token travels on stdin, never argv, terminal text or a tracked file.
    run(['secret', 'set', 'PAPERCUP_PAIR_PAYLOAD', '-R', MOBILE_REPO], JSON.stringify(payload.qrPayload));
    installed = true;
    run(['workflow', 'run', 'ci.yml', '-R', MOBILE_REPO, '--ref', env.REVIEWER_MOBILE_REF, '-f', 'paired_ui=true']);
    const deadline = requestedAt + 120_000;
    while (!runId && now() < deadline) {
      const runs = JSON.parse(run(['run', 'list', '-R', MOBILE_REPO, '--workflow', 'ci.yml',
        '--event', 'workflow_dispatch', '--limit', '20', '--json', 'databaseId,createdAt,headSha']));
      const matching = runs.filter(r => r.headSha === sha && Date.parse(r.createdAt) >= Math.floor(requestedAt / 1000) * 1000);
      if (matching.length > 1) throw new Error('Ambiguous native dispatch: multiple matching runs');
      if (matching.length === 1) runId = matching[0].databaseId;
      else await delay(5000);
    }
    if (!runId) throw new Error('Native workflow did not produce a traceable run');
    console.log(`REVIEWER: native capture run=${runId} candidate=${sha}`);
    run(['run', 'watch', String(runId), '-R', MOBILE_REPO, '--exit-status', '--interval', '30']);
    const artifactRoot = resolve(output, 'native');
    run(['run', 'download', String(runId), '-R', MOBILE_REPO,
      '-n', `iphone-native-candidate-${sha}`, '-D', artifactRoot]);
    validatePairedSummary(readSummary(artifactRoot));
    writeFileSync(resolve(output, 'native-capture-receipt.json'), JSON.stringify({ runId, candidateSha: sha,
      artifact: `iphone-native-candidate-${sha}`, pairedPassed: 1, pairedFailed: 0, pairedSkipped: 0 }), { mode: 0o600 });
    completed = true;
  } finally {
    // Cancel only the exact run we observed if its artifact was not accepted.
    // Deletion follows even if cancellation itself fails.
    try { if (runId && !completed) run(['run', 'cancel', String(runId), '-R', MOBILE_REPO]); }
    finally { if (installed) run(['secret', 'delete', 'PAPERCUP_PAIR_PAYLOAD', '-R', MOBILE_REPO]); }
  }
}

async function main() {
  const ctx = reviewerContext(process.env);
  const relayPort = Number(process.env.PROTO_RELAY_PORT);
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    throw new Error('Reviewer controls require the reserved relay port');
  }
  const relay = spawn('socat', [`TCP-LISTEN:${relayPort},bind=127.0.0.1,fork,reuseaddr`,
    `TCP:127.0.0.1:${new URL(ctx.local).port}`], { stdio: 'ignore' });
  let spawnFailed = false;
  relay.on('error', () => { spawnFailed = true; });
  const stop = () => relay.kill('SIGTERM');
  process.once('SIGTERM', () => { stop(); process.exit(143); });
  process.once('SIGINT', () => { stop(); process.exit(130); });
  try {
    const deadline = Date.now() + 5000;
    let listening = false;
    while (!listening && Date.now() < deadline && !spawnFailed && relay.exitCode === null) {
      listening = await new Promise(ok => {
        const socket = createConnection({ host: '127.0.0.1', port: relayPort });
        socket.once('connect', () => { socket.destroy(); ok(true); });
        socket.once('error', () => { socket.destroy(); ok(false); });
      });
      if (!listening) await new Promise(ok => setTimeout(ok, 100));
    }
    if (!listening) throw new Error('Reviewer relay did not become ready');
    if (process.env.REVIEWER_SEED_CONTENT === '1') {
      await seedReviewer({ env: process.env, invoke: (name, args) => invokeIsolated(process.env, name, args) });
    }
    const payload = await runPairingControls({ env: process.env });
    if (process.env.REVIEWER_SEED_CONTENT === '1') {
      await verifyReviewerReadback({ env: process.env });
    }
    if (!process.env.REVIEWER_PAIR_PAYLOAD_PATH) throw new Error('Private output path is required');
    writeFileSync(process.env.REVIEWER_PAIR_PAYLOAD_PATH, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
    console.log('REVIEWER: pairing controls passed; private payload saved');
    if (process.env.REVIEWER_CAPTURE_NATIVE === '1') {
      await captureNative({ env: process.env, payload });
      console.log('REVIEWER: native paired capture accepted');
    }
  } finally { stop(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => process.argv.includes('--native-preflight')
    ? nativeCapturePreflight(process.env) : main())
    .catch(error => { console.error(`REVIEWER_FAILED: ${error.message}`); process.exitCode = 1; });
}
