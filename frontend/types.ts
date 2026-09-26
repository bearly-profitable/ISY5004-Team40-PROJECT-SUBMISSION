
export interface Photo {
  id: string;
  url: string;
  /** Full-resolution URL when `url` is a thumbnail. */
  fullUrl?: string;
  /** A sharper thumbnail for large tiles (hero shots). */
  largeUrl?: string;
  name: string;
  size: string;
  source?: 'local' | 'session';
}

export interface Cluster {
  id: string;
  label: string;
  photos: Photo[];
  topPhotoId: string;
  faceThumb?: string | null;
}

export type SignalKey =
  | 'centrality'
  | 'nimaScore'
  | 'faceSharpness'
  | 'faceSize'
  | 'detScore'
  | 'poseQuality'
  | 'ear';

export type NormSignals = Record<SignalKey, number>;

export interface ExplanationReason {
  signal: SignalKey;
  label: string;
  detail: string;
  strength: number;
}

export interface Explanation {
  summary: string;
  reasons: ExplanationReason[];
}

export type RejectFlag = 'duplicate' | 'blurry' | 'eyes_closed' | 'low_quality';

export interface EventMember {
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
  flags?: RejectFlag[];
  duplicateOf?: string;
}

export interface BestByPerson {
  personId: string;
  photoId: string;
  score: number;
  numCandidates: number;
  explanation?: Explanation;
}

export type MmrMode = 'safe' | 'balanced' | 'diverse';

export interface EventAutoLabel {
  /** Scene word ("Beach") that picks Lumi's outfit; null if none fits. */
  label: string | null;
  confidence: number;
  /** 'vision' when a vision LLM wrote the event's title; CLIP otherwise. */
  source?: 'clip' | 'vision';
  model?: string;
}

export interface Event {
  id: string;
  label: string;
  autoLabel?: EventAutoLabel | null;
  caption?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  dateLabel?: string | null;
  photoIds: string[];
  topPhotoId: string;
  persons: string[];
  members: EventMember[];
  bestByPerson?: BestByPerson[];
  mmrPicks?: Partial<Record<MmrMode, string[]>>;
  userPinned?: boolean;
  photos: Photo[];
}

/** Normalised [x1, y1, x2, y2] face box, 0..1 fractions of the image. */
export type FaceBox = [number, number, number, number];

export interface Identity {
  id: string;
  label: string;
  faceThumb?: string | null;
  photoIds: string[];
  eventIds: string[];
  /** photoId -> this person's face location in that photo */
  faceBoxes?: Record<string, FaceBox>;
}

export interface SessionSummary {
  jobId: string;
  createdAt: number;
  numPhotos: number;
  summary?: {
    numPhotos: number;
    numEvents: number;
    numIdentities: number;
  } | null;
  topPhotoId?: string | null;
}

export interface SearchResult {
  photoId: string;
  score: number;
}

export interface PreferenceState {
  weights: NormSignals;
  defaultWeights: NormSignals;
  nUpdates: number;
  feedbackCount?: number;
}

export enum AppStep {
  LANDING = 'landing',
  UPLOAD = 'upload',
  PROCESSING = 'processing',
  GALLERY = 'gallery',
  FACE_ANALYSIS = 'face-analysis',
  SESSIONS = 'sessions',
  PROFILE = 'profile'
}

export interface FaceMetrics {
  symmetry: number;
  proportions: number;
  skinQuality: number;
  eyeScore: number;
  noseScore: number;
  lipScore: number;
  jawlineScore: number;
  overall: number;
}

export interface FaceResult {
  faceIndex: number;
  bbox: [number, number, number, number];
  faceCrop: string;            // base64 data URL
  metrics: FaceMetrics;
  landmarks?: number[][];      // optional landmark coords for overlay
}

export interface FaceAnalysisResult {
  imageWidth: number;
  imageHeight: number;
  faces: FaceResult[];
}
