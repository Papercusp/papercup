/**
 * Consumer attestation for the control-anchor projection of a mode write
 * (WI-10005199, generalizing EI-23770243810745552).
 *
 * `mode:set` commits to `harness_shared.agent_modes`, then PROJECTS the result into
 * `session_briefs.control_state` via `refreshControlAnchorAfterMutation` — which is
 * fail-soft by design (a bounded timeout or a lock failure returns `null` rather
 * than rolling back the committed mode write). The turn-start hook and the
 * kernel/dispatch seat read `control_state->modes`, not `agent_modes`, so a mode
 * write whose projection did not land reports `ok` while the consumer still sees
 * the OLD modes — exactly the "write landed, consumer sees something else" class.
 *
 * This compares what the write intended (the mode is present, or absent after a
 * clear) with what that projected read returned. A refresh that returned nothing
 * readable is reported as diverged: an attestation that cannot prove agreement must
 * not claim it (see `buildConsumerView`).
 *
 * Leaf on purpose: no runtime imports beyond the shared consumer-view primitive, so
 * `mode:set` (and `loop:arm`, the sibling write) can attest without importing the
 * 1,600-line control-anchor graph.
 */
import { buildConsumerView, type ConsumerView } from '../../consumer-view';

/** The path the consumer reads for the mode set — NOT `agent_modes`, the write target. */
export const MODES_CONSUMER_READ_PATH = 'harness_shared.session_briefs.control_state->modes';

/**
 * The slice of a refreshed `ControlAnchor` the attestation needs. Structural (every
 * field optional) so a refresh result that came back without a readable state —
 * `null`, or an anchor with no `state` — is a representable, attestable outcome
 * rather than a TypeError.
 */
export interface RefreshedModesView {
  state?: { modes?: readonly string[] } | null;
}

export interface ModeConsumerObservation {
  modeId: string;
  /** `null` = the consumer read returned nothing readable (refresh failed/timed out). */
  present: boolean | null;
}

export function attestModeControlConsumerView(
  intent: { modeId: string; enabled: boolean },
  refreshed: RefreshedModesView | null,
): ConsumerView<ModeConsumerObservation> {
  const modes = refreshed?.state?.modes;
  return buildConsumerView<ModeConsumerObservation>({
    readPath: MODES_CONSUMER_READ_PATH,
    written: { modeId: intent.modeId, present: intent.enabled },
    consumed: { modeId: intent.modeId, present: Array.isArray(modes) ? modes.includes(intent.modeId) : null },
  });
}
