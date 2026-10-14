import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RETENTION_POLICY,
  compilePolicy,
  classifyPath,
  deletionClassFor,
  mapCensusConsumers,
  validatePolicy,
  isDeletableRule,
  type RetentionClass,
} from './retention-policy';

const HOME = '/hm/agent';
const policy = compilePolicy(RETENTION_POLICY, HOME);
const del = (p: string) => deletionClassFor(p, policy)?.id ?? null;

describe('retention policy (disk-headroom P-003 / R-2)', () => {
  it('the shipped policy passes every structural check', () => {
    expect(validatePolicy(RETENTION_POLICY, HOME)).toEqual([]);
  });

  it('every class has exactly one keep rule and at least one enforcer entry', () => {
    for (const cls of RETENTION_POLICY) {
      expect(cls.keep, cls.id).toBeTruthy();
      expect(typeof cls.keep.kind, cls.id).toBe('string');
      expect(cls.enforcers.length, cls.id).toBeGreaterThan(0);
    }
  });

  it('never selects owner data, swap, databases or product stores for deletion (D-002)', () => {
    for (const p of [
      '/mnt/data/Backup/kopia-repo/p/abc',
      '/mnt/data/owner-recordings/2026-06-27 18-14-07.mkv',
      '/mnt/data/Debug/Transformer/x',
      '/mnt/data/Debug_extra/y',
      '/mnt/data/db/collection-17.wt',
      '/mnt/data/back/Debug/z',
      '/mnt/data/swapfile',
      '/swap.img',
      '/var/lib/postgresql/18/main/base/1/2',
      `${HOME}/.papercusp-workspaces/.shared/embedded-pg-data/base/5`,
      `${HOME}/.papercusp-workspaces/ws/.papercusp/papercusp/hyperbee/data`,
      `${HOME}/Android/Sdk/x`,
    ]) {
      expect(del(p), p).toBeNull();
    }
  });

  it('the most specific root wins: in-tree scratch is deletable, the checkout around it is not', () => {
    expect(del(`${HOME}/papercupai-workspace/papercusp/.papercusp/scratch/probe.log`)).toBe('repo-scratch');
    expect(del(`${HOME}/papercupai-workspace/papercusp/packages/x.ts`)).toBeNull();
    expect(classifyPath(`${HOME}/papercupai-workspace/papercusp/packages/x.ts`, policy)).toMatchObject({ classId: 'source-checkouts' });
    expect(del(`${HOME}/papercupai-workspace/papercusp-relcut-0026/x`)).toBe('release-cut-worktrees');
  });

  it('protects the owner macOS VM and deletes nothing on /mnt/backup (WI-6554700010011387)', () => {
    // The owner-protected VM: the OSX-KVM disk, its recovery images and the backup-source link.
    for (const p of [
      '/mnt/backup/offload/macos-vm/OSX-KVM/mac_hdd_ng.img',
      '/mnt/backup/offload/macos-vm/recovery-EI-25726196477154042/attempt-2/builddata-20260820-160g.qcow2',
      `${HOME}/macos-vm/OSX-KVM`,
    ]) {
      expect(del(p), p).toBeNull();
      expect(classifyPath(p, policy), p).toMatchObject({ classId: 'owner-macos-vm' });
    }
    // The more specific protected root wins over the generic offload review class.
    expect(classifyPath('/mnt/backup/offload/WI-2146953/x', policy)).toMatchObject({ classId: 'backup-offload-other' });
    expect(classifyPath('/mnt/backup/db-dumps/papercusp-state.dump', policy)).toMatchObject({ classId: 'db-dumps' });
    expect(classifyPath('/mnt/backup/cloud-e2e-workspace-host-20261009r2/source/x', policy)).toMatchObject({
      classId: 'backup-agent-trees',
    });
    // Until the owner rules (WI-6554700010010388), no /mnt/backup class may delete.
    const backupClasses = RETENTION_POLICY.filter((c) => c.roots.some((r) => r.startsWith('/mnt/backup')));
    expect(backupClasses.map((c) => c.id).sort()).toEqual(
      ['backup-agent-trees', 'backup-offload-other', 'db-dumps', 'owner-macos-vm'].sort(),
    );
    for (const cls of backupClasses) expect(isDeletableRule(cls.keep), cls.id).toBe(false);
    for (const p of [
      '/mnt/backup/customer-terminal-native-target.PfNyjp/debug/a',
      '/mnt/backup/p012-bake-fire105/x',
      '/mnt/backup/offload/papercusp-audit-inputs/a.qcow2',
    ]) {
      expect(del(p), p).toBeNull();
    }
  });

  it('a deletable class can never reach under the owner macOS VM root (D-002 validator)', () => {
    const rogue: RetentionClass = {
      id: 'rogue-macos-reclaim',
      title: 'would delete the VM disk',
      origin: 'agent',
      roots: ['/mnt/backup/offload/macos-vm/OSX-KVM'],
      keep: { kind: 'max-age', maxAgeHours: 24 },
      enforcers: [{ kind: 'standing-reclaim' }],
    };
    expect(validatePolicy([...RETENTION_POLICY, rogue], HOME)).toContain(
      'rogue-macos-reclaim: deletable root /mnt/backup/offload/macos-vm/OSX-KVM lies under owner root /mnt/backup/offload/macos-vm',
    );
  });

  it('only work-item-named offload entries are deletable; VM disks are review', () => {
    expect(del('/mnt/data/offload/wi4480-rollback70/payload.tar.zst')).toBe('offload-work-copies');
    expect(del('/mnt/data/offload/wi-10006692-retained-bench-2026-10-08/a')).toBe('offload-work-copies');
    expect(del('/mnt/data/offload/gate-cache-WI-10006055-20261007/a')).toBe('offload-work-copies');
    expect(del('/mnt/data/offload/windows-vm/disk.qcow2')).toBeNull();
    expect(classifyPath('/mnt/data/offload/windows-vm/disk.qcow2', policy)).toMatchObject({ classId: 'offload-other' });
    expect(del('/mnt/data/offload/root-disk/x')).toBeNull();
  });

  it('fails closed on an unmatched path, a class root itself and a non-path store key', () => {
    expect(del('/nowhere/at/all')).toBeNull();
    expect(del(`${HOME}/papercupai-workspace/papercusp/.papercusp/scratch`)).toBeNull();
    expect(del('/tmp')).toBeNull();
    expect(del('/tmp/vitest-123')).toBe('tmp-scratch');
    expect(del('docker:build-cache')).toBeNull();
    expect(classifyPath('docker:build-cache', policy)).toMatchObject({ classId: 'container-storage' });
  });

  it('fails closed on a conflict between two classes at the same specificity', () => {
    const a: RetentionClass = { id: 'a', title: 'a', origin: 'agent', roots: ['/x/*'], keep: { kind: 'max-age', maxAgeHours: 1 }, enforcers: [{ kind: 'standing-reclaim' }] };
    const b: RetentionClass = { ...a, id: 'b', roots: ['/x/*'] };
    const compiled = compilePolicy([a, b], HOME);
    expect(classifyPath('/x/y/z', compiled)).toMatchObject({ status: 'conflict', classIds: ['a', 'b'] });
    expect(deletionClassFor('/x/y/z', compiled)).toBeNull();
    expect(validatePolicy([a, b], HOME).join('\n')).toMatch(/claimed by a and b/);
    // R-2: a census consumer under two classes is reported as a conflict, never as mapped.
    const m = mapCensusConsumers([{ consumer: '/x/y/z', kind: 'dir', bytes: 7 }], compiled);
    expect(m.conflicts.map((c) => [c.consumer, c.classIds])).toEqual([['/x/y/z', ['a', 'b']]]);
    expect(m.mapped).toEqual([]);
    expect(m.unmapped).toEqual([]);
  });

  it('validatePolicy rejects the rule breaks D-002 and D-005 forbid', () => {
    const base: RetentionClass = { id: 'ok', title: 't', origin: 'agent', roots: ['/a'], keep: { kind: 'max-age', maxAgeHours: 1 }, enforcers: [{ kind: 'standing-reclaim' }] };
    expect(validatePolicy([base], HOME)).toEqual([]);
    expect(validatePolicy([{ ...base, origin: 'owner' }], HOME).join('\n')).toMatch(/owner data must be keep/);
    expect(validatePolicy([{ ...base, origin: 'system' }], HOME).join('\n')).toMatch(/only agent-generated/);
    expect(validatePolicy([{ ...base, enforcers: [{ kind: 'none' }] }], HOME).join('\n')).toMatch(/no scheduled enforcer/);
    expect(validatePolicy([{ ...base, enforcers: [{ kind: 'existing', ref: 'x', schedule: ' ' }] }], HOME).join('\n')).toMatch(/no scheduled enforcer/);
    expect(validatePolicy([{ ...base, keep: { kind: 'review', reason: 'r' } }], HOME).join('\n')).toMatch(/must not name a deleter/);
    const owner: RetentionClass = { id: 'own', title: 'o', origin: 'owner', roots: ['/a'], keep: { kind: 'keep', reason: 'r' }, enforcers: [{ kind: 'none' }] };
    expect(validatePolicy([owner, { ...base, roots: ['/a/b'] }], HOME).join('\n')).toMatch(/lies under owner root/);
  });

  it('maps census rows: classes, aggregates, files rows, store keys, unattributed and unmapped', () => {
    const rows = [
      { consumer: '/', kind: 'dir', bytes: 10 },
      { consumer: '/home', kind: 'dir', bytes: 9 },
      { consumer: '/tmp', kind: 'dir', bytes: 1 },
      { consumer: `${HOME}/.papercusp/evidence/run-1`, kind: 'dir', bytes: 2 },
      { consumer: '/usr/lib/x86_64-linux-gnu/*', kind: 'files', bytes: 3 },
      { consumer: 'docker:images', kind: 'store', bytes: 4 },
      { consumer: 'unattributed:/', kind: 'unattributed', bytes: 5 },
      { consumer: '/brand-new-dir', kind: 'dir', bytes: 6 },
    ];
    const m = mapCensusConsumers(rows, policy);
    expect(m.mapped.map((x) => [x.consumer, x.classId])).toEqual([
      ['/tmp', 'tmp-scratch'],
      [`${HOME}/.papercusp/evidence/run-1`, 'agent-evidence'],
      ['/usr/lib/x86_64-linux-gnu/*', 'os'],
      ['docker:images', 'container-storage'],
    ]);
    expect(m.aggregates).toEqual(['/', '/home']);
    expect(m.skipped).toEqual(['unattributed:/']);
    expect(m.unmapped).toEqual([{ consumer: '/brand-new-dir', bytes: 6 }]);
    expect(m.conflicts).toEqual([]);
  });

  it('every named enforcer is a repo-qualified file that exists in this checkout', () => {
    // A placeholder or a path relative to the wrong checkout reads fine in review
    // but names no program; P-004 calls these, so each must resolve.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const refs = RETENTION_POLICY.flatMap((cls) =>
      cls.enforcers.flatMap((e) =>
        e.kind === 'existing' ? [[cls.id, e.ref] as const] : e.kind === 'standing-reclaim' && e.via ? [[cls.id, e.via] as const] : [],
      ),
    );
    expect(refs.length).toBeGreaterThan(0);
    const broken = refs.filter(([, ref]) => {
      const file = ref.split(/\s+/)[0];
      return !file.startsWith('papercusp/') || !existsSync(join(repoRoot, file.slice('papercusp/'.length)));
    });
    expect(broken).toEqual([]);
  });

  it('only max-age, newest and lease rules are deletable', () => {
    expect(isDeletableRule({ kind: 'max-age', maxAgeHours: 1 })).toBe(true);
    expect(isDeletableRule({ kind: 'newest', keep: 1 })).toBe(true);
    expect(isDeletableRule({ kind: 'lease', record: 'r', graceHours: 1 })).toBe(true);
    expect(isDeletableRule({ kind: 'native', manager: 'm', rule: 'r' })).toBe(false);
    expect(isDeletableRule({ kind: 'keep', reason: 'r' })).toBe(false);
    expect(isDeletableRule({ kind: 'review', reason: 'r' })).toBe(false);
  });
});
