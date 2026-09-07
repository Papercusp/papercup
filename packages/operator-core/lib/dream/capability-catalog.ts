import { adminRegistry } from '../testing-domains-registry';
import { parseCapabilityManifest, type CapabilityClaim, type CapabilityUnit } from './capability-contracts';

const observed = (text: string, ...evidenceIds: string[]): CapabilityClaim => ({
  text,
  status: 'observed',
  evidenceIds,
});
const unknown = (text: string): CapabilityClaim => ({ text, status: 'unknown', evidenceIds: [] });
const emptyContracts = () => ({
  inputs: [],
  outputs: [],
  events: [],
  state: [],
  guarantees: [],
  prerequisites: [],
  failureModes: [],
  resourceConstraints: [],
});
const root = 'packages/operator-core/lib/';
const units: CapabilityUnit[] = [
  {
    id: 'mechanism:memory.hive-scope',
    granularity: 'mechanism',
    name: 'Confine recall fan-out to a hive',
    homeDomain: 'memory',
    relatedDomains: ['harness'],
    parentId: null,
    branch: 'recall-scope',
    relatedUnitIds: [],
    overlapsUnitIds: [],
    purpose: [observed('Confined recall retains harnesses in the session hive.', 'scope-code')],
    mechanism: [
      observed('Resolve candidate harnesses through registry membership and filter sibling hives.', 'scope-code'),
    ],
    evaluation: [
      observed('Fixtures cover sibling exclusion, unknown candidates and unscoped pass-through.', 'scope-tests'),
    ],
    contracts: {
      ...emptyContracts(),
      inputs: [observed('Registry entries, candidate harness slugs and an optional session harness.', 'scope-code')],
      outputs: [
        observed(
          'A fresh filtered list; an unscoped or standalone session keeps the input candidates.',
          'scope-code',
          'scope-tests',
        ),
      ],
      guarantees: [observed('A hive-confined session excludes unknown candidates and sibling hives.', 'scope-tests')],
      prerequisites: [
        unknown(
          'Registry freshness and correctness are external prerequisites, not established by these pure fixtures.',
        ),
      ],
    },
    evidence: [
      {
        id: 'scope-code',
        kind: 'implementation',
        path: root + 'memory/hive-scope.ts',
        anchor: 'export function narrowHarnessSlugsToSessionHive(',
        proves: 'Registry-based filtering and unscoped behavior.',
      },
      {
        id: 'scope-tests',
        kind: 'test',
        path: root + 'memory/hive-scope.test.ts',
        anchor: "it('drops a sibling hive entirely from a confined fan-out'",
        proves: 'Sibling exclusion under a concrete session hive; adjacent cases cover unknown and unscoped inputs.',
      },
    ],
  },
  {
    id: 'capability:plans.spec-revisions',
    granularity: 'capability',
    name: 'Append immutable behavioral contract revisions',
    homeDomain: 'plans',
    relatedDomains: [],
    parentId: null,
    branch: 'spec-revisions',
    relatedUnitIds: [],
    overlapsUnitIds: [],
    purpose: [
      observed(
        'Preserve contract history while accepting changes only against the expected revision.',
        'revision-code',
      ),
    ],
    mechanism: [
      observed(
        'A transaction serializes revision writes and returns a conflict for a stale expected revision.',
        'revision-code',
      ),
    ],
    evaluation: [
      observed(
        'A real-database fixture checks immutable append, exact reads and one-winner concurrent revision writes.',
        'revision-tests',
      ),
    ],
    contracts: {
      ...emptyContracts(),
      inputs: [observed('A scoped spec identity, expected revision and full behavioral clause.', 'revision-code')],
      outputs: [
        observed('A stale expected revision receives a structured conflict with the actual revision.', 'revision-code'),
      ],
      state: [
        observed('Current revision advances while prior accepted content remains addressable.', 'revision-tests'),
      ],
      prerequisites: [
        unknown(
          'Database availability and the complete ownership guard require additional evidence beyond this excerpt.',
        ),
      ],
    },
    evidence: [
      {
        id: 'revision-code',
        kind: 'implementation',
        path: root + 'agent-tools/plans/spec-clauses-store.ts',
        anchor: 'if (input.expectedRevision !== actualRevision)',
        proves: 'Compare-and-swap refusal in the row-locked revision transaction.',
      },
      {
        id: 'revision-tests',
        kind: 'test',
        path: root + 'agent-tools/plans/spec-clauses-store.integration.test.ts',
        anchor: "it('supports deterministic no-op, revision append, exact reads, and one-winner concurrent CAS'",
        proves: 'Real Postgres revision history and competing writers.',
      },
    ],
  },
  {
    id: 'mechanism:dream.cost-admission',
    granularity: 'mechanism',
    name: 'Admit a bounded Dream cycle',
    homeDomain: 'dream',
    relatedDomains: ['learnings'],
    parentId: null,
    branch: 'budget',
    relatedUnitIds: [],
    overlapsUnitIds: [],
    purpose: [
      observed(
        'Prevent a new Dream cycle when the shared governor or rolling spend ceiling refuses it.',
        'budget-code',
      ),
    ],
    mechanism: [observed('Combine shared per-cycle admission with rolling workspace Dream spend.', 'budget-code')],
    evaluation: [
      observed('Fixtures cover disabled governor, shared refusal and the exact rolling ceiling.', 'budget-tests'),
    ],
    contracts: {
      ...emptyContracts(),
      inputs: [observed('Workspace and pot scope with bounded cycle configuration.', 'budget-code')],
      outputs: [observed('An allow/refuse verdict includes the available cycle and rolling budget.', 'budget-code')],
      resourceConstraints: [
        unknown('Admission estimates do not by themselves prove a strict ceiling on eventual billed usage.'),
      ],
    },
    evidence: [
      {
        id: 'budget-code',
        kind: 'implementation',
        path: root + 'dream/dream-governor.ts',
        anchor: 'export async function preflightDreamCycle(',
        proves: 'Shared and rolling admission checks.',
      },
      {
        id: 'budget-tests',
        kind: 'test',
        path: root + 'dream/dream-governor.test.ts',
        anchor: "it('refuses at the workspace-wide rolling ceiling",
        proves: 'Refusal at the configured rolling ceiling and exact time-window query.',
      },
    ],
  },
  {
    id: 'capability:code.secret-scanned-pack',
    granularity: 'capability',
    name: 'Pack explicitly scoped source evidence',
    homeDomain: 'papercusp-su',
    relatedDomains: ['packaged'],
    parentId: null,
    branch: 'code-evidence',
    relatedUnitIds: [],
    overlapsUnitIds: [],
    purpose: [
      observed(
        'Produce a source pack from an explicit nonempty include set with attributable engine provenance.',
        'pack-code',
      ),
    ],
    mechanism: [
      observed('Pinned packer identity and fixed denial rules restrict the pack command.', 'pack-code', 'pack-policy'),
    ],
    evaluation: [observed('Fixtures reject flag smuggling and prevent disabling the security scan.', 'pack-tests')],
    contracts: {
      ...emptyContracts(),
      inputs: [observed('Explicit repository scope and include selection.', 'pack-code')],
      outputs: [observed('Refusal or an artifact with source and engine provenance.', 'pack-code')],
      prerequisites: [
        unknown(
          'The pinned repomix executable must be installed and its scanner must finish before a packet is admissible.',
        ),
      ],
      failureModes: [
        observed('Empty include selection or unverified engine identity produces a refusal.', 'pack-code'),
      ],
      guarantees: [observed('The repomix argument builder cannot disable security scanning.', 'pack-tests')],
    },
    evidence: [
      {
        id: 'pack-code',
        kind: 'implementation',
        path: root + 'code-intelligence/packer-facade.ts',
        anchor: 'export async function packerFacade(',
        proves: 'Selection, pinned engine verification and refusal flow.',
      },
      {
        id: 'pack-policy',
        kind: 'implementation',
        path: root + 'code-intelligence/packer-facade.ts',
        anchor: 'export function buildRepomixArgs(',
        proves: 'Fixed deny set and safe attached packer arguments.',
      },
      {
        id: 'pack-tests',
        kind: 'test',
        path: root + 'code-intelligence/packer-facade.test.ts',
        anchor: "it('secret-scanning can never be disabled",
        proves: 'No-security-check is excluded from every constructed repomix argument vector.',
      },
    ],
  },
];

/** A reviewed seed manifest, not a new registry service or a census of the repository. */
export function getPilotCapabilityManifest() {
  return parseCapabilityManifest(
    {
      schemaVersion: 'dream-capability-manifest-v1',
      revision: 'pilot-2026-09-07-v1',
      domainSource: 'testing-domains-registry',
      coverage: {
        status: 'partial',
        unmapped: [
          'Every behavior outside the explicitly listed units remains uncatalogued.',
          'Parent capability boundaries for the initial mechanisms have not been established.',
        ],
        note: 'Existing test-domain identities organize sampling; their globs prove neither behavioral boundaries nor complete coverage. Null parentage means no asserted parent, not no wider subsystem.',
      },
      units,
    },
    adminRegistry.map((domain) => domain.id),
  );
}
