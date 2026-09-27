// Turns capture/out/<clip>/ (JPEG frames + wall-clock timestamps) into
// public/clips/<clip>.mp4 at a constant 60 fps of *page* time, plus
// public/clips/<clip>.json with the click/scroll events on the same clock.
//
//   node capture/encode.mjs            all clips
//   node capture/encode.mjs world why  some clips
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const DEST = path.resolve(HERE, '../public/clips');
const FFMPEG = path.resolve(HERE, '../node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe');
const FPS = 60;

fs.mkdirSync(DEST, { recursive: true });

const wanted = process.argv.slice(2);
const clips = fs.readdirSync(OUT)
  .filter((d) => fs.existsSync(path.join(OUT, d, 'meta.json')))
  .filter((d) => !wanted.length || wanted.includes(d));

const manifest = fs.existsSync(path.join(DEST, 'manifest.json'))
  ? JSON.parse(fs.readFileSync(path.join(DEST, 'manifest.json'), 'utf8'))
  : {};

for (const name of clips) {
  const dir = path.join(OUT, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const slow = meta.slow ?? 1;
  const t0 = meta.frames[0];
  const toPage = (wall) => (wall - t0) * slow; // seconds of page time
  const times = meta.frames.map(toPage);
  const duration = toPage(meta.stop);
  const total = Math.floor(duration * FPS);

  // Latest source frame at or before each output tick.
  const pick = new Array(total);
  let j = 0;
  for (let k = 0; k < total; k++) {
    const t = k / FPS;
    while (j + 1 < times.length && times[j + 1] <= t) j++;
    pick[k] = j;
  }
  const unique = new Set(pick).size;

  const mp4 = path.join(DEST, `${name}.mp4`);
  const ff = spawn(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p',
    '-g', '30', '-movflags', '+faststart', mp4,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const started = Date.now();
  let cache = { i: -1, buf: null };
  for (let k = 0; k < total; k++) {
    const i = pick[k];
    if (cache.i !== i) cache = { i, buf: fs.readFileSync(path.join(dir, `${String(i).padStart(6, '0')}.jpg`)) };
    if (!ff.stdin.write(cache.buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  const code = await new Promise((r) => ff.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg failed on ${name} (${code})`);

  const events = meta.events.map((e) => ({ ...e, t: +toPage(e.t).toFixed(3) }));
  fs.writeFileSync(path.join(DEST, `${name}.json`), JSON.stringify({ name, duration, fps: FPS, css: meta.css, events }, null, 1));
  manifest[name] = { duration: +duration.toFixed(3), frames: total };

  console.log(`${name.padEnd(11)} ${duration.toFixed(1)} s, ${total} frames from ${unique} unique `
    + `(${(unique / duration).toFixed(0)} fps real), encoded in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

fs.writeFileSync(path.join(DEST, 'manifest.json'), JSON.stringify(manifest, null, 1));
