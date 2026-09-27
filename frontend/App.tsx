
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Landing } from './pages/Landing';
import { UploadView } from './pages/UploadView';
import { Processing } from './pages/Processing';
import { SmartGallery } from './pages/SmartGallery';
import { Analysis } from './pages/Analysis';
import { Sessions } from './pages/Sessions';
import { Profile } from './pages/Profile';
import { Navbar } from './components/Navbar';
import { MEMBER_STEPS, SignInGate } from './components/SignInGate';
import { AnalysisMode, AppStep, Event, Identity, Photo } from './types';
import { AnalyzeResult, UploadProgress, getSession, sessionPhotoUrl, startAnalysis } from './lib/analysisApi';
import { makeThumbnails } from './lib/localThumbs';
import { startMotion } from './lib/motion';
import { useAuth } from './lib/auth';

/** Free the in-memory copies (originals and thumbnails) of local photos. */
function revokeLocalUrls(photos: Photo[]): void {
  for (const photo of photos) {
    if (photo.url.startsWith('blob:')) URL.revokeObjectURL(photo.url);
    if (photo.thumbUrl?.startsWith('blob:') && photo.thumbUrl !== photo.url) URL.revokeObjectURL(photo.thumbUrl);
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Where to go once the Google round-trip brings a visitor back signed in.
const AFTER_LOGIN_KEY = 'lumina-after-login';

// Raised from 80: the backend embedding cache + job queue handle larger
// batches, and re-runs of previously analysed photos skip inference entirely.
const MAX_PHOTOS = 200;

/** Map a backend result onto UI events/identities using a photo pool. */
function mapResult(result: AnalyzeResult, pool: Photo[]): { events: Event[]; identities: Identity[] } {
  const byId = new Map(pool.map((photo) => [photo.id, photo]));

  const events: Event[] = result.events
    .map((evt) => {
      const photos = evt.photoIds
        .map((id) => byId.get(id))
        .filter((p): p is Photo => Boolean(p));
      if (photos.length === 0) return null;
      const topPhotoId = photos.some((p) => p.id === evt.topPhotoId)
        ? evt.topPhotoId
        : photos[0].id;
      return {
        id: evt.id,
        label: evt.label,
        autoLabel: evt.autoLabel ?? null,
        caption: evt.caption ?? null,
        startTime: evt.startTime ?? null,
        endTime: evt.endTime ?? null,
        dateLabel: evt.dateLabel ?? null,
        photoIds: evt.photoIds,
        topPhotoId,
        persons: evt.persons,
        members: evt.members,
        bestByPerson: evt.bestByPerson ?? [],
        mmrPicks: evt.mmrPicks ?? {},
        userPinned: evt.userPinned,
        photos,
      };
    })
    .filter(Boolean) as Event[];

  const identities: Identity[] = result.identities.map((ident) => ({
    id: ident.id,
    label: ident.label,
    faceThumb: ident.faceThumb ?? null,
    photoIds: ident.photoIds,
    eventIds: ident.eventIds,
    faceBoxes: ident.faceBoxes ?? {},
  }));

  return { events, identities };
}

const App: React.FC = () => {
  const [step, setStep] = useState<AppStep>(AppStep.LANDING);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [galleryPhotoPool, setGalleryPhotoPool] = useState<Photo[]>([]);
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
  const [galleryJobId, setGalleryJobId] = useState<string | null>(null);
  // The running job's mode, and the mode of the session in the gallery.
  const [processingMode, setProcessingMode] = useState<AnalysisMode>('full');
  const [galleryMode, setGalleryMode] = useState<AnalysisMode>('full');
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  // Set while the selected photos are uploading (the Processing page shows it).
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const uploadRef = useRef<AbortController | null>(null);
  // What was picked when an upload or analysis failed, so a retry is one click.
  const [retrySelection, setRetrySelection] = useState<string[] | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [galleryEvents, setGalleryEvents] = useState<Event[]>([]);
  const [galleryIdentities, setGalleryIdentities] = useState<Identity[]>([]);
  const [enhancedPhotoIds, setEnhancedPhotoIds] = useState<string[]>([]);
  const { user, loading: authLoading, signInWithGoogle } = useAuth();

  /** Sign in, remembering the members-only tab the visitor was trying to open. */
  const logIn = useCallback(() => {
    // A gallery or a running analysis lives in memory and won't survive the
    // redirect, so those come back to their saved copy on the Sessions tab.
    const back = step === AppStep.UPLOAD ? AppStep.UPLOAD
      : MEMBER_STEPS.has(step) ? AppStep.SESSIONS : null;
    try {
      if (back) sessionStorage.setItem(AFTER_LOGIN_KEY, back);
    } catch { /* private mode: they land on Home instead */ }
    void signInWithGoogle();
  }, [step, signInWithGoogle]);

  // Back from Google: carry on where they were headed.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    try {
      const back = sessionStorage.getItem(AFTER_LOGIN_KEY) as AppStep | null;
      sessionStorage.removeItem(AFTER_LOGIN_KEY);
      if (back && MEMBER_STEPS.has(back)) setStep(back);
    } catch { /* storage blocked */ }
  }, [userId]);

  // Signing out drops the photos and results held in memory, so the next
  // person on this browser starts from nothing.
  const prevUserId = useRef<string | null>(null);
  useEffect(() => {
    if (prevUserId.current && !userId) {
      uploadRef.current?.abort();
      uploadRef.current = null;
      thumbGenRef.current += 1;
      revokeLocalUrls(photosRef.current);
      setPhotos([]);
      setUploadProgress(null);
      setGalleryPhotoPool([]);
      setGalleryEvents([]);
      setGalleryIdentities([]);
      setEnhancedPhotoIds([]);
      setAnalysisJobId(null);
      setGalleryJobId(null);
      setAnalysisError(null);
    }
    prevUserId.current = userId;
  }, [userId]);

  // GSAP drives every entrance in the app; see lib/motion.ts.
  useEffect(() => { startMotion(); }, []);

  // A new page starts at the top, like a real navigation would.
  useEffect(() => { window.scrollTo(0, 0); }, [step]);

  // Revoke blob URLs only on unmount. Revoking on every photos change
  // (the old behaviour) destroyed the URLs of photos that were still in the
  // list whenever a second batch was added — their images then silently
  // failed to load in the gallery (infinite skeleton).
  const photosRef = useRef<Photo[]>(photos);
  useEffect(() => { photosRef.current = photos; }, [photos]);
  useEffect(() => () => revokeLocalUrls(photosRef.current), []);

  // Thumbnails arrive one by one; they're applied in batches so thirty photos
  // don't mean thirty re-renders of every grid.
  const thumbGenRef = useRef(0);
  const pendingThumbs = useRef(new Map<string, string | null>());
  const thumbFlush = useRef<number | null>(null);
  const flushThumbs = useCallback(() => {
    thumbFlush.current = null;
    const ready = new Map(pendingThumbs.current);
    pendingThumbs.current.clear();
    if (ready.size === 0) return;
    const apply = (list: Photo[]) => (list.some((p) => ready.has(p.id) && !p.thumbUrl)
      // No thumbnail possible (e.g. HEIC): the grid shows the original instead.
      ? list.map((p) => (ready.has(p.id) && !p.thumbUrl ? { ...p, thumbUrl: ready.get(p.id) ?? p.url } : p))
      : list);
    setPhotos(apply);
    setGalleryPhotoPool(apply);
  }, []);

  const handleLocalUpload = (files: FileList) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    // Built out here, not inside a setPhotos updater: React may run an
    // updater later (or twice), and each run would mint new blob URLs.
    const remaining = MAX_PHOTOS - photosRef.current.length;
    if (remaining <= 0) {
      setAnalysisError(`Photo limit reached (max ${MAX_PHOTOS}). Remove some photos first.`);
      return;
    }
    if (imageFiles.length > remaining) {
      setAnalysisError(`Only ${remaining} more photos can be added (max ${MAX_PHOTOS}). ${imageFiles.length - remaining} were skipped.`);
    }
    const added: Photo[] = imageFiles.slice(0, remaining).map((file) => ({
      id: crypto.randomUUID(),
      url: URL.createObjectURL(file),
      name: file.name,
      size: formatFileSize(file.size),
      source: 'local' as const,
      file,
    }));
    photosRef.current = [...photosRef.current, ...added];
    setPhotos((prev) => [...prev, ...added]);
    setStep(AppStep.UPLOAD);

    const gen = thumbGenRef.current;
    void makeThumbnails(
      added.map((p) => ({ id: p.id, file: p.file as File })),
      (id, url) => {
        if (gen !== thumbGenRef.current) {
          if (url) URL.revokeObjectURL(url); // signed out meanwhile
          return;
        }
        pendingThumbs.current.set(id, url);
        if (thumbFlush.current === null) thumbFlush.current = window.setTimeout(flushThumbs, 120);
      },
    );
  };

  /** Go straight to the Processing page and upload from there, so a big
   *  batch shows progress instead of freezing the Upload page until every
   *  original has reached the server. */
  const handleAnalyze = (selectedPhotoIds: string[], mode: AnalysisMode = 'full') => {
    const photoSet = new Set(selectedPhotoIds);
    const selectedPhotos = photos.filter((photo) => photoSet.has(photo.id));
    if (selectedPhotos.length === 0) {
      setAnalysisError('Please select at least one image to analyze.');
      return;
    }

    uploadRef.current?.abort();
    const upload = new AbortController();
    uploadRef.current = upload;
    const current = () => uploadRef.current === upload;

    setAnalysisError(null);
    setRetrySelection(null);
    setGalleryPhotoPool(selectedPhotos);
    setEnhancedPhotoIds([]);
    setAnalysisJobId(null);
    setUploadProgress({ loaded: 0, total: 0 });
    setProcessingMode(mode);
    setStep(AppStep.PROCESSING);

    startAnalysis(selectedPhotos, {
      mode,
      signal: upload.signal,
      onProgress: (progress) => { if (current()) setUploadProgress(progress); },
    })
      .then((jobId) => {
        if (current()) setAnalysisJobId(jobId);
      })
      .catch((error) => {
        if (!current()) return;
        setAnalysisError(error instanceof Error ? error.message : 'Failed to start analysis.');
        setRetrySelection(selectedPhotoIds);
        setStep((s) => (s === AppStep.PROCESSING ? AppStep.UPLOAD : s));
      })
      .finally(() => {
        if (!current()) return;
        uploadRef.current = null;
        setUploadProgress(null);
      });
  };

  const applyResult = useCallback((result: AnalyzeResult, pool: Photo[], jobId: string | null) => {
    const mapped = mapResult(result, pool);
    setGalleryEvents(mapped.events);
    setGalleryIdentities(mapped.identities);
    setGalleryJobId(jobId);
    setGalleryMode(result.summary?.mode === 'quick' ? 'quick' : 'full');
  }, []);

  const handleAnalysisComplete = (result: AnalyzeResult) => {
    // Grids read the backend's small thumbnails instead of decoding every
    // multi-megabyte original; the local blob stays as the full-size source.
    const pool = analysisJobId
      ? galleryPhotoPool.map((p) => ({
          ...p,
          url: sessionPhotoUrl(analysisJobId, p.id, 400),
          largeUrl: sessionPhotoUrl(analysisJobId, p.id, 800),
          fullUrl: p.url,
        }))
      : galleryPhotoPool;
    setGalleryPhotoPool(pool);
    applyResult(result, pool, analysisJobId);
    setAnalysisError(null);
    setStep(AppStep.GALLERY);
  };

  /** Corrections persist server-side and return the full updated result. */
  const handleResultUpdate = useCallback((result: AnalyzeResult) => {
    applyResult(result, galleryPhotoPool, galleryJobId);
  }, [applyResult, galleryPhotoPool, galleryJobId]);

  const handleOpenSession = async (jobId: string) => {
    setIsLoadingSession(true);
    try {
      const session = await getSession(jobId);
      const pool: Photo[] = session.photos.map((p) => ({
        id: p.id,
        // Grids get a cached 400px thumbnail; the lightbox loads the original
        url: sessionPhotoUrl(jobId, p.id, 400),
        largeUrl: sessionPhotoUrl(jobId, p.id, 800),
        fullUrl: sessionPhotoUrl(jobId, p.id),
        name: p.name,
        size: '',
        source: 'session' as const,
      }));
      setGalleryPhotoPool(pool);
      setEnhancedPhotoIds(session.enhancedPhotoIds ?? []);
      applyResult(session.result, pool, jobId);
      setAnalysisError(null);
      setStep(AppStep.GALLERY);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load session.';
      setAnalysisError(message);
    } finally {
      setIsLoadingSession(false);
    }
  };

  const renderStep = () => {
    // Upload, gallery and sessions belong to an account: Lumi sends visitors
    // to the Log in button first.
    if (MEMBER_STEPS.has(step) && !user) {
      return <SignInGate step={step} onLogIn={logIn} checking={authLoading} />;
    }
    switch (step) {
      case AppStep.LANDING:
        return <Landing onGetStarted={() => setStep(AppStep.UPLOAD)} />;
      case AppStep.UPLOAD:
        return (
          <UploadView
            onAnalyze={handleAnalyze}
            photos={photos}
            onLocalUpload={handleLocalUpload}
            isAnalyzing={uploadProgress !== null}
            analyzeError={analysisError}
            initialSelected={retrySelection}
            maxPhotos={MAX_PHOTOS}
          />
        );
      case AppStep.PROCESSING:
        if (!analysisJobId && !uploadProgress) {
          return (
            <UploadView
              onAnalyze={handleAnalyze}
              photos={photos}
              onLocalUpload={handleLocalUpload}
              isAnalyzing={uploadProgress !== null}
              analyzeError={analysisError ?? 'No analysis job was found. Please start again.'}
              maxPhotos={MAX_PHOTOS}
            />
          );
        }
        return (
          <Processing
            jobId={analysisJobId}
            mode={processingMode}
            upload={uploadProgress}
            photos={galleryPhotoPool}
            onComplete={handleAnalysisComplete}
            onError={(message) => {
              setAnalysisError(message);
              setRetrySelection(galleryPhotoPool.map((p) => p.id));
              setStep(AppStep.UPLOAD);
            }}
          />
        );
      case AppStep.GALLERY:
        return (
          <SmartGallery
            jobId={galleryJobId}
            mode={galleryMode}
            events={galleryEvents}
            identities={galleryIdentities}
            onGoToPhotos={() => setStep(AppStep.UPLOAD)}
            onResultUpdate={handleResultUpdate}
            enhancedPhotoIds={enhancedPhotoIds}
          />
        );
      case AppStep.SESSIONS:
        return (
          <Sessions
            onOpenSession={handleOpenSession}
            isLoading={isLoadingSession}
          />
        );
      case AppStep.PROFILE:
        return <Profile onNavigate={setStep} />;
      case AppStep.FACE_ANALYSIS:
        return <Analysis photos={photos} />;
      default:
        return <Landing onGetStarted={() => setStep(AppStep.UPLOAD)} />;
    }
  };

  const isLanding = step === AppStep.LANDING;

  return (
    <div className="min-h-screen text-slate-900">
      <Navbar
        currentStep={step}
        setStep={setStep}
        onLogIn={logIn}
      />
      <main className={isLanding ? '' : 'pt-20 sm:pt-24'} key={step}>
        <div data-anim={isLanding ? undefined : 'page'}>
          {renderStep()}
        </div>
      </main>
    </div>
  );
};

export default App;
