'use client';

/**
 * /settings/omp-integration — P-012 of desktop-app-install-integration-2026-05-23.
 *
 * Opt-in engineer-collaborator wiring for OMP. Reads state from
 * GET /api/desktop/install/omp-integration; POST installs/re-installs,
 * DELETE uninstalls. Phase 1 (papercusp-files) runs automatically at
 * sidecar boot when PAPERCUSP_DESKTOP=1; this tile is purely for the
 * opt-in OMP-config wiring (Phase 2).
 */

import { useCallback, useEffect, useState } from 'react';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';

interface OmpIntegrationState {
  ompAgentDir: string;
  mcpJsonPath: string;
  legacyContextPath: string;
  legacyExtensionPath: string;
  ompAgentDirExists: boolean;
  ompBinaryPath: string | null;
  mcpServerInstalled: boolean;
  wrapperInstalled: boolean;
  wrapperPath: string;
  legacyBlockPresent: boolean;
  pathWarning: string | null;
}

interface InstallResponseBody extends OmpIntegrationState {
  ok: boolean;
  supported?: boolean;
  reason?: string;
  changed?: boolean;
  actions?: string[];
  error?: string;
}

type ActionState = 'idle' | 'installing' | 'uninstalling';

export default function OmpIntegrationSettingsPage() {
  const [state, setState] = useState<OmpIntegrationState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>('idle');
  const [actionResult, setActionResult] = useState<{ kind: 'ok' | 'error'; message: string; actions?: string[] } | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await fetch('/api/desktop/install/omp-integration');
      const d = (await r.json()) as InstallResponseBody;
      if (!d.ok) throw new Error(d.error ?? 'failed to load');
      setState(d);
    } catch (err) {
      setLoadError((err as Error).message ?? String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const install = useCallback(async () => {
    setAction('installing');
    setActionResult(null);
    try {
      const r = await fetch('/api/desktop/install/omp-integration', { method: 'POST' });
      const d = (await r.json()) as InstallResponseBody;
      if (!d.ok) throw new Error(d.error ?? 'install failed');
      const actions = d.actions ?? [];
      setActionResult({
        kind: 'ok',
        message: d.changed === false
          ? 'Already installed — no changes needed.'
          : `Installed (${actions.length} action${actions.length === 1 ? '' : 's'}).`,
        actions,
      });
      await refresh();
    } catch (err) {
      setActionResult({ kind: 'error', message: (err as Error).message ?? String(err) });
    } finally {
      setAction('idle');
    }
  }, [refresh]);

  const uninstall = useCallback(async () => {
    if (!await askConfirm({
      title: 'Uninstall OMP integration?',
      body: 'This removes the papercusp-su MCP entry and the omp-su wrapper.',
      confirmLabel: 'Uninstall',
      destructive: true,
    })) return;
    setAction('uninstalling');
    setActionResult(null);
    try {
      const r = await fetch('/api/desktop/install/omp-integration', { method: 'DELETE' });
      const d = (await r.json()) as InstallResponseBody;
      if (!d.ok) throw new Error(d.error ?? 'uninstall failed');
      const actions = d.actions ?? [];
      setActionResult({
        kind: 'ok',
        message: actions.length === 0 ? 'Nothing to uninstall.' : `Uninstalled (${actions.length} action${actions.length === 1 ? '' : 's'}).`,
        actions,
      });
      await refresh();
    } catch (err) {
      setActionResult({ kind: 'error', message: (err as Error).message ?? String(err) });
    } finally {
      setAction('idle');
    }
  }, [askConfirm, refresh]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {confirmEl}
      <header style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
        <h1>OMP integration</h1>
        <p className="pc-settings-intro" style={{ marginBottom: 0 }}>
          Wires Papercusp into your local OMP (oh-my-pi) install so <code>omp-su</code> launches OMP in
          engineer-collaborator mode (playbook + coordination extension + this operator as an MCP server).
          Plain <code>omp</code> stays vanilla.
        </p>
      </header>

      {loadError && (
        <div role="alert" style={{ color: 'var(--danger, #c00)' }}>Failed to load state: {loadError}</div>
      )}

      {state && (
        <>
          <section style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', alignItems: 'center' }}>
            <strong>OMP detected:</strong>
            <span>{state.ompBinaryPath ? <code>{state.ompBinaryPath}</code> : <em style={{ color: 'var(--muted)' }}>Not found on PATH</em>}</span>

            <strong>OMP agent dir:</strong>
            <span>
              <code>{state.ompAgentDir}</code>{' '}
              {state.ompAgentDirExists ? <span style={{ color: 'var(--success, #060)' }}>✓ exists</span> : <em style={{ color: 'var(--muted)' }}>missing</em>}
            </span>

            <strong>MCP server in mcp.json:</strong>
            <span>{state.mcpServerInstalled ? <span style={{ color: 'var(--success, #060)' }}>✓ installed</span> : <em style={{ color: 'var(--muted)' }}>not installed</em>}</span>

            <strong>omp-su wrapper:</strong>
            <span>
              <code>{state.wrapperPath}</code>{' '}
              {state.wrapperInstalled ? <span style={{ color: 'var(--success, #060)' }}>✓ installed</span> : <em style={{ color: 'var(--muted)' }}>not installed</em>}
            </span>

            <strong>Legacy CLAUDE.md block:</strong>
            <span>{state.legacyBlockPresent ? <em style={{ color: 'var(--warn, #b80)' }}>present — will be stripped on install</em> : <span>none</span>}</span>
          </section>

          {state.pathWarning && (
            <div role="alert" style={{ color: 'var(--warn, #b80)' }}>{state.pathWarning}</div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={install}
              disabled={action !== 'idle'}
              className="pc-button-primary"
            >
              {action === 'installing' ? 'Installing…' : (state.mcpServerInstalled || state.wrapperInstalled ? 'Re-install' : 'Install')}
            </button>
            <button
              type="button"
              onClick={uninstall}
              disabled={action !== 'idle' || (!state.mcpServerInstalled && !state.wrapperInstalled)}
              className="pc-button"
            >
              {action === 'uninstalling' ? 'Uninstalling…' : 'Uninstall'}
            </button>
            <button type="button" onClick={() => void refresh()} disabled={action !== 'idle'} className="pc-button">
              Refresh
            </button>
          </div>

          {actionResult && (
            <div role="status" style={{ color: actionResult.kind === 'error' ? 'var(--danger, #c00)' : 'var(--text)' }}>
              <div>{actionResult.message}</div>
              {actionResult.actions && actionResult.actions.length > 0 && (
                <ul style={{ marginTop: 4 }}>
                  {actionResult.actions.map((a, i) => (
                    <li key={i}><code>{a}</code></li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
