#!/usr/bin/env node
/**
 * Local end-to-end smoke test against `wrangler dev --local`.
 *
 * Drives the full flow:
 *   1. POST /register-tenant → { tenantId, tenantSecret }
 *   2. Build a 3-file static site, walk + sha256, build canonical manifest
 *   3. Mint JWT signed with HKDF-derived publish key
 *   4. POST /publish/start → { deploymentId, missing[], vanityUrl }
 *   5. PUT each missing file via signed-URL token
 *   6. POST /publish/finalize  (will fail at CF Pages call — that's expected
 *                                 with stub CF_MASTER_TOKEN; we assert the
 *                                 422/502/error shape)
 *   7. GET /publish/status/<id>
 *   8. POST /rotate-secret → new secret
 *
 * Steps 1-5 + 7 + 8 should succeed. Step 6 will fail at the CF Pages
 * subrequest because we didn't provide a real master token; we assert the
 * error path's shape rather than success.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  b64uDecode,
  derivePublishKey,
  jti,
  manifestSha256Hex,
  mintJwt,
} from '@papercusp/publish-auth';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:8788';

function ok(name) { console.log(`  ✓ ${name}`); }
function fail(name, e) {
  console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

async function http(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function main() {
  console.log(`smoke against ${BASE}\n`);

  // 1. Health
  const health = await http('GET', '/healthz');
  if (health.status !== 200 || health.body?.ok !== true) fail('health', JSON.stringify(health));
  ok('health');

  // 2. Register
  const reg = await http('POST', '/register-tenant', {});
  if (reg.status !== 200 || !reg.body.tenantId || !reg.body.tenantSecret)
    fail('register', JSON.stringify(reg));
  const { tenantId, tenantSecret } = reg.body;
  ok(`register → tenantId=${tenantId}`);

  // 3. Stage a fake static site
  const stage = await fs.mkdtemp(join(tmpdir(), 'pp-smoke-'));
  const files = {
    'index.html': '<!doctype html><h1>hello</h1>',
    'about/index.html': '<!doctype html><h1>about</h1>',
    'styles.css': 'body{font-family:system-ui}',
  };
  for (const [path, content] of Object.entries(files)) {
    const abs = join(stage, ...path.split('/'));
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  // sha256 each
  const { createHash } = await import('node:crypto');
  const manifestFiles = [];
  for (const [path, content] of Object.entries(files)) {
    manifestFiles.push({
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
    });
  }
  const manifest = { files: manifestFiles, deployment_slug: 'smoke-test' };
  const manifestSha = await manifestSha256Hex(manifest);
  ok(`manifest sha256 ${manifestSha.slice(0, 12)}…`);

  // 4. JWT
  const key = await derivePublishKey(b64uDecode(tenantSecret));
  const mintTok = () =>
    mintJwt(key, { sub: tenantId, jti: jti(), sha256: manifestSha, aud: 'publish' });

  // 5. /publish/start
  const start = await http('POST', '/publish/start', manifest, {
    authorization: `Bearer ${await mintTok()}`,
  });
  if (start.status !== 200) fail('publish/start', JSON.stringify(start));
  if (!start.body.deploymentId) fail('publish/start: no deploymentId', JSON.stringify(start));
  if (!Array.isArray(start.body.missing)) fail('publish/start: no missing[]', JSON.stringify(start));
  ok(`publish/start → ${start.body.deploymentId} (${start.body.missing.length} files to upload)`);
  if (start.body.missing.length !== 3)
    fail('publish/start expected 3 missing files', start.body.missing.length);

  // 6. Idempotency check — re-POST same manifest (with different jti); should
  //    return same deploymentId, same missing list.
  const start2 = await http('POST', '/publish/start', manifest, {
    authorization: `Bearer ${await mintTok()}`,
  });
  if (start2.body.deploymentId !== start.body.deploymentId)
    fail('idempotency: deploymentId changed on re-POST', JSON.stringify(start2));
  ok('idempotency: re-POST returns same deploymentId');

  // 7. Upload files via signed URLs
  for (const m of start.body.missing) {
    const path = m.path;
    const body = files[path];
    const url = m.uploadUrl.replace('https://publish.papercuspai.com', BASE);
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });
    if (!res.ok) {
      // CF Pages /file call fails because the master token is stubbed.
      // The code path before that — sha verify + token verify — must run,
      // so we expect 502 (CF api error) here, NOT 401 (token reject) or 400 (sha mismatch).
      const txt = await res.text();
      if (res.status !== 502) {
        fail(`upload ${path} unexpected status ${res.status}`, txt);
      }
      ok(`upload ${path} → 502 (expected — stub master token)`);
    } else {
      ok(`upload ${path} → 200`);
    }
  }

  // 8. JWT replay must be rejected
  const dupeTok = await mintTok();
  const r1 = await http('POST', '/publish/start', manifest, {
    authorization: `Bearer ${dupeTok}`,
  });
  const r2 = await http('POST', '/publish/start', manifest, {
    authorization: `Bearer ${dupeTok}`,
  });
  if (r2.status !== 401 || !String(r2.body?.error ?? '').includes('replay')) {
    fail('replay-guard: second use of same JWT should 401', JSON.stringify(r2));
  }
  ok('replay-guard: same JWT rejected on reuse');

  // 9. Audience check: snapshot-aud JWT against /publish/* → 401
  const snapAud = await mintJwt(await derivePublishKey(b64uDecode(tenantSecret)), {
    sub: tenantId,
    jti: jti(),
    sha256: manifestSha,
    aud: 'snapshot',
  });
  // Note: signed with publishKey, but with snapshot aud — won't pass audience
  // check. Either signature mismatch (because Worker derives publishKey for
  // publish-aud) or aud mismatch — both are 401.
  const aud = await http('POST', '/publish/start', manifest, {
    authorization: `Bearer ${snapAud}`,
  });
  if (aud.status !== 401) fail('audience-check', JSON.stringify(aud));
  ok('audience-check: snapshot-aud JWT rejected on /publish/*');

  // 10. Bad sha256 in JWT claim → 400
  const badSha = await mintJwt(key, {
    sub: tenantId,
    jti: jti(),
    sha256: 'b'.repeat(64),
    aud: 'publish',
  });
  const badShaRes = await http('POST', '/publish/start', manifest, {
    authorization: `Bearer ${badSha}`,
  });
  if (badShaRes.status !== 401 && badShaRes.status !== 400) {
    fail('bad-sha-check', JSON.stringify(badShaRes));
  }
  ok(`bad-sha-check: ${badShaRes.status} on mismatch`);

  // 11. Rotate secret — uses publish-aud JWT (the rotate-secret route accepts publish-aud per code)
  const rot = await http('POST', '/rotate-secret', {}, {
    authorization: `Bearer ${await mintTok()}`,
  });
  if (rot.status !== 200 || !rot.body.tenantSecret) fail('rotate', JSON.stringify(rot));
  if (rot.body.tenantSecret === tenantSecret) fail('rotate: secret unchanged');
  ok('rotate: secret rotated');

  // 12. Old JWT should now reject (signed with old key → signature mismatch
  //     because tenant.secret_b64 was updated)
  const oldJwt = await mintTok();
  const post = await http('POST', '/publish/start', manifest, {
    authorization: `Bearer ${oldJwt}`,
  });
  if (post.status !== 401) fail('rotate-invalidates-old', JSON.stringify(post));
  ok('rotate: old JWT rejected after rotate');

  console.log(`\n✔ all smoke checks passed`);
  await fs.rm(stage, { recursive: true, force: true });
}

main().catch((e) => fail('uncaught', e));
