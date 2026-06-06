'use client';

import type { CSSProperties } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import styles from './swarm-identity.module.css';

type DirectionId = 'crown' | 'signal' | 'blackcomb' | 'sentinel' | 'eclipse';

type Direction = {
  id: DirectionId;
  name: string;
  stance: string;
  mood: string;
  colors: string[];
  operator: string;
  queen: string;
  note: string;
};

const TAGLINE = 'Welcome to the End. Be part of the new beginning. Create or Join a swarm and watch the world change.';
const TAGLINE_SEQUENCE = [
  'Welcome to the End.',
  'Be part of the new beginning.',
  'Create or Join a swarm and watch the world change.',
] as const;

const DIRECTIONS: Direction[] = [
  {
    id: 'crown',
    name: 'Crown Swarm',
    stance: 'Regal, ominous, premium',
    mood: 'The Queen is a command intelligence inside a black-gold swarm.',
    colors: ['#070704', '#131008', '#D99A18', '#FFE08A', '#7A1C1C'],
    operator: 'Guard Bee',
    queen: 'Queen',
    note: 'Best if we want the bee metaphor to stay explicit and high-status.',
  },
  {
    id: 'signal',
    name: 'The Signal',
    stance: 'Cryptic, networked, inevitable',
    mood: 'The swarm follows a pulse. Bees become nodes in a dark transmission field.',
    colors: ['#050609', '#0D1411', '#F3B232', '#7DD3FC', '#A3E635'],
    operator: 'Signal Bee',
    queen: 'Queen',
    note: 'Best if the product should feel more technical than biological.',
  },
  {
    id: 'blackcomb',
    name: 'Black Comb',
    stance: 'Industrial, sharp, dev-tool serious',
    mood: 'A machine honeycomb: exact hexes, black wax, amber compute light.',
    colors: ['#080806', '#17130A', '#EAB308', '#FDE68A', '#78716C'],
    operator: 'Guard Bee',
    queen: 'Queen',
    note: 'Best fit for a dark-first desktop coding tool.',
  },
  {
    id: 'sentinel',
    name: 'Sentinel Swarm',
    stance: 'Watchful, tactical, always-on',
    mood: 'The operator is the perimeter: alert, cheaper, tireless, ready to wake the Queen.',
    colors: ['#050505', '#111827', '#F59E0B', '#FB7185', '#CBD5E1'],
    operator: 'Sentinel Bee',
    queen: 'Queen',
    note: 'Best if we want the operator role to be immediately legible.',
  },
  {
    id: 'eclipse',
    name: 'Eclipse Hive',
    stance: 'Apocalyptic, cinematic, memorable',
    mood: 'The swarm moves across the sun. The world changes after the Queen wakes.',
    colors: ['#030303', '#180C07', '#FFB020', '#FF5A1F', '#FFF1B8'],
    operator: 'Harbinger Bee',
    queen: 'Queen',
    note: 'Best for the website hero if we want maximum ominous energy.',
  },
];

export default function SwarmIdentityPage() {
  const [selected, setSelected] = useQueryState(
    'direction',
    parseAsStringEnum<DirectionId>(DIRECTIONS.map((d) => d.id) as [DirectionId, ...DirectionId[]]).withDefault('blackcomb'),
  );
  const active = DIRECTIONS.find((d) => d.id === selected) ?? DIRECTIONS[2];

  return (
    <main className={styles.page}>
      <section className={styles.introSequence} aria-label={TAGLINE}>
        <div className={styles.introComb} aria-hidden="true" />
        <div className={styles.introLines} aria-hidden="true">
          {TAGLINE_SEQUENCE.map((line, index) => (
            <span key={line} style={{ '--intro-index': index } as CSSProperties}>
              {line}
            </span>
          ))}
        </div>
        <div className={styles.introSwarm} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </section>

      <div className={styles.contentReveal}>
        <section className={`${styles.hero} ${styles[active.id]}`}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>theswarm.dev identity lab</span>
            <h1>The Swarm</h1>
            <p>{TAGLINE}</p>
            <div className={styles.lexicon}>
              <span><strong>Queen</strong> brain</span>
              <span><strong>{active.operator}</strong> operator</span>
              <span><strong>Keepers</strong> humans</span>
              <span><strong>Bees</strong> agents</span>
            </div>
          </div>
          <HeroLogo direction={active.id} />
        </section>

        <section className={styles.switcher} aria-label="Swarm identity directions">
          {DIRECTIONS.map((direction) => (
            <button
              key={direction.id}
              type="button"
              className={direction.id === active.id ? styles.activeButton : undefined}
              onClick={() => setSelected(direction.id)}
            >
              <span>{direction.name}</span>
              <small>{direction.stance}</small>
            </button>
          ))}
        </section>

        <section className={`${styles.optionDetail} ${styles[active.id]}`}>
          <div className={styles.optionHeader}>
            <div>
              <span className={styles.eyebrow}>Selected direction</span>
              <h2>{active.name}</h2>
              <p>{active.mood}</p>
            </div>
            <div className={styles.palette} aria-label={`${active.name} palette`}>
              {active.colors.map((color) => (
                <span key={color} style={{ background: color }} title={color} />
              ))}
            </div>
          </div>

          <div className={styles.detailGrid}>
            <article className={styles.logoCard}>
              <div className={styles.cardHeader}>
                <span>Primary mark</span>
                <code>SVG / app icon candidate</code>
              </div>
              <HeroLogo direction={active.id} compact />
            </article>

            <article className={styles.wordmarkCard}>
              <div className={styles.cardHeader}>
                <span>Wordmark</span>
                <code>theswarm.dev</code>
              </div>
              <div className={styles.wordmark}>
                <LogoGlyph direction={active.id} />
                <div>
                  <strong>The Swarm</strong>
                  <span>{active.stance}</span>
                </div>
              </div>
              <p>{active.note}</p>
            </article>

            <article className={styles.websiteCard}>
              <div className={styles.cardHeader}>
                <span>Website hero treatment</span>
                <code>landing page</code>
              </div>
              <div className={styles.browserMock}>
                <div className={styles.browserTop}>
                  <span />
                  <span />
                  <span />
                  <code>https://theswarm.dev</code>
                </div>
                <div className={styles.browserBody}>
                  <span className={styles.miniEyebrow}>A new intelligence is forming</span>
                  <h3>Welcome to the End.</h3>
                  <p>Be part of the new beginning. Create or Join a swarm and watch the world change.</p>
                  <div className={styles.browserActions}>
                    <button type="button">Create a swarm</button>
                    <button type="button">Join a swarm</button>
                  </div>
                </div>
              </div>
            </article>

            <article className={styles.appCard}>
              <div className={styles.cardHeader}>
                <span>App chrome treatment</span>
                <code>desktop shell</code>
              </div>
              <div className={styles.appMock}>
                <aside>
                  <div className={styles.appBrand}><LogoGlyph direction={active.id} /> The Swarm</div>
                  <span>Hive</span>
                  <span>Swarm</span>
                  <span>{active.operator}</span>
                  <span>Comb</span>
                </aside>
                <div className={styles.appPanel}>
                  <div className={styles.statusLine}>
                    <strong>{active.queen}</strong>
                    <span>thinking</span>
                  </div>
                  <div className={styles.hexRows}>
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <p>{active.operator} is online. The Queen wakes when judgment is required.</p>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section className={styles.compareGrid}>
          {DIRECTIONS.map((direction) => (
            <article key={direction.id} className={`${styles.compareCard} ${styles[direction.id]}`}>
              <LogoGlyph direction={direction.id} />
              <h3>{direction.name}</h3>
              <p>{direction.note}</p>
              <div className={styles.palette}>
                {direction.colors.map((color) => (
                  <span key={color} style={{ background: color }} title={color} />
                ))}
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}

function HeroLogo({ direction, compact = false }: { direction: DirectionId; compact?: boolean }) {
  return (
    <div className={compact ? styles.logoStageCompact : styles.logoStage} aria-label={`${direction} logo preview`}>
      <LogoGlyph direction={direction} />
      {!compact ? <div className={styles.orbit}><span /><span /><span /><span /><span /></div> : null}
    </div>
  );
}

function LogoGlyph({ direction }: { direction: DirectionId }) {
  if (direction === 'signal') return <SignalGlyph />;
  if (direction === 'sentinel') return <SentinelGlyph />;
  if (direction === 'eclipse') return <EclipseGlyph />;
  if (direction === 'crown') return <CrownGlyph />;
  return <BlackCombGlyph />;
}

function CrownGlyph() {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Crowned bee hex logo">
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      <path className={styles.markStroke} d="m48 61 14-22 18 20 18-20 14 22" />
      <path className={styles.wingLeft} d="M70 74C51 57 34 59 25 76c17 8 32 6 45-2Z" />
      <path className={styles.wingRight} d="M90 74c19-17 36-15 45 2-17 8-32 6-45-2Z" />
      <path className={styles.beeBody} d="M80 55c13 10 19 24 19 42 0 21-8 35-19 35S61 118 61 97c0-18 6-32 19-42Z" />
      <path className={styles.markStroke} d="M63 86h34M61 103h38" />
    </svg>
  );
}

function SignalGlyph() {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Signal bee logo">
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      <path className={styles.signalLine} d="M32 80h28l12-24 18 48 12-24h26" />
      <circle className={styles.node} cx="80" cy="80" r="21" />
      <path className={styles.markStroke} d="M80 42v76M54 57l52 46M106 57l-52 46" />
      <circle className={styles.markFill} cx="80" cy="80" r="8" />
    </svg>
  );
}

function BlackCombGlyph() {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Black comb logo">
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      <path className={styles.combCell} d="M80 35 104 49v28L80 91 56 77V49z" />
      <path className={styles.combCell} d="M55 79 79 93v28l-24 14-24-14V93z" />
      <path className={styles.combCell} d="M105 79 129 93v28l-24 14-24-14V93z" />
      <path className={styles.markStroke} d="M80 35v100M31 93l98 28M129 93l-98 28" />
    </svg>
  );
}

function SentinelGlyph() {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Sentinel bee shield logo">
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      <path className={styles.shield} d="M80 34 121 50v32c0 29-15 48-41 60-26-12-41-31-41-60V50z" />
      <path className={styles.wingLeft} d="M74 75C56 61 42 64 34 78c15 7 28 6 40-3Z" />
      <path className={styles.wingRight} d="M86 75c18-14 32-11 40 3-15 7-28 6-40-3Z" />
      <path className={styles.markStroke} d="M80 51v70M61 90h38" />
      <circle className={styles.dangerDot} cx="80" cy="79" r="7" />
    </svg>
  );
}

function EclipseGlyph() {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Eclipse swarm logo">
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      <circle className={styles.eclipseSun} cx="80" cy="78" r="42" />
      <circle className={styles.eclipseMoon} cx="94" cy="68" r="42" />
      <path className={styles.markStroke} d="M45 114c20-20 50-20 70 0M56 124c14-12 34-12 48 0" />
      <circle className={styles.markFill} cx="43" cy="58" r="4" />
      <circle className={styles.markFill} cx="61" cy="39" r="3" />
      <circle className={styles.markFill} cx="119" cy="100" r="4" />
    </svg>
  );
}
