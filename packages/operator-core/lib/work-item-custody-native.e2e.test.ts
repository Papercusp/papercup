/**
 * EI-28957830517847385: exercise the actual native operator reader over its
 * disposable migrated database. Run through verify-tauri-headless.sh with
 * VERIFY_TAURI_ISOLATED_DB=1 and this suite's live profile. The draft is applied
 * only to that database; a valid receipt is never a continuity attestation.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { captureOwnedDatabaseSchema } from '@papercusp/test-config/pg';
import { describe, expect, inject, it } from 'vitest';
import { assertNativeRuntimeLiveness } from './testing-native-runtime';
import type { WorkItemLifecycleCoverage, WorkItemLifecycleEvent } from './work-item-lifecycle-history';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PROFILE = 'packages/operator-core/test/work-item-custody.live-profile.json';
const DRAFT = 'libs/papercusp/libs/db/sql/1643-work-item-custody-audit-capture.sql.DRAFT';
const execute = promisify(execFile);
type Lifecycle = { events: WorkItemLifecycleEvent[]; coverage: WorkItemLifecycleCoverage };

describe.skipIf(inject('papercuspTestLayer') !== 'e2e')('R-46 owned native custody capture', () => {
  it('reads migrated receipts, rejects a foreign harness and preserves uncertainty across equal endpoints', async () => {
    // Refuse before connecting or writing unless the maintained verifier owns
    // both the source snapshot and disposable database. No shared fallback.
    expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
    expect(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED).toBe('1');
    expect(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE).toBe(PROFILE);
    expect(await realpath(ROOT)).toBe(await realpath(process.env.OPERATOR_SOURCE_ROOT!));
    const receipt = JSON.parse(await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
    expect(receipt.schemaVersion).toBe('verifier-source-v1');
    expect(receipt.sourceCommit).toBe(process.env.VERIFY_TAURI_SOURCE_REF);
    const runtimeBefore = assertNativeRuntimeLiveness(ROOT, receipt.sourceCommit);
    const owner = process.env.PAPERCUSP_SID!;
    const workspace = process.env.PAPERCUSP_WORKSPACE!;
    const port = process.env.VERIFY_TAURI_PORT!;
    expect(owner).toBeTruthy();
    expect(workspace).toBeTruthy();
    expect(port).toMatch(/^[1-9][0-9]*$/);
    expect(['3070', '3170', '3270', '3271']).not.toContain(port);
    const origin = `http://127.0.0.1:${port}`;
    expect([origin, origin + '/']).toContain(process.env.VERIFY_TAURI_DEV_URL);
    const url = process.env.HARNESS_ADMIN_DATABASE_URL!;
    expect(url).toBeTruthy();
    expect(new URL(url).port).toBe(process.env.PAPERCUSP_PG_PORT);
    expect(new URL(url).port).not.toBe('5432');
    const env = { ...process.env };
    delete env.PAPERCUSP_SCRATCH_ROOT;
    const tool = async (name: string, args: object) => {
      const result = await execute(process.execPath, [resolve(ROOT, 'scripts/mcp-call.mjs'), name,
        '--port', port, '--client', owner, '--workspace', workspace, '--harness', 'papercusp',
        JSON.stringify(args)], { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
      return JSON.parse(result.stdout);
    };
    const who = await tool('coord:whoami', {});
    expect(who.ownerId).toBe(owner);
    expect(who.workspaceId).toBe(workspace);
    const id = 'WI-r46-native-' + randomUUID();
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    let installed = false;
    let seeded = false;
    const initialSchema = await captureOwnedDatabaseSchema(url);
    expect(initialSchema).not.toBeNull();
    const lifecycle = async (): Promise<Lifecycle> => {
      assertNativeRuntimeLiveness(ROOT, receipt.sourceCommit);
      const response = await tool('work_items:get', { id, harness: 'papercusp', detail: true,
        threadLimit: 0, payloadTier: 'full', projection: { pick: [
          'results[].id', 'results[].lifecycle.events[].action',
          'results[].lifecycle.events[].custodyCapture', 'results[].lifecycle.coverage',
        ] } });
      expect(response.results, JSON.stringify(response)).toHaveLength(1);
      expect(response.results[0].id).toBe(id);
      expect(response.results[0].lifecycle, JSON.stringify(response)).toBeTruthy();
      return response.results[0].lifecycle;
    };
    const captures = (value: Lifecycle) => value.events
      .filter(event => event.action === 'work_items:custody:capture');
    try {
      const existing = await sql`SELECT oid FROM pg_trigger WHERE NOT tgisinternal
        AND tgrelid = 'harness_shared.work_items'::regclass
        AND tgname = 'capture_work_item_custody_audit_trg'`;
      expect(existing, 'this prospective fixture must not overwrite an installed capture').toHaveLength(0);
      await sql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, taken_by, payload)
        VALUES (${workspace}, 'papercusp', ${id}, ${id}, 'private native custody fixture',
          'open', 'feature', 'local', 'su-original', '{}')`;
      seeded = true;
      const absent = await lifecycle();
      expect(captures(absent)).toHaveLength(0);
      expect(absent.coverage.notRecorded.join(' ')).toMatch(/does not qualify.*continuity/);
      const draft = await readFile(resolve(ROOT, DRAFT), 'utf8');
      await sql.unsafe(draft);
      installed = true;
      const enabledSchema = await captureOwnedDatabaseSchema(url);
      expect(enabledSchema).not.toBeNull();
      expect(enabledSchema!.fingerprint).not.toBe(initialSchema!.fingerprint);
      await sql.begin(async tx => {
        for (let i = 0; i < 7; i += 1) {
          await tx`UPDATE harness_shared.work_items SET taken_by = ${'su-step-' + i}
            WHERE workspace_id = ${workspace} AND harness_slug = 'papercusp' AND feature_id = ${id}`;
        }
      });
      const positive = await lifecycle();
      expect(captures(positive)).toHaveLength(7);
      for (const event of captures(positive)) {
        expect(event.custodyCapture).toMatchObject({ receipt: 'valid', operation: 'UPDATE',
          actorAuthentication: 'unverified', continuity: 'unknown', problems: [] });
      }
      expect(positive.coverage.truncated).toBe(false);
      // Equal enabled schemas and receipt rows cannot erase a disabled interval.
      await sql.unsafe('ALTER TABLE harness_shared.work_items DISABLE TRIGGER capture_work_item_custody_audit_trg');
      try {
        expect((await captureOwnedDatabaseSchema(url))!.fingerprint).not.toBe(enabledSchema!.fingerprint);
        await sql`UPDATE harness_shared.work_items SET taken_by = 'su-hidden-transfer'
          WHERE workspace_id = ${workspace} AND harness_slug = 'papercusp' AND feature_id = ${id}`;
        await sql`UPDATE harness_shared.work_items SET taken_by = 'su-step-6'
          WHERE workspace_id = ${workspace} AND harness_slug = 'papercusp' AND feature_id = ${id}`;
      } finally {
        await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER capture_work_item_custody_audit_trg');
      }
      expect(await captureOwnedDatabaseSchema(url)).toEqual(enabledSchema);
      const restored = await lifecycle();
      expect(captures(restored)).toEqual(captures(positive));
      expect(restored.coverage.notRecorded.join(' ')).toMatch(/independent DDL, capture or retention continuity/);
      // Both foreign endpoints must fail the real API's requested-harness check.
      await sql`UPDATE harness_shared.audit_log SET details =
        jsonb_set(jsonb_set(details, '{before,harness_slug}', '"foreign"'), '{after,harness_slug}', '"foreign"')
        WHERE workspace_id = ${workspace} AND subject = ${id} AND action = 'work_items:custody:capture'`;
      const tampered = await lifecycle();
      expect(captures(tampered)).toHaveLength(7);
      expect(captures(tampered).every(event => event.custodyCapture?.receipt === 'invalid')).toBe(true);
      expect(tampered.coverage.degraded).toBe(true);
      const runtimeAfter = assertNativeRuntimeLiveness(ROOT, receipt.sourceCommit);
      expect(runtimeAfter.fingerprint).toBe(runtimeBefore.fingerprint);
      console.info('R46_NATIVE_CUSTODY_EVIDENCE', JSON.stringify({
        scope: 'owned current-build private API drill; no historical or continuous-custody attestation',
        sourceCommit: receipt.sourceCommit, runtimeBefore, runtimeAfter, origin,
        draftSha256: createHash('sha256').update(draft).digest('hex'),
        initialSchema, enabledSchema, receiptCount: captures(positive).length,
        absentCoverage: absent.coverage, restoredCoverage: restored.coverage,
        tamperedCoverage: tampered.coverage,
      }));
    } finally {
      try {
        if (seeded) {
          await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${workspace}
            AND harness_slug = 'papercusp' AND feature_id = ${id}`;
          await sql`DELETE FROM harness_shared.audit_log WHERE workspace_id = ${workspace} AND subject = ${id}`;
        }
        if (installed) {
          await sql.unsafe('DROP TRIGGER capture_work_item_custody_audit_trg ON harness_shared.work_items');
          await sql.unsafe('DROP FUNCTION harness_shared.capture_work_item_custody_audit()');
          expect(await captureOwnedDatabaseSchema(url)).toEqual(initialSchema);
        }
      } finally { await sql.end({ timeout: 5 }); }
    }
  }, 360_000);
});
