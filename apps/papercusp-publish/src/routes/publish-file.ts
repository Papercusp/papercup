/**
 * PUT /publish/file/:depId/:sha256?token=<...>
 *
 * Buffers the file body (≤25MB per §15.5 cap, well under Worker 128MB
 * memory limit), verifies sha256, then fans out to CF Pages + R2 archive
 * in parallel.
 */

import { Hono } from 'hono';
import {
  verifyFileToken,
  fileSha256Hex,
  b64uDecode,
} from '@papercusp/publish-auth';
import type { Env } from '../env.ts';
import { getDeployment, getProject, markFileUploaded } from '../db.ts';
import { uploadFile } from '../cf-pages.ts';
import { writeFile } from '../r2-archive.ts';

export function publishFileRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.put('/publish/file/:depId/:sha256', async (c) => {
    const depId = c.req.param('depId')!;
    const sha = c.req.param('sha256')!;
    const token = c.req.query('token') ?? '';

    const ok = await verifyFileToken(b64uDecode(c.env.JWT_SECRET), token, {
      deploymentId: depId,
      sha256: sha,
    });
    if (!ok) return c.json({ error: 'invalid or expired upload token' }, 401);

    const dep = await getDeployment(c.env.DB, depId);
    if (!dep) return c.json({ error: 'unknown deployment' }, 404);
    const project = await getProject(c.env.DB, dep.tenant_id, dep.harness_slug);
    if (!project) return c.json({ error: 'project lookup failed' }, 500);

    const perFileCap = parseInt(c.env.PER_FILE_BYTES_CAP, 10);
    const declared = parseInt(c.req.header('content-length') ?? '0', 10);
    if (declared > perFileCap) {
      return c.json({ error: `file exceeds ${perFileCap} byte cap` }, 413);
    }

    const buf = new Uint8Array(await c.req.raw.arrayBuffer());
    if (buf.byteLength > perFileCap) {
      return c.json({ error: `file exceeds ${perFileCap} byte cap` }, 413);
    }

    const computed = await fileSha256Hex(buf);
    if (computed !== sha) {
      return c.json({ error: `sha256 mismatch (got ${computed})` }, 400);
    }

    await Promise.all([
      uploadFile(c.env, project.cf_project_name, streamFromBytes(buf), sha, buf.byteLength),
      writeFile(c.env, dep.tenant_id, dep.id, sha, buf),
    ]);
    await markFileUploaded(c.env.DB, depId, sha);
    return c.json({ ok: true });
  });

  return app;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
