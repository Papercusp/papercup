export function privatePgSeedEnvironment(
  source?: Readonly<Record<string, string | undefined>>,
): Record<string, string>;

export function privatePgCommandEnvironment(
  source?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined>;

export function isolatedRuntimeEvidenceKeys(ownedTestDbDirectoryKey: string): Set<string>;

export function isolatedRuntimeInheritedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  evidenceKeys: ReadonlySet<string>,
): { environment: Record<string, string>; discardedKeys: string[] };
