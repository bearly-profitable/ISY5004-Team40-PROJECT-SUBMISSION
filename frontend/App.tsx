
import React, { useState, useEffect } from 'react';
import { Landing } from './pages/Landing';
import { DriveView } from './pages/DriveView';
import { Processing } from './pages/Processing';
import { SmartGallery } from './pages/SmartGallery';
import { Analysis } from './pages/Analysis';
import { Navbar } from './components/Navbar';
import { AppStep, Event, Identity, Photo } from './types';
import { connectGoogleDriveAndLoadPhotos } from './lib/googleDrive';
import { AnalyzeResult, startAnalysis } from './lib/analysisApi';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_PHOTOS = 80;

const App: React.FC = () => {
  const [step, setStep] = useState<AppStep>(AppStep.LANDING);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [folderName, setFolderName] = useState('Not connected');
  const [drivePhotos, setDrivePhotos] = useState<Photo[]>([]);
  const [selectedForAnalysis, setSelectedForAnalysis] = useState<Photo[]>([]);
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isStartingAnalysis, setIsStartingAnalysis] = useState(false);
  const [galleryEvents, setGalleryEvents] = useState<Event[]>([]);
  const [galleryIdentities, setGalleryIdentities] = useState<Identity[]>([]);

  useEffect(() => {
    return () => {
      for (const photo of drivePhotos) {
        if (photo.url.startsWith('blob:')) {
          URL.revokeObjectURL(photo.url);
        }
      }
    };
  }, [drivePhotos]);

  const handleConnect = async () => {
    setIsConnecting(true);
    setConnectError(null);
    try {
      const result = await connectGoogleDriveAndLoadPhotos();

      setDrivePhotos((prev) => {
        for (const photo of prev) {
          if (photo.url.startsWith('blob:')) {
            URL.revokeObjectURL(photo.url);
          }
        }
        return result.photos;
      });
      setFolderName(result.folderName);
      setSelectedForAnalysis([]);
      setAnalysisJobId(null);
      setAnalysisError(null);
      setGalleryEvents([]);
      setGalleryIdentities([]);
      setStep(AppStep.DRIVE_VIEW);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect Google Drive.';
      setConnectError(message);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleLocalUpload = (files: FileList) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    setDrivePhotos((prev) => {
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

    setFolderName((prev) => prev === 'Not connected' ? 'Local uploads' : prev);
    setStep(AppStep.DRIVE_VIEW);
  };

  const handleAnalyze = async (selectedPhotoIds: string[]) => {
    const photoSet = new Set(selectedPhotoIds);
    const photos = drivePhotos.filter((photo) => photoSet.has(photo.id));
    if (photos.length === 0) {
      setAnalysisError('Please select at least one image to analyze.');
      return;
    }

    setIsStartingAnalysis(true);
    setAnalysisError(null);
    try {
      const jobId = await startAnalysis(photos);
      setSelectedForAnalysis(photos);
      setAnalysisJobId(jobId);
      setStep(AppStep.PROCESSING);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start analysis.';
      setAnalysisError(message);
    } finally {
      setIsStartingAnalysis(false);
    }
  };

  const handleAnalysisComplete = (result: AnalyzeResult) => {
    const byId = new Map(selectedForAnalysis.map((photo) => [photo.id, photo]));

    const mappedEvents: Event[] = result.events
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
          photoIds: evt.photoIds,
          topPhotoId,
          persons: evt.persons,
          members: evt.members,
          photos,
        };
      })
      .filter(Boolean) as Event[];

    const mappedIdentities: Identity[] = result.identities.map((ident) => ({
      id: ident.id,
      label: ident.label,
      faceThumb: ident.faceThumb ?? null,
      photoIds: ident.photoIds,
      eventIds: ident.eventIds,
    }));

    setGalleryEvents(mappedEvents);
    setGalleryIdentities(mappedIdentities);
    setAnalysisError(null);
    setStep(AppStep.GALLERY);
  };

  const renderStep = () => {
    switch (step) {
      case AppStep.LANDING:
        return <Landing />;
      case AppStep.DRIVE_VIEW:
        return (
          <DriveView
            onAnalyze={handleAnalyze}
            photos={drivePhotos}
            folderName={folderName}
            onReconnect={handleConnect}
            onLocalUpload={handleLocalUpload}
            isConnecting={isConnecting}
            isAnalyzing={isStartingAnalysis}
            analyzeError={analysisError}
          />
        );
      case AppStep.PROCESSING:
        if (!analysisJobId) {
          return (
            <DriveView
              onAnalyze={handleAnalyze}
              photos={drivePhotos}
              folderName={folderName}
              onReconnect={handleConnect}
              onLocalUpload={handleLocalUpload}
              isConnecting={isConnecting}
              isAnalyzing={isStartingAnalysis}
              analyzeError={analysisError ?? 'No analysis job was found. Please start again.'}
            />
          );
        }
        return (
          <Processing
            jobId={analysisJobId}
            onComplete={handleAnalysisComplete}
            onError={(message) => {
              setAnalysisError(message);
              setStep(AppStep.DRIVE_VIEW);
            }}
          />
        );
      case AppStep.GALLERY:
        return (
          <SmartGallery
            events={galleryEvents}
            identities={galleryIdentities}
            onGoToPhotos={() => setStep(AppStep.DRIVE_VIEW)}
          />
        );
      case AppStep.FACE_ANALYSIS:
        return <Analysis drivePhotos={drivePhotos} />;
      default:
        return <Landing />;
    }
  };

  const isLanding = step === AppStep.LANDING;

  return (
    <div className="min-h-screen text-slate-900 transition-colors duration-500">
      <Navbar
        currentStep={step}
        setStep={setStep}
        onConnect={handleConnect}
        onLocalUpload={handleLocalUpload}
        isConnecting={isConnecting}
      />
      <main className={isLanding ? '' : 'pt-16'} key={step}>
        <div className={isLanding ? '' : 'page-enter'}>
          {renderStep()}
        </div>
      </main>
    </div>
  );
};

export default App;
