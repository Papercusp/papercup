/**
 * useMicLevel — emits a 0..1 audio level whenever voice mode is in a
 * listening state. Drives the mic-button "is-it-hearing-me?" indicator.
 *
 * Engine-independent: opens its own getUserMedia stream + AnalyserNode
 * solely for visualization, so all 3 STT engines (Voicemode, WebSpeech,
 * Deepgram) light up the same way without sharing the capture stream.
 *
 * Auto-stops when status leaves `listening` so a closed mic in always-on
 * idle state doesn't leave the indicator hot.
 */

import { useEffect, useRef, useState } from 'react';

export function useMicLevel(active: boolean): number {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!active) {
      // Immediate visual drop the moment the caller flips active false.
      setLevel(0);
      return;
    }
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;

    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);

        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          // RMS over the time-domain samples; 128 = silence midpoint.
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          // Floor + soft-knee to make modest speech read clearly.
          const eased = Math.min(1, Math.max(0, (rms - 0.02) * 6));
          setLevel(eased);
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        /* permission denied / device busy — silent fallback (level stays 0) */
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      try { ctxRef.current?.close(); } catch { /* ignore */ }
      ctxRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setLevel(0);
    };
  }, [active]);

  return level;
}
