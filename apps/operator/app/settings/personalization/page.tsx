'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Select } from '../../harness/Select';
import {
  applyVisualEffectsMode,
  readVisualEffectsMode,
  subscribeVisualEffects,
  writeVisualEffectsMode,
  type VisualEffectsMode,
} from '@/lib/visual-effects';

const VISUAL_EFFECTS_OPTIONS: Array<{ value: VisualEffectsMode; label: string; description: string }> = [
  {
    value: 'system',
    label: 'System default',
    description: 'Use the OS reduced-motion preference. Full cinematic HUD effects stay on unless this device asks for less motion.',
  },
  {
    value: 'full',
    label: 'Full cinematic',
    description: 'Jump gates, scans, HUD sweeps, glow loops, and the full Papercusp wow effect.',
  },
  {
    value: 'minimal',
    label: 'Minimal / calm',
    description: 'Static chrome, no jump gate, no decorative scan loops, and reduced expensive motion.',
  },
];

export default function PersonalizationSettingsPage() {
  const [visualEffectsMode, setVisualEffectsMode] = useState<VisualEffectsMode>('system');

  useEffect(() => {
    const syncVisualEffects = () => {
      const mode = readVisualEffectsMode();
      setVisualEffectsMode(mode);
      applyVisualEffectsMode(mode);
    };

    syncVisualEffects();
    return subscribeVisualEffects(() => {
      setVisualEffectsMode(readVisualEffectsMode());
    });
  }, []);

  const setVisualEffectsPreference = useCallback((value: string) => {
    const mode = (VISUAL_EFFECTS_OPTIONS.some((opt) => opt.value === value) ? value : 'system') as VisualEffectsMode;
    setVisualEffectsMode(mode);
    writeVisualEffectsMode(mode);
    toast.success('Visual effects preference saved');
  }, []);

  const selectedVisualEffects = VISUAL_EFFECTS_OPTIONS.find((opt) => opt.value === visualEffectsMode) ?? VISUAL_EFFECTS_OPTIONS[0];

  return (
    <div>
      <h1>Personalization</h1>
      <p className="pc-settings-intro">
        Tune browser-local presentation preferences for this Operator interface.
      </p>

      <section className="pc-settings-section">
        <h2>Visual effects</h2>
        <p className="pc-settings-hint" style={{ margin: '0 0 12px' }}>
          Controls cinematic motion on this browser/device only. Use Minimal / calm for older hardware or a quieter UI.
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Select
            value={visualEffectsMode}
            onChange={setVisualEffectsPreference}
            ariaLabel="Visual effects preference"
            options={VISUAL_EFFECTS_OPTIONS.map(({ value, label }) => ({ value, label }))}
            triggerStyle={{ minWidth: 180, justifyContent: 'space-between', padding: '7px 10px' }}
          />
          <div style={{ fontSize: 13, color: 'var(--fg-mute)', maxWidth: 560 }}>
            <strong style={{ display: 'block', color: 'var(--fg)', marginBottom: 2 }}>
              {selectedVisualEffects.label}
            </strong>
            {selectedVisualEffects.description}
          </div>
        </div>
      </section>
    </div>
  );
}
