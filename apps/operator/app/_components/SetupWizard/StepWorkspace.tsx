'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri-detect';

interface Profile {
  default_project_dir?: string;
}

export function StepWorkspace() {
  const [dir, setDir] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [tauri, setTauri] = useState(false);

  useEffect(() => {
    setTauri(isTauri());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/profile', { cache: 'no-store' });
        const j = (await r.json()) as Profile;
        setDir(j.default_project_dir ?? '');
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const pickFolder = async () => {
    try {
      const result = (await invoke('plugin:dialog|open', {
        options: {
          directory: true,
          multiple: false,
          title: 'Choose a folder for your Papercusp projects',
        },
      })) as string | string[] | null;
      const path = Array.isArray(result) ? result[0] : result;
      if (path) setDir(path);
    } catch {
      // user cancelled or plugin unavailable
    }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ default_project_dir: dir || undefined }),
      });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        This is where Papercusp creates new project folders when you scaffold a harness. Leave it
        blank to use the default <code>~/.papercusp/projects/</code>.
      </p>
      <label className="pc-field">
        <span className="pc-field__label">Default project directory</span>
        <div className="pc-field__row">
          <input
            type="text"
            className="pc-input"
            placeholder="~/papercusp-projects"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            disabled={!loaded || saving}
          />
          {tauri && (
            <button
              type="button"
              className="pc-btn"
              onClick={() => void pickFolder()}
              disabled={!loaded || saving}
            >
              Choose folder…
            </button>
          )}
        </div>
        <span className="pc-field__hint">
          Use an absolute path or a path starting with <code>~/</code>. The directory will be created
          if it doesn't exist.
        </span>
      </label>
      <div className="pc-step__actions">
        <button
          type="button"
          className="pc-btn pc-btn--primary"
          onClick={() => void onSave()}
          disabled={!loaded || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && <span className="pc-step__saved">Saved.</span>}
      </div>
      {!tauri && (
        <p className="pc-step__hint">
          A native folder picker appears here when running inside the desktop app. In a browser tab,
          paste the path manually.
        </p>
      )}
    </div>
  );
}
