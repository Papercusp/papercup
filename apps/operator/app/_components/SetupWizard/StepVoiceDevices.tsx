'use client';

import { useEffect, useRef, useState } from 'react';

type Permission = 'unknown' | 'granted' | 'denied' | 'prompt';

export function StepVoiceDevices() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedInput, setSelectedInput] = useState<string>('');
  const [selectedOutput, setSelectedOutput] = useState<string>('');
  const [permission, setPermission] = useState<Permission>('unknown');
  const [level, setLevel] = useState(0);
  const [recordings, setRecordings] = useState<{ url: string; createdAt: number }[]>([]);
  const [recording, setRecording] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    void navigator.mediaDevices.enumerateDevices().then((all) => {
      const ins = all.filter((d) => d.kind === 'audioinput');
      const outs = all.filter((d) => d.kind === 'audiooutput');
      setInputs(ins);
      setOutputs(outs);
      setSelectedInput(ins[0]?.deviceId ?? '');
      setSelectedOutput(outs[0]?.deviceId ?? '');
      setPermission(all.some((d) => d.label.length > 0) ? 'granted' : 'prompt');
    });
  }, []);

  const startMonitor = async (deviceId: string) => {
    stopMonitor();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      streamRef.current = stream;
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      analyserRef.current = analyser;
      setPermission('granted');
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        setLevel(Math.min(1, rms * 3));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      // Re-enumerate now that labels are revealed
      const all = await navigator.mediaDevices.enumerateDevices();
      setInputs(all.filter((d) => d.kind === 'audioinput'));
      setOutputs(all.filter((d) => d.kind === 'audiooutput'));
    } catch {
      setPermission('denied');
    }
  };

  const stopMonitor = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    analyserRef.current = null;
    setLevel(0);
  };

  useEffect(() => () => stopMonitor(), []);

  useEffect(() => {
    if (permission === 'granted' && selectedInput) {
      void startMonitor(selectedInput);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInput, permission]);

  const startRecording = () => {
    if (!streamRef.current) return;
    chunksRef.current = [];
    const recorder = new MediaRecorder(streamRef.current);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      const url = URL.createObjectURL(blob);
      setRecordings((prev) => [{ url, createdAt: Date.now() }, ...prev].slice(0, 3));
    };
    recorderRef.current = recorder;
    recorder.start();
    setRecording(true);
    setTimeout(() => stopRecording(), 5000);
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Pick a microphone and speaker, then verify with the live meter and the 5-second test
        recording. The mic that "works" in your system settings often isn't the one a browser/Tauri
        app picks by default — watch the meter move while you talk.
      </p>

      {permission !== 'granted' && (
        <>
          <div className="pc-step__progress" data-status="missing">
            <div className="pc-step__progress-dot" />
            <div className="pc-step__progress-text">
              <strong>Microphone permission needed.</strong>
              <span>Click below to request access.</span>
            </div>
          </div>
          <button
            type="button"
            className="pc-btn pc-btn--primary"
            onClick={() => void startMonitor(selectedInput)}
          >
            Grant microphone access
          </button>
        </>
      )}

      {permission === 'granted' && (
        <>
          <label className="pc-field">
            <span className="pc-field__label">Input (microphone)</span>
            <select
              className="pc-input"
              value={selectedInput}
              onChange={(e) => setSelectedInput(e.target.value)}
            >
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone (${d.deviceId.slice(0, 6)}…)`}
                </option>
              ))}
            </select>
          </label>

          <div className="pc-vu">
            <div className="pc-vu__label">Live level</div>
            <div className="pc-vu__bar">
              <div
                className="pc-vu__fill"
                style={{ width: `${Math.round(level * 100)}%` }}
              />
            </div>
            <div className="pc-vu__hint">
              {level < 0.02
                ? 'Say something — the bar should move.'
                : level < 0.4
                  ? 'Good — speak normally.'
                  : 'Clipping. Move farther from the mic.'}
            </div>
          </div>

          <label className="pc-field">
            <span className="pc-field__label">Output (speaker)</span>
            <select
              className="pc-input"
              value={selectedOutput}
              onChange={(e) => setSelectedOutput(e.target.value)}
            >
              {outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Speaker (${d.deviceId.slice(0, 6)}…)`}
                </option>
              ))}
            </select>
          </label>

          <div className="pc-step__actions">
            {!recording && (
              <button type="button" className="pc-btn pc-btn--primary" onClick={startRecording}>
                Record 5-second test
              </button>
            )}
            {recording && (
              <button type="button" className="pc-btn" onClick={stopRecording}>
                Stop
              </button>
            )}
          </div>

          {recordings.length > 0 && (
            <div className="pc-rec-list">
              {recordings.map((r) => (
                <audio
                  key={r.createdAt}
                  controls
                  src={r.url}
                  data-output-device={selectedOutput}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
