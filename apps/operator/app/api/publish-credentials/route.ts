import { NextResponse } from 'next/server';
import {
  deletePublishCredentials,
  maskPublishCredentials,
  readPublishCredentials,
} from '@/lib/publish-credentials';

export const dynamic = 'force-dynamic';

export async function GET() {
  const c = await readPublishCredentials();
  return NextResponse.json(maskPublishCredentials(c));
}

export async function DELETE() {
  await deletePublishCredentials();
  return NextResponse.json({ ok: true });
}
