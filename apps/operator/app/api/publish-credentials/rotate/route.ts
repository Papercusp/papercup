import { NextResponse } from 'next/server';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import {
  maskPublishCredentials,
  readPublishCredentials,
  writePublishCredentials,
} from '@/lib/publish-credentials';
import {
  b64uDecode,
  derivePublishKey,
  jti,
  manifestSha256Hex,
  mintJwt,
} from '@papercusp/publish-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = await gateApiRoute(req, FLAGS.CLOUDFLARE_PUBLISH);
  if (blocked) return blocked;
  const c = await readPublishCredentials();
  if (!c) return NextResponse.json({ error: 'not registered' }, { status: 404 });

  const sha = await manifestSha256Hex({ files: [], deployment_slug: '__rotate__' });
  const key = await derivePublishKey(b64uDecode(c.tenantSecret));
  const token = await mintJwt(key, {
    sub: c.tenantId,
    jti: jti(),
    sha256: sha,
    aud: 'publish',
  });

  const r = await fetch(`https://${c.publishHost}/rotate-secret`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!r.ok) {
    return NextResponse.json(
      { error: `rotate failed: ${r.status} ${await r.text()}` },
      { status: 502 },
    );
  }
  const body = (await r.json()) as { tenantSecret: string };
  const fresh = { ...c, tenantSecret: body.tenantSecret, registeredAt: Date.now() };
  await writePublishCredentials(fresh);
  return NextResponse.json(maskPublishCredentials(fresh));
}
