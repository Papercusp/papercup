export interface ProcRow {
  pid: number;
  ppid: number | null;
  cmdline: string;
}

export function parseCmdline(raw: Buffer | string): string;
export function parsePpid(statLine: string): number | null;
export function listProcesses(procRoot?: string): ProcRow[];
export function getAncestryChain(pid: number, byPid: Map<number, number | null>, maxHops?: number): Set<number>;
export function matchExternalProcesses(
  pattern: string,
  opts?: { procRoot?: string; selfPid?: number },
): ProcRow[];
