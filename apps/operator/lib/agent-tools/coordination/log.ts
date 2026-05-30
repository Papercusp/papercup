/**
 * log.ts — the operator's single FsCoordLog instance, wired to the
 * operator's coord-dir resolution (PAPERCUSP_COORD_DIR / repo-root, in
 * paths.ts). Every extracted channel module (messages, handoffs,
 * escalations, plan-events) reads/writes through this one seam, so a
 * future PG-backed CoordEventLog is a one-line swap here.
 *
 * (@papercusp/coordination P-011 host wiring.)
 */

import { FsCoordLog } from '@papercusp/coordination/event-log';
import { coordDir } from './paths';

export const coordLog = new FsCoordLog({ coordDir });
