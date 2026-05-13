import { NextResponse } from 'next/server';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import {
  deletePublishCredentials,
  maskPublishCredentials,
  readPublishCredentials,
} from '@/lib/publish-credentials';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const blocked = await gateApiRoute(req, FLAGS.CLOUDFLARE_PUBLISH);
  if (blocked) return blocked;
  const c = await readPublishCredentials();
  return NextResponse.json(maskPublishCredentials(c));
}

export async function DELETE(req: Request) {
  const blocked = await gateApiRoute(req, FLAGS.CLOUDFLARE_PUBLISH);
  if (blocked) return blocked;
  await deletePublishCredentials();
  return NextResponse.json({ ok: true });
}
