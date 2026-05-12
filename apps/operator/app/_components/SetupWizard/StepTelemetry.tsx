'use client';

import { useEffect, useState } from 'react';

const LS_KEY = 'pc-setup-wizard:telemetry-opt-in';

export function StepTelemetry() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(LS_KEY) : null;
    if (v === '1') setEnabled(true);
  }, []);

  const toggle = (v: boolean) => {
    setEnabled(v);
    if (typeof window !== 'undefined') window.localStorage.setItem(LS_KEY, v ? '1' : '0');
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Help us find bugs in alpha. If you opt in, Papercusp will send anonymized crash reports and
        performance metrics — no source code, no prompts, no API keys, no personally identifiable
        information.
      </p>
      <label className="pc-toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
        <span>Send anonymous crash reports and diagnostics</span>
      </label>
      <p className="pc-step__hint">
        The telemetry backend isn't live yet — your choice is saved locally and nothing will be
        transmitted until the backend lands.
      </p>
    </div>
  );
}
