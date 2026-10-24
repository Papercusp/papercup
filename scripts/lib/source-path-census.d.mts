export type SourceSite = {
    path: string; start: number; end: number; byteStart: number; byteEnd: number;
    line: number; column: number; kind: string; typeOnly: boolean; expression: string;
    specifier: string | null; source: string; enclosingFunctions: string[];
    predicates: Array<{ condition: string; side: boolean; start: number; end: number }>;
    initialization: boolean; fingerprint: string;
    binding: { imported: string; specifiers: string[] } | null;
    calleeCoverage: string | null; node: import('typescript').Node;
};
export type SourceUnit = { path: string; sha256: string; ast: import('typescript').SourceFile;
    sites: SourceSite[]; span: (node: import('typescript').Node) => Record<string, number> };
export function censusSites(path: string, text: string): SourceUnit;
export function changedSites(before: SourceUnit, after: SourceUnit): {
    addedOrChanged: SourceSite[]; removedOrChanged: SourceSite[] };
export function selectSourcePath(unit: SourceUnit, options: { functionName: string; containerName?: string; branchValues?: Record<string, boolean> }): {
    selected: SourceSite[]; excluded: Array<{ site: SourceSite; reason: string; proof: unknown }> };
export function boundedFrontier(edges: Array<{ path?: string; [key: string]: unknown }>, options?: {
    baseline?: string[]; priorAdditions?: string[]; bound?: number }): {
    status: string; bound: number; additions: string[]; frontier: Array<Record<string, unknown>>;
    complete: false; refusedEdge?: Record<string, unknown>; pending?: Array<Record<string, unknown>> };
export function siteEvidence(site: SourceSite): Omit<SourceSite, 'node'> & { sourceSha256: string; sourceTruncated: boolean };
