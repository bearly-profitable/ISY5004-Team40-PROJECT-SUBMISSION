
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Landing } from './pages/Landing';
import { UploadView } from './pages/UploadView';
import { Processing } from './pages/Processing';
import { SmartGallery } from './pages/SmartGallery';
import { Analysis } from './pages/Analysis';
import { Sessions } from './pages/Sessions';
import { Profile } from './pages/Profile';
import { Navbar } from './components/Navbar';
import { AppStep, Event, Identity, Photo } from './types';
import { AnalyzeResult, getSession, sessionPhotoUrl, startAnalysis } from './lib/analysisApi';
import { startMotion } from './lib/motion';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isStartingAnalysis, setIsStartingAnalysis] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [galleryEvents, setGalleryEvents] = useState<Event[]>([]);
  const [galleryIdentities, setGalleryIdentities] = useState<Identity[]>([]);
  const [enhancedPhotoIds, setEnhancedPhotoIds] = useState<string[]>([]);

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
  useEffect(() => {
    return () => {
      for (const photo of photosRef.current) {
        if (photo.url.startsWith('blob:')) {
          URL.revokeObjectURL(photo.url);
        }
      }
    };
  }, []);

  const handleLocalUpload = (files: FileList) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    setPhotos((prev) => {
      const remaining = MAX_PHOTOS - prev.length;
      const toAdd = imageFiles.slice(0, remaining);

      if (imageFiles.length > remaining && remaining > 0) {
        setAnalysisError(`Only ${remaining} more photos can be added (max ${MAX_PHOTOS}). ${imageFiles.length - remaining} were skipped.`);
      } else if (remaining <= 0) {
        setAnalysisError(`Photo limit reached (max ${MAX_PHOTOS}). Remove some photos first.`);
        return prev;
      }

      const newPhotos: Photo[] = toAdd.map((file) => ({
        id: crypto.randomUUID(),
        url: URL.createObjectURL(file),
        name: file.name,
        size: formatFileSize(file.size),
        source: 'local' as const,
      }));

      return [...prev, ...newPhotos];
    });

    setStep(AppStep.UPLOAD);
  };

  const handleAnalyze = async (selectedPhotoIds: string[]) => {
    const photoSet = new Set(selectedPhotoIds);
    const selectedPhotos = photos.filter((photo) => photoSet.has(photo.id));
    if (selectedPhotos.length === 0) {
      setAnalysisError('Please select at least one image to analyze.');
      return;
    }

    setIsStartingAnalysis(true);
    setAnalysisError(null);
    try {
      const jobId = await startAnalysis(selectedPhotos);
      setGalleryPhotoPool(selectedPhotos);
      setEnhancedPhotoIds([]);
      setAnalysisJobId(jobId);
      setStep(AppStep.PROCESSING);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start analysis.';
      setAnalysisError(message);
    } finally {
      setIsStartingAnalysis(false);
    }
  };

  const applyResult = useCallback((result: AnalyzeResult, pool: Photo[], jobId: string | null) => {
    const mapped = mapResult(result, pool);
    setGalleryEvents(mapped.events);
    setGalleryIdentities(mapped.identities);
    setGalleryJobId(jobId);
  }, []);

  const handleAnalysisComplete = (result: AnalyzeResult) => {
    applyResult(result, galleryPhotoPool, analysisJobId);
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
    switch (step) {
      case AppStep.LANDING:
        return <Landing onGetStarted={() => setStep(AppStep.UPLOAD)} />;
      case AppStep.UPLOAD:
        return (
          <UploadView
            onAnalyze={handleAnalyze}
            photos={photos}
            onLocalUpload={handleLocalUpload}
            isAnalyzing={isStartingAnalysis}
            analyzeError={analysisError}
            maxPhotos={MAX_PHOTOS}
          />
        );
      case AppStep.PROCESSING:
        if (!analysisJobId) {
          return (
            <UploadView
              onAnalyze={handleAnalyze}
              photos={photos}
              onLocalUpload={handleLocalUpload}
              isAnalyzing={isStartingAnalysis}
              analyzeError={analysisError ?? 'No analysis job was found. Please start again.'}
              maxPhotos={MAX_PHOTOS}
            />
          );
        }
        return (
          <Processing
            jobId={analysisJobId}
            photos={galleryPhotoPool}
            onComplete={handleAnalysisComplete}
            onError={(message) => {
              setAnalysisError(message);
              setStep(AppStep.UPLOAD);
            }}
          />
        );
      case AppStep.GALLERY:
        return (
          <SmartGallery
            jobId={galleryJobId}
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
