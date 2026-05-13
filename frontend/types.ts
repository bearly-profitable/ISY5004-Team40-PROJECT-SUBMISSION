
export interface Photo {
  id: string;
  url: string;
  name: string;
  size: string;
  source?: 'drive' | 'local';
}

export interface Cluster {
  id: string;
  label: string;
  photos: Photo[];
  topPhotoId: string;
  faceThumb?: string | null;
}

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
}

export interface Event {
  id: string;
  label: string;
  photoIds: string[];
  topPhotoId: string;
  persons: string[];
  members: EventMember[];
  photos: Photo[];
}

export interface Identity {
  id: string;
  label: string;
  faceThumb?: string | null;
  photoIds: string[];
  eventIds: string[];
}

export enum AppStep {
  LANDING = 'landing',
  DRIVE_VIEW = 'drive-view',
  PROCESSING = 'processing',
  GALLERY = 'gallery',
  FACE_ANALYSIS = 'face-analysis'
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
