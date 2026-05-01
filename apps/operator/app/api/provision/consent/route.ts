/**
 * Trust + consent endpoints.
 *
 * POST /api/provision/consent
 *   body: { publisher, plugin, scriptHash, publisherKeyFingerprint, dev? }
 *   Records user consent for a (publisher, plugin) pair to run a
 *   particular scriptHash signed by `publisherKeyFingerprint`.
 *
 * GET /api/provision/consent?publisher=&plugin=&scriptHash=&fingerprint=
 *   Returns the trust check result.
 *
 * Spec: /docs/snapshots/build-scripts#trust-lifecycle.
 */

import { NextResponse } from 'next/server';
import {
  checkTrust,
  recordTrust,
  revokeTrust,
} from '@/lib/provision/trust-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PostBody {
  publisher?: string;
  plugin?: string;
  scriptHash?: string;
  publisherKeyFingerprint?: string;
  dev?: boolean;
  /** When true, drops trust instead of recording it. */
  revoke?: boolean;
}

export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  if (!body.publisher || !body.plugin) {
    return NextResponse.json({ ok: false, error: 'publisher + plugin required' }, { status: 400 });
  }
  if (body.revoke) {
    await revokeTrust(body.publisher, body.plugin);
    return NextResponse.json({ ok: true });
  }
  if (!body.scriptHash || !body.publisherKeyFingerprint) {
    return NextResponse.json(
      { ok: false, error: 'scriptHash + publisherKeyFingerprint required' },
      { status: 400 },
    );
  }
  await recordTrust({
    publisher: body.publisher,
    plugin: body.plugin,
    publisherKeyFingerprint: body.publisherKeyFingerprint,
    scriptHash: body.scriptHash,
    dev: body.dev,
  });
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const publisher = url.searchParams.get('publisher') ?? '';
  const plugin = url.searchParams.get('plugin') ?? '';
  const scriptHash = url.searchParams.get('scriptHash') ?? '';
  const fingerprint = url.searchParams.get('fingerprint') ?? '';
  if (!publisher || !plugin || !scriptHash || !fingerprint) {
    return NextResponse.json(
      { ok: false, error: 'publisher, plugin, scriptHash, fingerprint required' },
      { status: 400 },
    );
  }
  const result = await checkTrust({
    publisher,
    plugin,
    scriptHash,
    currentFingerprint: fingerprint,
  });
  return NextResponse.json({ ok: true, result });
}
