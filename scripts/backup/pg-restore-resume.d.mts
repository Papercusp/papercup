export function planPgRestoreResume(input: {
  toc: string;
  log: string;
  exitOnError: boolean;
  interrupted: boolean;
}): {
  protocol: 'pg18-interrupted-parallel-index-v1';
  tocSha256: string;
  logSha256: string;
  remainingList: string;
  completedIds: number[];
  remainingIds: number[];
  inFlightIds: number[];
};
