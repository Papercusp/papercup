/** Preserve the operator API while native preloads share the portable implementation. */
export {
  linuxStartTicksFromProcStat,
  linuxPpidFromProcStat,
  linuxPgrpFromProcStat,
  readProcessGroupId,
  linuxProcStateFromStat,
  linuxProcessIdentityFromStat,
  normalizePsStartTime,
  readProcessIdentity,
} from '../../../scripts/lib/process-identity.mjs';
