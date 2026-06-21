'use client';

import type { CSSProperties } from 'react';
import RouteLink from './_components/RouteLink';
import { useLexicon } from '@/lib/useLexicon';

const frostCard: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  width: 'min(100%, 760px)',
  margin: '0 auto 0 0',
  padding: 'clamp(22px, 4vw, 38px)',
  border: '1px solid color-mix(in srgb, var(--accent-strong), transparent 74%)',
  borderRadius: 30,
  background:
    'radial-gradient(circle at 18% 10%, color-mix(in srgb, var(--accent-strong), transparent 84%), transparent 32%), linear-gradient(180deg, rgba(255,255,255,0.070), rgba(255,255,255,0.024)), color-mix(in srgb, var(--bg), transparent 22%)',
  boxShadow:
    '0 28px 90px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255,255,255,0.08)',
};

export default function NotFound() {
  const t = useLexicon();
  return (
    <div
      className="pc-shell"
      style={{
        minHeight: 'calc(100vh - 90px)',
        display: 'grid',
        placeItems: 'center start',
        paddingTop: 52,
        paddingBottom: 72,
      }}
    >
      <section style={frostCard} aria-labelledby="not-found-title">
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(120deg, rgba(255,255,255,0.055), transparent 28%, color-mix(in srgb, var(--accent-strong), transparent 94%) 58%, transparent 78%)',
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'clamp(22px, 4vw, 38px)',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'grid', placeItems: 'center', flex: '0 1 220px' }}>
            <div
              style={{
                position: 'relative',
                width: 'min(220px, 64vw)',
                aspectRatio: '1',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: '8%',
                  borderRadius: '50%',
                  background:
                    'radial-gradient(circle, color-mix(in srgb, var(--accent-soft), transparent 62%), color-mix(in srgb, var(--accent), transparent 90%) 48%, transparent 70%)',
                  filter: 'blur(6px)',
                }}
              />
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: '15% 10% auto',
                  height: 82,
                  borderRadius: '999px',
                  border: '1px solid color-mix(in srgb, var(--accent-strong), transparent 76%)',
                  background: 'color-mix(in srgb, var(--accent-strong), transparent 92%)',
                  transform: 'rotate(-8deg)',
                }}
              />
              <img
                src="/mascot.svg"
                alt="Papercusp cup mascot looking for the missing page"
                width={156}
                height={156}
                loading="lazy"
                style={{
                  position: 'relative',
                  zIndex: 1,
                  width: 'min(156px, 48vw)',
                  height: 'auto',
                  filter:
                    'drop-shadow(0 22px 34px rgba(0,0,0,0.34)) drop-shadow(0 0 20px color-mix(in srgb, var(--accent-strong), transparent 78%))',
                }}
              />
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  right: '5%',
                  top: '14%',
                  padding: '6px 10px',
                  border: '1px solid color-mix(in srgb, var(--accent-strong), transparent 72%)',
                  borderRadius: 999,
                  background: 'color-mix(in srgb, var(--bg), transparent 22%)',
                  color: 'var(--accent-cool)',
                  fontSize: 13,
                  fontWeight: 850,
                  boxShadow: '0 10px 26px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.06)',
                }}
              >
                404?
              </span>
            </div>
          </div>

          <div style={{ flex: '1 1 360px', minWidth: 0 }}>
            <p
              style={{
                margin: '0 0 12px',
                color: 'var(--accent-strong)',
                fontSize: 12,
                fontWeight: 850,
                letterSpacing: '0',
                textTransform: 'uppercase',
              }}
            >
              Tiny detour detected
            </p>
            <h1
              id="not-found-title"
              style={{
                margin: 0,
                color: 'var(--fg)',
                fontSize: 'clamp(36px, 5vw, 52px)',
                lineHeight: 0.98,
                fontWeight: 900,
                letterSpacing: '0',
                textShadow: '0 0 26px color-mix(in srgb, var(--accent-strong), transparent 86%)',
              }}
            >
              This page slipped past the cusp.
            </h1>
            <p
              style={{
                maxWidth: 500,
                margin: '18px 0 0',
                color: 'color-mix(in oklab, var(--fg-dim), white 8%)',
                fontSize: 'clamp(15px, 2vw, 17px)',
                lineHeight: 1.68,
              }}
            >
              Our little cup looked everywhere, but this route does not exist. Let’s get you back to a warm, working part of Papercusp.
            </p>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 26 }}>
              <RouteLink href="/harness" className="pc-button primary">
                Return to Mission Control
              </RouteLink>
              <RouteLink href="/cupboard" className="pc-button ghost">
                Browse the {t('cupboard')}
              </RouteLink>
              <RouteLink href="/support" className="pc-button ghost">
                Ask for help
              </RouteLink>
            </div>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                marginTop: 24,
                color: 'var(--fg-mute)',
                fontSize: 12,
              }}
            >
              <span style={chipStyle}>blue frost intact</span>
              <span style={chipStyle}>mascot on duty</span>
              <span style={chipStyle}>no crumbs found</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

const chipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 26,
  padding: '4px 9px',
  border: '1px solid color-mix(in srgb, var(--accent-strong), transparent 82%)',
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--accent-strong), transparent 93%)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.035)',
};
