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

const PART_BYTES = 32 * 1024 * 1024;
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 1024;
const DIRECT_MAX = { 'server.tgz.minisig': 64 * 1024, 'manifest.json': 1024 * 1024 };
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

function parseArgs(argv) {
  const out = { base: DEFAULT_BASE, planOnly: false, concurrency: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--plan-only') out.planOnly = true;
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.dir) throw new Error('--dir <publication dir> is required');
  out.base = out.base.replace(/\/+$/, '');
  return out;
}

function resolveToken(explicit) {
  if (explicit) return explicit;
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  if (!token) throw new Error('gh auth token returned empty; pass --token');
  return token;
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

async function request(url, init, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, init);
      // 4xx is a contract answer, not a transport blip: never retry it, or a
      // digest mismatch is re-sent until it looks like a network problem.
      if (res.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError ?? new Error('request failed');
}

async function body(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 400) };
  }
}

function fail(leg, res, payload) {
  const detail = JSON.stringify(payload);
  throw new Error(`${leg} failed: HTTP ${res.status} ${detail}`);
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
    const probe = await request(`${args.base}/admin/reports`, { headers: auth });
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
  });
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
    });
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
    });
    const payload = await body(res);
    if (!res.ok) fail(name, res, payload);
    console.log(`  ${name}: ${payload.deduped ? 'deduped' : 'stored'} ${sha} (${bytes.byteLength}B)`);
  }

  const finRes = await request(`${root}/finalize`, { method: 'POST', headers: auth });
  const fin = await body(finRes);
  if (!finRes.ok) fail('finalize', finRes, fin);
  console.log(`  finalized manifestSha256 ${fin.manifestSha256}${fin.deduped ? ' (deduped)' : ''}`);

  // Finalize returning ok is the store's claim; a public HEAD is the
  // independent check that the object a consumer would fetch actually exists.
  console.log('=== [6/6] verify the PUBLIC object is reachable ===');
  const pub = `${args.base}/artifacts/workspace-host/sha256/${plan.sha256}/server.tgz`;
  const headRes = await request(pub, { method: 'HEAD' });
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

main().catch((error) => {
  console.error('');
  console.error(`PUBLISH_VERDICT=FAIL`);
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
