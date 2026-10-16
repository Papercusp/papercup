#!/usr/bin/env node
/** Assemble genuine recorded chapters, aligned ElevenLabs speech and the shared
 * PaperCup rig. This does not create, stage or fabricate product results. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { PRODUCT_TUTORIAL_CHAPTERS } from '../../../packages/operator-core/lib/onboarding/product-tutorial-lesson.ts';
import { prepareNarration, renderPreview } from './tutorial-character-preview.mjs';

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateManifest(manifest) {
  const project = manifest?.project;
  if (!project?.workspaceId || !project?.projectSlug || project.portalOrigin !== 'https://app.papercusp.com') throw new Error('A real cloud portal workspace and project are required');
  const expected = PRODUCT_TUTORIAL_CHAPTERS.map(chapter => chapter.id);
  if (!Array.isArray(manifest.chapters) || manifest.chapters.map(chapter => chapter.id).join(',') !== expected.join(',')) throw new Error('Provide all tutorial chapters once, in curriculum order');
  for (const chapter of manifest.chapters) {
    if (!chapter.text?.trim() || !chapter.recordingPath || /[\r\n]/.test(chapter.recordingPath)) throw new Error(`${chapter.id}: narration and a local real recording are required`);
    if (!Number.isFinite(chapter.recordingStartSeconds) || chapter.recordingStartSeconds < 0 || !Number.isFinite(chapter.recordingDurationSeconds) || chapter.recordingDurationSeconds <= 0) throw new Error(`${chapter.id}: explicit bounded recording offsets are required`);
    const evidence = chapter.provenance;
    if (evidence?.workspaceId !== project.workspaceId || evidence?.projectSlug !== project.projectSlug || !Number.isFinite(Date.parse(evidence?.capturedAt)) || !Array.isArray(evidence?.evidenceRefs) || !evidence.evidenceRefs.length || evidence.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) throw new Error(`${chapter.id}: missing or different-project recording provenance`);
  }
  return manifest;
}

export function captionCues(alignment, offsetSeconds = 0) {
  const chars = alignment?.characters, starts = alignment?.character_start_times_seconds, ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || !chars.length || chars.length !== starts?.length || chars.length !== ends?.length) throw new Error('Incomplete narration alignment');
  const cues = []; let text = '', first = 0, last = 0;
  const flush = () => { if (text.trim()) cues.push({ start: first + offsetSeconds, end: Math.max(first + .04, last) + offsetSeconds, text: text.trim() }); text = ''; };
  for (let index = 0; index < chars.length; index += 1) {
    if (typeof chars[index] !== 'string' || !Number.isFinite(starts[index]) || !Number.isFinite(ends[index]) || starts[index] < 0 || ends[index] < starts[index] || (index && starts[index] < ends[index - 1] - .001)) throw new Error('Invalid narration timing');
    if (!text) first = starts[index];
    text += chars[index]; last = ends[index];
    if ((text.length >= 70 && /\s/.test(chars[index])) || (text.length >= 25 && /[.!?]/.test(chars[index]))) flush();
  }
  flush(); return cues;
}

export function vttTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid caption offset');
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
export function webVtt(cues) {
  return 'WEBVTT\n\n' + cues.map((cue, index) => `${index + 1}\n${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}\n${escapeHtml(cue.text)}\n`).join('\n');
}

function run(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.on('error', reject); child.on('close', code => code === 0 ? accept(stdout) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}
async function probe(path) { return JSON.parse(await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path])); }

export async function renderTutorial({ manifestPath, outDir }) {
  if (!manifestPath || !outDir) throw new Error('--manifest and --out are required');
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  outDir = resolve(outDir); await mkdir(outDir, { recursive: true });
  // Preflight every input before any paid synthesis or expensive rendering.
  for (const chapter of manifest.chapters) {
    if (!(await stat(chapter.recordingPath)).isFile()) throw new Error(`${chapter.id}: recording is not a file`);
    const recording = await probe(chapter.recordingPath);
    if (!recording.streams.some(stream => stream.codec_type === 'video') || chapter.recordingStartSeconds + chapter.recordingDurationSeconds > Number(recording.format.duration) + .05) throw new Error(`${chapter.id}: recording selection is outside the real footage`);
  }
  const clips = [], chapters = [], cues = []; let offset = 0;
  for (const chapter of manifest.chapters) {
    const chapterDir = join(outDir, chapter.id); await mkdir(chapterDir, { recursive: true });
    const speech = await prepareNarration({ outDir: chapterDir, text: chapter.text });
    const duration = Math.max(speech.duration, chapter.recordingDurationSeconds);
    const character = await renderPreview({ outDir: chapterDir, text: chapter.text, width: 384, height: 216, transparent: true });
    const clip = join(chapterDir, 'composited.mp4');
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(chapter.recordingStartSeconds), '-t', String(chapter.recordingDurationSeconds), '-i', chapter.recordingPath, '-i', character.video,
      '-filter_complex', `[0:v]scale=1536:960:force_original_aspect_ratio=decrease,pad=1920:1080:0:100:color=0xeaf2f5,tpad=stop_mode=clone:stop_duration=${duration},fps=24[screen];[screen][1:v]overlay=1536:760:eof_action=repeat[out]`,
      '-map', '[out]', '-map', '1:a:0', '-af', 'apad', '-t', String(duration), '-r', '24', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-movflags', '+faststart', clip]);
    const measured = Number((await probe(clip)).format.duration);
    if (!Number.isFinite(measured) || measured <= 0) throw new Error(`${chapter.id}: rendered duration is invalid`);
    cues.push(...captionCues(speech.alignment, offset));
    chapters.push({ id: chapter.id, startSeconds: offset, durationSeconds: measured, transcript: chapter.text,
      recordingSha256: digest(await readFile(chapter.recordingPath)), narrationHash: speech.narrationHash, provenance: chapter.provenance });
    clips.push(clip); offset += measured;
    await writeFile(join(outDir, 'production-progress.json'), JSON.stringify({ project: manifest.project, chapters }, null, 2));
    console.log(JSON.stringify({ chapter: chapter.id, duration: measured, completed: chapters.length, total: manifest.chapters.length }));
  }
  const concatPath = join(outDir, 'concat.txt');
  await writeFile(concatPath, clips.map(path => `file '${path.replace(/'/g, "'\\''")}'`).join('\n'));
  const output = join(outDir, 'cloud-portal-tutorial.mp4');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', '-movflags', '+faststart', output]);
  const measured = Number((await probe(output)).format.duration);
  if (Math.abs(measured - offset) > .3) throw new Error('Final media duration does not match its chapter timeline');
  await writeFile(join(outDir, 'cloud-portal-tutorial.vtt'), webVtt(cues));
  const transcript = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Build a project with PaperCup — transcript</title><style>body{font:18px/1.6 system-ui;max-width:75ch;margin:auto;padding:2rem}a{color:#245870}section{margin-block:3rem}</style><main><h1>Build a project with PaperCup</h1>${chapters.map(chapter => `<section id="${chapter.id}"><h2>${escapeHtml(PRODUCT_TUTORIAL_CHAPTERS.find(item => item.id === chapter.id).title)}</h2><p>${escapeHtml(chapter.transcript)}</p></section>`).join('')}</main></html>`;
  await writeFile(join(outDir, 'cloud-portal-tutorial-transcript.html'), transcript);
  const receipt = { schemaVersion: 1, project: manifest.project, provider: 'elevenlabs', producedAt: new Date().toISOString(), durationSeconds: measured, videoSha256: digest(await readFile(output)), chapters };
  await writeFile(join(outDir, 'delivery-receipt.json'), JSON.stringify(receipt, null, 2));
  return { output, receipt: join(outDir, 'delivery-receipt.json'), durationSeconds: measured };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const option = key => process.argv[process.argv.indexOf(key) + 1];
  renderTutorial({ manifestPath: process.argv.includes('--manifest') ? option('--manifest') : null, outDir: process.argv.includes('--out') ? option('--out') : null }).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode = 1; });
}
