import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  GitMerge, Image as ImageIcon, Loader2, Pencil, RotateCcw,
  SlidersHorizontal, Sparkles, User, Users, Wand2, X,
} from 'lucide-react';
import type { Identity, NormSignals, Photo } from '../../types';
import { SIGNAL_UI } from '../../lib/signals';
import { getPreferences, rescoreWithPreferences, resetPreferences } from '../../lib/analysisApi';
import { FaceAvatar, FaceRing, type Toast } from './shared';

/* Modal panels the gallery opens: people corrections and the learned
   taste profile. Both portaled to <body>. */

/* ------------------------------------------------
   People manager (rename + merge corrections)
   ------------------------------------------------ */
interface PeopleManagerProps {
  identities: Identity[];
  photosById: Map<string, Photo>;
  onRename: (personId: string, label: string) => Promise<void>;
  onMerge: (sourceId: string, targetId: string) => Promise<void>;
  onMovePhoto: (photoId: string, fromPersonId: string, toPersonId: string) => Promise<void>;
  onClose: () => void;
}

export const PeopleManager: React.FC<PeopleManagerProps> = ({ identities, photosById, onRename, onMerge, onMovePhoto, onClose }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [photosOpenId, setPhotosOpenId] = useState<string | null>(null);
  const [movingPhotoId, setMovingPhotoId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const commitRename = async (personId: string) => {
    const label = editValue.trim();
    setEditingId(null);
    if (!label) return;
    setBusy(true);
    try { await onRename(personId, label); } finally { setBusy(false); }
  };

  const commitMerge = async (sourceId: string, targetId: string) => {
    setMergingId(null);
    setBusy(true);
    try { await onMerge(sourceId, targetId); } finally { setBusy(false); }
  };

  const commitMove = async (photoId: string, fromPersonId: string, toPersonId: string) => {
    setMovingPhotoId(null);
    setBusy(true);
    try { await onMovePhoto(photoId, fromPersonId, toPersonId); } finally { setBusy(false); }
  };

  // Portaled to <body>: the gallery's animated/filtered ancestors create CSS
  // containing blocks that hijack position:fixed and produced the "modal in a
  // random place + weird blur" bug.
  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
      data-anim="fade" style={{ background: 'rgba(30, 27, 60, 0.28)', backdropFilter: 'blur(6px)' }}
    >
      <div
        className="w-full max-w-md max-h-[82vh] flex flex-col rounded-3xl overflow-hidden shadow-2xl shadow-black/25 ring-1 ring-white/60"
        data-anim="pop" style={{
          background: 'linear-gradient(165deg, rgba(255,255,255,0.98) 0%, rgba(248,246,255,0.96) 100%)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-4 px-6 pt-6 pb-5">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-lumina-400 to-indigo-500 flex items-center justify-center flex-shrink-0 shadow-lg shadow-lumina-500/25">
            <Users className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold tracking-tight text-slate-800">Manage People</h3>
            <p className="text-[11px] text-slate-400 leading-snug">
              Rename or merge clusters — every fix is saved & teaches Lumina.
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-slate-900/[0.04] flex items-center justify-center text-slate-400 hover:bg-slate-900/[0.08] hover:text-slate-700 transition-colors flex-shrink-0"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />

        {/* People list */}
        <div className="overflow-y-auto px-4 py-4 space-y-2">
          {identities.map((ident, i) => (
            <div
              key={ident.id}
              className={`rounded-2xl border transition-all duration-300 ${
                mergingId === ident.id
                  ? 'bg-indigo-50/70 border-indigo-200 shadow-sm'
                  : 'bg-white/70 border-slate-100 hover:border-slate-200 hover:shadow-sm'
              }`}
              data-anim="fade-up" data-delay={Math.min(i * 40, 300)}
            >
              <div className="flex items-center gap-3 p-3">
                <FaceAvatar faceThumb={ident.faceThumb} label={ident.label} size="sm" />
                <div className="min-w-0 flex-1">
                  {editingId === ident.id ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(ident.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => commitRename(ident.id)}
                      className="text-sm font-medium bg-transparent border-b-2 border-lumina-400 outline-none w-full pb-0.5 text-slate-800"
                      placeholder="Person name…"
                    />
                  ) : (
                    <button
                      onClick={() => { setEditingId(ident.id); setEditValue(ident.label); }}
                      className="text-sm font-medium text-slate-800 truncate hover:text-lumina-600 transition-colors text-left block max-w-full"
                      title="Click to rename"
                    >
                      {ident.label}
                    </button>
                  )}
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {ident.photoIds.length} {ident.photoIds.length === 1 ? 'photo' : 'photos'} · {ident.eventIds.length} {ident.eventIds.length === 1 ? 'event' : 'events'}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => {
                      setPhotosOpenId(photosOpenId === ident.id ? null : ident.id);
                      setMovingPhotoId(null);
                    }}
                    disabled={busy}
                    className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors disabled:opacity-40 ${
                      photosOpenId === ident.id
                        ? 'bg-slate-700 text-white'
                        : 'bg-slate-900/[0.06] text-slate-500 hover:bg-slate-900/[0.12]'
                    }`}
                    title="Review this person's photos / fix wrong assignments"
                  >
                    <ImageIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => { setEditingId(ident.id); setEditValue(ident.label); }}
                    disabled={busy}
                    className="w-8 h-8 rounded-xl bg-lumina-500/10 flex items-center justify-center text-lumina-500 hover:bg-lumina-500/20 transition-colors disabled:opacity-40"
                    title="Rename"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  {identities.length > 1 && (
                    <button
                      onClick={() => setMergingId(mergingId === ident.id ? null : ident.id)}
                      disabled={busy}
                      className={`h-8 rounded-xl flex items-center justify-center gap-1.5 px-2.5 transition-all duration-200 text-[10px] font-bold uppercase tracking-wider ${
                        mergingId === ident.id
                          ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/25'
                          : 'bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20'
                      }`}
                      title="Same person split into two clusters? Merge them."
                    >
                      <GitMerge className="w-3.5 h-3.5" />
                      Merge
                    </button>
                  )}
                </div>
              </div>

              {mergingId === ident.id && (
                <div className="px-3 pb-3" data-anim="fade-up">
                  <div className="rounded-xl bg-white/80 border border-indigo-100 p-3">
                    <p className="text-[11px] text-slate-500 mb-2 font-medium">
                      <span className="text-indigo-500 font-semibold">"{ident.label}"</span> is the same person as…
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {identities.filter((other) => other.id !== ident.id).map((other) => (
                        <button
                          key={other.id}
                          onClick={() => commitMerge(ident.id, other.id)}
                          disabled={busy}
                          className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full bg-white border border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 hover:shadow-sm transition-all text-xs font-medium text-slate-700 disabled:opacity-40"
                        >
                          <div className="w-5 h-5 rounded-full overflow-hidden flex-shrink-0">
                            {other.faceThumb
                              ? <img src={other.faceThumb} alt={other.label} className="w-full h-full object-cover" />
                              : <div className="w-full h-full bg-lumina-100 flex items-center justify-center"><User className="w-3 h-3 text-lumina-400" /></div>}
                          </div>
                          {other.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {photosOpenId === ident.id && (
                <div className="px-3 pb-3" data-anim="fade-up">
                  <div className="rounded-xl bg-white/80 border border-slate-200 p-3">
                    <p className="text-[11px] text-slate-500 mb-2 font-medium">
                      Click a photo that <span className="font-semibold">isn't</span> {ident.label} to reassign it.
                    </p>
                    <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1" style={{ scrollbarWidth: 'none' }}>
                      {ident.photoIds.map((photoId) => {
                        const photo = photosById.get(photoId);
                        if (!photo) return null;
                        const selected = movingPhotoId === photoId;
                        return (
                          <button
                            key={photoId}
                            onClick={() => setMovingPhotoId(selected ? null : photoId)}
                            className={`relative w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 transition-all ${
                              selected ? 'ring-2 ring-red-400 scale-95' : 'hover:ring-2 hover:ring-slate-300'
                            }`}
                          >
                            <img src={photo.url} alt={photo.name} className="w-full h-full object-cover" loading="lazy" />
                            {ident.faceBoxes?.[photoId] && (
                              <FaceRing bbox={ident.faceBoxes[photoId]} imageAspect={1} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {movingPhotoId && identities.length > 1 && (
                      <div className="mt-2 pt-2 border-t border-slate-200/70" data-anim="fade-up">
                        <p className="text-[11px] text-red-400 font-medium mb-1.5">This photo actually shows…</p>
                        <div className="flex flex-wrap gap-1.5">
                          {identities.filter((other) => other.id !== ident.id).map((other) => (
                            <button
                              key={other.id}
                              onClick={() => commitMove(movingPhotoId, ident.id, other.id)}
                              disabled={busy}
                              className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full bg-white border border-slate-200 hover:border-red-300 hover:bg-red-50 transition-all text-xs font-medium text-slate-700 disabled:opacity-40"
                            >
                              <div className="w-5 h-5 rounded-full overflow-hidden flex-shrink-0">
                                {other.faceThumb
                                  ? <img src={other.faceThumb} alt={other.label} className="w-full h-full object-cover" />
                                  : <div className="w-full h-full bg-lumina-100 flex items-center justify-center"><User className="w-3 h-3 text-lumina-400" /></div>}
                              </div>
                              {other.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-6 py-3.5 bg-slate-50/80 border-t border-slate-100 flex items-center gap-2">
          {busy
            ? <Loader2 className="w-3.5 h-3.5 text-lumina-500 animate-spin flex-shrink-0" />
            : <Sparkles className="w-3.5 h-3.5 text-lumina-400 flex-shrink-0" />}
          <p className="text-[11px] text-slate-400 leading-snug">
            {busy ? 'Saving correction…' : 'Corrections persist with this session and are logged as clustering feedback.'}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
};


/* ------------------------------------------------
   Personalization panel (learned preference weights)
   ------------------------------------------------ */
interface PersonalizationPanelProps {
  jobId: string | null;
  anchor: DOMRect | null;
  onApplyRescore: (events: Array<{ eventId: string; topPhotoId: string | null }>) => void;
  onNotify: (message: string, kind?: Toast['kind']) => void;
  onClose: () => void;
}

export const PersonalizationPanel: React.FC<PersonalizationPanelProps> = ({ jobId, anchor, onApplyRescore, onNotify, onClose }) => {
  const [state, setState] = useState<{ weights: NormSignals; defaults: NormSignals; nUpdates: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPreferences()
      .then((prefs) => setState({ weights: prefs.weights, defaults: prefs.defaultWeights, nUpdates: prefs.nUpdates }))
      .catch(() => onNotify('Could not load preferences.', 'error'));
  }, [onNotify]);

  const applyTaste = async () => {
    if (!jobId) return;
    setBusy(true);
    try {
      const rescored = await rescoreWithPreferences(jobId);
      onApplyRescore(rescored.events);
      onNotify('Rankings updated to match your taste.', 'success');
      onClose();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Rescore failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await resetPreferences();
      const prefs = await getPreferences();
      setState({ weights: prefs.weights, defaults: prefs.defaultWeights, nUpdates: prefs.nUpdates });
      onNotify('Preferences reset to defaults.', 'info');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Reset failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Portaled + fixed so it always paints above the gallery, immune to the
  // stacking contexts created by animated/blurred ancestors.
  const panelStyle: React.CSSProperties = anchor
    ? { top: Math.min(anchor.bottom + 10, window.innerHeight - 80), right: Math.max(window.innerWidth - anchor.right, 16) }
    : { top: 96, right: 16 };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[300]" onClick={onClose} aria-hidden />
      <div
        className="fixed w-[min(360px,calc(100vw-2rem))] z-[310] max-h-[calc(100vh-120px)] overflow-y-auto rounded-2xl shadow-2xl shadow-black/20 ring-1 ring-white/60 p-5"
        data-anim="scale" style={{
          ...panelStyle,
          background: 'linear-gradient(165deg, rgba(255,255,255,0.98) 0%, rgba(248,246,255,0.96) 100%)',
           transformOrigin: 'top right',
        }}
      >
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-lumina-500" />
            Your Taste Profile
          </h4>
          {state && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              {state.nUpdates} {state.nUpdates === 1 ? 'swap' : 'swaps'} learned
            </span>
          )}
        </div>
        <p className="text-[11px] text-slate-400 leading-relaxed mb-4">
          Every time you promote a different best shot, Lumina updates these signal
          weights with pairwise preference learning (Bradley-Terry).
        </p>

        {!state ? (
          <div className="flex items-center justify-center py-6 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : (
          <div className="space-y-2.5 mb-4">
            {SIGNAL_UI.map(({ key, label }) => {
              const learned = state.weights[key] ?? 0;
              const base = state.defaults[key] ?? 0;
              const delta = learned - base;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">{label}</span>
                    <span className={`text-[10px] font-bold tabular-nums ${
                      Math.abs(delta) < 0.01 ? 'text-slate-400' : delta > 0 ? 'text-green-500' : 'text-red-400'
                    }`}>
                      {(learned * 100).toFixed(0)}%
                      {Math.abs(delta) >= 0.01 && (delta > 0 ? ' ▲' : ' ▼')}
                    </span>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-slate-200/70 overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-lumina-400 to-lumina-500 transition-all duration-500"
                      style={{ width: `${Math.min(learned * 200, 100)}%` }}
                    />
                    {/* default marker */}
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-slate-400/70"
                      style={{ left: `${Math.min(base * 200, 100)}%` }}
                      title={`Default: ${(base * 100).toFixed(0)}%`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={applyTaste}
            disabled={busy || !jobId || !state || state.nUpdates === 0}
            className="flex-1 py-2.5 rounded-xl bg-lumina-500 text-white text-xs font-bold uppercase tracking-widest hover:bg-lumina-600 transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5"
            title={state?.nUpdates === 0 ? 'Promote a few best shots first so Lumina can learn your taste' : 'Re-rank all events with your personal weights'}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
            Apply my taste
          </button>
          <button
            onClick={reset}
            disabled={busy || !state}
            className="px-3 py-2.5 rounded-xl bg-slate-100 text-slate-500 hover:bg-slate-200 transition-colors disabled:opacity-40"
            title="Reset to default weights"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
};
