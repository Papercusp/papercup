/**
 * GET /api/design/regressions/<baseline|current|diff>/<file>.png
 *
 * Streams a Lost Pixel PNG from one of the three apps/operator/
 * lostpixel-{baseline,current,diff}/ directories. Validates the
 * filename against a strict allowlist regex and refuses any
 * traversal attempt — bucket + file together must resolve INSIDE
 * the configured root.
 */
import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROOTS: Record<string, string> = {
  baseline: 'lostpixel-baseline',
  current: 'lostpixel-current',
  diff: 'lostpixel-diff',
};

// Lost Pixel filenames look like
//   components-api-key-status--all-configured.png
// Allow [a-z0-9-] segments + '--' separator + .png suffix.
const FILENAME_RE = /^[a-z0-9][a-z0-9-]*\.png$/i;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ bucket: string; file: string }> },
) {
  const { bucket, file } = await params;
  const rel = ROOTS[bucket];
  if (!rel) {
    return NextResponse.json({ error: 'unknown bucket' }, { status: 400 });
  }
  if (!FILENAME_RE.test(file)) {
    return NextResponse.json({ error: 'invalid filename' }, { status: 400 });
  }
  const root = resolve(process.cwd(), rel);
  const abs = resolve(root, file);
  if (!abs.startsWith(root + '/')) {
    return NextResponse.json({ error: 'traversal blocked' }, { status: 400 });
  }
  try {
    const bytes = await fs.readFile(abs);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-cache',
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'io_error' }, { status: 500 });
  }
}
