'use client';

import { useEffect, useState } from 'react';

export function StepVoiceDevices() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied' | 'prompt'>(
    'unknown',
  );

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    void navigator.mediaDevices.enumerateDevices().then((all) => {
      setInputs(all.filter((d) => d.kind === 'audioinput'));
      setOutputs(all.filter((d) => d.kind === 'audiooutput'));
      const anyLabel = all.some((d) => d.label.length > 0);
      setPermission(anyLabel ? 'granted' : 'prompt');
    });
  }, []);

  const requestMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      const all = await navigator.mediaDevices.enumerateDevices();
      setInputs(all.filter((d) => d.kind === 'audioinput'));
      setOutputs(all.filter((d) => d.kind === 'audiooutput'));
      setPermission('granted');
    } catch {
      setPermission('denied');
    }
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Pick the microphone and speaker Papercusp should use for voice modes. The mic that "works"
        in your system settings often isn't the one a browser/Tauri app picks by default — verify
        with the test below.
      </p>

      {permission !== 'granted' && (
        <div className="pc-step__progress" data-status="missing">
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Microphone permission needed.</strong>
            <span>Click below to request access.</span>
          </div>
        </div>
      )}

      {permission !== 'granted' && (
        <button type="button" className="pc-btn pc-btn--primary" onClick={() => void requestMic()}>
          Grant microphone access
        </button>
      )}

      {permission === 'granted' && (
        <>
          <label className="pc-field">
            <span className="pc-field__label">Input (microphone)</span>
            <select className="pc-input">
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone (${d.deviceId.slice(0, 6)}…)`}
                </option>
              ))}
            </select>
          </label>
          <label className="pc-field">
            <span className="pc-field__label">Output (speaker)</span>
            <select className="pc-input">
              {outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Speaker (${d.deviceId.slice(0, 6)}…)`}
                </option>
              ))}
            </select>
          </label>
          <p className="pc-step__hint">
            A live VU meter + record/playback test are coming. For now, the system test in{' '}
            <a href="/settings/voice">Settings → Voice</a> is the most thorough check.
          </p>
        </>
      )}
    </div>
  );
}
