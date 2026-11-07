export function linuxStartTicksFromProcStat(stat: string): string | null;
export function linuxPpidFromProcStat(stat: string): number | null;
export function linuxPgrpFromProcStat(stat: string): number | null;
export function readProcessGroupId(pid: number): number | null;
export function linuxProcStateFromStat(stat: string): string | null;
export function linuxProcessIdentityFromStat(bootId: string, stat: string): string | null;
export function normalizePsStartTime(value: string): string;
export function readProcessIdentity(pid: number): string | null;
