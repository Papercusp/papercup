/**
 * The CONSUMING half of the cloud-resource-obligations ledger (EI-23459044188861686).
 *
 * `closeCloudResourceObligation` was correct from the day it was written and had ZERO production
 * callers, so every row stayed `teardown_owed = true` forever and the sweep escalated on phantom
 * obligations. That is worse than no detector: a REAL leak becomes indistinguishable from a
 * torn-down one.
 *
 * The subtle half — and the reason this file exists rather than a single wiring test — is that the
 * delete-op vocabulary and the recorded-kind vocabulary DISAGREE for the most expensive resource:
 * the provider op is `delete-instance` while the created resource's kind is `vm`. Any close keyed
 * off a `delete-` prefix strip therefore matches no row for the VM and returns `{ closed:false }`
 * silently. `PREFIX-STRIP CONTROL` below is a permanent, deliberately-wrong implementation kept in
 * the suite so these assertions can be shown to FAIL on that bug — a test that cannot fail is not
 * evidence.
 */
import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import {
  CLOUD_RESOURCE_DELETE_CONTRACT,
  CLOUD_RESOURCE_DELETE_OP_KIND,
  cloudResourceKindForDeleteOp,
  createCloudResourceObligationCloseObserver,
  type CloudResourceDestroyedEventLike,
} from './cloud-resource-obligations';

function makeFakeSql(opts: { updateAffected?: boolean } = {}) {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('UPDATE harness_shared.cloud_resource_obligations') && text.includes('SET closed_at')) {
      return Promise.resolve((opts.updateAffected ?? true) ? [{ id: 42 }] : []);
    }
    throw new Error(`unexpected query in fake sql: ${text}`);
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

function destroyEvent(deleteOp: string, providerId = 'pc-host-1'): CloudResourceDestroyedEventLike {
  return { resource: { deleteOp, providerId }, workspaceId: 'papercusp-workspace' };
}

/**
 * PREFIX-STRIP CONTROL — the wrong implementation this suite exists to catch. Kept permanently
 * rather than applied as a temporary mutation: the shared tree is swept into commits every few
 * minutes, so mutating the real source to prove falsifiability can commit the mutant.
 */
function prefixStripKind(deleteOp: string): string | undefined {
  return deleteOp.startsWith('delete-') ? deleteOp.slice('delete-'.length) : undefined;
}

describe('delete-op -> recorded-kind inversion', () => {
  it('POSITIVE CONTROL: the contract it inverts is non-empty and reachable', () => {
    // Without this, every assertion below would pass vacuously against an empty map.
    expect(Object.keys(CLOUD_RESOURCE_DELETE_CONTRACT).length).toBeGreaterThan(0);
    expect(Object.keys(CLOUD_RESOURCE_DELETE_OP_KIND).length).toBe(
      Object.keys(CLOUD_RESOURCE_DELETE_CONTRACT).length,
    );
  });

  it('is the exact inverse of CLOUD_RESOURCE_DELETE_CONTRACT — so a new kind cannot fall through unmapped', () => {
    for (const [kind, entry] of Object.entries(CLOUD_RESOURCE_DELETE_CONTRACT)) {
      expect(cloudResourceKindForDeleteOp(entry.op)).toBe(kind);
    }
  });

  it('maps delete-instance to vm — the op/kind disagreement a prefix strip gets wrong', () => {
    expect(cloudResourceKindForDeleteOp('delete-instance')).toBe('vm');

    // The control: the wrong implementation yields 'instance', which matches no obligation row.
    // If this ever equals 'vm', the control has stopped discriminating and the assertions above
    // no longer prove anything.
    expect(prefixStripKind('delete-instance')).toBe('instance');
    expect(prefixStripKind('delete-instance')).not.toBe(cloudResourceKindForDeleteOp('delete-instance'));
  });

  it('returns undefined for an op the ledger cannot address, rather than inventing a kind', () => {
    expect(cloudResourceKindForDeleteOp('delete-nonexistent')).toBeUndefined();
    expect(cloudResourceKindForDeleteOp('use-existing-network')).toBeUndefined();
  });
});

describe('createCloudResourceObligationCloseObserver', () => {
  it('closes the obligation using the RECORDED kind, not the op name', async () => {
    const { sql, calls } = makeFakeSql({ updateAffected: true });
    const observer = createCloudResourceObligationCloseObserver({ sql });

    const result = await observer(destroyEvent('delete-instance', 'pc-vm-1'));

    expect(result).toEqual({ closed: true });
    const update = calls.find((c) => c.text.includes('SET closed_at'));
    expect(update).toBeDefined();
    // 'vm' must be among the bound values; 'instance' must not.
    expect(update!.values).toContain('vm');
    expect(update!.values).not.toContain('instance');
  });

  it('reports the unmatched close instead of swallowing it', async () => {
    const { sql } = makeFakeSql({ updateAffected: false });
    const unmatched: CloudResourceDestroyedEventLike[] = [];
    const observer = createCloudResourceObligationCloseObserver({
      sql,
      onUnmatched: (e) => unmatched.push(e),
    });

    const result = await observer(destroyEvent('delete-network', 'pc-net-1'));

    expect(result).toEqual({ closed: false });
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]!.resource.providerId).toBe('pc-net-1');
  });

  it('reports an UNMAPPED delete-op without touching the database', async () => {
    const { sql, calls } = makeFakeSql();
    const unmatched: CloudResourceDestroyedEventLike[] = [];
    const observer = createCloudResourceObligationCloseObserver({
      sql,
      onUnmatched: (e) => unmatched.push(e),
    });

    const result = await observer(destroyEvent('delete-nonexistent'));

    expect(result).toEqual({ closed: false });
    expect(unmatched).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('is safe without an onUnmatched binding', async () => {
    const { sql } = makeFakeSql({ updateAffected: false });
    const observer = createCloudResourceObligationCloseObserver({ sql });
    await expect(observer(destroyEvent('delete-disk'))).resolves.toEqual({ closed: false });
  });

  it('closes every deletable kind the contract knows — no kind is silently unreachable', async () => {
    for (const [kind, entry] of Object.entries(CLOUD_RESOURCE_DELETE_CONTRACT)) {
      const { sql, calls } = makeFakeSql({ updateAffected: true });
      const observer = createCloudResourceObligationCloseObserver({ sql });

      const result = await observer(destroyEvent(entry.op, `pc-${kind}-1`));

      expect(result, `kind '${kind}' (op '${entry.op}') must close`).toEqual({ closed: true });
      expect(calls.find((c) => c.text.includes('SET closed_at'))!.values).toContain(kind);
    }
  });
});
