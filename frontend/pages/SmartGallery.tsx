import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Clapperboard, Download, FileText, Images, LayoutGrid, Loader2, Pencil, ScanFace, SlidersHorizontal,
  Sparkles, Trash2, TreePalm, UploadCloud, Users,
} from 'lucide-react';
import type { Event, EventMember, Identity, Photo } from '../types';
import type { LightboxItem } from '../components/Lightbox';
import { Lightbox } from '../components/Lightbox';
import { Lumi } from '../components/Lumi';
import {
  applyCorrection, deleteEnhanced, downloadCollage, enhancePhoto, enhancedPhotoUrl, exportAlbum, submitFeedback,
} from '../lib/analysisApi';
import type { AnalyzeResult, CollageOptions, EnhanceStyle } from '../lib/analysisApi';
import { useAuth } from '../lib/auth';
import { syncToLibrary, type LibrarySyncItem } from '../lib/library';
import { gsap, prefersReducedMotion } from '../lib/motion';
import {
  EnhanceContext, FaceAvatar, FocalContext, ToastStack, focalPoints,
  type EnhanceContextValue, type EnhanceEntry, type Toast,
} from '../components/gallery/shared';
import { CountUp, Segmented, SplitTitle, type SegmentItem } from '../components/gallery/motion';
import { MomentsView } from '../components/gallery/MomentsView';
import { AllPhotosView, CleanupView, PhotoGrid, keeperIds } from '../components/gallery/PhotoGrid';
import { SearchBar, type SearchHits } from '../components/gallery/SearchBar';
import { PeopleManager, PersonalizationPanel } from '../components/gallery/panels';
import { AlbumModal, type AlbumChoices } from '../components/gallery/AlbumModal';

// Remotion (preview + in-browser encoder) is only downloaded when a video is made.
const VideoModal = lazy(() => import('../components/gallery/VideoModal').then((m) => ({ default: m.VideoModal })));
// Likewise three.js, only when someone walks onto Lumi's island.
const WorldModal = lazy(() => import('../world/WorldModal'));

type View = 'moments' | 'all' | 'cleanup';

const VIEW_KEY = 'lumina-gallery-view';
const ALBUM_MMR_MODE = 'balanced' as const;

/** Sessions already saved to the library (it feeds Lumi's island) this page-load (per user). */
const syncedSessions = new Set<string>();

function readView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'all' || v === 'cleanup' ? v : 'moments';
  } catch {
    return 'moments';
  }
}

/** A session's keepers, described for the library. */
function librarySyncItems(events: Event[], identities: Identity[]): LibrarySyncItem[] {
  const peopleByPhoto = new Map<string, string[]>();
  for (const person of identities) {
    for (const photoId of person.photoIds) {
      peopleByPhoto.set(photoId, [...(peopleByPhoto.get(photoId) ?? []), person.label]);
    }
  }
  const items: LibrarySyncItem[] = [];
  const seen = new Set<string>();
  for (const evt of events) {
    const keep = keeperIds(evt);
    const members = new Map<string, EventMember>(evt.members.map((m) => [m.photoId, m]));
    for (const photo of evt.photos) {
      if (!keep.has(photo.id) || seen.has(photo.id)) continue;
      seen.add(photo.id);
      items.push({
        photoId: photo.id,
        name: photo.name,
        sourceUrl: photo.fullUrl ?? photo.url,
        takenAt: evt.startTime ?? null,
        eventLabel: evt.label,
        people: peopleByPhoto.get(photo.id) ?? [],
        score: members.get(photo.id)?.finalScore ?? null,
        isBest: photo.id === evt.topPhotoId,
      });
    }
  }
  return items;
}

interface SmartGalleryProps {
  jobId: string | null;
  events: Event[];
  identities: Identity[];
  onGoToPhotos?: () => void;
  onResultUpdate?: (result: AnalyzeResult) => void;
  /** Photos that already had an AI edit when a stored session was reopened. */
  enhancedPhotoIds?: string[];
}

export const SmartGallery: React.FC<SmartGalleryProps> = ({
  jobId,
  events: initialEvents,
  identities: initialIdentities,
  onGoToPhotos,
  onResultUpdate,
  enhancedPhotoIds,
}) => {
  const [events, setEvents] = useState<Event[]>(initialEvents);
  const [identities, setIdentities] = useState<Identity[]>(initialIdentities);
  const { user, profile } = useAuth();
  const enhanceStyleRef = useRef<EnhanceStyle>('natural');
  enhanceStyleRef.current = profile?.enhance_style ?? 'natural';

  const hasSession = initialEvents.length > 0;
  const [view, setViewState] = useState<View>(readView);
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [faceRingOn, setFaceRingOn] = useState(true);
  const [search, setSearch] = useState<SearchHits | null>(null);
  const [peopleManagerOpen, setPeopleManagerOpen] = useState(false);
  const [personalizationAnchor, setPersonalizationAnchor] = useState<DOMRect | null>(null);
  const [exporting, setExporting] = useState(false);
  const [collageOpen, setCollageOpen] = useState(false);
  const [collageBusy, setCollageBusy] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [worldOpen, setWorldOpen] = useState(false);
  const [enhanceEntries, setEnhanceEntries] = useState<Record<string, EnhanceEntry>>({});
  const [enhancePending, setEnhancePending] = useState<Record<string, boolean>>({});
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setEvents(initialEvents); }, [initialEvents]);
  useEffect(() => { setIdentities(initialIdentities); }, [initialIdentities]);

  // Reopening a session restores its enhancements (without the match score,
  // which is not persisted).
  useEffect(() => {
    if (!jobId || !enhancedPhotoIds?.length) return;
    setEnhanceEntries((prev) => {
      const next = { ...prev };
      for (const photoId of enhancedPhotoIds) {
        if (!next[photoId]) next[photoId] = { url: enhancedPhotoUrl(jobId, photoId) };
      }
      return next;
    });
  }, [jobId, enhancedPhotoIds]);

  const notify = useCallback((message: string, kind: Toast['kind'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3400);
  }, []);

  const setView = useCallback((next: View) => {
    setViewState(next);
    setSearch(null);
    setPersonalizationAnchor(null); // its button only lives on Moments
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* per-viewer nicety only */ }
    // Switching views from deep in the page starts the new one at its top
    // (instantly: the new view fades in, and a smooth scroll would race it).
    const bar = toolbarRef.current;
    if (bar) {
      const top = bar.getBoundingClientRect().top + window.scrollY - 88;
      if (window.scrollY > top + 4) window.scrollTo({ top });
    }
  }, []);

  /* ---- save this session's best photos to the library (signed in) ---- */

  useEffect(() => {
    if (!user || !jobId || initialEvents.length === 0) return;
    const key = `${user.id}:${jobId}`;
    if (syncedSessions.has(key)) return;
    syncedSessions.add(key);
    syncToLibrary(user.id, jobId, librarySyncItems(initialEvents, initialIdentities))
      .catch(() => { syncedSessions.delete(key); });
  }, [user?.id, jobId, initialEvents, initialIdentities]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- derived data ---- */

  const focal = useMemo(() => focalPoints(identities), [identities]);

  const photosById = useMemo(() => {
    const map = new Map<string, Photo>();
    for (const evt of events) for (const photo of evt.photos) map.set(photo.id, photo);
    return map;
  }, [events]);

  const eventByPhotoId = useMemo(() => {
    const map = new Map<string, Event>();
    for (const evt of events) for (const photo of evt.photos) map.set(photo.id, evt);
    return map;
  }, [events]);

  const searchSuggestions = useMemo(() => {
    const fromEvents = [...new Set(events.map((e) => e.autoLabel?.label).filter(Boolean))] as string[];
    const evergreen = ['smiling', 'group photo', 'food', 'outdoors'];
    return [...fromEvents.slice(0, 4), ...evergreen.filter((s) => !fromEvents.includes(s))].slice(0, 6);
  }, [events]);

  const rejects = useMemo(() => {
    const out: Array<{ photo: Photo; member: EventMember; event: Event }> = [];
    for (const evt of events) {
      for (const member of evt.members) {
        if ((member.flags?.length ?? 0) > 0) {
          const photo = photosById.get(member.photoId);
          if (photo) out.push({ photo, member, event: evt });
        }
      }
    }
    return out;
  }, [events, photosById]);

  const person = selectedPerson ? identities.find((i) => i.id === selectedPerson) ?? null : null;
  const highlightPerson = faceRingOn ? person : null;

  const filteredEvents = useMemo(() => events
    .filter((e) => !selectedPerson || e.persons.includes(selectedPerson))
    .filter((e) => !selectedEvent || e.id === selectedEvent), [events, selectedPerson, selectedEvent]);

  const eventsForStrip = selectedPerson ? events.filter((e) => e.persons.includes(selectedPerson)) : events;
  const totalPhotos = events.reduce((n, e) => n + e.photos.length, 0);

  /* ---- motion: view changes ---- */

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || prefersReducedMotion()) return;
    gsap.fromTo(el, { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power3.out', clearProps: 'all' });
  }, [view, search === null, selectedPerson, selectedEvent]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- lightbox ---- */

  const openLightbox = useCallback((items: LightboxItem[], index: number) => setLightbox({ items, index }), []);

  const openEventPhoto = useCallback((event: Event, photoId: string) => {
    const items = event.members
      .map((m) => {
        const photo = photosById.get(m.photoId);
        return photo ? { photo, event } : null;
      })
      .filter(Boolean) as LightboxItem[];
    setLightbox({ items, index: Math.max(0, items.findIndex((it) => it.photo.id === photoId)) });
  }, [photosById]);

  /* ---- corrections (persisted when a jobId exists) ---- */

  const handleDelete = useCallback(async (id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
    setSelectedEvent((prev) => (prev === id ? null : prev));
    if (!jobId) return;
    try {
      onResultUpdate?.(await applyCorrection(jobId, { action: 'delete_event', eventId: id }));
      notify('Moment removed.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Delete failed on server.', 'error');
    }
  }, [jobId, onResultUpdate, notify]);

  const handleRename = useCallback(async (id: string, label: string) => {
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, label } : e)));
    if (!jobId) return;
    try {
      onResultUpdate?.(await applyCorrection(jobId, { action: 'rename_event', eventId: id, label }));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Rename failed on server.', 'error');
    }
  }, [jobId, onResultUpdate, notify]);

  const handleMakeBest = useCallback(async (eventId: string, photoId: string) => {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    const previousBest = event.topPhotoId;
    setEvents((prev) => prev.map((e) => (e.id === eventId ? { ...e, topPhotoId: photoId, userPinned: true } : e)));
    if (!jobId) { notify('Best shot updated.'); return; }
    try {
      const response = await submitFeedback(jobId, eventId, photoId, previousBest);
      notify(`Best shot updated. Lumi has learned from ${response.nUpdates} ${response.nUpdates === 1 ? 'swap' : 'swaps'}.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not record feedback.', 'error');
    }
  }, [events, jobId, notify]);

  const handlePersonRename = useCallback(async (personId: string, label: string) => {
    setIdentities((prev) => prev.map((i) => (i.id === personId ? { ...i, label } : i)));
    if (!jobId) return;
    try {
      onResultUpdate?.(await applyCorrection(jobId, { action: 'rename_person', personId, label }));
      notify(`Renamed to "${label}".`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Rename failed.', 'error');
    }
  }, [jobId, onResultUpdate, notify]);

  const handlePersonMerge = useCallback(async (sourceId: string, targetId: string) => {
    if (!jobId) { notify('Merging requires a saved session.', 'error'); return; }
    try {
      onResultUpdate?.(await applyCorrection(jobId, { action: 'merge_persons', personId: sourceId, targetPersonId: targetId }));
      setSelectedPerson((prev) => (prev === sourceId ? targetId : prev));
      notify('People merged.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Merge failed.', 'error');
    }
  }, [jobId, onResultUpdate, notify]);

  const handleMovePhoto = useCallback(async (photoId: string, fromPersonId: string, toPersonId: string) => {
    if (!jobId) { notify('Reassigning requires a saved session.', 'error'); return; }
    try {
      onResultUpdate?.(await applyCorrection(jobId, { action: 'move_photo', photoId, personId: fromPersonId, targetPersonId: toPersonId }));
      notify('Photo reassigned.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Reassign failed.', 'error');
    }
  }, [jobId, onResultUpdate, notify]);

  const handleApplyRescore = useCallback((rescored: Array<{ eventId: string; topPhotoId: string | null }>) => {
    setEvents((prev) => prev.map((evt) => {
      const update = rescored.find((r) => r.eventId === evt.id);
      if (!update?.topPhotoId || evt.userPinned) return evt;
      return { ...evt, topPhotoId: update.topPhotoId };
    }));
  }, []);

  /* ---- AI enhancement ---- */

  const handleEnhance = useCallback(async (photoId: string, style: EnhanceStyle = enhanceStyleRef.current) => {
    if (!jobId) { notify('Enhancement requires a saved session.', 'error'); return; }
    setEnhancePending((prev) => ({ ...prev, [photoId]: true }));
    try {
      const status = await enhancePhoto(jobId, photoId, style);
      setEnhanceEntries((prev) => ({
        ...prev,
        [photoId]: { url: enhancedPhotoUrl(jobId, photoId, Date.now()), identityScore: status.identityScore, warning: status.warning },
      }));
      if (status.warning) notify(status.warning, 'error');
      else if (status.identityScore != null) notify(`Enhanced. Identity verified (${(status.identityScore * 100).toFixed(0)}% match).`);
      else notify('Photo enhanced.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Enhancement failed.', 'error');
    } finally {
      setEnhancePending((prev) => {
        const next = { ...prev };
        delete next[photoId];
        return next;
      });
    }
  }, [jobId, notify]);

  const handleRevertEnhance = useCallback(async (photoId: string) => {
    if (!jobId) return;
    const drop = <T,>(prev: Record<string, T>) => {
      const next = { ...prev };
      delete next[photoId];
      return next;
    };
    setEnhanceEntries(drop);
    setShowOriginal(drop);
    try {
      await deleteEnhanced(jobId, photoId);
      notify('Back to the original.');
    } catch {
      // The UI already shows the original; a failed cleanup is not worth a toast.
    }
  }, [jobId, notify]);

  const handleToggleOriginal = useCallback((photoId: string) => {
    setShowOriginal((prev) => ({ ...prev, [photoId]: !prev[photoId] }));
  }, []);

  const enhanceContext = useMemo<EnhanceContextValue>(() => ({
    enabled: Boolean(jobId),
    entries: enhanceEntries,
    pending: enhancePending,
    showOriginal,
    enhance: handleEnhance,
    revert: handleRevertEnhance,
    toggleOriginal: handleToggleOriginal,
  }), [jobId, enhanceEntries, enhancePending, showOriginal, handleEnhance, handleRevertEnhance, handleToggleOriginal]);

  /* ---- album + export ---- */

  /** What goes in an album: each event's diversity-aware picks, else its best shot. */
  const curatedPhotoIds = useCallback((): string[] => {
    const ids = new Set<string>();
    for (const evt of filteredEvents) {
      const picks = evt.mmrPicks?.[ALBUM_MMR_MODE];
      if (picks?.length) picks.forEach((id) => ids.add(id));
      else ids.add(evt.topPhotoId);
    }
    return [...ids];
  }, [filteredEvents]);

  const handleBuildCollage = useCallback(async ({ theme, title, photoIds, characterOutfit, aiCaptions }: AlbumChoices) => {
    if (!jobId) { notify('An album requires a saved session.', 'error'); return; }
    if (photoIds.length === 0) { notify('Nothing to put in the album.', 'error'); return; }
    // Everything beyond theme, title, outfit and photos is always on: captions,
    // enhanced versions, chapter pages, the cast page and Lumi.
    const options: CollageOptions = {
      photoIds,
      theme,
      title,
      autoTitle: false,
      captions: true,
      aiCaptions,
      useEnhanced: true,
      chapters: true,
      cast: true,
      character: true,
      characterOutfit,
    };
    setCollageBusy(true);
    try {
      await downloadCollage(jobId, options);
      notify(`Album ready: ${photoIds.length} ${photoIds.length === 1 ? 'photo' : 'photos'}.`);
      setCollageOpen(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Album export failed.', 'error');
    } finally {
      setCollageBusy(false);
    }
  }, [jobId, notify]);

  const handleExport = useCallback(async () => {
    if (!jobId) { notify('Export requires a saved session.', 'error'); return; }
    const ids = curatedPhotoIds();
    if (ids.length === 0) { notify('Nothing to export.', 'error'); return; }
    setExporting(true);
    try {
      await exportAlbum(jobId, ids, 'lumina-best-shots');
      notify(`Exported ${ids.length} ${ids.length === 1 ? 'photo' : 'photos'}.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Export failed.', 'error');
    } finally {
      setExporting(false);
    }
  }, [jobId, curatedPhotoIds, notify]);

  /* ---- render ---- */

  const tabs: SegmentItem<View>[] = [
    { key: 'moments', label: 'Moments', icon: <Sparkles className="w-4 h-4 hidden sm:block" /> },
    { key: 'all', label: 'All photos', icon: <LayoutGrid className="w-4 h-4 hidden sm:block" /> },
    { key: 'cleanup', label: 'Cleanup', icon: <Trash2 className="w-4 h-4 hidden sm:block" />, badge: rejects.length },
  ];

  const showFilters = hasSession && !search && (view === 'moments' || view === 'all');
  const clearFilters = () => { setSelectedPerson(null); setSelectedEvent(null); };

  const renderContent = () => {
    if (!hasSession) {
      return (
        <div className="flex flex-col items-center text-center py-16">
          <Lumi pose="search" size={130} />
          <h3 className="font-display text-2xl font-semibold text-slate-900 mt-4">No session open</h3>
          <p className="text-sm text-slate-500 mt-1 max-w-sm">
            Analyse a new batch of photos, or reopen one from My sessions, and Lumi will lay it out here.
          </p>
        </div>
      );
    }
    if (search && jobId) {
      return (
        <div>
          <div className="flex items-center justify-between gap-3 mb-5">
            <div className="min-w-0">
              <p className="font-display text-xl sm:text-2xl font-semibold text-slate-900 truncate">
                {search.results.length > 0 ? <>&ldquo;{search.query}&rdquo;</> : <>Nothing matched &ldquo;{search.query}&rdquo;</>}
              </p>
              <p className="text-sm text-slate-500 mt-0.5">
                {search.results.length > 0
                  ? `${search.results.length} ${search.results.length === 1 ? 'photo' : 'photos'}, best match first`
                  : 'Try describing what you see: "two people hugging", "food on a table".'}
              </p>
            </div>
            <button onClick={() => setSearch(null)} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full text-sm font-bold text-slate-600 bg-slate-900/[0.05] hover:bg-slate-900/[0.08] flex-shrink-0">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
          </div>
          {search.results.length > 0 && (
            <PhotoGrid
              entries={search.results.map((r, i) => ({
                photo: r.photo,
                event: eventByPhotoId.get(r.photo.id) ?? null,
                caption: eventByPhotoId.get(r.photo.id)?.label,
                isBest: i === 0 && search.results.length > 1,
              }))}
              eagerCount={12}
              onOpen={(i) => openLightbox(search.results.map((r) => ({ photo: r.photo, event: eventByPhotoId.get(r.photo.id) ?? null })), i)}
            />
          )}
        </div>
      );
    }
    switch (view) {
      case 'cleanup':
        return <CleanupView rejects={rejects} onOpenItems={openLightbox} />;
      case 'all':
        return (
          <AllPhotosView
            events={selectedEvent ? filteredEvents : events}
            person={person}
            highlightPerson={highlightPerson}
            onOpenItems={openLightbox}
            onMakeBest={handleMakeBest}
          />
        );
      default:
        return (
          <MomentsView
            events={filteredEvents}
            identities={identities}
            highlightPerson={highlightPerson}
            onDelete={handleDelete}
            onRename={handleRename}
            onMakeBest={handleMakeBest}
            onOpenPhoto={openEventPhoto}
            onClearFilters={clearFilters}
          />
        );
    }
  };

  return (
    <EnhanceContext.Provider value={enhanceContext}>
    <FocalContext.Provider value={focal}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-6 sm:pt-10 pb-24">
        {/* ---------- Header ---------- */}
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 mb-8 sm:mb-10">
          <div className="flex items-end gap-4 sm:gap-5 min-w-0">
            <Lumi pose="star" size={84} animate className="hidden sm:block shrink-0 -mb-1" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-lumina-500 mb-1.5" data-anim="fade-up">
                {hasSession ? 'Curated by Lumi' : 'Nothing here yet'}
              </p>
              <SplitTitle
                text="Your gallery"
                className="font-display text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight text-slate-900 leading-[1.02]"
              />
              {hasSession && (
                <p className="text-[15px] text-slate-500 mt-3" data-anim="fade-up" data-delay="250">
                  <CountUp value={events.length} className="font-bold text-slate-800" /> {events.length === 1 ? 'moment' : 'moments'}
                  <span className="mx-2 text-slate-300">/</span>
                  <CountUp value={identities.length} delay={0.1} className="font-bold text-slate-800" /> {identities.length === 1 ? 'person' : 'people'}
                  <span className="mx-2 text-slate-300">/</span>
                  <CountUp value={totalPhotos} delay={0.2} className="font-bold text-slate-800" /> photos
                </p>
              )}
            </div>
          </div>

          {hasSession && jobId && view === 'moments' ? (
            <div className="flex items-center gap-2 flex-wrap" data-anim="fade-up" data-delay="300">
              <button
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setPersonalizationAnchor((prev) => (prev ? null : rect));
                }}
                className={`h-10 px-4 rounded-full text-sm font-bold flex items-center gap-2 transition-colors ${
                  personalizationAnchor ? 'bg-slate-900 text-white' : 'bg-white/80 ring-1 ring-slate-200/80 text-slate-700 hover:bg-white'
                }`}
                title="Your learned taste profile"
                aria-label="My taste"
              >
                <SlidersHorizontal className="w-4 h-4" /> <span className="hidden sm:inline">My taste</span>
              </button>
              <button
                onClick={handleExport}
                disabled={exporting}
                className="h-10 px-4 rounded-full text-sm font-bold flex items-center gap-2 bg-white/80 ring-1 ring-slate-200/80 text-slate-700 hover:bg-white transition-colors disabled:opacity-50"
                title="Download the curated picks as a zip"
                aria-label="Export"
              >
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} <span className="hidden sm:inline">Export</span>
              </button>
              <button onClick={() => setCollageOpen(true)} className="btn-jelly btn-jelly-sm !h-10" title="Design a themed PDF album from these picks">
                <FileText className="w-4 h-4" /> Create album
              </button>
              <button onClick={() => setVideoOpen(true)} className="btn-jelly btn-jelly-sm !h-10" title="Make a 1080p video of these picks, with music and Lumi">
                <Clapperboard className="w-4 h-4" /> Create video
              </button>
              <button onClick={() => setWorldOpen(true)} className="btn-jelly btn-jelly-sm !h-10" title="Walk Lumi around a 3D island of your photos">
                <TreePalm className="w-4 h-4" /> Explore world
              </button>
            </div>
          ) : !hasSession && onGoToPhotos ? (
            <div className="flex items-center gap-2 flex-wrap self-start lg:self-auto" data-anim="fade-up" data-delay="300">
              {user && (
                <button onClick={() => setWorldOpen(true)} className="btn-jelly btn-jelly-sm !h-10" title="Walk Lumi around a 3D island of your library">
                  <TreePalm className="w-4 h-4" /> Explore world
                </button>
              )}
              <button onClick={onGoToPhotos} className="btn-jelly btn-jelly-sm !h-10">
                <UploadCloud className="w-4 h-4" /> Analyse new photos
              </button>
            </div>
          ) : null}
        </header>

        {/* ---------- Toolbar ---------- */}
        <div
          ref={toolbarRef}
          className="relative z-30 py-2 mb-6 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4"
        >
          {hasSession && <Segmented items={tabs} value={view} onChange={setView} className="self-start max-w-full" />}
          {hasSession && jobId && (
            <SearchBar
              jobId={jobId}
              photosById={photosById}
              scopePerson={person}
              suggestions={searchSuggestions}
              active={search !== null}
              onResults={setSearch}
              onError={(message) => notify(message, 'error')}
              className="w-full sm:max-w-md sm:ml-auto"
            />
          )}
        </div>

        {/* ---------- People + moments filters ---------- */}
        {showFilters && identities.length > 0 && (
          <section className="mb-6" aria-label="Filter by person">
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-sm font-bold text-slate-800 flex items-center gap-1.5 !font-sans">
                <Users className="w-4 h-4 text-slate-400" /> People
              </h2>
              {person && (
                <button
                  onClick={() => setFaceRingOn((v) => !v)}
                  className="inline-flex items-center gap-2 text-xs font-bold text-slate-500 hover:text-slate-800"
                  role="switch"
                  aria-checked={faceRingOn}
                  title="Circle this person's face in every photo"
                >
                  <span className={`relative w-7 h-4 rounded-full transition-colors duration-300 ${faceRingOn ? 'bg-lumina-500' : 'bg-slate-300'}`}>
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-[left] duration-300 ${faceRingOn ? 'left-3.5' : 'left-0.5'}`} />
                  </span>
                  <ScanFace className="w-3.5 h-3.5" /> Spotlight
                </button>
              )}
            </div>
            <div className="flex gap-3 sm:gap-4 overflow-x-auto scrollbar-hide pb-1 -mx-1 px-1" style={{ scrollbarWidth: 'none' }}>
              <PersonChip
                label="Everyone"
                active={!selectedPerson}
                onClick={() => { setSelectedPerson(null); setSelectedEvent(null); }}
                avatar={<span className="w-full h-full rounded-full bg-slate-900/[0.06] flex items-center justify-center"><Images className="w-5 h-5 text-slate-500" /></span>}
              />
              {identities.map((ident) => (
                <PersonChip
                  key={ident.id}
                  label={ident.label}
                  count={ident.photoIds.length}
                  active={selectedPerson === ident.id}
                  dimmed={Boolean(selectedPerson) && selectedPerson !== ident.id}
                  onClick={() => { setSelectedPerson((p) => (p === ident.id ? null : ident.id)); setSelectedEvent(null); }}
                  avatar={<FaceAvatar faceThumb={ident.faceThumb} label={ident.label} />}
                />
              ))}
              <PersonChip
                label="Edit"
                onClick={() => setPeopleManagerOpen(true)}
                avatar={<span className="w-full h-full rounded-full border-2 border-dashed border-slate-300 flex items-center justify-center"><Pencil className="w-4 h-4 text-slate-400" /></span>}
              />
            </div>
          </section>
        )}

        {showFilters && eventsForStrip.length > 1 && (
          <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1 mb-8 sm:mb-10 -mx-1 px-1" style={{ scrollbarWidth: 'none' }} aria-label="Filter by moment">
            {eventsForStrip.map((evt) => {
              const active = selectedEvent === evt.id;
              const cover = evt.photos.find((p) => p.id === evt.topPhotoId) ?? evt.photos[0];
              return (
                <button
                  key={evt.id}
                  onClick={() => setSelectedEvent(active ? null : evt.id)}
                  title={evt.caption ?? evt.label}
                  className={`flex items-center gap-2 pl-1 pr-3.5 h-10 rounded-full text-sm font-bold whitespace-nowrap flex-shrink-0 max-w-[15rem] transition-colors duration-300 ${
                    active ? 'bg-slate-900 text-white' : 'bg-white/70 ring-1 ring-slate-200/70 text-slate-600 hover:bg-white hover:text-slate-900'
                  }`}
                >
                  {cover && <img src={cover.url} alt="" loading="lazy" decoding="async" className="w-8 h-8 rounded-full object-cover flex-shrink-0 bg-slate-100" />}
                  <span className="truncate">{evt.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* ---------- Content ---------- */}
        <div ref={contentRef} key={`${view}-${search ? 'search' : 'browse'}`}>
          {renderContent()}
        </div>

        {/* ---------- Overlays ---------- */}
        {peopleManagerOpen && (
          <PeopleManager
            identities={identities}
            photosById={photosById}
            onRename={handlePersonRename}
            onMerge={handlePersonMerge}
            onMovePhoto={handleMovePhoto}
            onClose={() => setPeopleManagerOpen(false)}
          />
        )}
        {personalizationAnchor && (
          <PersonalizationPanel
            jobId={jobId}
            anchor={personalizationAnchor}
            onApplyRescore={handleApplyRescore}
            onNotify={notify}
            onClose={() => setPersonalizationAnchor(null)}
          />
        )}
        {lightbox && (
          <Lightbox
            items={lightbox.items}
            index={lightbox.index}
            onNavigate={(index) => setLightbox((prev) => (prev ? { ...prev, index } : prev))}
            onClose={() => setLightbox(null)}
            onMakeBest={handleMakeBest}
          />
        )}
        {collageOpen && (
          <AlbumModal
            photos={curatedPhotoIds().map((id) => photosById.get(id)).filter((p): p is Photo => Boolean(p))}
            busy={collageBusy}
            onBuild={handleBuildCollage}
            onClose={() => setCollageOpen(false)}
          />
        )}
        {videoOpen && jobId && (
          <Suspense fallback={null}>
            <VideoModal
              jobId={jobId}
              events={filteredEvents}
              photos={curatedPhotoIds().map((id) => photosById.get(id)).filter((p): p is Photo => Boolean(p))}
              focal={focal}
              enhancedUrls={Object.fromEntries(
                (Object.entries(enhanceEntries) as Array<[string, EnhanceEntry]>).filter(([id]) => !showOriginal[id]).map(([id, entry]) => [id, entry.url]),
              )}
              onNotify={notify}
              onClose={() => setVideoOpen(false)}
            />
          </Suspense>
        )}
        {worldOpen && (
          <Suspense fallback={null}>
            <WorldModal events={events} onClose={() => setWorldOpen(false)} />
          </Suspense>
        )}
        <ToastStack toasts={toasts} />
      </div>
    </FocalContext.Provider>
    </EnhanceContext.Provider>
  );
};

const PersonChip: React.FC<{
  label: string;
  avatar: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  dimmed?: boolean;
  count?: number;
}> = ({ label, avatar, onClick, active, dimmed, count }) => (
  <button
    onClick={onClick}
    className={`group flex flex-col items-center gap-1.5 w-16 flex-shrink-0 transition-opacity duration-300 ${dimmed ? 'opacity-45 hover:opacity-100' : ''}`}
    aria-pressed={active}
    title={count != null ? `${label} · ${count} photos` : label}
  >
    <span className={`relative w-14 h-14 rounded-full p-[3px] transition-all duration-300 ${
      active ? 'bg-gradient-to-br from-lumina-400 to-indigo-400 scale-105' : 'bg-transparent group-hover:scale-105'
    }`}>
      <span className="block w-full h-full rounded-full overflow-hidden ring-2 ring-white [&>div]:!w-full [&>div]:!h-full">
        {avatar}
      </span>
    </span>
    <span className={`text-xs max-w-full truncate ${active ? 'font-bold text-slate-900' : 'font-semibold text-slate-500'}`}>{label}</span>
  </button>
);
