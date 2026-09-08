import React from 'react';
import type { HostedDesktopViewerProps } from '../../app/cloud-workspaces/HostedDesktopViewer';

/** Explicit local viewer stand-in: visual state evidence, never remote-control proof. */
export function HostedDesktopViewer(props: HostedDesktopViewerProps) {
  return <section aria-label="Fixture desktop viewer">
    <div data-ready-fixture style={{ minHeight: 360, background: '#203450', color: '#ffffff', padding: 24 }}>
      <h2>Controlled desktop image</h2>
      <p>Fixture pixels · no live screen or cloud connection</p>
    </div>
    <button disabled={!props.canTakeControl} onClick={() => props.onModeChange?.('takeover')}>Take control</button>
  </section>;
}
