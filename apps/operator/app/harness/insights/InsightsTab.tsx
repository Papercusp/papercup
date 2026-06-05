'use client';

/**
 * InsightsTab — Phase 8 P-073.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.0 — pinned-top sidebar tab; post-install default landing.
 *
 * Composes the six cards into the canonical Insights layout:
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │  ProjectCard (full width)                        │
 *   ├─────────────────────────┬───────────────────────┤
 *   │  ActivityFeedCard       │  YourPlaceCard         │
 *   │  (large left col)       │  (right col)           │
 *   ├─────────────────────────┼───────────────────────┤
 *   │  PeopleCard             │  SpendCard             │
 *   ├─────────────────────────┴───────────────────────┤
 *   │  HowItWorksHereCard (full width)                 │
 *   └─────────────────────────────────────────────────┘
 *
 * Pure UI; consumer feeds pre-computed props per card. P-073g
 * (force-route on first visit) is a separate wiring step in the
 * sidebar router — InsightsTab itself is render-only.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { InsightsTabProps } from '@papercusp/operator-core/lib/harness-insights/card-types';
import { ProjectCard, type ProjectCardProps } from './ProjectCard';
import {
  ActivityFeedCard,
  type ActivityFeedCardProps,
} from './ActivityFeedCard';
import { PeopleCard, type PeopleCardProps } from './PeopleCard';
import { YourPlaceCard, type YourPlaceCardProps } from './YourPlaceCard';
import {
  HowItWorksHereCard,
  type HowItWorksHereCardProps,
} from './HowItWorksHereCard';
import { SpendCard, type SpendCardProps } from './SpendCard';

const CONTAINER: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr',
  gap: 16,
  padding: 16,
};

const TWO_COL: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '2fr 1fr',
  gap: 16,
};

const ONE_COL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

export type { InsightsTabProps };

export function InsightsTab(props: InsightsTabProps): ReactNode {
  const { project, activity, people, yourPlace, howItWorks, spend } = props;
  return (
    <div style={CONTAINER} data-testid="insights-tab">
      <ProjectCard {...project} />
      <div style={TWO_COL}>
        <ActivityFeedCard {...activity} />
        <div style={ONE_COL}>
          <YourPlaceCard {...yourPlace} />
          <SpendCard {...spend} />
        </div>
      </div>
      <div style={TWO_COL}>
        <PeopleCard {...people} />
        {/* right slot reserved for future card; for now intentionally empty */}
        <div />
      </div>
      <HowItWorksHereCard {...howItWorks} />
    </div>
  );
}
