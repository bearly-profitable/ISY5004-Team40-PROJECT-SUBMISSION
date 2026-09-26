import type { LumiPose } from '../components/Lumi';
import type { EnhanceStyle } from './analysisApi';

/** Mirrors public.profiles (supabase/migrations). */
export interface Profile {
  id: string;
  display_name: string | null;
  tagline: string | null;
  avatar_pose: LumiPose;
  avatar_bg: AvatarBg;
  avatar_url: string | null;
  accent: Accent;
  lumi_outfit: Outfit;
  collage_theme: string;
  enhance_style: EnhanceStyle;
  created_at: string;
  updated_at: string;
}

export type ProfilePatch = Partial<Omit<Profile, 'id' | 'created_at' | 'updated_at'>>;

export type Accent = 'lumi' | 'rose' | 'mint' | 'honey' | 'ocean';
export type Outfit = 'classic' | 'mint' | 'honey' | 'ocean';
export type AvatarBg = 'lavender' | 'rose' | 'peach' | 'mint' | 'sky' | 'sunset' | 'night' | 'cream';

/** App-wide accent themes; the colours themselves live in index.css (1b). */
export const ACCENTS: Array<{ key: Accent; name: string; blurb: string; swatch: [string, string, string] }> = [
  { key: 'lumi', name: 'Lumi', blurb: 'Lavender hood, peachy glow', swatch: ['#9d88d4', '#e38c9e', '#f3ad7f'] },
  { key: 'rose', name: 'Rose', blurb: 'Warm and a little romantic', swatch: ['#d6567a', '#e67896', '#f3ad7f'] },
  { key: 'mint', name: 'Mint', blurb: 'Fresh, like a garden morning', swatch: ['#3fae8f', '#6cc4a8', '#b5d98a'] },
  { key: 'honey', name: 'Honey', blurb: 'Golden hour, all day', swatch: ['#d9962a', '#eea06c', '#f5c46a'] },
  { key: 'ocean', name: 'Ocean', blurb: 'Cool blues for beach days', swatch: ['#4a80d9', '#6aa3e8', '#7fd1d8'] },
];

/** Lumi's colourways: same hue/saturate as backend/mascot.py OUTFITS. */
export const OUTFITS: Array<{ key: Outfit; name: string; hue: number }> = [
  { key: 'classic', name: 'Classic', hue: 0 },
  { key: 'mint', name: 'Mint', hue: -120 },
  { key: 'honey', name: 'Honey', hue: 25 },
  { key: 'ocean', name: 'Ocean', hue: 210 },
];

export const AVATAR_BGS: Array<{ key: AvatarBg; name: string; css: string }> = [
  { key: 'lavender', name: 'Lavender', css: 'linear-gradient(145deg, #e4dbf7 0%, #c4b4e6 100%)' },
  { key: 'rose', name: 'Rose', css: 'linear-gradient(145deg, #fbe2e8 0%, #eea5b6 100%)' },
  { key: 'peach', name: 'Peach', css: 'linear-gradient(145deg, #fdeee2 0%, #f5bd95 100%)' },
  { key: 'mint', name: 'Mint', css: 'linear-gradient(145deg, #dcf5ea 0%, #93d6bd 100%)' },
  { key: 'sky', name: 'Sky', css: 'linear-gradient(145deg, #e2eefc 0%, #a3c6f0 100%)' },
  { key: 'sunset', name: 'Sunset', css: 'linear-gradient(145deg, #c9b3ef 0%, #eea5b6 50%, #f7c99a 100%)' },
  { key: 'night', name: 'Night', css: 'linear-gradient(145deg, #3f3262 0%, #1d1830 100%)' },
  { key: 'cream', name: 'Cream', css: 'linear-gradient(145deg, #fffaf4 0%, #f1e6da 100%)' },
];

/** Poses that read well cropped into a round badge. */
export const AVATAR_POSES: LumiPose[] = [
  'wave', 'idle', 'star', 'celebrate', 'camera', 'hug', 'present', 'think',
  'sleepy', 'point', 'travel', 'beach', 'cafe', 'garden', 'birthday', 'night',
];

export const avatarBgCss = (key: string | null | undefined): string =>
  (AVATAR_BGS.find((b) => b.key === key) ?? AVATAR_BGS[0]).css;

// ---------------------------------------------------------------------------
// Applying the look. Cached locally so a returning user doesn't see the
// default lavender flash in before their profile loads.
// ---------------------------------------------------------------------------

const LOOK_KEY = 'lumina-look';

export function applyLook(accent: Accent = 'lumi', outfit: Outfit = 'classic'): void {
  const root = document.documentElement;
  root.dataset.accent = accent;
  root.dataset.outfit = outfit;
  try { localStorage.setItem(LOOK_KEY, JSON.stringify({ accent, outfit })); } catch { /* private mode */ }
}

export function applyCachedLook(): void {
  try {
    const raw = localStorage.getItem(LOOK_KEY);
    if (!raw) return;
    const { accent, outfit } = JSON.parse(raw) as { accent?: Accent; outfit?: Outfit };
    applyLook(accent, outfit);
  } catch { /* ignore */ }
}

export const firstName = (profile: Profile | null, fallback = 'friend'): string =>
  profile?.display_name?.trim().split(/\s+/)[0] || fallback;
