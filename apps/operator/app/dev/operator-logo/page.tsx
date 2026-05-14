'use client';

import { useMemo } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import styles from './logo-lab.module.css';

type CandidateId = 'sentinel' | 'iris' | 'plate';

const CANDIDATES: Array<{
  id: CandidateId;
  name: string;
  src: string;
  summary: string;
  bestFor: string;
  notes: string[];
}> = [
  {
    id: 'sentinel',
    name: 'Sentinel Cup',
    src: '/operator-logo/sentinel.svg',
    summary: 'Closest to papercusp: the cup silhouette becomes a watchful control orb.',
    bestFor: 'Best if you want Papercup to feel like the in-house sibling of papercusp itself.',
    notes: [
      'Strongest continuity with the existing mascot + wordmark language.',
      'Reads well as a sidebar badge or avatar chip.',
      'Feels friendly, but still futuristic enough for the operator shell.',
    ],
  },
  {
    id: 'iris',
    name: 'Relay Iris',
    src: '/operator-logo/iris.svg',
    summary: 'More control-room / scanning-station. The cup is embedded inside a lens.',
    bestFor: 'Best if Papercup should feel more tactical, observant, and command-driven.',
    notes: [
      'Most futuristic of the three.',
      'Strong shape for dock bubbles, overlays, and HUD-like status pills.',
      'Slightly less “papercup mascot” and more “operator subsystem”.',
    ],
  },
  {
    id: 'plate',
    name: 'Command Plate',
    src: '/operator-logo/plate.svg',
    summary: 'A more app-icon / system-utility direction with a heavier chassis.',
    bestFor: 'Best if you want Papercup to feel like a persistent product surface, not a character.',
    notes: [
      'Strongest desktop / app icon candidate.',
      'Feels premium and structural on dark chrome.',
      'Most serious; least mascot-like.',
    ],
  },
];

export default function OperatorLogoLabPage() {
  const [candidateId, setCandidateId] = useQueryState(
    'candidate',
    parseAsStringEnum<CandidateId>(['sentinel', 'iris', 'plate']).withDefault('sentinel'),
  );

  const active = useMemo(
    () => CANDIDATES.find((candidate) => candidate.id === candidateId) ?? CANDIDATES[0],
    [candidateId],
  );

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div>
          <div className={styles.eyebrow}>Papercup logo lab</div>
          <h1 className={styles.title}>Three Papercup logo directions</h1>
          <p className={styles.subtitle}>
            These are intentionally aligned to the papercusp palette: dark metallic shell,
            cyan control-light, and a cup/cusp reference so Operator still feels like part of
            the same family.
          </p>
        </div>
        <div className={styles.heroMeta}>
          <div>
            <span className={styles.metaLabel}>Route</span>
            <code>/dev/operator-logo</code>
          </div>
          <div>
            <span className={styles.metaLabel}>Selected</span>
            <strong>{active.name}</strong>
          </div>
        </div>
      </div>

      <div className={styles.layout}>
        <section className={styles.gallery}>
          {CANDIDATES.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => setCandidateId(candidate.id)}
              className={`${styles.card} ${candidate.id === active.id ? styles.cardActive : ''}`}
            >
              <div className={styles.cardPreview}>
                <img src={candidate.src} alt={candidate.name} className={styles.cardLogo} />
              </div>
              <div className={styles.cardBody}>
                <div className={styles.cardTopline}>
                  <strong>{candidate.name}</strong>
                  {candidate.id === active.id && <span className={styles.activePill}>Selected</span>}
                </div>
                <p>{candidate.summary}</p>
              </div>
            </button>
          ))}
        </section>

        <section className={styles.detailPanel}>
          <div className={styles.detailHeader}>
            <div className={styles.detailHeroLogoWrap}>
              <img src={active.src} alt={active.name} className={styles.detailHeroLogo} />
            </div>
            <div className={styles.detailCopy}>
              <div className={styles.eyebrow}>Active concept</div>
              <h2>{active.name}</h2>
              <p>{active.summary}</p>
              <p className={styles.bestFor}>{active.bestFor}</p>
              <a href={active.src} target="_blank" rel="noreferrer" className={styles.downloadLink}>
                Open SVG
              </a>
            </div>
          </div>

          <div className={styles.contextGrid}>
            <div className={styles.contextCard}>
              <div className={styles.contextLabel}>Sidebar badge</div>
              <div className={styles.badgeMock}>
                <div className={styles.badgeIconWrap}>
                  <img src={active.src} alt="" className={styles.badgeIcon} />
                </div>
                <div>
                  <div className={styles.badgeTitle}>Papercup</div>
                  <div className={styles.badgeHint}>Workspace assistant</div>
                </div>
              </div>
            </div>

            <div className={styles.contextCard}>
              <div className={styles.contextLabel}>Dock / floating icon</div>
              <div className={styles.orbMock}>
                <img src={active.src} alt="" className={styles.orbIcon} />
              </div>
            </div>

            <div className={styles.contextCard}>
              <div className={styles.contextLabel}>App icon / tile</div>
              <div className={styles.tileMock}>
                <img src={active.src} alt="" className={styles.tileIcon} />
              </div>
            </div>

            <div className={styles.contextCard}>
              <div className={styles.contextLabel}>Header chip</div>
              <div className={styles.headerMock}>
                <img src={active.src} alt="" className={styles.headerIcon} />
                <span>Papercup</span>
                <span className={styles.headerStatus}>active</span>
              </div>
            </div>
          </div>

          <div className={styles.notesPanel}>
            <div className={styles.contextLabel}>Why this direction works</div>
            <ul>
              {active.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
