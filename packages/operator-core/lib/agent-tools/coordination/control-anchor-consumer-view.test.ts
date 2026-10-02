/**
 * WI-10005199 (EI-23770243810745552) — the consumerView on a mode write's control-anchor
 * projection. The write target is `agent_modes`; the consumer reads
 * `session_briefs.control_state->modes`, and the refresh between them is fail-soft.
 */
import { describe, expect, it } from 'vitest';
import { attestModeControlConsumerView, MODES_CONSUMER_READ_PATH } from './control-anchor-consumer-view';

const anchor = (modes: string[]) => ({ generation: 4, state: { modes } });

describe('attestModeControlConsumerView', () => {
  it('names the path the consumer reads, not the write target', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: true }, anchor(['auto']));
    expect(view.readPath).toBe(MODES_CONSUMER_READ_PATH);
    expect(view.readPath).toContain('control_state');
    expect(view.readPath).not.toContain('agent_modes');
  });

  it('agrees when an enabled mode is present in the projected modes', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: true }, anchor(['auto', 'ideate']));
    expect(view.divergedFromWrite).toBe(false);
    expect(view.value).toEqual({ modeId: 'auto', present: true });
  });

  it('agrees when a cleared mode is absent from the projected modes', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: false }, anchor(['ideate']));
    expect(view.divergedFromWrite).toBe(false);
    expect(view.value).toEqual({ modeId: 'auto', present: false });
  });

  // The diverging fixtures: each is a write the agent_modes table accepted but the
  // consumer's read does not reflect.
  it('DIVERGES when an enabled mode never reached the projection', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: true }, anchor(['ideate']));
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toEqual({ modeId: 'auto', present: false });
  });

  it('DIVERGES when a cleared mode still lingers in the projection', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: false }, anchor(['auto']));
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toEqual({ modeId: 'auto', present: true });
  });

  it('DIVERGES — cannot prove agreement — when the fail-soft refresh returned null', () => {
    const view = attestModeControlConsumerView({ modeId: 'auto', enabled: true }, null);
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toEqual({ modeId: 'auto', present: null });
  });

  it('DIVERGES when the refreshed anchor carries no readable modes', () => {
    expect(attestModeControlConsumerView({ modeId: 'auto', enabled: true }, {}).divergedFromWrite).toBe(true);
    expect(attestModeControlConsumerView({ modeId: 'auto', enabled: true }, { state: null }).divergedFromWrite).toBe(true);
    expect(attestModeControlConsumerView({ modeId: 'auto', enabled: false }, { state: {} }).divergedFromWrite).toBe(true);
  });

  it('is not fooled by a clear + null refresh: absent-by-failure is not absent-by-agreement', () => {
    // A disable whose refresh failed must NOT read as "agrees, auto is absent" —
    // null (unknown) and false (known absent) are different observations.
    const failed = attestModeControlConsumerView({ modeId: 'auto', enabled: false }, null);
    const landed = attestModeControlConsumerView({ modeId: 'auto', enabled: false }, anchor([]));
    expect(failed.divergedFromWrite).toBe(true);
    expect(landed.divergedFromWrite).toBe(false);
  });
});
