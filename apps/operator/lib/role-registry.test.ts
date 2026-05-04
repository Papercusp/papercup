import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listRoles, getRole, rolesFiringOn, __clearRoleRegistryCache } from './role-registry';

let harnessRoot: string;
let promptsDir: string;

vi.mock('../app/api/_hono/harness-paths', () => ({
  harnessPackageDir: () => harnessRoot,
}));

beforeEach(async () => {
  __clearRoleRegistryCache();
  harnessRoot = await mkdtemp(join(tmpdir(), 'role-registry-test-'));
  promptsDir = join(harnessRoot, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
});

afterEach(async () => {
  __clearRoleRegistryCache();
  await rm(harnessRoot, { recursive: true, force: true });
});

function writeRole(id: string, role: Record<string, unknown>) {
  writeFileSync(join(promptsDir, `${id}.md`), `# ${id}\n\nfake prompt`, 'utf8');
  writeFileSync(join(promptsDir, `${id}.role.json`), JSON.stringify(role), 'utf8');
}

describe('role-registry', () => {
  it('returns empty when no sidecars exist', () => {
    expect(listRoles()).toEqual([]);
  });

  it('discovers a single valid role', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'when infra changes',
      output: { kind: 'features', featureKind: 'infra' },
    });
    const roles = listRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0].id).toBe('infra-reviewer');
    expect(roles[0].output.featureKind).toBe('infra');
  });

  it('discovers multiple roles and sorts by id', () => {
    writeRole('security-reviewer', {
      id: 'security-reviewer',
      whenUseful: 'security changes',
      output: { kind: 'features', featureKind: 'security' },
    });
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'infra changes',
      output: { kind: 'features', featureKind: 'infra' },
    });
    const ids = listRoles().map((r) => r.id);
    expect(ids).toEqual(['infra-reviewer', 'security-reviewer']);
  });

  it('skips roles where the sidecar id mismatches the filename', () => {
    writeRole('infra-reviewer', {
      id: 'something-else',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'infra' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('skips roles missing whenUseful', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      output: { kind: 'features', featureKind: 'infra' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('skips roles missing output.featureKind', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('skips roles whose featureKind is not slug-shaped', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'INFRA STRUCTURE' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('skips a sidecar without a matching prompt file', () => {
    // Don't call writeRole — manually write only the sidecar.
    writeFileSync(join(promptsDir, 'orphan.role.json'), JSON.stringify({
      id: 'orphan',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'orphan' },
    }), 'utf8');
    expect(listRoles()).toEqual([]);
  });

  it('skips a sidecar with malformed JSON', () => {
    writeFileSync(join(promptsDir, 'broken.md'), '# broken', 'utf8');
    writeFileSync(join(promptsDir, 'broken.role.json'), '{not json', 'utf8');
    expect(listRoles()).toEqual([]);
  });

  it('skips invalid role ids', () => {
    writeRole('Bad Role', {
      id: 'Bad Role',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'bad' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('getRole returns the matching manifest or null', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'infra' },
    });
    expect(getRole('infra-reviewer')?.id).toBe('infra-reviewer');
    expect(getRole('nonexistent')).toBeNull();
  });

  it('rolesFiringOn returns roles whose alwaysFireOn includes the event', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'infra' },
      alwaysFireOn: ['onProvisioned', 'onTeardown'],
    });
    writeRole('security-reviewer', {
      id: 'security-reviewer',
      whenUseful: 'y',
      output: { kind: 'features', featureKind: 'security' },
      alwaysFireOn: [],
    });
    expect(rolesFiringOn('onProvisioned').map((r) => r.id)).toEqual(['infra-reviewer']);
    expect(rolesFiringOn('onTeardown').map((r) => r.id)).toEqual(['infra-reviewer']);
    expect(rolesFiringOn('onUnknown').map((r) => r.id)).toEqual([]);
  });
});
