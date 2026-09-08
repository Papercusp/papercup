#!/usr/bin/env node
/**
 * Publish a workspace-host publication to the Cupboard artifact store.
 *
 * The store caps a DIRECT server.tgz PUT at 64MB (MAX_BYTES in
 * apps/operator-public/src/routes/workspace-host-artifacts.ts), so a real
 * release bundle (GBs) MUST go through the multipart route. This script is the
 * client for that route; there was none before, and hand-rolling curl for a
 * 64-part upload with per-part digests is how a release gets corrupted quietly.
 *
 * Wire contract (mirrors the route + its test):
 *   POST   .../sha256/<sha>/server.tgz/multipart              {parts:[{partNumber,sha256,sizeBytes}]}
 *          headers: x-artifact-sha256, x-artifact-size        -> 201 {uploadId,...} | 200 {deduped:true}
 *   PUT    .../server.tgz/multipart/parts/<n>?uploadId=<id>   headers: x-part-sha256, x-part-size
 *   POST   .../server.tgz/multipart/complete?uploadId=<id>    {parts:[{partNumber,etag}]}
 *   PUT    .../sha256/<sha>/<file>                            headers: x-artifact-sha256, x-artifact-size
 *   POST   .../sha256/<sha>/finalize
 *
 * Every non-final part must be an identical size >= 5MB and <= 32MB, and the
 * sizes must sum to x-artifact-size, so the plan is computed from the file
 * itself rather than declared by the caller.
 *
 * Usage:
 *   node scripts/publish-workspace-host-artifacts.mjs \
 *     --dir ~/.papercusp/p046-r11-workspace-host-publication \
 *     [--base https://cupboard.papercusp.com] \    # default; see DEFAULT_BASE
 *     [--token <bearer>]        # default: `gh auth token`
 *     [--plan-only]             # hash + plan + preflight, no writes
 *
 * Exit 0 only when the publication is finalized AND the public object is
 * reachable; anything else is a non-zero failure naming the leg that failed.
 */

import { createHash } from 'node:crypto';
import { open, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import {
  appendTaskReleaseReceipt,
  getTask,
  taskReleaseJournalFromDetail,
} from '@papercusp/operator-core/lib/task-manager/store';

const PART_BYTES = 32 * 1024 * 1024;
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 1024;
const DIRECT_MAX = { 'server.tgz.minisig': 64 * 1024, 'manifest.json': 1024 * 1024 };
const SENSITIVE_KEY = /(?:access[_-]?token|api[_-]?key|authorization|credential|password|private[_-]?key|secret|signature|token|upload[-_]?id)/i;
const SENSITIVE_QUERY = /(?:access[_-]?token|api[_-]?key|authorization|credential|password|private[_-]?key|secret|signature|token|upload[-_]?id)/i;
const SENSITIVE_ASSIGNMENT = new RegExp(
  `\\b(${SENSITIVE_QUERY.source})\\b\\s*[:=]\\s*(?:Bearer\\s+)?[^\\s,;}]+`,
  'gi',
);
const SENSITIVE_ERROR_FIELDS = [
  'name',
  'message',
  'code',
  'errno',
  'syscall',
  'hostname',
  'address',
  'port',
  'type',
];
/**
 * The BRANDED Cupboard host, matching WORKSPACE_HOST_ARTIFACT_ORIGIN in
 * libs/generic/deployment-driver/src/workspace-host-build-manifest.ts — the origin the artifacts
 * this script publishes are later FETCHED from, so the two must name the same host.
 *
 * ⚠ Deliberately NOT the Worker's own `*.workers.dev` origin. That form embeds the Cloudflare
 * ACCOUNT SUBDOMAIN (the release owner's GitHub handle); scripts/ ships inside the release bundle,
 * so a literal here is a personal identity string in the product (WI-38233 / WI-38321).
 *
 * ⚠ FROM THE PAPERCUSP DEV BOX this host will hang: that box blackholes TLS to every
 * papercusp-family name by SNI (EI-16742, agent-insights/su-box-sni-tls-blackhole-not-outage). It
 * is a LOCAL network filter, not an outage — pass `--base <the worker's own origin>` for a run
 * from that box rather than changing this default back.
 */
const DEFAULT_BASE = 'https://cupboard.papercusp.com';

function parseArgs(argv, env = process.env) {
  const out = { base: DEFAULT_BASE, planOnly: false, concurrency: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--task-id') out.taskId = argv[++i];
    else if (a === '--operation-id') out.operationId = argv[++i];
    else if (a === '--plan-only') out.planOnly = true;
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.dir) throw new Error('--dir <publication dir> is required');
  if (!Number.isSafeInteger(out.concurrency) || out.concurrency < 1 || out.concurrency > 32) {
    throw new Error('--concurrency must be an integer between 1 and 32');
  }
  out.taskId ??= env.PAPERCUSP_RELEASE_TASK_ID?.trim();
  out.operationId ??= env.PAPERCUSP_RELEASE_OPERATION_ID?.trim();
  out.base = out.base.replace(/\/+$/, '');
  return out;
}

function resolveToken(explicit) {
  if (explicit) return explicit;
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  if (!token) throw new Error('gh auth token returned empty; pass --token');
  return token;
}

function redactText(value) {
  return String(value)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:access[_-]?token|api[_-]?key|authorization|credential|password|private[_-]?key|secret|signature|token|upload[-_]?id)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, (match) => match.replace(/([:=]\s*)(?:Bearer\s+)?[^\s,;}]+$/i, '$1[REDACTED]'));
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return redactText(url.toString());
  } catch {
    return redactText(value);
  }
}

function serializeError(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? redactText(value) : value;
  }
  if (depth >= 4) return '[cause depth limit]';
  if (seen.has(value)) return '[circular cause]';
  seen.add(value);

  const result = {};
  for (const key of SENSITIVE_ERROR_FIELDS) {
    if (!(key in value)) continue;
    const field = value[key];
    if (SENSITIVE_KEY.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof field === 'string') {
      result[key] = redactText(field);
    } else if (
      field === null ||
      typeof field === 'number' ||
      typeof field === 'boolean'
    ) {
      result[key] = field;
    }
  }
  if ('cause' in value && value.cause !== undefined) {
    result.cause = serializeError(value.cause, seen, depth + 1);
  }
  if ('errors' in value && Array.isArray(value.errors)) {
    result.errors = value.errors.map((entry) => serializeError(entry, seen, depth + 1));
  }
  seen.delete(value);
  return Object.keys(result).length > 0 ? result : redactText(Object.prototype.toString.call(value));
}

export function formatRequestError(stage, url, error) {
  return `${stage} request failed URL=${redactUrl(url)} error=${JSON.stringify(serializeError(error))}`;
}

/**
 * ONE streaming pass computes the whole-file digest AND every part digest.
 * Reading the file twice would let a concurrent writer produce a plan that
 * disagrees with the bytes actually uploaded.
 */
async function hashAndPlan(path) {
  const { size } = await stat(path);
  if (size === 0) throw new Error(`${path} is empty`);
  const partCount = Math.ceil(size / PART_BYTES);
  if (partCount > MAX_PARTS) {
    throw new Error(`bundle needs ${partCount} parts, store allows ${MAX_PARTS}`);
  }
  if (partCount > 1 && PART_BYTES < MIN_PART_BYTES) {
    throw new Error('part size below the store minimum');
  }

  const whole = createHash('sha256');
  const parts = [];
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(PART_BYTES);
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const offset = (partNumber - 1) * PART_BYTES;
      const want = Math.min(PART_BYTES, size - offset);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      if (bytesRead !== want) {
        throw new Error(`short read at part ${partNumber}: ${bytesRead} != ${want}`);
      }
      const slice = buf.subarray(0, want);
      whole.update(slice);
      parts.push({
        partNumber,
        sha256: createHash('sha256').update(slice).digest('hex'),
        sizeBytes: want,
      });
    }
  } finally {
    await fh.close();
  }
  return { size, sha256: whole.digest('hex'), parts };
}

async function readPart(path, partNumber) {
  const offset = (partNumber - 1) * PART_BYTES;
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const want = Math.min(PART_BYTES, size - offset);
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(buf, 0, want, offset);
    if (bytesRead !== want) throw new Error(`short read at part ${partNumber}`);
    return buf;
  } finally {
    await fh.close();
  }
}

const SAFE_RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function request(
  url,
  init,
  attempts = 4,
  stage = 'request',
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const method = String(init?.method ?? 'GET').toUpperCase();
  if (attempts > 1 && !SAFE_RETRY_METHODS.has(method)) {
    throw new Error(
      `${stage} refused a blind ${method} retry; journal the intent and reconcile its outcome instead`,
    );
  }
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchImpl(url, init);
      // 4xx is a contract answer, not a transport blip: never retry it, or a
      // digest mismatch is re-sent until it looks like a network problem.
      if (res.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(1000 * attempt);
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(1000 * attempt);
    }
  }
  throw new Error(
    formatRequestError(stage, url, lastError ?? new Error('request failed')),
    { cause: lastError },
  );
}

async function body(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 400) };
  }
}

class ReleaseHttpError extends Error {
  constructor(leg, res, payload) {
    super(`${leg} failed: HTTP ${res.status} ${JSON.stringify(payload)}`);
    this.name = 'ReleaseHttpError';
    this.status = res.status;
    this.payload = payload;
    this.outcomeUnknown =
      res.status >= 500 ||
      (res.status === 409 && /outcome_unknown/.test(String(payload?.error ?? '')));
  }
}

function fail(leg, res, payload) {
  const detail = JSON.stringify(payload);
  throw new ReleaseHttpError(leg, res, payload, detail);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('release stage identity contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') {
    throw new Error('release stage identity contains a non-JSON value');
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => {
      if (entry === undefined) throw new Error(`release stage identity field '${key}' is undefined`);
      return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
    })
    .join(',')}}`;
}

export function releaseStageInputHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Stable UUIDv4-shaped identity accepted by the workspace-host multipart API. */
export function releaseStageRequestIdentity(operationId, stage, inputHash, attempt = 0) {
  const hex = createHash('sha256')
    .update(`${operationId}\u0000${stage}\u0000${inputHash}\u0000${attempt}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  const raw = hex.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

const DEFAULT_RELEASE_LEDGER = {
  getTask,
  appendTaskReleaseReceipt,
  taskReleaseJournalFromDetail,
};

function latestReceipt(receipts, requestIdentity) {
  return [...receipts]
    .reverse()
    .find((receipt) => receipt.requestIdentity === requestIdentity) ?? null;
}

function matchingStageReceipts(journal, stage, inputHash) {
  const forStage = journal.receipts.filter((receipt) => receipt.stage === stage);
  const conflicting = forStage.find((receipt) => receipt.inputHash !== inputHash);
  if (conflicting) {
    throw new Error(
      `release stage ${stage} input changed within operation ${journal.operationId}; ` +
        `receipt ${conflicting.sequence} pins ${conflicting.inputHash}, current input is ${inputHash}`,
    );
  }
  return forStage;
}

async function readReleaseJournal(ledger, taskId, operationId) {
  const task = await ledger.getTask(taskId);
  if (!task) throw new Error(`release task ${taskId} is absent from the task ledger`);
  const journal = ledger.taskReleaseJournalFromDetail(task.detail);
  if (!journal) {
    throw new Error(`release task ${taskId} has no complete task_ledger.detail.release journal`);
  }
  if (journal.operationId !== operationId) {
    throw new Error(
      `release task ${taskId} belongs to operation ${journal.operationId}, not ${operationId}`,
    );
  }
  return { task, journal };
}

async function appendReleaseReceipt(ctx, receipt) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { journal } = await readReleaseJournal(ctx.ledger, ctx.taskId, ctx.operationId);
    const prior = latestReceipt(journal.receipts, receipt.requestIdentity);
    if (prior?.state === receipt.state) return journal;
    const result = await ctx.ledger.appendTaskReleaseReceipt(
      ctx.taskId,
      journal.cursor,
      {
        operationId: ctx.operationId,
        ...receipt,
        credentialGeneration: ctx.credentialGeneration,
        credentialExpiresAt: ctx.credentialExpiresAt,
      },
    );
    if (result.ok) return result.journal;
    if (result.reason === 'cursor_mismatch' || result.reason === 'cas_conflict') continue;
    throw new Error(
      `release journal refused ${receipt.stage}/${receipt.requestIdentity}/${receipt.state}: ${result.reason}`,
    );
  }
  throw new Error(`release journal stayed contended while recording ${receipt.stage}/${receipt.state}`);
}

function assertCredentialFresh(ctx) {
  if (!ctx.credentialExpiresAt) return;
  const expiresAt = Date.parse(ctx.credentialExpiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new Error('PAPERCUSP_RELEASE_CREDENTIAL_EXPIRES_AT must be an ISO timestamp');
  }
  if (expiresAt <= ctx.now().getTime()) {
    throw new Error(
      `release credential generation ${ctx.credentialGeneration ?? '(unreported)'} expired at ${ctx.credentialExpiresAt}`,
    );
  }
}

async function reconcilePending(ctx, args, requestIdentity, priorState) {
  let reconciled;
  try {
    reconciled = await args.reconcile(requestIdentity);
  } catch (error) {
    if (priorState === 'intent') {
      await appendReleaseReceipt(ctx, {
        requestIdentity,
        stage: args.stage,
        state: 'unknown',
        inputHash: args.inputHash,
        evidenceRefs: ['reconcile:unavailable'],
      });
    }
    throw new Error(
      `release stage ${args.stage} outcome remains unknown because reconciliation failed: ${error.message}`,
      { cause: error },
    );
  }
  if (reconciled.state === 'committed') {
    await appendReleaseReceipt(ctx, {
      requestIdentity,
      stage: args.stage,
      state: 'committed',
      inputHash: args.inputHash,
      evidenceRefs: reconciled.evidenceRefs ?? [],
    });
    return reconciled;
  }
  if (reconciled.state === 'absent') {
    await appendReleaseReceipt(ctx, {
      requestIdentity,
      stage: args.stage,
      state: 'refused',
      inputHash: args.inputHash,
      evidenceRefs: ['reconcile:confirmed-absent', ...(reconciled.evidenceRefs ?? [])],
    });
    return reconciled;
  }
  if (priorState === 'intent') {
    await appendReleaseReceipt(ctx, {
      requestIdentity,
      stage: args.stage,
      state: 'unknown',
      inputHash: args.inputHash,
      evidenceRefs: reconciled.evidenceRefs ?? ['reconcile:outcome-unknown'],
    });
  }
  throw new Error(`release stage ${args.stage} provider outcome is still unknown; refusing another mutation`);
}

/**
 * Execute one provider mutation behind the task-ledger receipt chain.
 * A mutation is attempted once. A second attempt is possible only after the
 * adapter proves the prior identity absent; a committed receipt is revalidated
 * against the provider before it is trusted.
 */
export async function runJournaledMutation(ctx, args) {
  assertCredentialFresh(ctx);
  const inputHash = releaseStageInputHash(args.input);
  const stageArgs = { ...args, inputHash };
  let { journal } = await readReleaseJournal(ctx.ledger, ctx.taskId, ctx.operationId);
  let receipts = matchingStageReceipts(journal, args.stage, inputHash);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const identities = [...new Set(receipts.map((receipt) => receipt.requestIdentity))];
    const activeIdentity = identities.at(-1) ?? null;
    const prior = activeIdentity ? latestReceipt(receipts, activeIdentity) : null;

    if (prior?.state === 'committed') {
      const verified = await args.reconcile(activeIdentity);
      if (verified.state !== 'committed') {
        throw new Error(
          `release stage ${args.stage} has a committed receipt but provider verification returned ${verified.state}`,
        );
      }
      await ctx.afterStage?.(args.stage, { resumed: true, requestIdentity: activeIdentity });
      return verified.value;
    }

    if (prior?.state === 'intent' || prior?.state === 'unknown') {
      const reconciled = await reconcilePending(ctx, stageArgs, activeIdentity, prior.state);
      if (reconciled.state === 'committed') {
        await ctx.afterStage?.(args.stage, { resumed: true, requestIdentity: activeIdentity });
        return reconciled.value;
      }
      ({ journal } = await readReleaseJournal(ctx.ledger, ctx.taskId, ctx.operationId));
      receipts = matchingStageReceipts(journal, args.stage, inputHash);
      continue;
    }

    if (prior?.state === 'refused' && !prior.evidenceRefs.includes('reconcile:confirmed-absent')) {
      throw new Error(`release stage ${args.stage} was refused for request ${activeIdentity}; input must change before retry`);
    }

    const requestIdentity = releaseStageRequestIdentity(
      ctx.operationId,
      args.stage,
      inputHash,
      identities.length,
    );
    await appendReleaseReceipt(ctx, {
      requestIdentity,
      stage: args.stage,
      state: 'intent',
      inputHash,
      evidenceRefs: args.intentEvidenceRefs ?? [],
    });

    try {
      assertCredentialFresh(ctx);
      const outcome = await args.mutate(requestIdentity);
      await appendReleaseReceipt(ctx, {
        requestIdentity,
        stage: args.stage,
        state: 'committed',
        inputHash,
        evidenceRefs: outcome.evidenceRefs ?? [],
      });
      await ctx.afterStage?.(args.stage, { resumed: false, requestIdentity });
      return outcome.value;
    } catch (error) {
      if (error instanceof ReleaseHttpError && !error.outcomeUnknown) {
        await appendReleaseReceipt(ctx, {
          requestIdentity,
          stage: args.stage,
          state: 'refused',
          inputHash,
          evidenceRefs: [`http:${error.status}`],
        });
        throw error;
      }
      await appendReleaseReceipt(ctx, {
        requestIdentity,
        stage: args.stage,
        state: 'unknown',
        inputHash,
        evidenceRefs: ['response:outcome-unknown'],
      });
      const reconciled = await reconcilePending(ctx, stageArgs, requestIdentity, 'unknown');
      if (reconciled.state === 'committed') {
        await ctx.afterStage?.(args.stage, { resumed: true, requestIdentity });
        return reconciled.value;
      }
      ({ journal } = await readReleaseJournal(ctx.ledger, ctx.taskId, ctx.operationId));
      receipts = matchingStageReceipts(journal, args.stage, inputHash);
    }
  }
  throw new Error(`release stage ${args.stage} exhausted reconciled attempts`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = resolveToken(args.token);
  const auth = { Authorization: `Bearer ${token}` };
  const bundlePath = join(args.dir, 'server.tgz');

  console.log('=== [1/6] hash bundle + build part plan ===');
  const plan = await hashAndPlan(bundlePath);
  console.log(`  bundle sha256 ${plan.sha256}`);
  console.log(`  bytes ${plan.size}  parts ${plan.parts.length} x ${PART_BYTES}B`);

  // The manifest is the release's own claim about which bytes it describes.
  // Uploading a bundle whose digest disagrees with it would publish a manifest
  // that points at something else, so refuse before any write.
  // Shape per validatePublicationManifest: { schemaVersion, kind, artifact,
  // files:{bundle,signature}, trustReport }. Read the digest from the path the
  // route validates, and treat an ABSENT claim as a hard failure — a check that
  // silently does not run is indistinguishable from one that passed.
  const manifestRaw = await readFile(join(args.dir, 'manifest.json'));
  const manifest = JSON.parse(manifestRaw.toString('utf8'));
  const claimed = manifest?.files?.bundle?.sha256;
  const claimedRelease = manifest?.artifact?.release?.bundleSha256;
  if (typeof claimed !== 'string' || typeof claimedRelease !== 'string') {
    throw new Error(
      'manifest.json has no files.bundle.sha256 / artifact.release.bundleSha256 — ' +
        'cannot verify it describes this bundle; regenerate the publication',
    );
  }
  for (const [label, value] of [['files.bundle', claimed], ['artifact.release', claimedRelease]]) {
    if (value !== plan.sha256) {
      throw new Error(
        `manifest ${label} declares ${value} but server.tgz hashes to ${plan.sha256} — refusing`,
      );
    }
  }
  console.log(`  manifest bundle claim MATCHES (files.bundle + artifact.release)`);

  const root = `${args.base}/admin/artifacts/workspace-host/sha256/${plan.sha256}`;
  const mp = `${root}/server.tgz/multipart`;

  if (args.planOnly) {
    const probe = await request(`${args.base}/admin/reports`, { headers: auth }, 4, 'credential preflight');
    console.log(`  credential preflight: HTTP ${probe.status} (200 expected)`);
    console.log('PLAN_ONLY=1 — no writes performed');
    return;
  }

  console.log('=== [2/6] initiate multipart ===');
  const initRes = await request(mp, {
    method: 'POST',
    headers: {
      ...auth,
      'content-type': 'application/json',
      'x-artifact-sha256': plan.sha256,
      'x-artifact-size': String(plan.size),
    },
    body: JSON.stringify({ parts: plan.parts }),
  }, 4, 'initiate multipart');
  const init = await body(initRes);
  if (!initRes.ok) fail('initiate', initRes, init);

  let uploaded = [];
  if (init.deduped) {
    console.log('  bundle already stored (deduped) — skipping part upload');
  } else {
    const uploadId = init.uploadId;
    console.log(`  uploadId ${uploadId}  partCount ${init.partCount}`);

    console.log('=== [3/6] upload parts ===');
    const results = new Array(plan.parts.length);
    let cursor = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= plan.parts.length) return;
        const part = plan.parts[index];
        const buf = await readPart(bundlePath, part.partNumber);
        const res = await request(
          `${mp}/parts/${part.partNumber}?uploadId=${encodeURIComponent(uploadId)}`,
          {
            method: 'PUT',
            headers: {
              ...auth,
              'content-type': 'application/octet-stream',
              'content-length': String(part.sizeBytes),
              'x-part-sha256': part.sha256,
              'x-part-size': String(part.sizeBytes),
            },
            body: buf,
          },
          4,
          `part ${part.partNumber}`,
        );
        const payload = await body(res);
        if (!res.ok) fail(`part ${part.partNumber}`, res, payload);
        results[index] = { partNumber: part.partNumber, etag: payload.etag };
        done += 1;
        if (done % 8 === 0 || done === plan.parts.length) {
          console.log(`  ${done}/${plan.parts.length} parts uploaded`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(args.concurrency, plan.parts.length) }, worker),
    );
    uploaded = results;

    console.log('=== [4/6] complete multipart ===');
    const compRes = await request(`${mp}/complete?uploadId=${encodeURIComponent(uploadId)}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: uploaded }),
    }, 4, 'complete multipart');
    const comp = await body(compRes);
    if (!compRes.ok) fail('complete', compRes, comp);
    console.log(`  stored sha256 ${comp.sha256 ?? '(unreported)'} bytes ${comp.bytes ?? '?'}`);
  }

  console.log('=== [5/6] upload minisig + manifest, then finalize ===');
  for (const name of ['server.tgz.minisig', 'manifest.json']) {
    const bytes = name === 'manifest.json' ? manifestRaw : await readFile(join(args.dir, name));
    if (bytes.byteLength > DIRECT_MAX[name]) {
      throw new Error(`${name} is ${bytes.byteLength}B, over the ${DIRECT_MAX[name]}B cap`);
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    const res = await request(`${root}/${name}`, {
      method: 'PUT',
      headers: {
        ...auth,
        'content-length': String(bytes.byteLength),
        'x-artifact-sha256': sha,
        'x-artifact-size': String(bytes.byteLength),
      },
      body: bytes,
    }, 4, `upload ${name}`);
    const payload = await body(res);
    if (!res.ok) fail(name, res, payload);
    console.log(`  ${name}: ${payload.deduped ? 'deduped' : 'stored'} ${sha} (${bytes.byteLength}B)`);
  }

  const finRes = await request(`${root}/finalize`, { method: 'POST', headers: auth }, 4, 'finalize');
  const fin = await body(finRes);
  if (!finRes.ok) fail('finalize', finRes, fin);
  console.log(`  finalized manifestSha256 ${fin.manifestSha256}${fin.deduped ? ' (deduped)' : ''}`);

  // Finalize returning ok is the store's claim; a public HEAD is the
  // independent check that the object a consumer would fetch actually exists.
  console.log('=== [6/6] verify the PUBLIC object is reachable ===');
  const pub = `${args.base}/artifacts/workspace-host/sha256/${plan.sha256}/server.tgz`;
  const headRes = await request(pub, { method: 'HEAD' }, 4, 'public HEAD');
  const len = headRes.headers.get('content-length');
  if (!headRes.ok) throw new Error(`public HEAD failed: HTTP ${headRes.status}`);
  if (len !== null && Number(len) !== plan.size) {
    throw new Error(`public object is ${len}B, expected ${plan.size}B`);
  }
  console.log(`  public HEAD ${headRes.status}, content-length ${len ?? '(absent)'}`);

  console.log('');
  console.log(`PUBLISH_VERDICT=PASS`);
  console.log(`BUNDLE_SHA256=${plan.sha256}`);
  console.log(`BUNDLE_BYTES=${plan.size}`);
  console.log(`PUBLIC_URL=${pub}`);
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    console.error('');
    console.error(`PUBLISH_VERDICT=FAIL`);
    console.error(String(error?.stack ?? error));
    process.exit(1);
  });
}
