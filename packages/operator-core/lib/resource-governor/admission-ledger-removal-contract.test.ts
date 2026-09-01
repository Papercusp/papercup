/**
 * P-005 / D-008 — source and migration 1077 must cross the retirement edge
 * atomically.
 *
 * The real-PostgreSQL migration suite proves the database refuses an unsafe
 * cleanup. This companion guard covers the other half of that change: arming
 * 1077 while any production caller or work-item compatibility surface remains
 * would leave dead code and misleading work-item semantics behind; removing a
 * compatibility surface while 1077 is still parked would strand live legacy
 * receipts. Exactly one phase is valid at a time.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RETIREMENT = 'libs/papercusp/libs/db/sql/1077-resource-governor-work-item-receipt-retirement.sql';

function absolute(relative: string): string {
  return resolve(ROOT, relative);
}

function source(relative: string): string {
  return readFileSync(absolute(relative), 'utf8');
}

const armed = existsSync(absolute(RETIREMENT));
const parked = existsSync(absolute(`${RETIREMENT}.DRAFT`));

const WRITER_CALLERS = [
  'packages/operator-core/lib/resource-governor/execution.ts',
  'packages/operator-core/lib/inference-gateway/durable-admission.ts',
  'packages/operator-core/lib/dbos/periodic-workflows.ts',
] as const;

const LEGACY_SOURCE_MARKERS = [
  {
    path: 'packages/operator-core/lib/resource-governor/queue.ts',
    markers: [
      'export class PgWorkItemAdmissionQueueStore',
      'export function hasResourceGovernorReceiptPayload',
      'export class ResourceGovernorReleaseRequiredError',
      'FROM harness_shared.work_items',
    ],
  },
  {
    path: 'packages/operator-core/lib/work-items.ts',
    markers: ['hasResourceGovernorReceiptPayload(wi.payload)', 'ResourceGovernorReleaseRequiredError'],
  },
  {
    path: 'packages/operator-core/lib/carry-brief.ts',
    markers: ["NOT jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor')"],
  },
  {
    path: 'packages/operator-core/lib/agent-tools/coordination/agent-goal-sources.ts',
    markers: ["NOT jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor')"],
  },
  {
    path: 'packages/operator-core/lib/scheduler/claim-spec-store.ts',
    markers: ['RESOURCE_GOVERNOR_PARK_OWNER'],
  },
  {
    path: 'packages/operator-core/lib/storage/storage-growth-alarm.ts',
    markers: ["predicateSql: `payload ? 'resource_governor'`"],
  },
  {
    path: 'packages/operator-core/lib/db-schema-reference/index-manifest.ts',
    markers: ['work_items_resource_governor_identity_uq', 'work_items_resource_governor_queue_idx'],
  },
] as const;

const LEGACY_FILES = [
  'packages/operator-core/lib/resource-governor/admission-cutover-store.ts',
  'packages/operator-core/lib/resource-governor/admission-cutover-store.integration.test.ts',
  'packages/operator-core/lib/agent-tools/operator/resource-governor-cutover.ts',
  'packages/operator-core/lib/agent-tools/operator/resource-governor-cutover.test.ts',
] as const;

describe('resource-governor admission-ledger final removal contract', () => {
  it('has exactly one retirement-migration phase', () => {
    expect(
      armed,
      'migration 1077 must be parked as .sql.DRAFT or armed as .sql, never absent or present under both names',
    ).not.toBe(parked);
  });

  it('keeps every production writer on the store appropriate to that phase', () => {
    for (const path of WRITER_CALLERS) {
      const text = source(path);
      if (armed) {
        expect(text, `${path} must be ledger-only when migration 1077 is armed`).toContain(
          'PgAdmissionLedgerQueueStore',
        );
        expect(text, `${path} must not retain the rolling compatibility store after retirement`).not.toContain(
          'PgAdmissionCutoverQueueStore',
        );
      } else {
        expect(text, `${path} must retain compatibility while migration 1077 is parked`).toContain(
          'PgAdmissionCutoverQueueStore',
        );
      }
    }
  });

  it('removes all listed work-item compatibility artifacts in the armed phase', () => {
    for (const path of LEGACY_FILES) {
      expect(
        existsSync(absolute(path)),
        armed
          ? `${path} must be deleted with the armed migration`
          : `${path} is required while migration 1077 is parked`,
      ).toBe(!armed);
    }

    for (const { path, markers } of LEGACY_SOURCE_MARKERS) {
      const text = source(path);
      for (const marker of markers) {
        if (armed) {
          expect(text, `${path} still carries legacy marker: ${marker}`).not.toContain(marker);
        } else {
          expect(text, `${path} lost required rolling-compatibility marker: ${marker}`).toContain(marker);
        }
      }
    }
  });
});
