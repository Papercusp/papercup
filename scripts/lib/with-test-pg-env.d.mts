export function privatePgSeedEnvironment(
  source?: Readonly<Record<string, string | undefined>>,
): Record<string, string>;

export function isolatedRuntimeEvidenceKeys(ownedTestDbDirectoryKey: string): Set<string>;

export function isolatedRuntimeInheritedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  evidenceKeys: ReadonlySet<string>,
): { environment: Record<string, string>; discardedKeys: string[] };
