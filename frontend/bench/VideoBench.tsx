import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Player } from '@remotion/player';
import { canRenderMediaOnWeb, renderMediaOnWeb } from '@remotion/web-renderer';
import { BenchMovie, totalFrames, type BenchPhoto } from './BenchMovie';

/**
 * Dev-only export benchmark for "Create video": open /bench/video.html on the
 * Vite dev server, pick photos (or use generated ones), run an export and read
 * off how long it took. Nothing here ships in the production build.
 */

interface Preset { key: string; label: string; width: number; height: number; fps: number }
const PRESETS: Preset[] = [
  { key: '720p25', label: '720p · 25 fps', width: 1280, height: 720, fps: 25 },
  { key: '1080p30', label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30 },
  { key: '720p25-v', label: '9:16 720p · 25 fps', width: 720, height: 1280, fps: 25 },
];

interface Result {
  preset: string;
  photos: number;
  videoSeconds: number;
  frames: number;
  renderSeconds: number;
  msPerFrame: number;
  realtimeX: number;
  sizeMB: number;
  responsiveness: string;
  error?: string;
}

const MAX_SIDE = 1920;

/** Downscale a picked photo the way the backend's `?w=` thumbnails would. */
async function loadPhoto(file: Blob): Promise<BenchPhoto> {
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * k);
  const h = Math.round(bitmap.height * k);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.88));
  return { src: URL.createObjectURL(blob), w, h };
}

/** Photo-like noise images so the bench also runs with nothing picked. */
async function demoPhotos(n: number): Promise<BenchPhoto[]> {
  const out: BenchPhoto[] = [];
  for (let i = 0; i < n; i++) {
    const portrait = i % 3 === 1;
    const w = portrait ? 1080 : 1920;
    const h = portrait ? 1440 : 1280;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${(i * 37) % 360} 70% 60%)`);
    g.addColorStop(1, `hsl(${(i * 37 + 120) % 360} 60% 35%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 400; k++) {
      ctx.fillStyle = `hsla(${(i * 37 + k) % 360} 60% ${30 + (k % 50)}% / 0.35)`;
      ctx.beginPath();
      ctx.arc(((k * 7919) % w), ((k * 104729) % h), 10 + (k % 90), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${h / 6}px system-ui`;
    ctx.fillText(String(i + 1), w * 0.08, h * 0.25);
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.88));
    out.push({ src: URL.createObjectURL(blob), w, h });
  }
  return out;
}

declare global {
  interface Window { __bench?: { ready: boolean; results: Result[]; run: (preset: string, responsiveness?: string) => Promise<Result> } }
}

const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #e2e8f0', textAlign: 'right', whiteSpace: 'nowrap' };

const App: React.FC = () => {
  const [photos, setPhotos] = useState<BenchPhoto[]>([]);
  const [count, setCount] = useState(30);
  const [blurBackdrop, setBlurBackdrop] = useState(true);
  const [responsiveness, setResponsiveness] = useState<'disabled' | 'medium'>('disabled');
  const [previewPreset, setPreviewPreset] = useState(PRESETS[0]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  const [support, setSupport] = useState<string>('checking…');

  const used = useMemo(() => photos.slice(0, count), [photos, count]);

  useEffect(() => {
    canRenderMediaOnWeb({ width: 1920, height: 1080, container: 'mp4', videoCodec: 'h264', muted: true })
      .then((r) => setSupport(r.canRender ? `OK (${r.resolvedVideoCodec})` : r.issues.map((i) => i.message).join('; ')))
      .catch((e) => setSupport(String(e)));
  }, []);

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy('loading photos');
    const list = await Promise.all(Array.from(files).filter((f) => f.type.startsWith('image/')).map(loadPhoto));
    setPhotos(list);
    setCount(Math.min(list.length, 30));
    setBusy(null);
  };

  const useDemo = async () => {
    setBusy('generating demo photos');
    setPhotos(await demoPhotos(60));
    setCount(30);
    setBusy(null);
  };

  const run = useCallback(async (presetKey: string, resp: string = responsiveness): Promise<Result> => {
    const preset = PRESETS.find((p) => p.key === presetKey)!;
    const frames = totalFrames(used.length, preset.fps);
    const base = { preset: preset.label, photos: used.length, videoSeconds: frames / preset.fps, frames, responsiveness: resp };
    setBusy(`exporting ${preset.label}`);
    setProgress(0);
    const t0 = performance.now();
    try {
      const { getBlob } = await renderMediaOnWeb({
        composition: {
          id: 'bench',
          component: BenchMovie,
          durationInFrames: frames,
          fps: preset.fps,
          width: preset.width,
          height: preset.height,
          calculateMetadata: null,
          defaultProps: { photos: used, blurBackdrop },
        },
        inputProps: { photos: used, blurBackdrop },
        container: 'mp4',
        videoCodec: 'h264',
        muted: true,
        videoBitrate: 'medium',
        pageResponsiveness: resp as 'disabled' | 'medium',
        hardwareAcceleration: 'prefer-hardware',
        onProgress: ({ progress: p }) => setProgress(p),
      });
      const blob = await getBlob();
      const renderSeconds = (performance.now() - t0) / 1000;
      const result: Result = {
        ...base,
        renderSeconds,
        msPerFrame: (renderSeconds * 1000) / frames,
        realtimeX: base.videoSeconds / renderSeconds,
        sizeMB: blob.size / 1e6,
      };
      setDownload((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url: URL.createObjectURL(blob), name: `lumina-bench-${preset.key}.mp4` };
      });
      setResults((r) => [...r, result]);
      window.__bench!.results.push(result);
      return result;
    } catch (e) {
      const result: Result = { ...base, renderSeconds: (performance.now() - t0) / 1000, msPerFrame: 0, realtimeX: 0, sizeMB: 0, error: String(e) };
      setResults((r) => [...r, result]);
      window.__bench!.results.push(result);
      return result;
    } finally {
      setBusy(null);
    }
  }, [used, blurBackdrop, responsiveness]);

  useEffect(() => {
    window.__bench = { ready: used.length > 0, results: window.__bench?.results ?? [], run };
  }, [run, used.length]);

  const previewFrames = used.length ? totalFrames(used.length, previewPreset.fps) : 1;

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 960, margin: '0 auto', padding: 16, color: '#0f172a' }}>
      <h1 style={{ fontSize: 22, margin: '8px 0' }}>Create-video export benchmark</h1>
      <p style={{ color: '#64748b', margin: '0 0 12px', fontSize: 14 }}>WebCodecs support: <b>{support}</b></p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <label style={{ padding: '8px 12px', background: '#0f172a', color: '#fff', borderRadius: 999, cursor: 'pointer', fontSize: 14 }}>
          Pick photos
          <input type="file" accept="image/*" multiple hidden onChange={(e) => onPick(e.target.files)} data-testid="pick" />
        </label>
        <button onClick={useDemo} disabled={!!busy} style={{ padding: '8px 12px', borderRadius: 999, fontSize: 14 }}>Use 60 demo photos</button>
        <span style={{ fontSize: 14 }}>{photos.length} loaded</span>
      </div>

      {photos.length > 0 && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', fontSize: 14, marginBottom: 12 }}>
            <label>Photos in video: <input type="range" min={1} max={photos.length} value={count} onChange={(e) => setCount(+e.target.value)} /> <b>{count}</b></label>
            <label><input type="checkbox" checked={blurBackdrop} onChange={(e) => setBlurBackdrop(e.target.checked)} /> blurred backdrops</label>
            <label>page responsiveness{' '}
              <select value={responsiveness} onChange={(e) => setResponsiveness(e.target.value as 'disabled' | 'medium')}>
                <option value="disabled">disabled (fastest)</option>
                <option value="medium">medium (default)</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button key={p.key} onClick={() => setPreviewPreset(p)} style={{ fontWeight: previewPreset.key === p.key ? 700 : 400, fontSize: 13 }}>Preview {p.label}</button>
            ))}
          </div>
          <Player
            key={`${previewPreset.key}-${used.length}`}
            component={BenchMovie}
            inputProps={{ photos: used, blurBackdrop }}
            durationInFrames={previewFrames}
            fps={previewPreset.fps}
            compositionWidth={previewPreset.width}
            compositionHeight={previewPreset.height}
            controls
            style={{ width: '100%', maxHeight: '60vh', aspectRatio: `${previewPreset.width} / ${previewPreset.height}`, background: '#000', borderRadius: 12 }}
          />
          <p style={{ fontSize: 13, color: '#64748b' }}>Video length: {(previewFrames / previewPreset.fps).toFixed(1)} s ({previewFrames} frames)</p>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
            {PRESETS.map((p) => (
              <button key={p.key} disabled={!!busy} onClick={() => run(p.key)} style={{ padding: '10px 14px', borderRadius: 999, background: '#7c3aed', color: '#fff', border: 0, fontWeight: 700 }}>
                Export {p.label}
              </button>
            ))}
          </div>
        </>
      )}

      {busy && (
        <div style={{ margin: '8px 0' }}>
          <div style={{ fontSize: 14, marginBottom: 4 }}>{busy}… {Math.round(progress * 100)}% (keep this tab in front)</div>
          <div style={{ height: 8, background: '#e2e8f0', borderRadius: 4 }}><div style={{ height: 8, width: `${progress * 100}%`, background: '#7c3aed', borderRadius: 4 }} /></div>
        </div>
      )}

      {results.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13, marginTop: 12 }}>
            <thead><tr>{['Preset', 'Photos', 'Video s', 'Frames', 'Export s', 'ms/frame', '× realtime', 'MB', 'Responsiveness'].map((h) => <th key={h} style={{ ...cell, textAlign: 'left' }}>{h}</th>)}</tr></thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...cell, textAlign: 'left' }}>{r.preset}</td>
                  <td style={cell}>{r.photos}</td>
                  <td style={cell}>{r.videoSeconds.toFixed(1)}</td>
                  <td style={cell}>{r.frames}</td>
                  <td style={cell}>{r.error ? `failed: ${r.error}` : r.renderSeconds.toFixed(1)}</td>
                  <td style={cell}>{r.msPerFrame.toFixed(1)}</td>
                  <td style={cell}>{r.realtimeX.toFixed(2)}</td>
                  <td style={cell}>{r.sizeMB.toFixed(1)}</td>
                  <td style={cell}>{r.responsiveness}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {download && <p><a href={download.url} download={download.name}>Download last export</a></p>}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
