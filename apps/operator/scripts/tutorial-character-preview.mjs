#!/usr/bin/env node
/** Render a short speech-synchronised PaperCup preview using ElevenLabs alignment. */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

export const PREVIEW_TEXT = "Hi, I'm PaperCup, the operator of Papercusp. I'll guide you through your first project.";
const FPS = 24;

export function visemeForCharacter(character) {
  if (!character || /[\s.,!?;:]/.test(character)) return 'rest';
  if (/[mbp]/i.test(character)) return 'closed';
  if (/[wqou]/i.test(character)) return 'round';
  if (/[fv]/i.test(character)) return 'teeth';
  if (/[eiyjsz]/i.test(character)) return 'narrow';
  return 'open';
}

export function characterStateAt(alignment, seconds) {
  const chars = alignment?.characters ?? [];
  const starts = alignment?.character_start_times_seconds ?? [];
  const ends = alignment?.character_end_times_seconds ?? [];
  let index = -1;
  for (let i = 0; i < chars.length; i += 1) {
    if (seconds >= (starts[i] ?? 0) && seconds < (ends[i] ?? 0)) { index = i; break; }
  }
  const speaking = index >= 0;
  const time = Math.max(0, seconds);
  const wave = time > 0.55 && time < 2.2;
  const point = time > 3.4 && time < 4.7;
  const lastPunctuation = chars.slice(0, Math.max(0, index)).join('').match(/[.!?][^.!?]*$/)?.[0]?.[0];
  return {
    mouth: speaking ? visemeForCharacter(chars[index]) : 'rest',
    expression: lastPunctuation === '!' ? 'happy' : 'warm',
    blink: time % 3.7 > 2.75 && time % 3.7 < 2.88,
    gesture: wave ? 'wave' : point ? 'point' : 'idle',
    armAngle: wave ? -48 + Math.sin(time * 14) * 12 : point ? -56 : Math.sin(time * 1.5) * 2,
    gazeX: point ? 5 : Math.sin(time * 0.65) * 1.7,
    tilt: speaking ? Math.sin(time * 2.3) * 0.7 : 0,
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}

async function synthesize(text, voiceId) {
  const { readElevenLabsKey } = await import('../../../packages/operator-core/lib/voice-credentials.ts');
  const key = await readElevenLabsKey(); if (!key) throw new Error('ElevenLabs key is not configured');
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }) });
  if (!response.ok) throw new Error(`ElevenLabs returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json(); return { audio: Buffer.from(payload.audio_base64, 'base64'), alignment: payload.alignment };
}

export function pageHtml(svg, alignment, duration) {
  const clean = svg.replace(/<script[\s\S]*?<\/script>/gi, '');
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#eaf2f5;overflow:hidden}svg{width:960px;height:540px}</style>${clean}<script>const a=${JSON.stringify(alignment)},d=${duration};${visemeForCharacter.toString()};${characterStateAt.toString()};window.setTime=t=>{const z=characterStateAt(a,Math.max(0,Math.min(d,t)));const r=document.querySelector('svg');Object.entries(z).forEach(([k,v])=>r.dataset[k]=v);r.querySelector('.right-arm').style.transform='rotate('+z.armAngle+'deg)';r.querySelector('.right-arm').style.transformOrigin='657px 357px';r.querySelector('#cup').style.transform='rotate('+z.tilt+'deg)';r.querySelector('#cup').style.transformOrigin='480px 449px';r.querySelectorAll('.pupil').forEach(p=>p.style.transform='translateX('+z.gazeX+'px)')};</script>`;
}

export async function renderPreview({ outDir, text = PREVIEW_TEXT } = {}) {
  if (!outDir) throw new Error('outDir is required'); await mkdir(outDir, { recursive: true }); const framesDir = await mkdtemp(join(outDir, 'frames-'));
  const { loadVoicePrefs } = await import('../../../packages/operator-core/lib/voice-prefs.ts');
  const prefs = await loadVoicePrefs();
  const narrationHash = createHash('sha256').update(JSON.stringify({ text, voiceId: prefs.elevenlabsVoiceId, model: 'eleven_turbo_v2_5' })).digest('hex');
  let audio, alignment;
  try { const receipt = JSON.parse(await readFile(join(outDir, 'narration-receipt.json'), 'utf8')); if (receipt.narrationHash !== narrationHash) throw Object.assign(new Error('Narration changed'), { code: 'ENOENT' }); audio = await readFile(join(outDir, 'narration.mp3')); alignment = JSON.parse(await readFile(join(outDir, 'alignment.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ({ audio, alignment } = await synthesize(text, prefs.elevenlabsVoiceId)); }
  await writeFile(join(outDir, 'narration.mp3'), audio);
  await writeFile(join(outDir, 'alignment.json'), JSON.stringify(alignment));
  await writeFile(join(outDir, 'narration-receipt.json'), JSON.stringify({ narrationHash, voiceId: prefs.elevenlabsVoiceId, provider: 'elevenlabs', text }));
  const ends = alignment?.character_end_times_seconds ?? []; const duration = Math.max(1, (ends.at(-1) ?? 1) + 0.4); const svg = await readFile(new URL('../public/tutorial-character.svg', import.meta.url), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(svg, alignment, duration));
    for (let frame = 0; frame < Math.ceil(duration * FPS); frame += 1) {
      await page.evaluate(async t => {
        window.setTime(t);
        // Capture a painted pose, rather than racing the first compositor frame.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, frame / FPS);
      try { await page.screenshot({ path: join(framesDir, `frame-${String(frame).padStart(5, '0')}.png`) }); }
      catch (error) { throw new Error(`Character capture failed at frame ${frame}/${Math.ceil(duration * FPS)}: ${error.message}`); }
    }
  } finally { await browser.close(); }
  await run('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', join(framesDir, 'frame-%05d.png'), '-i', join(outDir, 'narration.mp3'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-af', 'apad=pad_dur=0.5', '-t', String(duration), '-movflags', '+faststart', join(outDir, 'papercup-speaking-preview.mp4')]);
  return { outDir, video: join(outDir, 'papercup-speaking-preview.mp4'), duration, alignmentCharacters: alignment?.characters?.length ?? 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) { const i = process.argv.indexOf('--out'); const outDir = i >= 0 ? process.argv[i + 1] : '/tmp/papercup-speaking-preview'; renderPreview({ outDir }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; }); }
