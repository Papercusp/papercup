import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MANAGED_CAPABILITY_CONTRACT_VERSION,
  MANAGED_CAPABILITY_CUTOVER_READY,
  MANAGED_CAPABILITY_DISPOSITIONS,
  MANAGED_CAPABILITY_FAMILY_IDS,
  managedCapabilityContractViolations,
  managedCapabilityDisposition,
} from '@papercusp/orchestrator';
import {
  MANAGED_CAPABILITY_CUTOVER_READY as SUBPATH_CUTOVER_READY,
  MANAGED_CAPABILITY_DISPOSITIONS as SUBPATH_DISPOSITIONS,
} from '@papercusp/orchestrator/managed-capability-contract';

const ROOT = resolve(import.meta.dirname, '../../..');

const EXACT_R1_FAMILIES = [
  'shell-ssh-interpreters',
  'jobs-output-stop-pty',
  'script-orchestration-kernels',
  'reads-list-search-lsp',
  'edit-write-patch-notebook',
  'http-search-browser-computer',
  'delegation',
  'schedules-monitors-wakes',
  'tasks-plans-goals',
  'memory-checkpoint-resume-rewind',
  'questions-approvals',
  'images-artifacts-skills-discovery',
  'pure-tui-presentation',
] as const;

const ALLOWED_DISPOSITIONS = new Set([
  'managed-execution',
  'managed-backed-native-interface',
  'deliberately-retained-interface',
  'unsupported-gap',
]);

describe('managed capability disposition contract (P-001 / R-1)', () => {
  it('publishes the same versioned contract from the package barrel and explicit subpath', () => {
    expect(MANAGED_CAPABILITY_CONTRACT_VERSION).toBe(1);
    expect(SUBPATH_DISPOSITIONS).toBe(MANAGED_CAPABILITY_DISPOSITIONS);
    expect(SUBPATH_CUTOVER_READY).toBe(MANAGED_CAPABILITY_CUTOVER_READY);
  });

  it('contains exactly the thirteen R-1 families once, each with exactly one allowed disposition', () => {
    expect(MANAGED_CAPABILITY_FAMILY_IDS).toEqual(EXACT_R1_FAMILIES);
    expect(MANAGED_CAPABILITY_DISPOSITIONS.map((entry) => entry.family)).toEqual(EXACT_R1_FAMILIES);
    expect(new Set(MANAGED_CAPABILITY_DISPOSITIONS.map((entry) => entry.family)).size).toBe(EXACT_R1_FAMILIES.length);

    for (const entry of MANAGED_CAPABILITY_DISPOSITIONS) {
      expect(typeof entry.disposition).toBe('string');
      expect(ALLOWED_DISPOSITIONS.has(entry.disposition)).toBe(true);
      expect(managedCapabilityDisposition(entry.family)).toBe(entry);
    }
  });

  it('keeps every family and the root gate unready while recording precise, owned gaps', () => {
    expect(MANAGED_CAPABILITY_CUTOVER_READY).toBe(false);

    for (const entry of MANAGED_CAPABILITY_DISPOSITIONS) {
      expect(entry.cutoverReady, entry.family).toBe(false);
      expect(entry.cutoverReason.length, entry.family).toBeGreaterThan(20);
      expect(entry.boundary.length, entry.family).toBeGreaterThan(40);
      expect(entry.managedAuthorities.length, entry.family).toBeGreaterThan(0);
      expect(entry.gaps.length, entry.family).toBeGreaterThan(0);

      for (const gap of entry.gaps) {
        expect(gap.id, entry.family).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)+$/);
        expect(gap.description.length, gap.id).toBeGreaterThan(30);
        expect(gap.falsifier.length, gap.id).toBeGreaterThan(30);
        expect(gap.owningPlanItems.length, gap.id).toBeGreaterThan(0);
        expect(gap.owningPlanItems, gap.id).not.toContain('P-001');
        for (const item of gap.owningPlanItems) expect(item).toMatch(/^P-00[2-8]$/);
      }
    }
  });

  it('has executable red controls for missing, duplicate, uncited, and prematurely enabled entries', () => {
    expect(managedCapabilityContractViolations(MANAGED_CAPABILITY_DISPOSITIONS)).toEqual([]);

    expect(managedCapabilityContractViolations(MANAGED_CAPABILITY_DISPOSITIONS.slice(1))).toContain(
      'missing-family:shell-ssh-interpreters',
    );
    expect(
      managedCapabilityContractViolations([MANAGED_CAPABILITY_DISPOSITIONS[0], ...MANAGED_CAPABILITY_DISPOSITIONS]),
    ).toContain('duplicate-family:shell-ssh-interpreters');
    expect(
      managedCapabilityContractViolations([
        { ...MANAGED_CAPABILITY_DISPOSITIONS[0], evidence: { path: '', anchors: [] } },
        ...MANAGED_CAPABILITY_DISPOSITIONS.slice(1),
      ]),
    ).toContain('missing-evidence:shell-ssh-interpreters');
    expect(
      managedCapabilityContractViolations([
        { ...MANAGED_CAPABILITY_DISPOSITIONS[0], cutoverReady: true },
        ...MANAGED_CAPABILITY_DISPOSITIONS.slice(1),
      ]),
    ).toContain('cutover-not-blocked:shell-ssh-interpreters');
  });

  it('gives every family one primary evidence citation and verifies every cited source anchor', () => {
    for (const entry of MANAGED_CAPABILITY_DISPOSITIONS) {
      expect(entry.evidence.path, entry.family).toBeTruthy();
      expect(entry.evidence.anchors.length, entry.family).toBeGreaterThan(0);
      expect(entry.reuseSites.length, entry.family).toBeGreaterThan(0);

      for (const citation of [entry.evidence, ...entry.reuseSites]) {
        const source = readFileSync(resolve(ROOT, citation.path), 'utf8');
        for (const anchor of citation.anchors) {
          expect(source, `${entry.family}: ${citation.path} must contain ${JSON.stringify(anchor)}`).toContain(anchor);
        }
        for (const absent of 'absentAnchors' in citation ? (citation.absentAnchors ?? []) : []) {
          expect(source, `${entry.family}: ${citation.path} must not contain ${JSON.stringify(absent)}`).not.toContain(
            absent,
          );
        }
      }
    }
  });
});
