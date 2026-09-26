
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CalendarDays, Check, Clock, History, ImageIcon, Loader2, LogIn, Pencil, RefreshCw, Star, Trash2, Users,
} from 'lucide-react';
import { SessionSummary } from '../types';
import { deleteSession, listSessions, sessionPhotoUrl } from '../lib/analysisApi';
import { useAuth } from '../lib/auth';
import { deleteSessionLabel, fetchSessionLabels, saveSessionLabel, type SessionLabel } from '../lib/sessionLabels';
import { Lumi } from '../components/Lumi';

function formatWhen(createdAt: number): string {
  const date = new Date(createdAt * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    + ' · ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

interface SessionCardProps {
  session: SessionSummary;
  index: number;
  onOpen: (jobId: string) => void;
  onDelete: (jobId: string) => Promise<void>;
  disabled: boolean;
  /** Signed-in users can name and star their sessions. */
  label?: SessionLabel;
  onLabel?: (label: SessionLabel) => void;
}

const SessionCard: React.FC<SessionCardProps> = ({ session, index, onOpen, onDelete, disabled, label, onLabel }) => {
  const [thumbFailed, setThumbFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const s = session.summary;
  const current: SessionLabel = label ?? { title: null, favourite: false };

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(current.title ?? '');
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    if ((draft.trim() || null) !== current.title) onLabel?.({ ...current, title: draft.trim() || null });
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      window.setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    setDeleting(true);
    try {
      await onDelete(session.jobId);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      onClick={() => { if (!disabled && !deleting) onOpen(session.jobId); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && !renaming && !disabled && !deleting) onOpen(session.jobId); }}
      className={`text-left w-full group liquid-glass-light rounded-2xl overflow-hidden hover:shadow-xl hover:shadow-lumina-500/10 hover:-translate-y-0.5 transition-all duration-300 cursor-pointer ${disabled || deleting ? 'opacity-60 pointer-events-none' : ''}`}
      data-anim="fade-up"
      data-delay={Math.min(index * 60, 500)}
    >
      <div className="relative aspect-[16/9] overflow-hidden bg-slate-100/50">
        {session.topPhotoId && !thumbFailed ? (
          <>
            <div className="absolute inset-0 skeleton" />
            <img
              src={sessionPhotoUrl(session.jobId, session.topPhotoId, 400)}
              alt="Session preview"
              className="relative w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.05]"
              loading="lazy"
              onError={() => setThumbFailed(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent pointer-events-none" />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-slate-300" />
          </div>
        )}
        <div className="absolute bottom-3 left-3 flex items-center gap-1.5 bg-black/45 backdrop-blur-md rounded-lg px-2.5 py-1">
          <Clock className="w-3 h-3 text-white/70" />
          <span className="text-[10px] font-semibold text-white tracking-wide">{formatWhen(session.createdAt)}</span>
        </div>

        {onLabel && (
          <button
            onClick={(e) => { e.stopPropagation(); onLabel({ ...current, favourite: !current.favourite }); }}
            aria-pressed={current.favourite}
            className={`absolute top-3 left-3 w-9 h-9 rounded-full backdrop-blur-md flex items-center justify-center transition-all duration-200 ${
              current.favourite
                ? 'bg-white text-amber-400 shadow-lg'
                : 'bg-black/40 text-white/90 hover:bg-white hover:text-amber-400 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
            }`}
            title={current.favourite ? 'Unstar' : 'Star this session'}
            aria-label={current.favourite ? 'Unstar session' : 'Star session'}
          >
            <Star className="w-4 h-4" fill={current.favourite ? 'currentColor' : 'none'} />
          </button>
        )}

        {/* Delete — two-step confirm, right where the cursor already is */}
        <button
          onClick={handleDelete}
          disabled={deleting}
          className={`absolute top-3 right-3 flex items-center gap-1.5 rounded-full backdrop-blur-md transition-all duration-200 ${
            confirming
              ? 'bg-red-500 text-white px-3 py-1.5 shadow-lg shadow-red-500/30'
              : 'bg-black/40 text-white/90 hover:bg-red-500/85 hover:text-white w-9 h-9 justify-center [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          }`}
          title={confirming ? 'Click again to permanently delete' : 'Delete this session'}
        >
          {deleting
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : confirming
            ? (<><AlertTriangle className="w-3 h-3" /><span className="text-[10px] font-bold uppercase tracking-widest">Sure?</span></>)
            : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>

      {onLabel && (
        <div className="px-4 pt-3.5 -mb-1.5 flex items-center gap-2 min-w-0" onClick={(e) => renaming && e.stopPropagation()}>
          {renaming ? (
            <form className="flex items-center gap-2 flex-1" onSubmit={(e) => { e.preventDefault(); commitRename(); }}>
              <input
                autoFocus
                value={draft}
                maxLength={60}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(false); }}
                onClick={(e) => e.stopPropagation()}
                placeholder="Bali trip, Mum's 60th…"
                className="glass-input flex-1 min-w-0 rounded-xl px-3 py-1.5 text-sm font-bold text-slate-800"
              />
              <button type="submit" className="w-8 h-8 rounded-full bg-lumina-500 text-white flex items-center justify-center" aria-label="Save name">
                <Check className="w-4 h-4" />
              </button>
            </form>
          ) : (
            <>
              <span className={`truncate font-extrabold ${current.title ? 'text-slate-800' : 'text-slate-400'}`}>
                {current.title || 'Untitled session'}
              </span>
              <button onClick={startRename} className="shrink-0 w-7 h-7 rounded-full text-slate-400 hover:text-lumina-600 hover:bg-lumina-100 flex items-center justify-center" aria-label="Rename session" title="Rename">
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      <div className="p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <ImageIcon className="w-3.5 h-3.5 text-lumina-400" />
            {session.numPhotos} photos
          </span>
          {s && (
            <>
              <span className="flex items-center gap-1.5">
                <CalendarDays className="w-3.5 h-3.5 text-indigo-400" />
                {s.numEvents} {s.numEvents === 1 ? 'event' : 'events'}
              </span>
              <span className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-lumina-400" />
                {s.numIdentities} {s.numIdentities === 1 ? 'person' : 'people'}
              </span>
            </>
          )}
        </div>
        <span className="text-[10px] font-extrabold uppercase tracking-widest text-lumina-500 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex-shrink-0">
          Open →
        </span>
      </div>
    </div>
  );
};

interface SessionsProps {
  onOpenSession: (jobId: string) => void;
  isLoading: boolean;
}

export const Sessions: React.FC<SessionsProps> = ({ onOpenSession, isLoading }) => {
  const { user, loading: authLoading, signInWithGoogle } = useAuth();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [labels, setLabels] = useState<Record<string, SessionLabel>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    setError(null);
    try {
      setSessions(await listSessions());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions.');
    } finally {
      setRefreshing(false);
    }
    // Names and stars come from Supabase; the list still works without them.
    if (user) fetchSessionLabels().then(setLabels).catch(() => setLabels({}));
    else setLabels({});
  };

  // Wait for auth to settle so we list the account's sessions, not the browser's.
  useEffect(() => { if (!authLoading) load(); }, [user?.id, authLoading]);

  const handleDelete = async (jobId: string) => {
    try {
      await deleteSession(jobId);
      setSessions((prev) => prev?.filter((s) => s.jobId !== jobId) ?? prev);
      if (user) deleteSessionLabel(jobId).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session.');
    }
  };

  const handleLabel = async (jobId: string, label: SessionLabel) => {
    if (!user) return;
    const previous = labels[jobId];
    setLabels((prev) => ({ ...prev, [jobId]: label }));
    try {
      await saveSessionLabel(user.id, jobId, label);
    } catch (err) {
      setLabels((prev) => {
        const next = { ...prev };
        if (previous) next[jobId] = previous; else delete next[jobId];
        return next;
      });
      setError(err instanceof Error ? err.message : 'Could not save that change.');
    }
  };

  // Starred sessions first, each group newest first (the backend's order).
  const ordered = useMemo(() => {
    if (!sessions) return null;
    const starred = sessions.filter((s) => labels[s.jobId]?.favourite);
    return [...starred, ...sessions.filter((s) => !labels[s.jobId]?.favourite)];
  }, [sessions, labels]);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex items-center justify-between gap-4 mb-8">
        <div className="flex items-center gap-3 sm:gap-5 min-w-0">
          <Lumi pose="carry" size={96} className="shrink-0" />
          <div className="min-w-0">
            <span data-anim="fade-left" className="chip mb-2">
              <History className="w-3 h-3" /> Your history
            </span>
            <h1 data-anim="fade-up" data-delay="80" className="font-display text-3xl md:text-5xl font-bold text-slate-900">
              {user ? 'Your sessions' : 'Past sessions'}
            </h1>
            <p data-anim="fade-up" data-delay="160" className="text-slate-500 text-sm mt-1">
              {user
                ? 'Only you can see these. Name them, star the keepers, reopen any one with your corrections included.'
                : 'Lumi saved every analysis. Reopen one anytime, your corrections included.'}
            </p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={refreshing}
          className="btn-soft !p-0 w-11 h-11 flex-shrink-0"
          title="Refresh"
          aria-label="Refresh sessions"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {!user && !authLoading && (
        <div data-anim="fade-up" className="liquid-glass-light rounded-[24px] p-4 mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
          <img src="/lumi/present.webp" alt="" aria-hidden className="lumi-sprite h-14 w-auto self-start sm:self-auto" />
          <p className="text-sm text-slate-600 flex-1">
            <span className="font-extrabold text-slate-800">Keep your sessions for 30 days, private to you.</span>{' '}
            Log in and Lumi moves the sessions from this browser into your account, so you can name them and open them on any device.
          </p>
          <button onClick={signInWithGoogle} className="btn-jelly btn-jelly-sm self-start sm:self-auto">
            <LogIn className="w-3.5 h-3.5" /> Log in
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="liquid-glass rounded-[28px] p-6 text-center mb-6 flex flex-col items-center">
          <Lumi pose="sad" size={110} />
          <p className="text-sm font-bold text-red-500 mt-3">{error}</p>
          <p className="text-xs text-slate-500 mt-1">Is the backend running?</p>
        </div>
      )}

      {sessions === null && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-3">
          <Lumi pose="search" size={120} />
          <span className="text-sm font-bold flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Finding your sessions…</span>
        </div>
      )}

      {sessions !== null && sessions.length === 0 && (
        <div data-anim="scale" className="liquid-glass rounded-[32px] px-6 py-10 sm:p-12 text-center flex flex-col items-center">
          <Lumi pose="sleepy" size={140} />
          <h3 className="font-display text-2xl font-bold mt-4 mb-2">Nothing here yet</h3>
          <p className="text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
            Run an analysis and it will appear here. Sessions persist across restarts
            and expire automatically after {user ? '30 days' : '24 hours'}.
          </p>
        </div>
      )}

      {ordered !== null && ordered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-5">
          {ordered.map((session, i) => (
            <SessionCard
              key={session.jobId}
              session={session}
              index={i}
              onOpen={onOpenSession}
              onDelete={handleDelete}
              disabled={isLoading}
              label={labels[session.jobId]}
              onLabel={user ? (label) => handleLabel(session.jobId, label) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
};
