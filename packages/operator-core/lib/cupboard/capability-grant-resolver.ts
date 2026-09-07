/**
 * Pure install-time capability-class grant resolution (identities-v1 P-017).
 * Registry and marketplace reads are injected so unavailable evidence stays
 * unknown instead of being mistaken for price zero or no adoption.
 */
import {
  parseCapabilityClassRef,
  type PotCapabilityProviderBindingRow,
  type ProviderBindingRow,
} from '../capability-class-registry-store';

export type CapabilityGrantState = 'satisfied' | 'choosable' | 'absent';
export type CapabilityGrantInstallMode = 'interactive' | 'agent';
export type CapabilityProviderSelectionReason =
  | 'explicit-selection'
  | 'publisher-suggestion'
  | 'evidence-policy';

export interface CapabilityProviderPriceEvidence {
  amount: number;
  currency: string;
  billingUnit: string;
  source: string;
}

/** Evidence shown by the picker. Unknown price/adoption facts are explicit nulls. */
export interface CapabilityProviderCandidate extends ProviderBindingRow {
  price: CapabilityProviderPriceEvidence | null;
  activePotBindings: number | null;
  passingStructuralRuns: number;
  totalStructuralRuns: number;
}

export interface CapabilityProviderSelection {
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  reason: CapabilityProviderSelectionReason;
  /** Agent-selected choices are disclosed; existing bindings are reused silently. */
  disclosureRequired: boolean;
}

export interface ResolvedCapabilityGrant {
  classRef: string;
  optional: boolean;
  state: CapabilityGrantState;
  binding?: PotCapabilityProviderBindingRow;
  candidates?: CapabilityProviderCandidate[];
  selection?: CapabilityProviderSelection;
  absentReason?: 'invalid-class-ref' | 'no-conformant-provider';
  selectionProblem?: string;
}

export interface CapabilityGrantSet {
  requires?: readonly string[];
  optional?: readonly string[];
  suggestedProviders?: Readonly<Record<string, string>>;
}

export interface CapabilityGrantResolverDeps {
  getPotBinding: (classRef: string) => Promise<PotCapabilityProviderBindingRow | null>;
  listCandidates: (classRef: string) => Promise<readonly CapabilityProviderCandidate[]>;
}

export interface ResolveCapabilityGrantOptions {
  mode: CapabilityGrantInstallMode;
  /** Exact class ref to provider package or exact provider package@version. */
  selections?: Readonly<Record<string, string>>;
}

export interface CapabilityGrantResolutionVerdict {
  ok: boolean;
  requirements: ResolvedCapabilityGrant[];
  satisfied: string[];
  selected: CapabilityProviderSelection[];
  missingRequired: string[];
  requiresChoice: string[];
  missingOptional: string[];
  disclosures: string[];
}

export interface InstalledIdentityGrantView {
  identityRef: string;
  requires?: readonly string[];
  optional?: readonly string[];
}

export interface CapabilityProviderPin {
  classRef: string;
  providerPackage: string;
  providerVersion: string;
}

export interface CapabilityProviderIdentityDependent {
  identityRef: string;
  classRef: string;
  optional: boolean;
}

function exactClassRef(value: string): string | null {
  const parsed = parseCapabilityClassRef(value);
  return parsed ? parsed.id + '@' + parsed.version : null;
}

function providerRef(candidate: Pick<CapabilityProviderCandidate, 'providerPackage' | 'providerVersion'>): string {
  return candidate.providerPackage + '@' + candidate.providerVersion;
}

function hintMatches(candidate: CapabilityProviderCandidate, hint: string): boolean {
  return hint === candidate.providerPackage || hint === providerRef(candidate);
}

function behavioralRank(status: string): number {
  if (status === 'passed') return 3;
  if (status === 'not-required') return 2;
  if (status === 'not-run') return 1;
  return 0;
}

function passRate(candidate: CapabilityProviderCandidate): number {
  return candidate.totalStructuralRuns > 0
    ? candidate.passingStructuralRuns / candidate.totalStructuralRuns
    : -1;
}

/** Correctness evidence first, adoption next, deterministic identity last. */
export function compareCapabilityProviderCandidates(
  a: CapabilityProviderCandidate,
  b: CapabilityProviderCandidate,
): number {
  const behavioral = behavioralRank(b.behavioralStatus) - behavioralRank(a.behavioralStatus);
  if (behavioral !== 0) return behavioral;
  const rate = passRate(b) - passRate(a);
  if (rate !== 0) return rate;
  const runs = b.passingStructuralRuns - a.passingStructuralRuns;
  if (runs !== 0) return runs;
  const adoption = (b.activePotBindings ?? -1) - (a.activePotBindings ?? -1);
  if (adoption !== 0) return adoption;
  const packageOrder = a.providerPackage.localeCompare(b.providerPackage);
  return packageOrder !== 0
    ? packageOrder
    : b.providerVersion.localeCompare(a.providerVersion, undefined, { numeric: true });
}

function usableCandidates(
  classRef: string,
  candidates: readonly CapabilityProviderCandidate[],
): CapabilityProviderCandidate[] {
  const unique = new Map<string, CapabilityProviderCandidate>();
  for (const candidate of candidates) {
    if (
      exactClassRef(candidate.classRef) === classRef &&
      candidate.status === 'active' &&
      candidate.conformanceStatus === 'passed'
    ) {
      unique.set(providerRef(candidate), candidate);
    }
  }
  return [...unique.values()].sort(compareCapabilityProviderCandidates);
}

function requirements(grants: CapabilityGrantSet): Array<{ classRef: string; optional: boolean }> {
  const required = new Set(grants.requires ?? []);
  const out = [...required].map((classRef) => ({ classRef, optional: false }));
  for (const classRef of grants.optional ?? []) {
    if (!required.has(classRef)) out.push({ classRef, optional: true });
  }
  return out;
}

function select(
  classRef: string,
  candidates: readonly CapabilityProviderCandidate[],
  hint: string,
  reason: CapabilityProviderSelectionReason,
  mode: CapabilityGrantInstallMode,
): CapabilityProviderSelection | null {
  const candidate = candidates.find((item) => hintMatches(item, hint));
  return candidate
    ? {
        classRef,
        providerPackage: candidate.providerPackage,
        providerVersion: candidate.providerVersion,
        reason,
        disclosureRequired: mode === 'agent',
      }
    : null;
}

/** Resolve grants without installing packages or persisting pot bindings. */
export async function resolveCapabilityGrants(
  grants: CapabilityGrantSet,
  deps: CapabilityGrantResolverDeps,
  options: ResolveCapabilityGrantOptions,
): Promise<CapabilityGrantResolutionVerdict> {
  const resolved: ResolvedCapabilityGrant[] = [];

  for (const requirement of requirements(grants)) {
    const classRef = exactClassRef(requirement.classRef);
    if (!classRef) {
      resolved.push({
        classRef: requirement.classRef,
        optional: requirement.optional,
        state: 'absent',
        candidates: [],
        absentReason: 'invalid-class-ref',
      });
      continue;
    }

    const binding = await deps.getPotBinding(classRef);
    if (binding) {
      resolved.push({
        classRef,
        optional: requirement.optional,
        state: 'satisfied',
        binding,
        candidates: [],
      });
      continue;
    }

    const candidates = usableCandidates(classRef, await deps.listCandidates(classRef));
    if (candidates.length === 0) {
      resolved.push({
        classRef,
        optional: requirement.optional,
        state: 'absent',
        candidates,
        absentReason: 'no-conformant-provider',
      });
      continue;
    }

    const explicit = options.selections?.[classRef];
    const suggestion =
      grants.suggestedProviders?.[classRef] ??
      grants.suggestedProviders?.[requirement.classRef];
    let choice: CapabilityProviderSelection | null = null;
    let selectionProblem: string | undefined;

    if (explicit) {
      choice = select(classRef, candidates, explicit, 'explicit-selection', options.mode);
      if (!choice) selectionProblem = 'explicit provider ' + explicit + ' is not an active conformant candidate';
    } else if (suggestion) {
      choice = select(classRef, candidates, suggestion, 'publisher-suggestion', options.mode);
      if (!choice) selectionProblem = 'suggested provider ' + suggestion + ' is not an active conformant candidate';
    }
    if (!choice && options.mode === 'agent') {
      choice = select(classRef, candidates, providerRef(candidates[0]!), 'evidence-policy', options.mode);
    }

    resolved.push({
      classRef,
      optional: requirement.optional,
      state: 'choosable',
      candidates,
      ...(choice ? { selection: choice } : {}),
      ...(selectionProblem ? { selectionProblem } : {}),
    });
  }

  const satisfied = resolved.filter((item) => item.state === 'satisfied').map((item) => item.classRef);
  const selected = resolved.flatMap((item) => (item.selection ? [item.selection] : []));
  const missingRequired = resolved
    .filter((item) => !item.optional && item.state === 'absent')
    .map((item) => item.classRef);
  const requiresChoice = resolved
    .filter((item) => !item.optional && item.state === 'choosable' && !item.selection)
    .map((item) => item.classRef);
  const missingOptional = resolved
    .filter((item) => item.optional && item.state !== 'satisfied' && !item.selection)
    .map((item) => item.classRef);
  const disclosures = selected
    .filter((item) => item.disclosureRequired)
    .map((item) =>
      'Selected ' + item.providerPackage + '@' + item.providerVersion +
      ' for ' + item.classRef + ' by ' + item.reason + '.',
    );

  return {
    ok: missingRequired.length === 0 && requiresChoice.length === 0,
    requirements: resolved,
    satisfied,
    selected,
    missingRequired,
    requiresChoice,
    missingOptional,
    disclosures,
  };
}

/**
 * Pure reverse edge for uninstall review. The DB store finds affected pots;
 * this helper names the installed identities inside one pot that would lose a
 * required or optional class when an exact provider version is removed.
 */
export function findCapabilityProviderIdentityDependents(input: {
  providerPackage: string;
  providerVersion: string;
  pins: readonly CapabilityProviderPin[];
  identities: readonly InstalledIdentityGrantView[];
}): CapabilityProviderIdentityDependent[] {
  const affectedClasses = new Set(
    input.pins
      .filter(
        (pin) =>
          pin.providerPackage === input.providerPackage &&
          pin.providerVersion === input.providerVersion,
      )
      .map((pin) => exactClassRef(pin.classRef))
      .filter((ref): ref is string => ref !== null),
  );
  const dependents: CapabilityProviderIdentityDependent[] = [];
  const seen = new Set<string>();

  for (const identity of input.identities) {
    for (const grant of requirements(identity)) {
      const classRef = exactClassRef(grant.classRef);
      if (!classRef || !affectedClasses.has(classRef)) continue;
      const key = identity.identityRef + '\u0000' + classRef;
      if (seen.has(key)) continue;
      seen.add(key);
      dependents.push({
        identityRef: identity.identityRef,
        classRef,
        optional: grant.optional,
      });
    }
  }

  return dependents.sort(
    (a, b) =>
      a.identityRef.localeCompare(b.identityRef) ||
      a.classRef.localeCompare(b.classRef),
  );
}
