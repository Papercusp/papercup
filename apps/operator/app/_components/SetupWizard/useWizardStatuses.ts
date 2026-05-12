'use client';

import { useCallback, useState } from 'react';
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

function preflightToStatus(c: PreflightCheck | undefined): StepStatus {
  if (!c) return 'unknown';
  if (c.status === 'ok') return 'ok';
  if (c.status === 'missing') return 'needs-attention';
  return 'needs-attention';
}

export function useWizardStatuses() {
  const [statuses, setStatuses] = useState<Record<string, StepStatus>>({});

  const refreshAll = useCallback(async () => {
    try {
      const res = await fetch('/api/desktop/preflight', { cache: 'no-store' });
      const json = (await res.json()) as PreflightResponse;
      const byName = new Map(json.checks.map((c) => [c.name, c]));
      const claudeCheck = byName.get('claude');
      const ompCheck = byName.get('pi') ?? byName.get('omp');
      const pgCheck = byName.get('postgres');
      const agentsStatus: StepStatus =
        claudeCheck?.status === 'ok' || ompCheck?.status === 'ok' ? 'ok' : 'needs-attention';
      setStatuses({
        'embedded-pg': preflightToStatus(pgCheck),
        agents: agentsStatus,
      });
    } catch {
      // network failures leave statuses as 'unknown'
    }
  }, []);

  return { statuses, refreshAll };
}
