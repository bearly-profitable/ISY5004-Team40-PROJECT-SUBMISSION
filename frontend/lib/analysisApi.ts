import type {
  Explanation,
  NormSignals,
  Photo,
  PreferenceState,
  SearchResult,
  SessionSummary,
} from '../types';
import { supabase } from './supabase';

const BACKEND_BASE_URL = ((import.meta.env.VITE_BACKEND_URL as string | undefined) || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const API_KEY = (import.meta.env.VITE_API_KEY as string | undefined) ?? '';

/** Stable anonymous id for preference learning, persisted in localStorage. */
export function getClientId(): string {
  const KEY = 'lumina-client-id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

/** Signed in, requests also carry the Supabase access token, so the backend
 *  files sessions and learned taste under the account instead of the browser. */
async function apiHeaders(json = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'X-Client-Id': getClientId() };
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

async function requireOk(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.detail ?? '';
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(`${what} failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return response;
}

type AnalyzeEvent = {
  id: string;
  label: string;
  autoLabel?: { label: string | null; confidence: number; source?: 'clip' | 'vision'; model?: string } | null;
  caption?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  dateLabel?: string | null;
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
    normSignals?: NormSignals;
    explanation?: Explanation;
    flags?: Array<'duplicate' | 'blurry' | 'eyes_closed' | 'low_quality'>;
    duplicateOf?: string;
  }>;
  bestByPerson?: Array<{
    personId: string;
    photoId: string;
    score: number;
    numCandidates: number;
    explanation?: Explanation;
  }>;
  mmrPicks?: Partial<Record<'safe' | 'balanced' | 'diverse', string[]>>;
  userPinned?: boolean;
};

type AnalyzeIdentity = {
  id: string;
  label: string;
  faceThumb?: string | null;
  photoIds: string[];
  eventIds: string[];
  faceBoxes?: Record<string, [number, number, number, number]>;
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
    clipModel?: string | null;
    identityMode?: string;
    cacheHits?: number;
    cacheMisses?: number;
    timings?: Record<string, number>;
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
  imagesDone?: number | null;
  imagesTotal?: number | null;
  error?: string | null;
  result?: AnalyzeResult | null;
};

/** SSE endpoint for live progress (EventSource-compatible). */
export function analysisStreamUrl(jobId: string): string {
  return `${BACKEND_BASE_URL}/api/analyze/${jobId}/stream`;
}

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
    headers: await apiHeaders(),
    body: form,
  });
  await requireOk(response, 'Start analysis');

  const payload = await response.json() as AnalyzeStartResponse;
  return payload.jobId;
}

export async function getAnalysisStatus(jobId: string): Promise<AnalyzeStatus> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/analyze/${jobId}`, {
    headers: await apiHeaders(),
  });
  await requireOk(response, 'Fetch analysis status');
  return response.json() as Promise<AnalyzeStatus>;
}

// ---------------------------------------------------------------------------
// Sessions (persisted analyses)
// ---------------------------------------------------------------------------

export async function listSessions(): Promise<SessionSummary[]> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/sessions`, {
    headers: await apiHeaders(),
  });
  await requireOk(response, 'List sessions');
  const payload = await response.json() as { sessions: SessionSummary[] };
  return payload.sessions;
}

/** After sign-in: move this browser's anonymous sessions and taste into the account. */
export async function claimAnonymousData(): Promise<{ sessions: number; feedback: number; preferences: number }> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/account/claim`, {
    method: 'POST',
    headers: await apiHeaders(),
  });
  await requireOk(response, 'Move sessions to your account');
  return response.json();
}

export type SessionDetail = {
  jobId: string;
  createdAt: number;
  result: AnalyzeResult;
  photos: Array<{ id: string; name: string }>;
  /** Photos in this session that already have an AI-enhanced version on disk. */
  enhancedPhotoIds?: string[];
};

/** Permanently remove a stored session (DB row + photos on disk). */
export async function deleteSession(jobId: string): Promise<void> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/sessions/${jobId}`, {
    method: 'DELETE',
    headers: await apiHeaders(),
  });
  await requireOk(response, 'Delete session');
}

export async function getSession(jobId: string): Promise<SessionDetail> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/sessions/${jobId}`, {
    headers: await apiHeaders(),
  });
  await requireOk(response, 'Load session');
  return response.json() as Promise<SessionDetail>;
}

/** URL that serves a stored photo straight from the backend job directory.
 *  Pass `width` (200 | 400 | 800 | 1920) for a cached thumbnail instead of the original. */
export function sessionPhotoUrl(jobId: string, photoId: string, width?: 200 | 400 | 800 | 1920): string {
  const base = `${BACKEND_BASE_URL}/api/photos/${jobId}/${encodeURIComponent(photoId)}`;
  return width ? `${base}?w=${width}` : base;
}

// ---------------------------------------------------------------------------
// CLIP cross-modal search
// ---------------------------------------------------------------------------

export async function searchPhotos(
  jobId: string,
  query: string,
  topK = 12,
  personId?: string | null,
): Promise<SearchResult[]> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/search/${jobId}`, {
    method: 'POST',
    headers: await apiHeaders(true),
    body: JSON.stringify({ query, topK, personId: personId ?? null }),
  });
  await requireOk(response, 'Search');
  const payload = await response.json() as { results: SearchResult[] };
  return payload.results;
}

// ---------------------------------------------------------------------------
// Feedback + preference learning
// ---------------------------------------------------------------------------

export async function submitFeedback(
  jobId: string,
  eventId: string,
  winnerPhotoId: string,
  loserPhotoId: string,
): Promise<{ weights: NormSignals; nUpdates: number }> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/feedback`, {
    method: 'POST',
    headers: await apiHeaders(true),
    body: JSON.stringify({ jobId, eventId, winnerPhotoId, loserPhotoId }),
  });
  await requireOk(response, 'Submit feedback');
  return response.json();
}

export async function getPreferences(): Promise<PreferenceState> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/preferences`, {
    headers: await apiHeaders(),
  });
  await requireOk(response, 'Load preferences');
  return response.json() as Promise<PreferenceState>;
}

/** Hand-tuned weights; the server normalises them to sum to 1. */
export async function setPreferenceWeights(weights: NormSignals): Promise<PreferenceState> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/preferences`, {
    method: 'PUT',
    headers: await apiHeaders(true),
    body: JSON.stringify({ weights }),
  });
  await requireOk(response, 'Save preferences');
  return response.json() as Promise<PreferenceState>;
}

export async function resetPreferences(): Promise<void> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/preferences/reset`, {
    method: 'POST',
    headers: await apiHeaders(),
  });
  await requireOk(response, 'Reset preferences');
}

export type RescoreResult = {
  weights: NormSignals;
  nUpdates: number;
  events: Array<{
    eventId: string;
    topPhotoId: string | null;
    ranking: Array<{ photoId: string; finalScore: number }>;
  }>;
};

export async function rescoreWithPreferences(jobId: string): Promise<RescoreResult> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/rescore/${jobId}`, {
    method: 'POST',
    headers: await apiHeaders(),
  });
  await requireOk(response, 'Personalised rescore');
  return response.json() as Promise<RescoreResult>;
}

// ---------------------------------------------------------------------------
// Cluster corrections
// ---------------------------------------------------------------------------

export type CorrectionAction =
  | { action: 'rename_person'; personId: string; label: string }
  | { action: 'merge_persons'; personId: string; targetPersonId: string }
  | { action: 'move_photo'; photoId: string; personId?: string; targetPersonId: string }
  | { action: 'set_best'; eventId: string; photoId: string }
  | { action: 'rename_event'; eventId: string; label: string }
  | { action: 'delete_event'; eventId: string };

export async function applyCorrection(jobId: string, correction: CorrectionAction): Promise<AnalyzeResult> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/corrections/${jobId}`, {
    method: 'POST',
    headers: await apiHeaders(true),
    body: JSON.stringify(correction),
  });
  await requireOk(response, 'Apply correction');
  const payload = await response.json() as { result: AnalyzeResult };
  return payload.result;
}

// ---------------------------------------------------------------------------
// Album export
// ---------------------------------------------------------------------------

export async function exportAlbum(jobId: string, photoIds: string[], albumName: string): Promise<void> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/export/${jobId}`, {
    method: 'POST',
    headers: await apiHeaders(true),
    body: JSON.stringify({ photoIds, albumName }),
  });
  await requireOk(response, 'Export album');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${albumName || 'lumina-album'}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
    headers: await apiHeaders(),
    body: form,
  });
  await requireOk(response, 'Start face analysis');
  const payload = await response.json() as { jobId: string };
  return payload.jobId;
}

export async function getFaceAnalysisStatus(jobId: string): Promise<FaceAnalysisStatus> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/face-analysis/${jobId}`, {
    headers: await apiHeaders(),
  });
  await requireOk(response, 'Fetch face analysis status');
  return response.json() as Promise<FaceAnalysisStatus>;
}

// ---------------------------------------------------------------------------
// AI enhancement (OpenRouter image edit, identity-verified server-side)
// ---------------------------------------------------------------------------

export type EnhanceStyle = 'natural' | 'polished';

export type EnhanceStatus = {
  enhanceId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  jobId: string;
  photoId: string;
  error?: string | null;
  warning?: string | null;
  identityScore?: number | null;
  numFaces?: number | null;
  costUsd?: number | null;
  model?: string | null;
  url?: string | null;
};

export async function startEnhance(
  jobId: string,
  photoId: string,
  style: EnhanceStyle = 'natural',
): Promise<string> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/enhance`, {
    method: 'POST',
    headers: await apiHeaders(true),
    body: JSON.stringify({ jobId, photoId, style }),
  });
  await requireOk(response, 'Start enhancement');
  const payload = await response.json() as { enhanceId: string };
  return payload.enhanceId;
}

export async function getEnhanceStatus(enhanceId: string): Promise<EnhanceStatus> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/enhance/${enhanceId}`, {
    headers: await apiHeaders(),
  });
  await requireOk(response, 'Fetch enhancement status');
  return response.json() as Promise<EnhanceStatus>;
}

/** Poll until the enhancement finishes. Rejects with the server's message on failure. */
export async function enhancePhoto(
  jobId: string,
  photoId: string,
  style: EnhanceStyle = 'natural',
  signal?: AbortSignal,
): Promise<EnhanceStatus> {
  const enhanceId = await startEnhance(jobId, photoId, style);
  // Image edits take ~20-60s; poll for up to 5 minutes.
  for (let i = 0; i < 150; i += 1) {
    if (signal?.aborted) throw new Error('Enhancement cancelled.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await getEnhanceStatus(enhanceId);
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new Error(status.error || 'Enhancement failed.');
  }
  throw new Error('Enhancement timed out.');
}

/** `v` busts the browser cache after a re-enhance of the same photo. */
/** Fetch a photo (session or enhanced) as a blob, with the API's auth headers. */
export async function fetchMediaBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { headers: url.startsWith('blob:') ? undefined : await apiHeaders(), signal });
  await requireOk(response, 'Load photo');
  return response.blob();
}

export function enhancedPhotoUrl(jobId: string, photoId: string, v?: number): string {
  const base = `${BACKEND_BASE_URL}/api/enhanced/${jobId}/${encodeURIComponent(photoId)}`;
  return v ? `${base}?v=${v}` : base;
}

export async function deleteEnhanced(jobId: string, photoId: string): Promise<void> {
  const response = await fetch(
    `${BACKEND_BASE_URL}/api/enhanced/${jobId}/${encodeURIComponent(photoId)}`,
    { method: 'DELETE', headers: await apiHeaders() },
  );
  await requireOk(response, 'Remove enhancement');
}

// ---------------------------------------------------------------------------
// PDF collage export
// ---------------------------------------------------------------------------

export type CollageTheme = {
  key: string;
  name: string;
  dark: boolean;
  swatch: [string, string, string];
  /** Full palette, so the viewer can restyle a plan without refetching it. */
  bgTop: string;
  bgBottom: string;
  ink: string;
  muted: string;
  accent: string;
  frame: string;
  grain: number;
  serif: boolean;
  shadowAlpha: number;
  /** Pure paper: no gradient, no grain, no shadow, square corners. */
  flat: boolean;
};

/** One of Lumi's colourways. `hue`/`saturate` are CSS filter values — the
 *  backend recolours with the same matrices, so the web and PDF match. */
export type CharacterOutfit = { key: string; name: string; hue: number; saturate: number };

export async function getCollageThemes(): Promise<{
  themes: CollageTheme[];
  default: string;
  aiTitles: boolean;
  aiCaptions?: boolean;
  characterOutfits?: CharacterOutfit[];
}> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/collage/themes`, {
    headers: await apiHeaders(),
  });
  await requireOk(response, 'Load collage themes');
  return response.json();
}

export type CollageOptions = {
  photoIds: string[];
  title?: string;
  subtitle?: string;
  theme?: string;
  autoTitle?: boolean;
  captions?: boolean;
  aiCaptions?: boolean;
  useEnhanced?: boolean;
  chapters?: boolean;
  cast?: boolean;
  character?: boolean;
  characterOutfit?: string;
};

export async function downloadCollage(jobId: string, options: CollageOptions): Promise<void> {
  const response = await fetch(`${BACKEND_BASE_URL}/api/collage/${jobId}`, {
    method: 'POST',
    headers: await apiHeaders(true),
    body: JSON.stringify(options),
  });
  await requireOk(response, 'Build collage');

  const blob = await response.blob();
  // Prefer the server's filename (it reflects an AI-generated title).
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] || `${options.title || 'lumina-album'}.pdf`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
