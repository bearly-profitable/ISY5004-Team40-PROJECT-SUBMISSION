import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera, CalendarDays, Check, Heart, ImageIcon, Loader2, LogIn, LogOut, Palette,
  RotateCcw, Sparkles, SlidersHorizontal, Upload, UserRound, Users, Wand2,
} from 'lucide-react';
import { AppStep, type NormSignals, type SignalKey } from '../types';
import { useAuth, googlePhotoUrl } from '../lib/auth';
import {
  ACCENTS, AVATAR_BGS, AVATAR_POSES, OUTFITS, firstName, type ProfilePatch,
} from '../lib/profile';
import { getPreferences, listSessions, resetPreferences, setPreferenceWeights } from '../lib/analysisApi';
import { FALLBACK_COLLAGE_THEMES } from '../lib/collageCatalog';
import { SIGNAL_UI } from '../lib/signals';
import { Lumi, lumiSrc } from '../components/Lumi';
import { ProfileAvatar } from '../components/ProfileAvatar';

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

const Card: React.FC<{ title: string; icon: React.ReactNode; hint?: string; className?: string; children: React.ReactNode }> = ({
  title, icon, hint, className = '', children,
}) => (
  <section data-anim="fade-up" className={`liquid-glass rounded-[28px] p-5 sm:p-6 ${className}`}>
    <h2 className="flex items-center gap-2 text-lg font-extrabold text-slate-800 !font-sans !tracking-normal">
      <span className="w-8 h-8 rounded-xl bg-lumina-100 text-lumina-600 flex items-center justify-center">{icon}</span>
      {title}
    </h2>
    {hint && <p className="text-sm text-slate-500 mt-1.5 mb-4 leading-relaxed">{hint}</p>}
    {!hint && <div className="mb-4" />}
    {children}
  </section>
);

const Pick: React.FC<{
  selected: boolean; onClick: () => void; label: string; className?: string; children: React.ReactNode;
}> = ({ selected, onClick, label, className = '', children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={selected}
    aria-label={label}
    title={label}
    className={`relative rounded-2xl border-2 transition-all duration-200 ${
      selected
        ? 'border-lumina-500 bg-white shadow-[0_3px_0_rgb(var(--lumina-500)/0.25)]'
        : 'border-transparent bg-white/60 hover:bg-white hover:border-lumina-200'
    } ${className}`}
  >
    {children}
    {selected && (
      <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-lumina-500 text-white flex items-center justify-center shadow">
        <Check className="w-3 h-3" strokeWidth={3} />
      </span>
    )}
  </button>
);

// ---------------------------------------------------------------------------
// Stats: how much Lumi has sorted for you
// ---------------------------------------------------------------------------

const RANKS = [
  { min: 0, name: 'New friend', pose: 'wave' as const },
  { min: 25, name: 'Memory keeper', pose: 'carry' as const },
  { min: 150, name: 'Album artisan', pose: 'present' as const },
  { min: 500, name: 'Moment hunter', pose: 'camera' as const },
  { min: 1500, name: 'Legendary curator', pose: 'star' as const },
];

interface Stats { sessions: number; photos: number; moments: number; people: number; picks: number }

const StatsStrip: React.FC<{ stats: Stats | null; error: string | null }> = ({ stats, error }) => {
  const rankIndex = stats ? RANKS.reduce((acc, r, i) => (stats.photos >= r.min ? i : acc), 0) : 0;
  const rank = RANKS[rankIndex];
  const next = RANKS[rankIndex + 1];
  const progress = stats && next ? (stats.photos - rank.min) / (next.min - rank.min) : 1;

  const tiles: Array<{ label: string; value: number | undefined; icon: React.ReactNode }> = [
    { label: 'Sessions', value: stats?.sessions, icon: <CalendarDays className="w-4 h-4" /> },
    { label: 'Photos sorted', value: stats?.photos, icon: <ImageIcon className="w-4 h-4" /> },
    { label: 'Moments found', value: stats?.moments, icon: <Sparkles className="w-4 h-4" /> },
    { label: 'Faces met', value: stats?.people, icon: <Users className="w-4 h-4" /> },
    { label: 'Picks taught', value: stats?.picks, icon: <Heart className="w-4 h-4" /> },
  ];

  return (
    <section data-anim="fade-up" className="liquid-glass rounded-[28px] p-5 sm:p-6">
      <div className="flex flex-col md:flex-row md:items-center gap-5">
        <div className="flex items-center gap-4 md:w-72 shrink-0">
          <Lumi pose={rank.pose} size={84} />
          <div className="min-w-0">
            <p className="text-[11px] font-extrabold uppercase tracking-widest text-lumina-500">Your Lumi rank</p>
            <p className="font-display text-2xl font-bold text-slate-900">{rank.name}</p>
            {next ? (
              <>
                <div className="mt-2 h-2 rounded-full bg-lumina-100 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(4, progress * 100)}%`, background: 'var(--lumi-gradient)' }} />
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  {stats ? `${next.min - stats.photos} photos to ${next.name}` : '…'}
                </p>
              </>
            ) : (
              <p className="text-xs text-slate-500 mt-1">The top of the shelf. Lumi is impressed.</p>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 flex-1">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-2xl bg-white/70 px-3 py-3">
              <div className="flex items-center gap-1.5 text-lumina-500">{t.icon}</div>
              <p className="font-display text-2xl font-bold text-slate-900 mt-1 tabular-nums">
                {t.value === undefined ? <span className="inline-block w-8 h-6 skeleton rounded" /> : t.value.toLocaleString()}
              </p>
              <p className="text-[11px] font-bold text-slate-500">{t.label}</p>
            </div>
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-red-500 font-bold mt-3">{error}</p>}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Lumi's taste: the 7 signals that pick each moment's best shot
// ---------------------------------------------------------------------------

const SIGNAL_HINTS: Record<SignalKey, string> = {
  centrality: 'Captures what the moment was about',
  nimaScore: 'Light, colour and composition',
  faceSharpness: 'Faces in crisp focus',
  faceSize: 'People big in the frame',
  detScore: 'Faces clearly visible',
  poseQuality: 'Facing the camera, natural pose',
  ear: 'Nobody mid-blink',
};

const PRESETS: Array<{ name: string; pose: 'star' | 'hug' | 'think' | 'camera'; weights: NormSignals }> = [
  { name: 'Storyteller', pose: 'think', weights: { centrality: 35, nimaScore: 35, faceSharpness: 8, faceSize: 5, detScore: 4, poseQuality: 6, ear: 7 } },
  { name: 'Portrait lover', pose: 'hug', weights: { centrality: 10, nimaScore: 15, faceSharpness: 25, faceSize: 20, detScore: 8, poseQuality: 12, ear: 10 } },
  { name: 'No-blink guard', pose: 'camera', weights: { centrality: 15, nimaScore: 15, faceSharpness: 15, faceSize: 8, detScore: 12, poseQuality: 10, ear: 25 } },
  { name: 'Artist', pose: 'star', weights: { centrality: 15, nimaScore: 50, faceSharpness: 10, faceSize: 5, detScore: 5, poseQuality: 10, ear: 5 } },
];

const mapSignals = (w: NormSignals, fn: (v: number) => number): NormSignals =>
  Object.fromEntries(SIGNAL_UI.map(({ key }) => [key, fn(w[key] ?? 0)])) as NormSignals;
const toPercents = (w: NormSignals): NormSignals => mapSignals(w, (v) => Math.round(v * 100));
const sumSignals = (w: NormSignals): number => SIGNAL_UI.reduce((a, { key }) => a + (w[key] ?? 0), 0);

const TasteCard: React.FC<{ onFlash: (m: string) => void }> = ({ onFlash }) => {
  const [raw, setRaw] = useState<NormSignals | null>(null);
  const [saved, setSaved] = useState<NormSignals | null>(null);
  const [defaults, setDefaults] = useState<NormSignals | null>(null);
  const [nUpdates, setNUpdates] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const prefs = await getPreferences();
      const pct = toPercents(prefs.weights);
      setRaw(pct); setSaved(pct);
      setDefaults(toPercents(prefs.defaultWeights));
      setNUpdates(prefs.nUpdates);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? `${err.message}. Is the backend running?` : 'Could not load your taste.');
    }
  };
  useEffect(() => { load(); }, []);

  const total = raw ? sumSignals(raw) : 0;
  const dirty = !!raw && !!saved && SIGNAL_UI.some(({ key }) => raw[key] !== saved[key]);

  const save = async () => {
    if (!raw || total <= 0) return;
    setBusy(true);
    try {
      const res = await setPreferenceWeights(mapSignals(raw, (v) => v / total));
      const pct = toPercents(res.weights);
      setRaw(pct); setSaved(pct);
      onFlash('Lumi learned your taste');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally { setBusy(false); }
  };

  const reset = async () => {
    setBusy(true);
    try { await resetPreferences(); await load(); onFlash("Back to Lumi's defaults"); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not reset.'); }
    finally { setBusy(false); }
  };

  return (
    <Card
      title="Lumi's taste"
      icon={<SlidersHorizontal className="w-4 h-4" />}
      hint="How Lumi picks the best shot of each moment. Every time you swap a best shot in the gallery Lumi learns a little, or you can tune it by hand here."
      className="lg:col-span-2"
    >
      {error && <p className="text-sm font-bold text-red-500 mb-3">{error}</p>}
      {!raw || !defaults ? (
        !error && <div className="flex justify-center py-8 text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-5">
            <span className="text-xs font-bold text-slate-500 self-center mr-1">Try a style:</span>
            {PRESETS.map((p) => (
              <button key={p.name} onClick={() => setRaw(p.weights)} className="btn-soft !py-1.5 !pl-1.5 !pr-3 text-xs">
                <img src={lumiSrc(p.pose)} alt="" aria-hidden className="lumi-sprite h-6 w-auto" />
                {p.name}
              </button>
            ))}
            <button onClick={() => setRaw(defaults)} className="btn-soft !py-1.5 !px-3 text-xs">Lumi's balance</button>
          </div>

          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-4">
            {SIGNAL_UI.map(({ key, label }) => {
              const share = total > 0 ? (raw[key] / total) * 100 : 0;
              return (
                <label key={key} className="block">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-extrabold text-slate-700">{label}</span>
                    <span className="text-sm font-extrabold tabular-nums text-lumina-600">{share.toFixed(0)}%</span>
                  </span>
                  <span className="block text-xs text-slate-500 mb-1.5">{SIGNAL_HINTS[key]}</span>
                  <span className="relative block">
                    <input
                      type="range" min={0} max={60} step={1}
                      value={raw[key]}
                      onChange={(e) => setRaw({ ...raw, [key]: Number(e.target.value) })}
                      className="w-full accent-lumina-500 cursor-pointer"
                      aria-label={`${label} importance`}
                    />
                    <span
                      aria-hidden
                      className="absolute -bottom-1 w-0.5 h-2 rounded bg-slate-400/70 pointer-events-none"
                      style={{ left: `calc(${(defaults[key] / 60) * 100}% - 1px)` }}
                      title="Lumi's default"
                    />
                  </span>
                </label>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3 mt-6">
            <button onClick={save} disabled={!dirty || busy || total <= 0} className="btn-jelly btn-jelly-sm">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save my taste
            </button>
            <button onClick={reset} disabled={busy} className="btn-soft !py-2 text-sm">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
            <span className="text-xs text-slate-500">
              {nUpdates > 0 ? `Learned from ${nUpdates} ${nUpdates === 1 ? 'swap' : 'swaps'} so far.` : 'The small tick marks show Lumi\'s defaults.'}
            </span>
          </div>
        </>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

interface ProfileProps {
  onNavigate: (step: AppStep) => void;
}

export const Profile: React.FC<ProfileProps> = ({ onNavigate }) => {
  const {
    user, profile, profileError, loading, signInWithGoogle, signOut,
    updateProfile, uploadAvatar, setAvatarUrl,
  } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [avatarTab, setAvatarTab] = useState<'lumi' | 'photo'>('lumi');
  const [uploading, setUploading] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const flashTimer = useRef<number>();

  const showFlash = (message: string) => {
    setFlash(message);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1800);
  };

  useEffect(() => {
    if (!profile) return;
    setName(profile.display_name ?? '');
    setTagline(profile.tagline ?? '');
    setAvatarTab(profile.avatar_url ? 'photo' : 'lumi');
    // Only when a different profile arrives, not on every save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  useEffect(() => {
    if (!user) return;
    Promise.all([listSessions(), getPreferences().catch(() => null)])
      .then(([sessions, prefs]) => {
        setStats({
          sessions: sessions.length,
          photos: sessions.reduce((a, s) => a + (s.numPhotos || 0), 0),
          moments: sessions.reduce((a, s) => a + (s.summary?.numEvents || 0), 0),
          people: sessions.reduce((a, s) => a + (s.summary?.numIdentities || 0), 0),
          picks: prefs?.feedbackCount ?? prefs?.nUpdates ?? 0,
        });
      })
      .catch(() => setStatsError('Could not reach the Lumina backend for your stats.'));
  }, [user]);

  const save = async (patch: ProfilePatch, message = 'Saved') => {
    setError(null);
    try { await updateProfile(patch); showFlash(message); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save.'); }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try { await uploadAvatar(file); showFlash('New photo, looking sharp'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Upload failed.'); }
    finally { setUploading(false); }
  };

  const memberSince = useMemo(
    () => (profile ? new Date(profile.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : ''),
    [profile],
  );

  // ---- signed out / not ready ------------------------------------------------
  if (!user) {
    return (
      <div className="max-w-xl mx-auto px-4 py-12 sm:py-20">
        <div data-anim="scale" className="liquid-glass rounded-[32px] px-6 py-10 sm:p-12 text-center flex flex-col items-center">
          {loading ? (
            <Lumi pose="search" size={130} />
          ) : (
            <>
              <Lumi pose="wave" size={150} say="Let's make this place yours!" bubble="top" />
              <h1 className="font-display text-3xl font-bold mt-6 mb-2">Your Lumina, your way</h1>
              <p className="text-sm text-slate-500 max-w-sm leading-relaxed">
                Log in to pick your own badge and colours, teach Lumi your taste, and keep your
                sessions for 30 days on any device.
              </p>
              <button onClick={signInWithGoogle} className="btn-jelly mt-6">
                <LogIn className="w-4 h-4" /> Log in with Google
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (profileError) {
    return (
      <div className="max-w-xl mx-auto px-4 py-12">
        <div role="alert" className="liquid-glass rounded-[32px] p-8 text-center flex flex-col items-center">
          <Lumi pose="sad" size={120} />
          <p className="font-bold text-red-500 mt-4">{profileError}</p>
          <button onClick={signOut} className="btn-soft mt-5"><LogOut className="w-4 h-4" /> Sign out</button>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-slate-500">
        <Lumi pose="search" size={120} />
        <span className="text-sm font-bold flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Fetching your profile…</span>
      </div>
    );
  }

  const googlePhoto = googlePhotoUrl(user);
  const nameDirty = name.trim() !== (profile.display_name ?? '') || tagline.trim() !== (profile.tagline ?? '');

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10 space-y-5">
      {/* ---- hero ---- */}
      <section data-anim="fade-up" className="relative liquid-glass-heavy rounded-[32px] p-6 sm:p-8 overflow-hidden">
        <div aria-hidden className="absolute -right-16 -top-20 w-72 h-72 rounded-full opacity-40 blur-3xl" style={{ background: 'var(--lumi-gradient)' }} />
        <div className="relative flex flex-col sm:flex-row sm:items-center gap-5">
          <ProfileAvatar profile={profile} size={112} className="ring-4 ring-white shadow-[0_6px_0_rgb(var(--lumina-500)/0.2),0_18px_40px_rgba(80,50,110,0.15)] shrink-0" />
          <div className="min-w-0 flex-1">
            <span className="chip mb-2"><UserRound className="w-3 h-3" /> Your profile</span>
            <h1 className="font-display text-3xl sm:text-5xl font-bold text-slate-900 truncate leading-[1.2] pb-1">
              {profile.display_name || 'Lumina friend'}
            </h1>
            <p className="text-slate-600 mt-1">{profile.tagline || 'Add a tagline below, Lumi loves a good motto.'}</p>
            <p className="text-xs text-slate-500 mt-2">{user.email}{memberSince && ` · Member since ${memberSince}`}</p>
          </div>
          <div className="hidden lg:block shrink-0">
            <Lumi pose="wave" size={120} say={`Hi ${firstName(profile)}!`} bubble="left" />
          </div>
        </div>
      </section>

      <StatsStrip stats={stats} error={statsError} />

      {error && <p role="alert" className="text-sm font-bold text-red-500 text-center">{error}</p>}

      <div className="grid lg:grid-cols-2 gap-5">
        {/* ---- badge studio ---- */}
        <Card title="Your badge" icon={<Camera className="w-4 h-4" />} hint="This is you in the navbar. Pick a Lumi, or bring your own photo.">
          <div className="inline-flex rounded-full bg-lumina-100/70 p-1 mb-4">
            {(['lumi', 'photo'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setAvatarTab(tab)}
                className={`px-4 py-1.5 rounded-full text-sm font-extrabold transition-colors ${
                  avatarTab === tab ? 'bg-white text-lumina-700 shadow-sm' : 'text-slate-500'
                }`}
              >
                {tab === 'lumi' ? 'Lumi' : 'Photo'}
              </button>
            ))}
          </div>

          {avatarTab === 'lumi' ? (
            <>
              <div className="grid grid-cols-4 sm:grid-cols-8 lg:grid-cols-4 xl:grid-cols-8 gap-2">
                {AVATAR_POSES.map((pose) => (
                  <Pick
                    key={pose}
                    label={`Lumi ${pose}`}
                    selected={!profile.avatar_url && profile.avatar_pose === pose}
                    onClick={async () => {
                      if (profile.avatar_url) await setAvatarUrl(null).catch(() => undefined);
                      save({ avatar_pose: pose }, 'Badge updated');
                    }}
                    className="p-1"
                  >
                    <ProfileAvatar profile={{ ...profile, avatar_url: null, avatar_pose: pose }} size={52} className="mx-auto" />
                  </Pick>
                ))}
              </div>
              <p className="text-xs font-bold text-slate-500 mt-4 mb-2">Background</p>
              <div className="flex flex-wrap gap-2">
                {AVATAR_BGS.map((bg) => (
                  <button
                    key={bg.key}
                    onClick={async () => {
                      if (profile.avatar_url) await setAvatarUrl(null).catch(() => undefined);
                      save({ avatar_bg: bg.key }, 'Badge updated');
                    }}
                    aria-pressed={profile.avatar_bg === bg.key}
                    title={bg.name}
                    aria-label={`${bg.name} background`}
                    className={`w-9 h-9 rounded-full transition-transform hover:scale-110 ${
                      profile.avatar_bg === bg.key ? 'ring-[3px] ring-lumina-500 ring-offset-2' : 'ring-2 ring-white'
                    }`}
                    style={{ background: bg.css }}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-col sm:flex-row lg:flex-col xl:flex-row gap-4 items-start">
              <div className="rounded-full p-1 bg-white/70">
                {profile.avatar_url
                  ? <ProfileAvatar profile={profile} size={96} />
                  : <span className="w-24 h-24 rounded-full bg-lumina-100 flex items-center justify-center text-lumina-400"><ImageIcon className="w-8 h-8" /></span>}
              </div>
              <div className="flex flex-col gap-2 w-full">
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onUpload} />
                <button onClick={() => fileRef.current?.click()} disabled={uploading} className="btn-jelly btn-jelly-sm self-start">
                  {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Upload a photo
                </button>
                {googlePhoto && profile.avatar_url !== googlePhoto && (
                  <button onClick={() => setAvatarUrl(googlePhoto).then(() => showFlash('Using your Google photo'))} className="btn-soft !py-2 text-sm self-start">
                    Use my Google photo
                  </button>
                )}
                {profile.avatar_url && (
                  <button onClick={() => setAvatarUrl(null).then(() => { setAvatarTab('lumi'); showFlash('Lumi is back'); })} className="text-xs font-bold text-slate-500 hover:text-slate-700 self-start">
                    Remove photo, use Lumi
                  </button>
                )}
                <p className="text-xs text-slate-500">Square-cropped to 256px. PNG, JPEG or WebP.</p>
              </div>
            </div>
          )}
        </Card>

        {/* ---- about ---- */}
        <Card title="About you" icon={<UserRound className="w-4 h-4" />} hint="How Lumi greets you around the app.">
          <form
            onSubmit={(e) => { e.preventDefault(); save({ display_name: name.trim() || null, tagline: tagline.trim() || null }); }}
            className="space-y-4"
          >
            <label className="block">
              <span className="text-xs font-bold text-slate-500">Display name</span>
              <input
                value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
                className="glass-input w-full mt-1 rounded-2xl px-4 py-3 text-base font-bold text-slate-800"
                placeholder="What should Lumi call you?"
              />
            </label>
            <label className="block">
              <span className="flex justify-between text-xs font-bold text-slate-500">
                Tagline <span className="tabular-nums">{tagline.length}/80</span>
              </span>
              <input
                value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={80}
                className="glass-input w-full mt-1 rounded-2xl px-4 py-3 text-base text-slate-800"
                placeholder="Chasing golden hour"
              />
            </label>
            <button type="submit" disabled={!nameDirty} className="btn-jelly btn-jelly-sm">
              <Check className="w-3.5 h-3.5" /> Save
            </button>
          </form>
        </Card>

        {/* ---- look & feel ---- */}
        <Card title="Look & feel" icon={<Palette className="w-4 h-4" />} hint="Your colours follow you everywhere in Lumina, on every device you log in on." className="lg:col-span-2">
          <p className="text-xs font-bold text-slate-500 mb-2">App colour</p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            {ACCENTS.map((a) => (
              <Pick key={a.key} label={`${a.name} theme`} selected={profile.accent === a.key} onClick={() => save({ accent: a.key }, `${a.name} it is`)} className="p-2.5 text-left">
                <span className="block h-12 rounded-xl" style={{ background: `linear-gradient(135deg, ${a.swatch[0]} 0%, ${a.swatch[1]} 55%, ${a.swatch[2]} 100%)` }} />
                <span className="block text-sm font-extrabold text-slate-800 mt-2">{a.name}</span>
                <span className="block text-[11px] text-slate-500 leading-snug">{a.blurb}</span>
              </Pick>
            ))}
          </div>
          <p className="text-xs font-bold text-slate-500 mt-5 mb-2">Lumi's outfit <span className="font-normal">(everywhere, and in your PDF albums)</span></p>
          <div className="grid grid-cols-4 gap-2.5 max-w-md">
            {OUTFITS.map((o) => (
              <Pick key={o.key} label={`${o.name} outfit`} selected={profile.lumi_outfit === o.key} onClick={() => save({ lumi_outfit: o.key }, `Lumi changed into ${o.name}`)} className="pt-2 pb-1.5 flex flex-col items-center">
                <img src="/lumi/idle.webp" alt="" aria-hidden className="h-14 w-auto" style={{ filter: `hue-rotate(${o.hue}deg)` }} />
                <span className="text-xs font-bold text-slate-700 mt-1">{o.name}</span>
              </Pick>
            ))}
          </div>
        </Card>

        <TasteCard onFlash={showFlash} />

        {/* ---- gallery defaults ---- */}
        <Card title="Album & edit defaults" icon={<Wand2 className="w-4 h-4" />} hint="Where the gallery starts when you make an album or enhance a photo. You can still change them each time.">
          <p className="text-xs font-bold text-slate-500 mb-2">PDF album theme</p>
          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-3 xl:grid-cols-5 gap-2">
            {FALLBACK_COLLAGE_THEMES.map((t) => (
              <Pick key={t.key} label={`${t.name} album theme`} selected={profile.collage_theme === t.key} onClick={() => save({ collage_theme: t.key }, `${t.name} albums`)} className="p-1.5">
                <span className="flex h-10 rounded-lg overflow-hidden" style={{ background: t.bgTop }}>
                  <span className="flex-1" />
                  <span className="w-3" style={{ background: t.swatch[1] }} />
                  <span className="w-3" style={{ background: t.swatch[2] }} />
                </span>
                <span className="block text-[11px] font-bold text-slate-700 mt-1">{t.name}</span>
              </Pick>
            ))}
          </div>
          <p className="text-xs font-bold text-slate-500 mt-5 mb-2">AI enhance style</p>
          <div className="inline-flex rounded-full bg-lumina-100/70 p-1">
            {([['natural', 'Natural', 'Gentle fixes, true to life'], ['polished', 'Polished', 'Magazine-ready glow']] as const).map(([key, label, tip]) => (
              <button
                key={key}
                onClick={() => save({ enhance_style: key }, `${label} edits`)}
                title={tip}
                aria-pressed={profile.enhance_style === key}
                className={`px-4 py-1.5 rounded-full text-sm font-extrabold transition-colors ${
                  profile.enhance_style === key ? 'bg-white text-lumina-700 shadow-sm' : 'text-slate-500'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </Card>

        {/* ---- account ---- */}
        <Card title="Your sessions & account" icon={<CalendarDays className="w-4 h-4" />} hint="Sessions you analyse while logged in are yours alone and are kept for 30 days.">
          <div className="flex flex-wrap gap-3">
            <button onClick={() => onNavigate(AppStep.SESSIONS)} className="btn-jelly btn-jelly-sm">
              <CalendarDays className="w-3.5 h-3.5" /> My sessions
            </button>
            <button onClick={() => onNavigate(AppStep.UPLOAD)} className="btn-soft !py-2 text-sm">
              <Upload className="w-3.5 h-3.5" /> New session
            </button>
            <button onClick={async () => { await signOut(); onNavigate(AppStep.LANDING); }} className="btn-soft !py-2 text-sm">
              <LogOut className="w-3.5 h-3.5" /> Sign out
            </button>
          </div>
        </Card>
      </div>

      {flash && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 liquid-glass-heavy rounded-full pl-2 pr-4 py-1.5 shadow-lg">
          <img src={lumiSrc('celebrate')} alt="" aria-hidden className="lumi-sprite h-8 w-auto" />
          <span className="text-sm font-extrabold text-slate-700">{flash}</span>
        </div>
      )}
    </div>
  );
};
