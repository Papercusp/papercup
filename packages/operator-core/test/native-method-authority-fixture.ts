/** One read-only canonical method check. No product fixture or native launch. */
import assert from 'node:assert/strict';
import { getOrgPg, resolvedAdminDatabaseTarget } from '@papercusp/db-org';
import { z } from 'zod';
import { verifyMethodReviewAnswer } from '../lib/consult/get-feedback-prod';

process.once('message', async message => {
  let authorityEntered = false;
  try {
    const request = z.object({ requestId: z.string().uuid(), input: z.object({
      workspaceId: z.string().min(1), harnessSlug: z.string().min(1), subjectPlan: z.string().min(1),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/), reviewRef: z.string().regex(/^thread-post:[1-9][0-9]*$/),
    }).strict() }).strict().parse(message);
    const url = process.env.PAPERCUSP_TEST_RUNS_DB_URL?.trim();
    assert.ok(url && ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'DATABASE_URL']
      .every(key => process.env[key] === url), 'Canonical method database pins differ');
    const target = resolvedAdminDatabaseTarget();
    assert.equal(target.source, 'env', 'Canonical method authority cannot use discovery or fallback');
    authorityEntered = true;
    const review = await verifyMethodReviewAnswer(request.input);
    await new Promise<void>((resolve, reject) => process.send!({ requestId: request.requestId,
      targetSource: target.source, review }, error => error ? reject(error) : resolve()));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (authorityEntered) await getOrgPg().sql.end({ timeout: 5 });
    if (process.connected) process.disconnect();
  }
});
