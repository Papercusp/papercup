'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * HiveHeaderStrip — the selected hive's "face" inside the Harnesses tab
 * (harnesses-tab-hive-model-2026-06-07 P-022).
 *
 * A compact header above the member dock summarising the hive the tab is
 * scoped to: its name, kind, member count (the Colony size), how many members
 * are set up (the rail's zero-new-poller `hasState` liveness signal), and the
 * share state. A deploy badge shows only when the hive carries a non-local
 * deployment (D-022 "deploy:status when deployed").
 *
 * Share (comb-hive-native-sharing-2026-06-11 P-004/P-005): a formal Hive home
 * (kind 'hive') carries a directory-state badge — Public / Invite / Private /
 * unpublished, read from the OWNED registry meta via /api/discovery/pot-meta
 * — and a **Share** button opening the ShareHiveDialog (visibility choice with
 * consequence copy, title/description, member repos, invite artifact). The
 * legacy `is_shared` (shared.json) badge remains only on non-hive pots until
 * O-2 resolves. The dialog open-state rides nuqs `?share=` (user-meaningful →
 * URL; agents drive it via ui:dispatch).
 *
 * Labels route through `useLexicon` (D-006 — "Pot"/"Hive", "Harness(es)",
 * "Fleet"/"Colony"); flag default off keeps the classic words. Member-count /
 * liveness facets derive purely from data the tab already loaded
 * (projects/lite + the P-021 grouping) — no new poller, consistent with the
 * member rail.
 *
 * v1 SCOPE NOTE: blueprint-id, LIVE Colony/Queen presence (coord), and live
 * deploy:status are intentionally NOT wired here yet — they need a per-hive
 * data source the registry/grouping payload doesn't carry (fleet presence is
 * keyed by agent, not hive). Tracked as a P-022 follow-up; this v1 ships the
 * facets that are correct + free from the loaded data rather than mis-attribute
 * fleet-wide presence to one hive.
 */

import { useEffect, useState } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { Share2, Users, Cloud, Radio } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import {
  ShareHiveDialog,
  defaultFetchShareMeta,
  type HiveShareMeta,
  type HiveShareVisibility,
  type ShareHiveFormProps,
} from '@/app/harness/ShareHiveDialog';
import { useLexicon } from '@/lib/useLexicon';

export interface HiveHeaderMember {
  slug: string;
  hasState?: boolean;
}

/** The chrome's share state: registry-meta visibility, or never published. */
export type HiveDirectoryState = HiveShareVisibility | 'unpublished';

export interface HiveHeaderStripProps {
  /** The hive root slug (the `?slug=` scope). */
  potSlug: string;
  /** The hive root's kind, if any (`'hive'` ⇒ a formal Hive home). */
  hiveKind?: string | null;
  /** Whether the hive root is a shared harness (LEGACY shared.json signal —
   *  rendered only for non-hive pots until O-2 resolves). */
  isShared?: boolean;
  /** The hive's members (root + members), for the Colony count + liveness. */
  members: readonly HiveHeaderMember[];
  /** Truthy ⇒ the hive is deployed to a non-local execution plane (badge only). */
  deployed?: boolean;
  /**
   * P-005: the directory-state read seam — the OWNED registry meta behind the
   * Public/Invite/Private/unpublished badge. Tests inject; default GETs
   * /api/discovery/pot-meta. Only invoked for a formal Hive home.
   */
  fetchShareMeta?: (potSlug: string) => Promise<HiveShareMeta | null>;
  /** P-004: the Share-Hive dialog's write seam (tests inject). */
  setHiveListing?: ShareHiveFormProps['setHiveListing'];
  /**
   * B-07 / C-2: read the hive's current beacon-publish consent (absent = OFF).
   * Tests inject; default GETs /api/discovery/beacon-consent. Only invoked for a
   * formal Hive home (kind 'hive').
   */
  getBeaconConsent?: (potSlug: string) => Promise<boolean>;
  /**
   * B-07 / C-2: set the hive's beacon-publish consent — the secondary surface for
   * the publish-flow consent question. Tests inject; default POSTs
   * /api/discovery/beacon-consent.
   */
  setBeaconConsent?: (
    potSlug: string,
    consent: boolean,
  ) => Promise<{ ok: boolean; consent?: boolean; error?: string }>;
}

async function defaultGetBeaconConsent(potSlug: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/discovery/beacon-consent?potId=${encodeURIComponent(potSlug)}`);
    const body = (await res.json().catch(() => ({}))) as { consent?: boolean };
    return res.ok && body.consent === true;
  } catch {
    return false;
  }
}

async function defaultSetBeaconConsent(
  potSlug: string,
  consent: boolean,
): Promise<{ ok: boolean; consent?: boolean; error?: string }> {
  try {
    const res = await fetch('/api/discovery/beacon-consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ potId: potSlug, consent }),
    });
    const body = (await res.json().catch(() => ({}))) as { consent?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, consent: body.consent };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const DIRECTORY_STATE_LABEL: Record<HiveDirectoryState, string> = {
  public: 'Public',
  invite: 'Invite',
  private: 'Private',
  unpublished: 'Unpublished',
};

const DIRECTORY_STATE_TITLE: Record<HiveDirectoryState, string> = {
  public: 'Listed on the P2P directory — anyone can browse and join',
  invite: 'Announced invite-only — joining needs the invite link',
  private: 'Withdrawn from the directory',
  unpublished: 'Never published to the directory',
};

export default function HiveHeaderStrip({
  potSlug,
  hiveKind,
  isShared,
  members,
  deployed,
  fetchShareMeta = defaultFetchShareMeta,
  setHiveListing,
  getBeaconConsent = defaultGetBeaconConsent,
  setBeaconConsent = defaultSetBeaconConsent,
}: HiveHeaderStripProps) {
  const t = useLexicon();
  const isHiveHome = hiveKind === 'hive';
  // Injected readers are a test seam. Production reads come from the canonical
  // ID-scoped sync query so the header has one authoritative cache + push path.
  const beaconReadInjected = getBeaconConsent !== defaultGetBeaconConsent;
  const beaconQuery = useSyncQuery<{ potId: string; consent: boolean }>({
    queryName: 'hive.beaconConsent',
    args: { potId: potSlug },
    enabled: Boolean(potSlug && isHiveHome && !beaconReadInjected),
  });

  // The Share-Hive dialog open-state — user-meaningful → nuqs (`?share=`).
  const [shareOpen, setShareOpen] = useQueryState('share', parseAsBoolean.withDefault(false));

  // P-005: the directory-state chrome — read from the owned registry meta on
  // mount (null while loading), updated locally after a dialog save.
  const [dirState, setDirState] = useState<HiveDirectoryState | null>(null);
  useEffect(() => {
    if (!potSlug || !isHiveHome) return;
    let alive = true;
    void fetchShareMeta(potSlug)
      .then((meta) => {
        if (!alive) return;
        setDirState(meta?.found ? (meta.visibility ?? 'private') : 'unpublished');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [potSlug, isHiveHome, fetchShareMeta]);

  // B-07 / C-2: beacon-publish consent — read on mount (absent = OFF), toggled
  // here as the secondary surface for the publish-flow consent question. Only a
  // formal Hive home (kind 'hive') can publish a beacon, so it gates the same way
  // as the share surface.
  const [beacon, setBeacon] = useState<{ consent: boolean | null; busy: boolean; error?: string }>({
    consent: null,
    busy: false,
  });
  useEffect(() => {
    if (!potSlug || !isHiveHome || !beaconReadInjected) return;
    let alive = true;
    void getBeaconConsent(potSlug)
      .then((consent) => {
        if (alive) setBeacon((b) => ({ ...b, consent }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [potSlug, isHiveHome, beaconReadInjected, getBeaconConsent]);

  useEffect(() => {
    if (beaconReadInjected || !beaconQuery.data?.[0]) return;
    setBeacon((b) => ({ ...b, consent: beaconQuery.data![0].consent === true }));
  }, [beaconReadInjected, beaconQuery.data]);

  if (!potSlug) return null;

  async function toggleBeacon(): Promise<void> {
    const next = !(beacon.consent === true);
    setBeacon((b) => ({ ...b, busy: true, error: undefined }));
    const res = await setBeaconConsent(potSlug, next);
    setBeacon(
      res.ok
        ? { consent: res.consent ?? next, busy: false }
        : { consent: beacon.consent, busy: false, error: res.error ?? 'error' },
    );
    if (res.ok && !beaconReadInjected) beaconQuery.invalidate();
  }

  const hiveLabel = t('pot');
  const membersLabel = t('harness', { plural: true });
  const colonyLabel = t('fleet'); // "Fleet" | "Colony" — the live-agent collective (D-007)
  const memberCount = members.length;
  const setUp = members.filter((m) => m.hasState).length;

  return (
    <header className="pc-hive-header" data-testid="hive-header-strip" aria-label={`${hiveLabel} header`}>
      <div className="pc-hive-header__id">
        <span className="pc-hive-header__name" title={potSlug}>
          {potSlug}
        </span>
        {hiveKind === 'hive' ? (
          <span className="pc-hive-header__kind" title={`${hiveLabel} home`}>
            👑 {hiveLabel}
          </span>
        ) : hiveKind && hiveKind !== 'harness' ? (
          <span className="pc-hive-header__kind">{hiveKind}</span>
        ) : null}
        {/* P-005: the legacy shared.json badge survives ONLY on non-hive pots
            (O-2 keeps the dormant fall-through); a Hive home's share state is
            the directory-state badge below. */}
        {!isHiveHome && isShared && (
          <Share2 size={12} className="pc-hive-header__shared" aria-label="Shared" />
        )}
        {isHiveHome && dirState && (
          <span
            className={`pc-hive-header__dir pc-hive-header__dir--${dirState}`}
            data-testid="hive-directory-state"
            title={DIRECTORY_STATE_TITLE[dirState]}
          >
            {DIRECTORY_STATE_LABEL[dirState]}
          </span>
        )}
        {deployed && (
          <span className="pc-hive-header__deploy" title={`Deployed to a cloud ${t('node', { lower: true })}`}>
            <Cloud size={11} aria-hidden /> deployed
          </span>
        )}
      </div>
      <div className="pc-hive-header__stats">
        <span className="pc-hive-header__stat" title={`${memberCount} member ${membersLabel.toLowerCase()}`}>
          <Users size={12} aria-hidden />
          {memberCount} {memberCount === 1 ? t('harness') : membersLabel}
        </span>
        {memberCount > 0 && (
          <span
            className="pc-hive-header__stat pc-hive-header__stat--muted"
            title={`${setUp} of ${memberCount} set up (${colonyLabel.toLowerCase()} liveness)`}
          >
            {setUp}/{memberCount} set up
          </span>
        )}
        {/* P-004: the Share-Hive dialog replaces the flat visibility pills —
            one Share affordance, the explicit choice lives in the dialog. */}
        {isHiveHome && (
          <>
            <Tooltip label={`Share this ${hiveLabel.toLowerCase()} — choose who can find and join it`}><button
              type="button"
              className="pc-hive-header__viz-btn pc-hive-header__share-btn"
              data-testid="hive-share-button"

              onClick={() => void setShareOpen(true)}
            >
              <Share2 size={11} aria-hidden /> Share…
            </button></Tooltip>
            <ShareHiveDialog
              potSlug={potSlug}
              hiveLabel={hiveLabel.toLowerCase()}
              open={shareOpen}
              onOpenChange={(open) => void setShareOpen(open ? true : null)}
              onSaved={(visibility) => setDirState(visibility)}
              fetchShareMeta={fetchShareMeta}
              {...(setHiveListing ? { setHiveListing } : {})}
            />
          </>
        )}
        {/* B-07 / C-2: the beacon-publish consent — the publish-flow question,
            surfaced here as the standing toggle for an existing Hive (D-002:
            never ONLY a buried settings toggle, so the full question rides the
            control). Only a formal Hive home can publish a beacon. */}
        {isHiveHome && (
          <span
            className="pc-hive-header__stat pc-hive-header__beacon"
            data-testid="hive-beacon-consent"
            role="group"
            aria-label="Live status beacon"
          >
            <Radio size={12} aria-hidden />
            <span className="pc-hive-header__viz-label">
              also publish a live status beacon? (recommended for {hiveLabel.toLowerCase()}s you
              want collaborators to find)
            </span>
            <button
              type="button"
              className="pc-hive-header__viz-btn"
              data-testid="hive-beacon-toggle"
              aria-pressed={beacon.consent === true}
              disabled={beacon.busy}
              onClick={() => void toggleBeacon()}
            >
              {beacon.busy ? '…' : beacon.consent === true ? 'on' : 'off'}
            </button>
            {beacon.error && (
              <span className="pc-hive-header__stat--muted" data-testid="hive-beacon-error">
                failed: {beacon.error}
              </span>
            )}
          </span>
        )}
      </div>
      <HeaderStyles />
    </header>
  );
}

function HeaderStyles() {
  return (
    <style>{`
      .pc-hive-header {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 7px 12px;
        border-bottom: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 95%);
      }
      .pc-hive-header__id {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .pc-hive-header__name {
        font-size: 13px;
        font-weight: 680;
        color: var(--fg, #e7f7ff);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-hive-header__kind {
        flex: 0 0 auto;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        padding: 1px 7px;
        border-radius: 999px;
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
        color: var(--fg, #e7f7ff);
      }
      .pc-hive-header__shared { flex: 0 0 auto; color: var(--accent-strong, #7dd3fc); }
      .pc-hive-header__dir {
        flex: 0 0 auto;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        padding: 1px 7px;
        border-radius: 999px;
        border: 1px solid color-mix(in oklab, var(--fg-mute, #7f9bb4), transparent 60%);
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-hive-header__dir--public {
        border-color: color-mix(in oklab, var(--good, #34d399), transparent 55%);
        color: var(--good, #34d399);
      }
      .pc-hive-header__dir--invite {
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 55%);
        color: var(--accent-strong, #7dd3fc);
      }
      .pc-hive-header__deploy {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 10px;
        font-weight: 650;
        color: var(--good, #34d399);
      }
      .pc-hive-header__stats {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        flex: 0 0 auto;
      }
      .pc-hive-header__stat {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11.5px;
        font-weight: 600;
        color: var(--fg-dim, #b9d4e8);
        font-variant-numeric: tabular-nums;
      }
      .pc-hive-header__stat--muted { color: var(--fg-mute, #7f9bb4); font-weight: 500; }
      .pc-hive-header__viz-label {
        font-size: 10.5px;
        font-weight: 500;
        color: var(--fg-mute, #7f9bb4);
      }
      /* B-07: the beacon consent control carries the full question, so it wraps
         gracefully in the compact header rather than overflowing the row. */
      .pc-hive-header__beacon { flex-wrap: wrap; max-width: 420px; }
      .pc-hive-header__beacon .pc-hive-header__viz-label {
        max-width: 320px;
        white-space: normal;
        line-height: 1.35;
      }
      .pc-hive-header__viz-btn {
        padding: 1px 8px;
        font-size: 10.5px;
        font-weight: 600;
        color: var(--fg-dim, #b9d4e8);
        background: transparent;
        border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
        border-radius: 999px;
        cursor: pointer;
      }
      .pc-hive-header__viz-btn:hover:not(:disabled) {
        color: var(--fg, #e7f7ff);
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 45%);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 88%);
      }
      .pc-hive-header__viz-btn:disabled { opacity: 0.5; cursor: default; }
      .pc-hive-header__share-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
    `}</style>
  );
}
