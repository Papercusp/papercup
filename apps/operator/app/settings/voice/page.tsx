'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  initVoiceMode,
  listAvailableVoices,
  getVoiceConfig,
  updateVoiceConfig,
  assignVoiceToRole,
  speak,
} from '@/app/_components/voice/voice-mode';

const KNOWN_ROLES = [
  'system:operator',
  'system:oracle',
  'orchestrator',
  'worker',
  'validator',
  'architect',
  'scoper',
  'plan-gate',
  'documenter',
  'summarizer',
  'curator',
  'debugger',
  'crosscheck',
  'ui-qa',
  'project_manager',
  'director',
  'coordinator',
  'auditor',
];

export default function VoiceSettingsPage() {
  const [voices, setVoices] = useState<Array<{ name: string; lang: string }>>([]);
  const [config, setConfig] = useState(() => getVoiceConfig());

  useEffect(() => {
    // initVoiceMode loads persisted config from localStorage; refresh local
    // state from it so the form shows the user's saved values, not defaults.
    initVoiceMode();
    setConfig(getVoiceConfig());
    const tryRefresh = () => {
      const v = listAvailableVoices();
      if (v.length) setVoices(v);
    };
    tryRefresh();
    const t = setInterval(tryRefresh, 500);
    return () => clearInterval(t);
  }, []);

  const onAssign = useCallback((role: string, voiceName: string) => {
    assignVoiceToRole(role, voiceName);
    setConfig(getVoiceConfig());
  }, []);

  const onTest = useCallback((role: string) => {
    speak(`This is the voice for ${role.replace(':', ' ')}.`, role);
  }, []);

  const onWakeWordChange = useCallback((wakeWord: string) => {
    updateVoiceConfig({ wakeWord });
    setConfig(getVoiceConfig());
  }, []);

  const onRateChange = useCallback((rate: number) => {
    updateVoiceConfig({ rate });
    setConfig(getVoiceConfig());
  }, []);

  return (
    <div style={{ padding: '8px 4px', maxWidth: 880 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Voice mode</h1>
      <p style={{ color: 'var(--fg-mute)', marginBottom: 24, fontSize: 14 }}>
        Voice runs in the browser via the Web Speech API. Wake-word for always-on mode,
        per-role voice assignments, and speech rate.
      </p>

      {voices.length === 0 ? (
        <div style={{ padding: 16, background: 'rgba(255,200,0,0.08)', borderRadius: 6, marginBottom: 16 }}>
          No voices available yet. Some browsers load voices asynchronously — refresh in a few seconds.
        </div>
      ) : null}

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Wake word (always-on mode)</h2>
        <input
          type="text"
          value={config.wakeWord}
          onChange={(e) => onWakeWordChange(e.target.value)}
          style={{ padding: '6px 10px', minWidth: 240, fontSize: 14 }}
        />
        <p style={{ color: 'var(--fg-mute)', fontSize: 12, marginTop: 6 }}>
          Saying this phrase activates listening when voice mode is set to "always-on". A 3-syllable
          phrase that doesn't appear in normal speech works best (e.g. "hey operator").
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Speech rate</h2>
        <input
          type="range"
          min={0.5}
          max={2.0}
          step={0.1}
          value={config.rate}
          onChange={(e) => onRateChange(Number(e.target.value))}
          style={{ width: 240 }}
        />
        <span style={{ marginLeft: 12, fontSize: 13 }}>{config.rate.toFixed(1)}x</span>
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Per-role voices</h2>
        <p style={{ color: 'var(--fg-mute)', fontSize: 12, marginBottom: 12 }}>
          Assigned voices stay consistent across harnesses, sessions, and browser restarts.
          Auto-assignment uses a stable hash of the role name on first use.
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
              <th style={{ padding: '8px 4px', fontWeight: 600, fontSize: 12 }}>Role</th>
              <th style={{ padding: '8px 4px', fontWeight: 600, fontSize: 12 }}>Voice</th>
              <th style={{ padding: '8px 4px', fontWeight: 600, fontSize: 12 }}>Test</th>
            </tr>
          </thead>
          <tbody>
            {KNOWN_ROLES.map((role) => {
              const current = config.roleVoices[role] ?? '(auto)';
              return (
                <tr key={role} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 4px', fontSize: 13, fontFamily: 'monospace' }}>{role}</td>
                  <td style={{ padding: '8px 4px' }}>
                    <select
                      value={current === '(auto)' ? '' : current}
                      onChange={(e) => onAssign(role, e.target.value)}
                      style={{ padding: '4px 8px', fontSize: 13, minWidth: 240 }}
                    >
                      <option value="">(auto)</option>
                      {voices.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name} ({v.lang})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '8px 4px' }}>
                    <button type="button" onClick={() => onTest(role)} style={{ padding: '4px 8px', fontSize: 12 }}>
                      Test
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
