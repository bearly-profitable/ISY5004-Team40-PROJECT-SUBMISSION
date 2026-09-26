import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Player } from '@remotion/player';
import { canRenderMediaOnWeb, renderMediaOnWeb } from '@remotion/web-renderer';
import {
  Check, Clapperboard, Download, Monitor, Music, Pencil, Share2, Smartphone, Upload, VolumeX, X,
} from 'lucide-react';
import type { Event, Photo } from '../../types';
import { sessionPhotoUrl } from '../../lib/analysisApi';
import { gsap, prefersReducedMotion } from '../../lib/motion';
import { Lumi } from '../Lumi';
import { PickTile } from './AlbumModal';
import type { Focal } from './shared';
import { LuminaMovie, type LuminaMovieProps } from '../../video/LuminaMovie';
import { FPS, MOOD_BPM, introBeats, planStoryboard, type Mood, type MoviePhoto } from '../../video/storyboard';
import { buildChapters, dateSpan, preparePhotos, releasePhotos } from '../../video/prepare';
import { composeSoundtrack } from '../../video/soundtrack';

/**
 * "Create video": a 1080p movie of the chosen photos, one chapter per moment,
 * with Lumi, transitions cut to the beat and a composed soundtrack. The
 * preview plays live; Export encodes an MP4 right here in the browser.
 */

type MusicChoice = Mood | 'custom' | 'none';
type Phase = 'loading' | 'ready' | 'exporting' | 'done';

const MUSIC_OPTIONS: Array<{ key: MusicChoice; name: string; blurb: string }> = [
  { key: 'sunny', name: 'Sunny', blurb: 'Bright and bouncy' },
  { key: 'dreamy', name: 'Dreamy', blurb: 'Soft and wistful' },
  { key: 'custom', name: 'My music', blurb: 'Pick a song' },
  { key: 'none', name: 'Silent', blurb: 'No music' },
];

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'lumina-video';

/** Make sure the movie's fonts are loaded before frames are drawn with them. */
async function loadFonts() {
  if (!document.fonts) return;
  await Promise.all([
    '800 100px Fraunces', '500 100px Fraunces', '700 40px Nunito', '800 40px Nunito', '900 40px Nunito',
  ].map((font) => document.fonts.load(font).catch(() => undefined)));
}

export const VideoModal: React.FC<{
  jobId: string;
  events: Event[];
  /** The curated picks the picker starts from, in moment order. */
  photos: Photo[];
  focal: Map<string, Focal>;
  /** photoId -> box around every face, so crops never cut someone out. */
  faces?: Map<string, [number, number, number, number]>;
  /** photoId -> URL of its AI-enhanced version, where one is showing. */
  enhancedUrls: Record<string, string>;
  onNotify: (message: string, kind?: 'success' | 'error' | 'info') => void;
  onClose: () => void;
}> = ({ jobId, events, photos, focal, faces, enhancedUrls, onNotify, onClose }) => {
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: photos.length });
  const [loaded, setLoaded] = useState<Map<string, MoviePhoto>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(() => new Set(photos.map((p) => p.id)));
  const [title, setTitle] = useState(() => (events.length === 1 ? events[0].label : 'Our favourite moments'));
  const [music, setMusic] = useState<MusicChoice>('sunny');
  const [custom, setCustom] = useState<{ url: string; name: string } | null>(null);
  const [vertical, setVertical] = useState(false);
  const [track, setTrack] = useState<{ key: string; url: string } | null>(null);
  const [exportProgress, setExportProgress] = useState({ progress: 0, eta: null as number | null });
  const [result, setResult] = useState<{ url: string; blob: Blob; name: string } | null>(null);
  const [support, setSupport] = useState<{ ok: boolean; message?: string }>({ ok: true });

  const backdropRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const trackRef = useRef(track);
  trackRef.current = track;
  const resultRef = useRef(result);
  resultRef.current = result;
  const customRef = useRef(custom);
  customRef.current = custom;

  const mood: Mood = music === 'dreamy' ? 'dreamy' : 'sunny';
  const subtitle = useMemo(() => dateSpan(events), [events]);

  // Fetch every candidate photo once; toggling them afterwards is instant.
  useEffect(() => {
    const controller = new AbortController();
    const sources = photos.map((p) => ({ id: p.id, url: enhancedUrls[p.id] ?? sessionPhotoUrl(jobId, p.id, 1920) }));
    preparePhotos(sources, focal, (done, total) => setLoadProgress({ done, total }), controller.signal, faces)
      .then((map) => {
        if (controller.signal.aborted) { releasePhotos(map.values()); return; }
        setLoaded(map);
        setPhase('ready');
        if (map.size < sources.length) onNotify(`${sources.length - map.size} photos could not be loaded and were left out.`, 'info');
      });
    return () => controller.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    canRenderMediaOnWeb({ width: 1920, height: 1080, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' })
      .then((r) => setSupport(r.canRender ? { ok: true } : { ok: false, message: r.issues.find((i) => i.severity === 'error')?.message }))
      .catch(() => setSupport({ ok: false }));
  }, []);

  // Free every blob this modal made.
  useEffect(() => () => {
    abortRef.current?.abort();
    releasePhotos(loadedRef.current.values());
    if (trackRef.current) URL.revokeObjectURL(trackRef.current.url);
    if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
    if (customRef.current) URL.revokeObjectURL(customRef.current.url);
  }, []);

  const storyboard = useMemo(() => {
    const chapters = buildChapters(events, selected, loaded);
    return planStoryboard(chapters, { title: title.trim() || 'Our moments', subtitle, mood, vertical });
  }, [events, selected, loaded, title, subtitle, mood, vertical]);

  const seconds = storyboard.durationInFrames / FPS;
  const trackKey = `${mood}:${storyboard.durationInFrames}`;

  // Compose the soundtrack to fit the movie (debounced while photos change).
  useEffect(() => {
    if (phase === 'loading' || music === 'custom' || music === 'none') return;
    if (track?.key === trackKey) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      const beatSec = 60 / MOOD_BPM[mood];
      composeSoundtrack({ mood, seconds, dropBeat: introBeats(beatSec) })
        .then((blob) => {
          if (!alive) return;
          setTrack((prev) => {
            if (prev) URL.revokeObjectURL(prev.url);
            return { key: trackKey, url: URL.createObjectURL(blob) };
          });
        })
        .catch((err) => console.warn('[Lumina] Soundtrack failed:', err));
    }, 350);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [phase, music, mood, seconds, trackKey, track?.key]);

  const musicUrl = music === 'custom' ? custom?.url ?? null : music === 'none' ? null : track?.key === trackKey ? track.url : null;
  const movieProps: LuminaMovieProps = { storyboard, music: musicUrl, fadeMusic: music === 'custom' };
  const width = vertical ? 1080 : 1920;
  const height = vertical ? 1920 : 1080;
  const photoCount = storyboard.scenes.reduce((n, s) => n + (s.scene.kind === 'shot' ? s.scene.photos.length : 0), 0);

  /* ---- motion ---- */

  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    const card = cardRef.current;
    const ctx = gsap.context(() => {
      gsap.timeline()
        .fromTo(backdropRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power2.out' })
        .fromTo(card, { y: 40, scale: 0.96, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.6, ease: 'expo.out' }, 0)
        .from(card?.querySelectorAll('[data-video-section]') ?? [], { y: 14, opacity: 0, duration: 0.45, ease: 'power3.out', stagger: 0.07 }, 0.12);
    });
    return () => ctx.revert();
  }, []);

  const close = useCallback(() => {
    if (phase === 'exporting') return;
    if (prefersReducedMotion()) { onClose(); return; }
    gsap.to(cardRef.current, { y: 24, scale: 0.97, opacity: 0, duration: 0.22, ease: 'power2.in' });
    gsap.to(backdropRef.current, { opacity: 0, duration: 0.25, ease: 'power2.in', onComplete: onClose });
  }, [phase, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [close]);

  /* ---- actions ---- */

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const pickSong = (file: File | undefined) => {
    if (!file) return;
    setCustom((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { url: URL.createObjectURL(file), name: file.name };
    });
    setMusic('custom');
  };

  const startExport = async () => {
    if (!photoCount) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('exporting');
    setExportProgress({ progress: 0, eta: null });
    // The page's own animations would compete with the exporter for every frame.
    gsap.globalTimeline.pause();
    let shownPct = -1;
    let shownEta = 0;
    try {
      await loadFonts();
      // The soundtrack must match this exact cut before it is baked in.
      let audio = musicUrl;
      if ((music === 'sunny' || music === 'dreamy') && !audio) {
        const blob = await composeSoundtrack({ mood, seconds, dropBeat: introBeats(60 / MOOD_BPM[mood]) });
        audio = URL.createObjectURL(blob);
        setTrack((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return { key: trackKey, url: audio! };
        });
      }
      const props: LuminaMovieProps = { storyboard, music: audio, fadeMusic: music === 'custom' };
      const { getBlob } = await renderMediaOnWeb({
        composition: {
          id: 'lumina-movie',
          component: LuminaMovie,
          durationInFrames: storyboard.durationInFrames,
          fps: FPS,
          width,
          height,
          defaultProps: props,
          calculateMetadata: null,
        },
        inputProps: props,
        container: 'mp4',
        videoCodec: 'h264',
        videoBitrate: 'high',
        muted: !audio,
        hardwareAcceleration: 'prefer-hardware',
        // Keep the progress bar moving without giving up much speed.
        pageResponsiveness: 'low',
        signal: controller.signal,
        licenseKey: 'free-license',
        // Re-render only when the numbers on screen change, not every frame.
        onProgress: ({ progress, renderEstimatedTime }) => {
          const pct = Math.floor(progress * 100);
          const eta = Math.round(renderEstimatedTime / 1000);
          if (pct === shownPct && eta === shownEta) return;
          shownPct = pct;
          shownEta = eta;
          setExportProgress({ progress, eta: renderEstimatedTime });
        },
      });
      const blob = await getBlob();
      const name = `${slug(title.trim())}.mp4`;
      setResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url: URL.createObjectURL(blob), blob, name };
      });
      setPhase('done');
    } catch (err) {
      setPhase('ready');
      if (controller.signal.aborted) return;
      console.error('[Lumina] Video export failed:', err);
      onNotify(err instanceof Error ? `Video export failed: ${err.message}` : 'Video export failed.', 'error');
    } finally {
      abortRef.current = null;
      gsap.globalTimeline.resume();
    }
  };

  const download = () => {
    if (!result) return;
    const a = document.createElement('a');
    a.href = result.url;
    a.download = result.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const shareFile = result ? new File([result.blob], result.name, { type: 'video/mp4' }) : null;
  const canShare = Boolean(shareFile && typeof navigator.canShare === 'function' && navigator.canShare({ files: [shareFile] }));
  const share = async () => {
    if (!shareFile) return;
    try {
      await navigator.share({ files: [shareFile], title: title.trim() });
    } catch {
      // Cancelled by the user.
    }
  };

  /* ---- render ---- */

  const loadingPct = loadProgress.total ? Math.round((loadProgress.done / loadProgress.total) * 100) : 0;
  const exportPct = Math.round(exportProgress.progress * 100);

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[330] flex items-end sm:items-center justify-center p-3 sm:p-6"
      // No backdrop blur while exporting: it would be recomposited every frame.
      style={phase === 'exporting' ? { background: 'rgba(23, 15, 31, 0.72)' } : { background: 'rgba(23, 15, 31, 0.5)', backdropFilter: 'blur(8px)' }}
      onClick={close}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-title"
        className="w-full max-w-5xl max-h-[92vh] flex flex-col rounded-[1.75rem] bg-white shadow-2xl shadow-slate-900/25 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 sm:px-6 pt-5 sm:pt-6 pb-4">
          <div className="min-w-0 flex-1">
            <h3 id="video-title" className="font-display text-2xl font-semibold text-slate-900 leading-tight">Create a video</h3>
            <p className="text-sm text-slate-500 mt-0.5">A 1080p movie of your moments, cut to the beat, with Lumi as your director.</p>
          </div>
          <button
            onClick={close}
            disabled={phase === 'exporting'}
            className="w-9 h-9 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800 flex items-center justify-center flex-shrink-0 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto lg:overflow-hidden flex-1 min-h-0 grid lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* Preview */}
          <div className="px-5 sm:px-6 pb-4 lg:pb-6 flex flex-col justify-center min-h-0" data-video-section>
            <div
              className={`relative mx-auto max-w-full rounded-2xl bg-slate-950 overflow-hidden flex items-center justify-center ${
                vertical ? 'h-[min(62vh,640px)] aspect-[9/16]' : 'w-full aspect-video'
              }`}
            >
              {phase === 'loading' && (
                <div className="flex flex-col items-center text-center px-6">
                  <Lumi pose="carry" size={120} />
                  <p className="text-white font-bold mt-3">Gathering your photos…</p>
                  <div className="w-56 h-2 rounded-full bg-white/15 mt-3 overflow-hidden">
                    <div className="h-full rounded-full bg-lumina-400 transition-[width] duration-300" style={{ width: `${loadingPct}%` }} />
                  </div>
                  <p className="text-white/60 text-xs mt-2">{loadProgress.done} of {loadProgress.total}</p>
                </div>
              )}

              {/* The live preview stops during export so it does not compete for the CPU. */}
              {phase === 'ready' && photoCount > 0 && (
                <Player
                  key={vertical ? 'v' : 'h'}
                  component={LuminaMovie}
                  inputProps={movieProps}
                  durationInFrames={storyboard.durationInFrames}
                  fps={FPS}
                  compositionWidth={width}
                  compositionHeight={height}
                  controls
                  loop
                  autoPlay
                  acknowledgeRemotionLicense
                  style={{ width: '100%', height: '100%' }}
                />
              )}

              {phase === 'ready' && photoCount === 0 && (
                <p className="text-white/70 text-sm px-6 text-center">Pick at least one photo to make a video.</p>
              )}

              {phase === 'exporting' && (
                <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center text-center px-6">
                  <Lumi pose="star" size={130} float={false} />
                  <p className="text-white font-bold text-lg mt-3">Lumi is editing your video… {exportPct}%</p>
                  <div className="w-64 max-w-full h-2.5 rounded-full bg-white/15 mt-3 overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-lumina-400 to-pink-400" style={{ width: `${exportPct}%` }} />
                  </div>
                  <p className="text-white/60 text-xs mt-2">
                    {exportProgress.eta != null && exportProgress.progress > 0.03 ? `About ${Math.max(1, Math.round(exportProgress.eta / 1000))} s left · ` : ''}
                    Keep this tab open
                  </p>
                  <button onClick={() => abortRef.current?.abort()} className="mt-4 text-sm font-bold text-white/80 hover:text-white underline underline-offset-4">
                    Cancel
                  </button>
                </div>
              )}

              {phase === 'done' && result && (
                <video src={result.url} controls autoPlay playsInline className="w-full h-full object-contain" />
              )}
            </div>
          </div>

          {/* Options */}
          <div className="px-5 sm:px-6 pb-6 space-y-6 lg:overflow-y-auto lg:border-l border-slate-100 lg:pt-1">
            <section data-video-section>
              <label htmlFor="video-name" className="block text-sm font-bold text-slate-800 mb-2">Title</label>
              <input
                id="video-name"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={40}
                disabled={phase === 'exporting'}
                placeholder="Summer at the Bay"
                className="w-full h-11 px-4 rounded-xl bg-slate-50 ring-1 ring-slate-200 text-[15px] text-slate-800 outline-none focus:ring-2 focus:ring-lumina-400 focus:bg-white transition-shadow disabled:opacity-60"
              />
            </section>

            <section data-video-section>
              <p className="text-sm font-bold text-slate-800 mb-2">Format</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { v: false, label: 'Landscape', sub: '16:9 · 1920×1080', icon: <Monitor className="w-4 h-4" /> },
                  { v: true, label: 'Vertical', sub: '9:16 · Stories, Reels', icon: <Smartphone className="w-4 h-4" /> },
                ].map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => setVertical(o.v)}
                    disabled={phase === 'exporting'}
                    aria-pressed={vertical === o.v}
                    className={`text-left rounded-xl px-3 py-2.5 transition-all ${
                      vertical === o.v ? 'bg-lumina-500/10 ring-2 ring-lumina-500' : 'bg-slate-50 ring-1 ring-slate-200 hover:ring-slate-300'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-bold text-slate-800">{o.icon}{o.label}</span>
                    <span className="block text-[11px] text-slate-500 mt-0.5">{o.sub}</span>
                  </button>
                ))}
              </div>
            </section>

            <section data-video-section>
              <p className="text-sm font-bold text-slate-800 mb-2">Music</p>
              <div className="grid grid-cols-2 gap-2">
                {MUSIC_OPTIONS.map((o) => {
                  const active = music === o.key;
                  const content = (
                    <>
                      <span className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
                        {o.key === 'none' ? <VolumeX className="w-4 h-4" /> : o.key === 'custom' ? <Upload className="w-4 h-4" /> : <Music className="w-4 h-4" />}
                        {o.name}
                      </span>
                      <span className="block text-[11px] text-slate-500 mt-0.5 truncate">
                        {o.key === 'custom' && custom ? custom.name : o.blurb}
                      </span>
                      {active && (
                        <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-lumina-500 text-white flex items-center justify-center">
                          <Check className="w-2.5 h-2.5" strokeWidth={3} />
                        </span>
                      )}
                    </>
                  );
                  const cls = `relative text-left rounded-xl px-3 py-2.5 transition-all ${
                    active ? 'bg-lumina-500/10 ring-2 ring-lumina-500' : 'bg-slate-50 ring-1 ring-slate-200 hover:ring-slate-300'
                  } ${phase === 'exporting' ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`;
                  return o.key === 'custom' && !custom ? (
                    <label key={o.key} className={cls}>
                      {content}
                      <input type="file" accept="audio/*" hidden onChange={(e) => pickSong(e.target.files?.[0])} />
                    </label>
                  ) : (
                    <button key={o.key} type="button" onClick={() => setMusic(o.key)} aria-pressed={active} className={cls}>
                      {content}
                    </button>
                  );
                })}
              </div>
              {custom && (
                <label className="inline-block text-xs font-bold text-lumina-600 hover:text-lumina-700 mt-2 cursor-pointer">
                  Choose a different song
                  <input type="file" accept="audio/*" hidden onChange={(e) => pickSong(e.target.files?.[0])} />
                </label>
              )}
              {(music === 'sunny' || music === 'dreamy') && (
                <p className="text-[11px] text-slate-400 mt-2">Composed for your video, so every cut lands on the beat.</p>
              )}
            </section>

            <section data-video-section>
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-sm font-bold text-slate-800">
                  Photos <span className="font-semibold text-slate-400">{selected.size} of {photos.length}</span>
                </p>
                <button
                  type="button"
                  disabled={phase === 'exporting'}
                  onClick={() => setSelected(selected.size === photos.length ? new Set() : new Set(photos.map((p) => p.id)))}
                  className="text-xs font-bold text-lumina-600 hover:text-lumina-700"
                >
                  {selected.size === photos.length ? 'Clear' : 'Select all'}
                </button>
              </div>
              <div className={`grid grid-cols-5 gap-1.5 ${phase === 'exporting' ? 'pointer-events-none opacity-60' : ''}`}>
                {photos.map((photo) => (
                  <PickTile key={photo.id} photo={photo} selected={selected.has(photo.id)} onToggle={() => toggle(photo.id)} />
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-2">More photos make a faster-paced video; big sets are shown in collages.</p>
            </section>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 sm:px-6 py-4 border-t border-slate-100 bg-white flex flex-col sm:flex-row sm:items-center gap-3">
          <p className="text-xs text-slate-500 sm:flex-1">
            {phase === 'loading'
              ? 'Getting everything ready…'
              : `${formatTime(seconds)} · ${photoCount} ${photoCount === 1 ? 'photo' : 'photos'} · ${vertical ? '1080×1920' : '1920×1080'} MP4`}
            {!support.ok && <span className="block text-red-500 font-semibold mt-0.5">{support.message ?? 'This browser cannot export video. Try the latest Chrome, Edge or Safari.'}</span>}
          </p>
          {phase === 'done' && result ? (
            <div className="flex gap-2">
              <button onClick={() => setPhase('ready')} className="h-11 px-4 rounded-full text-sm font-bold flex items-center gap-2 bg-slate-100 text-slate-700 hover:bg-slate-200">
                <Pencil className="w-4 h-4" /> Edit
              </button>
              {canShare && (
                <button onClick={share} className="h-11 px-4 rounded-full text-sm font-bold flex items-center gap-2 bg-slate-100 text-slate-700 hover:bg-slate-200">
                  <Share2 className="w-4 h-4" /> Share
                </button>
              )}
              <button onClick={download} className="btn-jelly">
                <Download className="w-4 h-4" /> Download · {(result.blob.size / 1e6).toFixed(0)} MB
              </button>
            </div>
          ) : (
            <button
              onClick={startExport}
              disabled={phase !== 'ready' || photoCount === 0 || !support.ok}
              className="btn-jelly sm:min-w-[220px]"
            >
              <Clapperboard className="w-4 h-4" />
              {phase === 'exporting' ? `Exporting… ${exportPct}%` : 'Export video'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
