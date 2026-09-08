import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HostedDesktopWorkspace, type DesktopSelection } from '../../app/cloud-workspaces/HostedDesktopWorkspace';

// Component/state evidence only. The test server substitutes the viewer module;
// it never loads a cloud connector, requests credentials or opens a real socket.
const state = new URL(location.href).searchParams.get('state') ?? 'disconnected';
const theme = new URL(location.href).searchParams.get('theme') ?? 'light';
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;
function Fixture() {
  const [selected, setSelected] = useState<DesktopSelection | null>(
    state === 'ready' ? { desktopSessionId: 'fixture-display-1', mode: 'watch' } : null,
  );
  return <main>
    <p role="note">Controlled {state} fixture · no real service connection</p>
    <HostedDesktopWorkspace
      hostName="Design acceptance fixture" workspaceId="fixture-workspace" hostId="fixture-host"
      routeLabel="fixture-route"
      bridge={state === 'disconnected' ? null : { requestRoster: () => true, requestThumbnail: () => true }}
      roster={state === 'ready' ? [{ desktopSessionId: 'fixture-display-1', displayNumber: 1,
        state: 'running', geometry: '1280x720', lastActiveAt: '2026-09-08T12:00:00Z' }] : []}
      rosterState={state === 'loading' ? 'loading' : state === 'error' ? 'error' : 'ready'}
      rosterError={state === 'error' ? 'Controlled roster error' : null} thumbnails={{}}
      selectedDesktop={selected} viewerState={state === 'ready' ? 'connected' : null}
      onSelectDesktop={setSelected} onViewerStateChange={() => {}}
    />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
