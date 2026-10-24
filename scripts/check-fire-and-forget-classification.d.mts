export interface NotifySite {
  id: string; path: string; line: number; context: string; expression: string;
  roots: string[]; mode: string;
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
export function validateClassifications(census: NotifyCensus, records: NotifyClassification[], seedIds?: string[]): string[];
export function scanRepository(cwd?: string): NotifyCensus & { coverage: unknown; sourceDigest: string };
