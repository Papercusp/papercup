'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StepStatus } from './types';

interface PreflightCheck {
  name: string;
  status: 'ok' | 'missing' | 'error';
  detail?: string;
  hint?: string;
  optional?: boolean;
}

interface PreflightResponse {
  ok: boolean;
  checks: PreflightCheck[];
}

interface PersistentState {
  step_status: Record<string, 'dismissed' | 'completed'>;
  last_visited_step?: string;
  finished_at?: string;
}

function preflightToStatus(c: PreflightCheck | undefined): StepStatus {
  if (!c) return 'unknown';
  if (c.status === 'ok') return 'ok';
  return 'needs-attention';
}

function mergeWithPersisted(
  detected: StepStatus,
  persisted: 'dismissed' | 'completed' | undefined,
): StepStatus {
  if (detected === 'ok') return 'ok';
  if (persisted === 'completed') return 'ok';
  if (persisted === 'dismissed') return 'skipped';
  return detected;
}

export function useWizardStatuses() {
  const [statuses, setStatuses] = useState<Record<string, StepStatus>>({});
  const [persisted, setPersisted] = useState<PersistentState>({ step_status: {} });
  const [voiceConfigured, setVoiceConfigured] = useState(false);

  const refreshAll = useCallback(async () => {
    try {
      const [preflightRes, persistedRes, voiceRes] = await Promise.all([
        fetch('/api/desktop/preflight', { cache: 'no-store' }),
        fetch('/api/desktop/setup-wizard-state', { cache: 'no-store' }),
        fetch('/api/desktop/voice-configured', { cache: 'no-store' }),
      ]);
      const preflight = (await preflightRes.json()) as PreflightResponse;
      const persistedJson = persistedRes.ok
        ? ((await persistedRes.json()) as PersistentState)
        : { step_status: {} };

      const byName = new Map(preflight.checks.map((c) => [c.name, c]));
      const claudeCheck = byName.get('claude');
      const ompCheck = byName.get('pi') ?? byName.get('omp');
      const pgCheck = byName.get('postgres');
      const detected: Record<string, StepStatus> = {
        'embedded-pg': preflightToStatus(pgCheck),
        agents:
          claudeCheck?.status === 'ok' || ompCheck?.status === 'ok' ? 'ok' : 'needs-attention',
      };

      const merged: Record<string, StepStatus> = {};
      const allIds = new Set([
        ...Object.keys(detected),
        ...Object.keys(persistedJson.step_status ?? {}),
      ]);
      for (const id of allIds) {
        merged[id] = mergeWithPersisted(
          detected[id] ?? 'unknown',
          persistedJson.step_status?.[id],
        );
      }
      setStatuses(merged);
      setPersisted(persistedJson);
      if (voiceRes.ok) {
        const j = (await voiceRes.json()) as { configured?: boolean };
        setVoiceConfigured(Boolean(j.configured));
      }
    } catch {
      // network failures leave statuses unchanged
    }
  }, []);

  const setStepPersistedStatus = useCallback(
    async (stepId: string, status: 'dismissed' | 'completed' | null) => {
      const body = { step_status: { [stepId]: status } };
      try {
        const r = await fetch('/api/desktop/setup-wizard-state', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (r.ok) await refreshAll();
      } catch {
        // ignore
      }
    },
    [refreshAll],
  );

  const setLastVisitedStep = useCallback(async (stepId: string) => {
    try {
      await fetch('/api/desktop/setup-wizard-state', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ last_visited_step: stepId }),
      });
    } catch {
      // ignore
    }
  }, []);

  return { statuses, persisted, voiceConfigured, refreshAll, setStepPersistedStatus, setLastVisitedStep };
}
