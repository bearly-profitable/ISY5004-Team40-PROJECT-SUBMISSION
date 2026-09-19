
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CalendarDays, Clock, History, ImageIcon, Loader2, RefreshCw, Trash2, Users } from 'lucide-react';
import { SessionSummary } from '../types';
import { deleteSession, listSessions, sessionPhotoUrl } from '../lib/analysisApi';

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
}

const SessionCard: React.FC<SessionCardProps> = ({ session, index, onOpen, onDelete, disabled }) => {
  const [thumbFailed, setThumbFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const s = session.summary;

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
      onKeyDown={(e) => { if (e.key === 'Enter' && !disabled && !deleting) onOpen(session.jobId); }}
      className={`text-left w-full group liquid-glass-light rounded-2xl overflow-hidden hover:shadow-xl hover:shadow-lumina-500/10 hover:-translate-y-0.5 transition-all duration-300 cursor-pointer ${disabled || deleting ? 'opacity-60 pointer-events-none' : ''}`}
      style={{ animation: `fadeInUp 0.5s var(--smooth, cubic-bezier(0.4,0,0.2,1)) ${Math.min(index * 60, 500)}ms both` }}
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

        {/* Delete — two-step confirm, right where the cursor already is */}
        <button
          onClick={handleDelete}
          disabled={deleting}
          className={`absolute top-3 right-3 flex items-center gap-1.5 rounded-full backdrop-blur-md transition-all duration-200 ${
            confirming
              ? 'bg-red-500 text-white px-3 py-1.5 shadow-lg shadow-red-500/30'
              : 'bg-black/40 text-white/80 hover:bg-red-500/85 hover:text-white w-8 h-8 justify-center opacity-0 group-hover:opacity-100'
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
        <span className="text-[10px] font-bold uppercase tracking-widest text-lumina-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex-shrink-0">
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
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
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
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (jobId: string) => {
    try {
      await deleteSession(jobId);
      setSessions((prev) => prev?.filter((s) => s.jobId !== jobId) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session.');
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 text-lumina-400 font-medium text-xs uppercase tracking-widest mb-2 anim-fade-in-left">
            <History className="w-3.5 h-3.5" />
            <span>Persistent Analysis History</span>
          </div>
          <h2 className="text-3xl md:text-4xl font-medium tracking-tight anim-fade-in-up d-100">Past Sessions</h2>
          <p className="text-slate-400 text-sm mt-1 tracking-wide anim-fade-in-up d-200">
            Every analysis is saved — reopen it anytime, corrections included.
          </p>
        </div>
        <button
          onClick={load}
          disabled={refreshing}
          className="glass-btn w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 hover:text-slate-800 transition-colors flex-shrink-0"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="liquid-glass rounded-2xl p-6 text-center mb-6">
          <p className="text-sm text-red-500">{error}</p>
          <p className="text-xs text-slate-400 mt-1">Is the backend running?</p>
        </div>
      )}

      {sessions === null && !error && (
        <div className="flex items-center justify-center py-20 text-slate-400 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading sessions…</span>
        </div>
      )}

      {sessions !== null && sessions.length === 0 && (
        <div className="liquid-glass rounded-3xl p-12 text-center anim-scale-in">
          <div className="w-16 h-16 rounded-full bg-lumina-500/10 text-lumina-400 flex items-center justify-center mx-auto mb-6">
            <History className="w-8 h-8" />
          </div>
          <h3 className="text-xl font-semibold tracking-tight mb-2">No sessions yet</h3>
          <p className="text-sm text-slate-400 max-w-sm mx-auto leading-relaxed">
            Run an analysis and it will appear here. Sessions persist across restarts
            and expire automatically after 24 hours.
          </p>
        </div>
      )}

      {sessions !== null && sessions.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-5">
          {sessions.map((session, i) => (
            <SessionCard
              key={session.jobId}
              session={session}
              index={i}
              onOpen={onOpenSession}
              onDelete={handleDelete}
              disabled={isLoading}
            />
          ))}
        </div>
      )}
    </div>
  );
};
