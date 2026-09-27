// Records the real Lumina app (localhost:3000) as a set of clips for the demo
// video. Every frame is a CDP screencast of headless Chrome at 1600x900 CSS px
// and 2x device scale (3200x1800), with a DOM cursor drawn into the page so the
// clicks show up in the footage. Frames + timestamps land in capture/out/<clip>/;
// encode.mjs turns them into constant-60fps MP4s for Remotion.
//
// Slow-motion capture: 3200x1800 screencast tops out around 30 fps, so the page's
// clock (rAF, performance.now, Date.now, timers, CSS/Web animations) runs at SLOW
// speed and every scripted action is stretched to match. Played back at 1/SLOW,
// the footage is real-speed UI at ~75 fps. Only the backend runs in real time.
//
//   node capture/record.mjs              all clips
//   CLIPS=world,why node capture/record.mjs   re-shoot some (the rest still runs, unrecorded)
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const PHOTOS_DIR = path.resolve(HERE, '../../testing_images');
const APP = process.env.APP_URL || 'http://localhost:3000';
const W = 1600, H = 900;
const SLOW = Number(process.env.SLOW || 0.4);
const CLIPS = process.env.CLIPS ? new Set(process.env.CLIPS.split(',')) : null;

const photos = fs.readdirSync(PHOTOS_DIR).sort().map((f) => path.join(PHOTOS_DIR, f));

/* ------------------------------------------------------------------ browser */

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--force-device-scale-factor=2', '--window-size=1626,1000', // => 1600x900 @2x
    '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
  ],
});
const ctx = await browser.newContext({ viewport: null, acceptDownloads: true });

// Warp the page clock before any app script (GSAP caches Date.now at load).
await ctx.addInitScript((S) => {
  const perfNow = performance.now.bind(performance);
  const dateNow = Date.now;
  const p0 = perfNow(), d0 = dateNow();
  performance.now = () => p0 + (perfNow() - p0) * S;
  Date.now = () => Math.round(d0 + (dateNow() - d0) * S);
  // CDP's Animation.setPlaybackRate also slows the native rAF timestamp, which
  // then drifts from performance.now; hand callbacks the warped clock instead.
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => cb(performance.now()));
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
  window.setTimeout = (fn, ms, ...a) => st(fn, (Number(ms) || 0) / S, ...a);
  window.setInterval = (fn, ms, ...a) => si(fn, (Number(ms) || 0) / S, ...a);
}, SLOW);

// A soft macOS-style pointer plus a click ripple in Lumina's lavender.
await ctx.addInitScript(() => {
  const install = () => {
    if (document.getElementById('__demo_cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      ::-webkit-scrollbar { display: none !important; }
      html { scrollbar-width: none !important; }
      #__demo_cursor { position: fixed; left: 0; top: 0; width: 30px; height: 30px; pointer-events: none;
        z-index: 2147483647; transform: translate(-200px, -200px); will-change: transform; }
      #__demo_cursor svg { width: 30px; height: 30px; transition: transform .12s ease; transform-origin: 6px 4px;
        filter: drop-shadow(0 3px 5px rgba(40, 20, 70, .35)); }
      #__demo_cursor.down svg { transform: scale(.82); }
      #__demo_cursor.hidden { opacity: 0; }
      .__demo_ripple { position: fixed; width: 54px; height: 54px; margin: -27px 0 0 -27px; border-radius: 50%;
        pointer-events: none; z-index: 2147483646; border: 3px solid rgba(160, 128, 230, .95);
        background: radial-gradient(circle, rgba(236, 168, 190, .35), rgba(236, 168, 190, 0) 70%);
        animation: __demo_r .6s cubic-bezier(.2, .8, .3, 1) forwards; }
      @keyframes __demo_r { from { transform: scale(.25); opacity: 1; } to { transform: scale(1.35); opacity: 0; } }`;
    document.head.appendChild(style);
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.innerHTML = `<svg viewBox="0 0 32 32"><path d="M6 3 L6 25 L11.5 20 L15.5 29 L19.5 27.3 L15.6 18.6 L23 18.6 Z"
      fill="#1f1733" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(c);
    const pos = window.__demoPos || { x: -200, y: -200 };
    c.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    addEventListener('mousemove', (e) => {
      window.__demoPos = { x: e.clientX, y: e.clientY };
      c.style.transform = `translate(${e.clientX - 6}px, ${e.clientY - 4}px)`;
    }, true);
    addEventListener('mousedown', (e) => {
      c.classList.add('down');
      const r = document.createElement('div');
      r.className = '__demo_ripple';
      r.style.left = `${e.clientX}px`; r.style.top = `${e.clientY}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install);
  else install();
});

const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Animation.enable');
await cdp.send('Animation.setPlaybackRate', { playbackRate: SLOW }); // CSS + Web Animations

/* ----------------------------------------------------------------- recorder */

const rec = {
  clip: null,
  frames: [],
  events: [],
  writes: [],
  async start(name) {
    const dir = path.join(OUT, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    Object.assign(this, { clip: { name, dir, start: Date.now() / 1000 }, frames: [], events: [], writes: [] });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W * 2, maxHeight: H * 2 });
    console.log(`● ${name}`);
  },
  mark(type, extra = {}) {
    if (this.clip) this.events.push({ t: Date.now() / 1000, type, ...extra });
  },
  async stop() {
    await cdp.send('Page.stopScreencast');
    await Promise.all(this.writes);
    const { name, dir, start } = this.clip;
    const meta = { name, start, stop: Date.now() / 1000, slow: SLOW, frames: this.frames, events: this.events, css: { w: W, h: H } };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    const secs = meta.stop - start;
    console.log(`  ${this.frames.length} frames / ${(secs * SLOW).toFixed(1)} s screen time = ${(this.frames.length / secs / SLOW).toFixed(0)} fps`);
    this.clip = null;
  },
};

cdp.on('Page.screencastFrame', (f) => {
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  if (!rec.clip) return;
  const i = rec.frames.length;
  rec.frames.push(f.metadata.timestamp);
  rec.writes.push(fs.promises.writeFile(path.join(rec.clip.dir, `${String(i).padStart(6, '0')}.jpg`), Buffer.from(f.data, 'base64')));
});

/* ------------------------------------------------------------------ helpers */

const log = (...a) => { if (process.env.DEBUG) console.log(new Date().toISOString().slice(11, 23), ...a); };

/** Wait `ms` of page time (the page clock runs at SLOW). */
const wait = (ms) => page.waitForTimeout(ms / SLOW);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
let mouse = { x: W * 0.62, y: H * 0.7 };

/** Glide the pointer along a gentle arc, like a person would. */
async function moveTo(x, y, ms = 650) {
  const from = { ...mouse };
  const bend = { x: (y - from.y) * 0.12, y: -(x - from.x) * 0.12 };
  const t0 = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / (ms / SLOW));
    const e = ease(t);
    const arc = Math.sin(Math.PI * e);
    await page.mouse.move(from.x + (x - from.x) * e + bend.x * arc, from.y + (y - from.y) * e + bend.y * arc);
    if (t >= 1) break;
    await page.waitForTimeout(8);
  }
  mouse = { x, y };
}

async function center(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/** Move to an element and click it, logging the click for Remotion's auto-zoom. */
async function click(locator, { ms = 650, pause = 140, label } = {}) {
  log('click', String(locator));
  await locator.waitFor({ state: 'visible' });
  const { x, y, box } = await center(locator);
  await moveTo(x, y, ms);
  await wait(pause);
  rec.mark('click', { x, y, box, label });
  await page.mouse.down();
  await wait(90);
  await page.mouse.up();
}

/** Smooth, eased window scroll (GSAP ScrollTriggers follow it frame by frame). */
async function scrollTo(y, ms = 1200) {
  log('scroll', y, ms);
  rec.mark('scroll', { to: y, ms });
  await page.evaluate(([y, ms]) => new Promise((done) => {
    const y0 = scrollY, t0 = performance.now();
    const e = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      scrollTo(0, y0 + (y - y0) * e(t));
      if (t < 1) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  }), [y, ms]);
}

/** Scroll so an element sits at `ratio` of the viewport height. */
async function scrollToEl(locator, ratio = 0.3, ms = 1000) {
  const top = await locator.evaluate((el) => el.getBoundingClientRect().top + scrollY);
  await scrollTo(Math.max(0, top - H * ratio), ms);
}

const cursor = (visible) => page.evaluate((v) => document.getElementById('__demo_cursor')?.classList.toggle('hidden', !v), visible);
const vis = (text) => page.locator('button:visible', { hasText: text }).first();
const byLabel = (label) => page.locator(`[aria-label="${label}"]:visible`).first();

/* -------------------------------------------------------------------- shots */

/** Record one clip. `needed` clips still run when skipped, since later ones depend on them. */
const shot = async (name, fn, { needed = false } = {}) => {
  const recording = !CLIPS || CLIPS.has(name);
  if (!recording && !needed) return;
  if (recording) await rec.start(name);
  try { await fn(); } finally { if (recording) await rec.stop(); }
};

await page.goto(APP, { waitUntil: 'networkidle' });
await page.mouse.move(mouse.x, mouse.y);
await wait(2000);

// 1. Landing: hero, then scrub through Lumi's scroll film.
await shot('landing', async () => {
  await wait(1800);
  await moveTo(W * 0.45, H * 0.62, 900);
  await scrollTo(H * 4.5, 9000); // ScrollStory pins for 4.5 viewports
  await wait(900);
});

await scrollTo(0, 10);
await wait(600);

// 2. Upload: drop in the photos, select all, analyze.
await shot('upload', async () => {
  await click(vis('Start with your photos'), { ms: 800 });
  await wait(1600);
  rec.mark('drop');
  await page.locator('input[type=file]').setInputFiles(photos);
  await wait(2200);
  await click(vis('Select all'));
  await wait(900);
  await click(vis(/^Analyze/));
  await wait(400);
}, { needed: true });

// 3. Processing: the real pipeline, in real time (sped up in the edit).
await shot('processing', async () => {
  await moveTo(W * 0.85, H * 0.9, 700);
  await page.getByText('Your gallery').waitFor({ timeout: 180000 });
  await wait(2600); // gallery entrance
}, { needed: true });

// 4. Gallery tour: named moments, best shots.
await shot('gallery', async () => {
  await moveTo(W * 0.72, H * 0.55, 900);
  await wait(600);
  await scrollTo(560, 1600);
  await wait(900);
  await scrollTo(1500, 2200);
  await wait(900);
  await scrollTo(2450, 2000);
  await wait(900);
  await scrollTo(0, 1600);
  await wait(500);
});

// 5. People: filter to one person, spotlight their face everywhere.
const personChip = (name) => page.locator('[aria-label="Filter by person"] button:visible', { hasText: name }).first();
await shot('people', async () => {
  await click(personChip('Person 4'), { ms: 800 });
  await wait(1500);
  await click(page.getByText('Spotlight', { exact: true }));
  await wait(2400);
  await scrollTo(260, 900);
  await wait(1400);
  await click(page.getByText('Spotlight', { exact: true }));
  await scrollTo(0, 700);
  await click(personChip('Everyone'));
  await wait(900);
});

// 6. Why this photo: the explanation behind a best shot.
await shot('why', async () => {
  const why = page.getByRole('button', { name: 'Why this photo?' }).last();
  await scrollToEl(why, 0.55, 1300);
  await wait(300);
  await click(why);
  await wait(1200);
  const modal = page.locator('[role=dialog]:visible, [aria-modal=true]:visible').first();
  const box = await modal.boundingBox().catch(() => null);
  if (box) await moveTo(box.x + box.width * 0.5, box.y + box.height * 0.75, 1200);
  await wait(2800);
  await click(byLabel('Close').or(page.locator('[title="Close"]:visible')).first());
  await wait(700);
});

// 7. Search in plain words (CLIP).
await shot('search', async () => {
  await scrollTo(0, 900);
  const box = page.getByRole('textbox', { name: /Search your photos/ });
  await click(box);
  await wait(300);
  rec.mark('type', { text: 'eating lunch together' });
  await box.pressSequentially('eating lunch together', { delay: 70 / SLOW });
  await wait(250);
  await page.keyboard.press('Enter');
  await wait(3400);
  await moveTo(W * 0.3, H * 0.62, 900);
  await wait(900);
  await click(vis('Back'));
  await wait(700);
});
await page.getByRole('textbox', { name: /Search your photos/ }).fill('');
await page.locator('body').click({ position: { x: 5, y: 890 } });
await wait(400);

// 8. Learn my taste: promote a different photo, see the weights move.
await shot('taste', async () => {
  const make = page.getByRole('button', { name: 'Make best shot' }).last();
  await scrollToEl(make, 0.5, 1200);
  // "Make best shot" shows on hover over the photo tile.
  const m = await center(make);
  await moveTo(m.x - 60, m.y - 120, 800);
  await wait(500);
  await click(make, { ms: 400 });
  await wait(1800);
  await scrollTo(0, 1200);
  await click(vis('My taste'));
  await wait(3200);
  await click(vis('My taste'));
  await wait(600);
});

// 9. Album: themed PDF with Lumi.
let albumPdf = null;
await shot('album', async () => {
  await click(vis('Create album'));
  await wait(1100);
  const title = page.getByPlaceholder('Summer at the Bay');
  await click(title);
  await title.pressSequentially('Lunch Break Crew', { delay: 65 / SLOW });
  await wait(500);
  await click(page.getByRole('button', { name: 'Midnight' }), { ms: 500 });
  await wait(600);
  await click(page.getByRole('button', { name: 'Lumi', exact: true }), { ms: 500 });
  await wait(500);
  const dl = page.waitForEvent('download', { timeout: 240000 });
  await click(page.locator('button.btn-jelly.w-full:visible'));
  const d = await dl;
  albumPdf = path.join(OUT, 'album.pdf');
  await d.saveAs(albumPdf);
  await wait(1500);
});
await page.keyboard.press('Escape');
await byLabel('Close').click({ timeout: 2000 }).catch(() => {});
await wait(800);

// 10. Create video: the in-app beat-synced movie plays.
await shot('video', async () => {
  await click(vis('Create video'));
  await wait(6500);
  await click(page.getByRole('button', { name: /Vertical/ }), { ms: 700 });
  await wait(3000);
  await click(page.getByRole('button', { name: /Landscape/ }), { ms: 500 });
  await wait(1200);
});
await byLabel('Close').click({ timeout: 3000 }).catch(() => page.keyboard.press('Escape'));
await wait(800);

// 11. Cleanup: blinks and near-duplicates set aside.
await shot('cleanup', async () => {
  await click(page.locator('button:visible', { hasText: /^Cleanup/ }).first());
  await wait(1600);
  await moveTo(W * 0.3, H * 0.75, 900);
  await scrollTo(420, 1600);
  await wait(1200);
});

// 12. Explore world: Lumi on a 3D island of your photos.
await shot('world', async () => {
  await scrollTo(0, 600);
  await click(page.locator('button:visible', { hasText: /^All photos/ }).first());
  await wait(1400);
  await click(vis('Explore world'));
  await page.getByText(/Building Lumi/).waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {});
  await cursor(false);
  await wait(1500);
  rec.mark('world-ready');
  const kd = (k) => page.keyboard.down(k), ku = (k) => page.keyboard.up(k);
  // Walk up to the first easel until the "See all" prompt shows, then look.
  await kd('KeyW');
  await page.getByText(/^See all/).waitFor({ timeout: 4000 / SLOW }).catch(() => {});
  await ku('KeyW');
  await wait(500);
  await page.keyboard.press('KeyE');
  await wait(2800);
  await page.keyboard.press('ArrowRight');
  await wait(1300);
  await page.locator('[aria-label="Close"]:visible').last().click().catch(() => {});
  await wait(900);
  // Sprint loop with jumps.
  await kd('KeyS'); await wait(700);
  await kd('KeyD'); await kd('KeyQ'); await wait(1300);
  await ku('KeyS');
  await page.keyboard.press('Space'); await wait(900);
  await kd('KeyW'); await wait(700);
  await ku('KeyD'); await wait(900);
  await page.keyboard.press('Space'); await wait(1100);
  await kd('KeyA'); await wait(1500); await ku('KeyA');
  await page.keyboard.press('Space'); await wait(1000);
  await ku('KeyQ'); await wait(1000);
  await ku('KeyW'); await wait(1200);
});

await browser.close();
console.log('done →', OUT, albumPdf ? `(album: ${albumPdf})` : '');
