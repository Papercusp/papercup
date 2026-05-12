'use client';

import { useEffect, useState } from 'react';

type Channel = 'alpha' | 'beta' | 'stable';

const LS_KEY = 'pc-setup-wizard:auto-update-channel';

export function StepAutoUpdate() {
  const [channel, setChannel] = useState<Channel>('alpha');

  useEffect(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(LS_KEY) : null;
    if (v === 'alpha' || v === 'beta' || v === 'stable') setChannel(v);
  }, []);

  const pick = (c: Channel) => {
    setChannel(c);
    if (typeof window !== 'undefined') window.localStorage.setItem(LS_KEY, c);
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Which release channel should Papercusp auto-update from? You can change this any time. While
        the app is in alpha, the alpha channel is recommended — that's where the latest fixes land
        first.
      </p>
      <div className="pc-radio-grid">
        {(['alpha', 'beta', 'stable'] as const).map((c) => (
          <label key={c} className="pc-radio-card" data-active={c === channel ? 'true' : undefined}>
            <input type="radio" name="channel" value={c} checked={c === channel} onChange={() => pick(c)} />
            <div>
              <div className="pc-radio-card__title">{c[0].toUpperCase() + c.slice(1)}</div>
              <div className="pc-radio-card__sub">
                {c === 'alpha' && 'Latest fixes, fastest cadence, may have rough edges.'}
                {c === 'beta' && 'Newer features, sanity-checked. Updated weekly-ish.'}
                {c === 'stable' && 'Conservative. Updated when a release is ready for everyone.'}
              </div>
            </div>
          </label>
        ))}
      </div>
      <p className="pc-step__hint">
        The update server isn't live yet — your choice is saved locally and will take effect once
        the auto-update backend lands.
      </p>
    </div>
  );
}
