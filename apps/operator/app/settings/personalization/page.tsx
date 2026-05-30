'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { Select } from '../../harness/Select';
import {
  applyVisualEffectsMode,
  readVisualEffectsMode,
  subscribeVisualEffects,
  writeVisualEffectsMode,
  type VisualEffectsMode,
} from '@/lib/visual-effects';
import { BUILTIN_THEMES, useActiveTheme, writeActiveTheme } from '@/lib/theme';

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

const THEME_DESCRIPTIONS: Record<string, string> = {
  frost: 'The default — a slate-navy base with sky-cyan accents and glassy frost surfaces.',
  black: 'Pure-black surfaces with neutral greys and a white accent. High contrast, minimal color.',
};

/**
 * A small live preview of a theme. The wrapper carries `data-theme={id}`, so its
 * subtree resolves that theme's tokens regardless of the page's active theme —
 * this is why the frost/black blocks are both explicitly scopable (see
 * design-tokens/style-dictionary.config.mjs). All colors come from real tokens,
 * so previews can never drift from the themes themselves.
 */
function ThemePreview({ themeId }: { themeId: string }) {
  return (
    <div
      data-theme={themeId}
      aria-hidden
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--border-strong)',
        borderRadius: 6,
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 62,
      }}
    >
      <div style={{ height: 8, width: '55%', borderRadius: 3, background: 'var(--fg)' }} />
      <div style={{ height: 6, width: '82%', borderRadius: 3, background: 'var(--fg-mute)' }} />
      <div
        style={{
          alignSelf: 'flex-start',
          marginTop: 2,
          fontSize: 10,
          fontWeight: 600,
          lineHeight: 1.4,
          padding: '2px 8px',
          borderRadius: 999,
          background: 'var(--accent)',
          color: 'var(--accent-ink)',
        }}
      >
        Accent
      </div>
    </div>
  );
}

export default function PersonalizationSettingsPage() {
  const [visualEffectsMode, setVisualEffectsMode] = useState<VisualEffectsMode>('system');
  const activeTheme = useActiveTheme();

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

  const selectTheme = useCallback((id: string) => {
    writeActiveTheme(id);
    const label = BUILTIN_THEMES.find((t) => t.id === id)?.label ?? id;
    toast.success(`Theme set to ${label}`);
  }, []);

  const selectedVisualEffects = VISUAL_EFFECTS_OPTIONS.find((opt) => opt.value === visualEffectsMode) ?? VISUAL_EFFECTS_OPTIONS[0];

  return (
    <div>
      <h1>Personalization</h1>
      <p className="pc-settings-intro">
        Tune browser-local presentation preferences for this Papercup interface.
      </p>

      <section className="pc-settings-section">
        <h2>Theme</h2>
        <p className="pc-settings-hint" style={{ margin: '0 0 12px' }}>
          Recolors the entire interface on this device. A theme changes only the high-level color
          tokens — surfaces, text, borders, and accents.
        </p>
        <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {BUILTIN_THEMES.map((t) => {
            const selected = t.id === activeTheme;
            const cardStyle: CSSProperties = {
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              width: 172,
              padding: 10,
              textAlign: 'left',
              cursor: 'pointer',
              background: 'var(--bg-2)',
              border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
              boxShadow: selected ? '0 0 0 1px var(--accent)' : 'none',
              borderRadius: 10,
            };
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t.label}
                onClick={() => selectTheme(t.id)}
                style={cardStyle}
              >
                <ThemePreview themeId={t.id} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 13, color: 'var(--fg)' }}>{t.label}</strong>
                  {selected && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)' }}>● Active</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        <p className="pc-settings-hint" style={{ marginTop: 10, maxWidth: 560 }}>
          {THEME_DESCRIPTIONS[activeTheme] ?? 'Custom theme.'}
        </p>
      </section>

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
