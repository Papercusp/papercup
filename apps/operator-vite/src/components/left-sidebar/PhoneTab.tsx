/**
 * The Phone rail tab — the self-hosted call plane's live state.
 *
 * [owner 2026-08-30, verbatim: "add a phone button to the sidebar"] — WI-1403107.
 *
 * WHAT THIS PANE IS ALLOWED TO CLAIM, and why that boundary is drawn hard:
 * plan phone-app-2026-08-30 has a working media plane (P-002 — LiveKit server
 * + SIP gateway on our own infra) and a working agent worker (P-004 — measured
 * at p50 1226ms speech-to-speech, under the 1.5s bar, D-015), but NO PHONE
 * NUMBER. P-003 is owner-gated on a carrier account that does not exist yet, so
 * nothing here can currently ring.
 *
 * That makes the honest failure mode of this pane obvious: a nav entry called
 * "Phone" invites the reading "the phone works", and a pane full of green
 * checks would confirm it. So the pane reports what systemd actually says about
 * the units, and states the PSTN wall as its own row rather than leaving a
 * reader to infer capability from two green lights.
 *
 * Every status here is DERIVED (`phone.plane` → `probeUnitStates`, the same
 * reader `dev:service_health` uses). Nothing about which services exist or
 * whether they are up is written down in this file — that would be a second
 * copy of a truth the units own, and it would go stale silently.
 */
import { Phone } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import RailSection from './RailSection';

/** One row of the `phone.plane` sync query. Mirrors the resolver's projection. */
interface PlaneUnit {
  id: string;
  unit: string;
  role: string;
  /** systemd LOADED the unit. FALSE means it has never heard of it. */
  known: boolean;
  activeState: string;
  subState: string | null;
  up: boolean;
  unknownUnit: boolean;
}

export interface PhoneTabProps {
  /** LeftSidebar renders every tab; only the active one should do work. */
  active?: boolean;
}

/**
 * The status word for one unit.
 *
 * `known` is checked BEFORE `activeState` on purpose. systemd answers
 * `inactive` for a unit it has never heard of, which is byte-identical to its
 * answer for a unit that is installed and stopped — so reading activeState
 * first would render a renamed or typo'd unit as a service that is merely
 * down, and send a reader to restart something that does not exist.
 */
export function unitStatusLabel(u: Pick<PlaneUnit, 'known' | 'activeState' | 'up'>): string {
  if (!u.known) return 'not installed';
  if (u.up) return 'running';
  return u.activeState || 'unknown';
}

export default function PhoneTab({ active = true }: PhoneTabProps = {}) {
  // Gate the fetch on `active`: LeftSidebar mounts panes for tabs the user is
  // not looking at, and this resolver shells out to systemd.
  const { data: rows, error } = useSyncQuery(
    active ? { queryName: 'phone.plane' } : { queryName: 'phone.plane', enabled: false },
  );
  const units = (rows as PlaneUnit[] | undefined) ?? [];

  return (
    <div className="pclsb-panel" data-testid="phone-tab">
      <RailSection icon={Phone} title="Call plane" defaultOpen>
        {error && units.length === 0 && (
          <div className="pclsb-panel__error">
            plane status unavailable: {error instanceof Error ? error.message : String(error)}
          </div>
        )}

        {!error && units.length === 0 && (
          // Distinct from "everything is down": the query has not answered yet.
          <div className="pclsb-row" data-testid="phone-plane-pending">
            <span className="pclsb-row__label">reading systemd…</span>
          </div>
        )}

        {units.map((u) => (
          <div className="pclsb-row" key={u.id} data-testid={`phone-unit-${u.id}`}>
            <span className="pclsb-row__label">{u.role}</span>
            <span
              className="pclsb-row__value"
              data-up={u.up ? 'true' : 'false'}
              data-known={u.known ? 'true' : 'false'}
              title={u.unit}
            >
              {unitStatusLabel(u)}
              {u.subState && u.up ? ` (${u.subState})` : ''}
            </span>
          </div>
        ))}
      </RailSection>

      {/*
        NOT a status row — a capability wall, and the reason this pane exists in
        this shape. Both units above can be green while no call can be placed or
        received, because there is no number. Stating it here is what stops the
        green lights from being read as "the phone works".
      */}
      <RailSection icon={Phone} title="Phone number" defaultOpen>
        <div className="pclsb-row" data-testid="phone-pstn-wall">
          <span className="pclsb-row__label">PSTN</span>
          <span className="pclsb-row__value" data-up="false">
            not provisioned
          </span>
        </div>
        <div className="pclsb-panel__hint">
          The call plane runs on our own infra and the agent answers on it, but there is no
          carrier trunk yet — so calls work browser-to-browser and not over the phone network.
          Provisioning a number needs an owner-created carrier account (plan
          phone-app-2026-08-30, P-003).
        </div>
      </RailSection>
    </div>
  );
}
