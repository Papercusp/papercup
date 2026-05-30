/**
 * @papercusp/coordination/core — the pure, host-agnostic protocol layer.
 * Zero I/O (no fs, no DB), identity-free (receives resolved owner-id
 * strings, never a host ctx). Everything here is unit-testable in
 * isolation and shared by both storage seams (event-log, presence) and
 * the host.
 */

export {
  type CoordKind,
  type CoordEnvelope,
  newMsgId,
  compareByTsThenId,
} from './envelope';
export { type WatchTrigger, patternToRegex, matchesPattern } from './glob';
export {
  type Watermark,
  emptyWatermark,
  normaliseWatermark,
  mergeWatermark,
} from './watermark';
export { foldThread } from './thread';
export { type InboxOptions, filterInbox } from './inbox';
export {
  type OpenHandoffInput,
  type HandoffRecord,
  type HandoffWithAcceptance,
  isHandoffRecord,
  foldHandoffs,
} from './handoffs';
export {
  type EscalationSeverity,
  type EscalationOption,
  type OpenEscalationInput,
  type ResolveInput,
  type EscalationRecord,
  type EscalationResolvedEvent,
  foldResolved,
  indexResolves,
  foldEscalations,
} from './escalations';
export {
  type PlanEventType,
  type ReadPlanEventsOpts,
  filterPlanEvents,
} from './plan-events';
export { findUnknownFromItems } from './promote';
