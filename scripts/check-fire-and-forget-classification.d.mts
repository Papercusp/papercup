export interface NotifySite {
  id: string; path: string; line: number; context: string; expression: string;
  roots: string[]; mode: string;
  declaration?: Omit<NotifyClassification, 'id' | 'path'>;
}
export interface NotifyCensus {
  schemaVersion: number; files: { path: string; sha256: string }[];
  sites: NotifySite[]; gaps: { path: string; kind: string; message?: string }[];
}
export interface NotifyClassification {
  id: string; path: string; classification: string; reason: string;
  durablePath?: string; mandatory?: boolean;
}
export function inScope(path: string): boolean;
export function censusSources(sources: Record<string, string>): NotifyCensus;
/** D-018: `judged` = repo-relative paths of the change under review; null judges every file. */
export interface ClassificationScope { judged?: Set<string> | null }
export interface ClassificationReport { errors: string[]; drift: { unclassified: string[]; stale: string[] } }
export function classificationReport(census: NotifyCensus, records: NotifyClassification[], seedIds?: string[], options?: ClassificationScope): ClassificationReport;
export function validateClassifications(census: NotifyCensus, records: NotifyClassification[], seedIds?: string[], options?: ClassificationScope): string[];
export function changedSinceSeed(census: Pick<NotifyCensus, 'files'>, seedFiles: NotifyCensus['files']): Set<string>;
export function resolveJudgedScope(argv: string[], context: { census: Pick<NotifyCensus, 'files'>; seedFiles?: NotifyCensus['files'] | null; root?: string }): { mode: 'all' | 'changed-paths' | 'seed-pin'; judged: Set<string> | null };
export function scanRepository(cwd?: string): NotifyCensus & { coverage: unknown; sourceDigest: string };
export const BASELINE_SEED_SHA256: string;
export function inlineClassifications(census: NotifyCensus): NotifyClassification[];
export function validateSeed(registry: { seedIds: string[]; records: NotifyClassification[] }, expectedHash?: string): string[];
export function seedClassifications(census: NotifyCensus & { sourceDigest: string; coverage?: unknown }): {
  schemaVersion: number; policy: string; seedSourceDigest: string; seedCensusDigest: string;
  seedFiles: NotifyCensus['files']; seedCoverage: unknown; seedIds: string[];
  records: (NotifyClassification & { deliveryState: string })[];
};
