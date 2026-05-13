import type { Photo } from '../types';

const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://127.0.0.1:8000';

type AnalyzeEvent = {
  id: string;
  label: string;
  topPhotoId: string;
  photoIds: string[];
  persons: string[];
  members: Array<{
    photoId: string;
    finalScore: number;
    centrality: number;
    faceSharpness: number;
    faceSize: number;
    detScore: number;
    poseQuality: number;
    ear: number;
    nimaScore: number;
  }>;
};

type AnalyzeIdentity = {
  id: string;
  label: string;
  faceThumb?: string | null;
  photoIds: string[];
  eventIds: string[];
};

export type AnalyzeResult = {
  summary: {
    numPhotos: number;
    numEvents: number;
    numIdentities: number;
    noFacePhotos?: number;
    embeddingModel: string;
    faceModel?: string;
    reidModel?: string;
    yoloModel?: string;
  };
  events: AnalyzeEvent[];
  identities: AnalyzeIdentity[];
};

export type AnalyzeStatus = {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  stepKey: string;
  stepLabel: string;
  progress: number;
  error?: string | null;
  result?: AnalyzeResult | null;
};

type AnalyzeStartResponse = {
  jobId: string;
};

async function photoToFile(photo: Photo, index: number): Promise<File> {
  const response = await fetch(photo.url);
  if (!response.ok) {
    throw new Error(`Failed to load photo payload for ${photo.name}.`);
  }
  const blob = await response.blob();
  const fallbackName = `photo-${index}.jpg`;
  const name = photo.name?.trim() ? photo.name : fallbackName;
  return new File([blob], name, { type: blob.type || 'image/jpeg' });
}

export async function startAnalysis(photos: Photo[]): Promise<string> {
  if (photos.length === 0) {
    throw new Error('No photos selected for analysis.');
  }

  const form = new FormData();
  const meta = photos.map((photo) => ({
    id: photo.id,
    name: photo.name,
    size: photo.size,
  }));

  const files = await Promise.all(photos.map((photo, idx) => photoToFile(photo, idx)));
  files.forEach((file) => form.append('files', file));
  form.append('photoMeta', JSON.stringify(meta));

  const response = await fetch(`${BACKEND_BASE_URL}/api/analyze`, {
    method: 'POST',
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to start analysis (${response.status}): ${text}`);
  }

  const payload = await response.json() as AnalyzeStartResponse;
  return payload.jobId;
}

export async function getAnalysisStatus(jobId: string): Promise<AnalyzeStatus> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/analyze/${jobId}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch analysis status (${response.status}): ${text}`);
  }
  return response.json() as Promise<AnalyzeStatus>;
}

// ---------------------------------------------------------------------------
// Face Analysis API
// ---------------------------------------------------------------------------

export type FaceAnalysisStatus = {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  error?: string | null;
  result?: import('../types').FaceAnalysisResult | null;
};

export async function startFaceAnalysis(photoBlob: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append('file', photoBlob, filename);

  const response = await fetch(`${BACKEND_BASE_URL}/api/face-analysis`, {
    method: 'POST',
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to start face analysis (${response.status}): ${text}`);
  }
  const payload = await response.json() as { jobId: string };
  return payload.jobId;
}

export async function getFaceAnalysisStatus(jobId: string): Promise<FaceAnalysisStatus> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/face-analysis/${jobId}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch face analysis status (${response.status}): ${text}`);
  }
  return response.json() as Promise<FaceAnalysisStatus>;
}
