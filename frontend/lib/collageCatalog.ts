import type { CharacterOutfit, CollageTheme } from './analysisApi';

/** Mirrors backend/mascot.py OUTFITS, for when the themes fetch fails. */
export const FALLBACK_CHARACTER_OUTFITS: CharacterOutfit[] = [
  { key: 'classic', name: 'Classic', hue: 0, saturate: 1 },
  { key: 'mint', name: 'Mint', hue: -120, saturate: 1 },
  { key: 'honey', name: 'Honey', hue: 25, saturate: 1 },
  { key: 'ocean', name: 'Ocean', hue: 210, saturate: 1 },
];

/** Mirrors backend/collage.py THEMES so the picker still works if the fetch
 *  fails. Keep in step with the server; it is the source. */
export const FALLBACK_COLLAGE_THEMES: CollageTheme[] = [
  {
    key: 'lumi', name: 'Lumi', dark: false, serif: true,
    swatch: ['#fdf6f3', '#d66f86', '#3a2d4d'],
    bgTop: '#fdf6f3', bgBottom: '#efe6f7', ink: '#3a2d4d', muted: '#8e7ea3',
    accent: '#d66f86', frame: '#ecdff1', grain: 0.06, shadowAlpha: 0.16, flat: false,
  },
  {
    key: 'midnight', name: 'Midnight', dark: true, serif: true,
    swatch: ['#141824', '#d8b26a', '#f4f6fb'],
    bgTop: '#141824', bgBottom: '#070910', ink: '#f4f6fb', muted: '#8b95ac',
    accent: '#d8b26a', frame: '#2b3243', grain: 0.5, shadowAlpha: 0.4, flat: false,
  },
  {
    key: 'ivory', name: 'Ivory', dark: false, serif: true,
    swatch: ['#fcfaf7', '#b0814f', '#1b1a18'],
    bgTop: '#fcfaf7', bgBottom: '#efe9df', ink: '#1b1a18', muted: '#8c8478',
    accent: '#b0814f', frame: '#e2dacd', grain: 0.2, shadowAlpha: 0.16, flat: false,
  },
  {
    key: 'blush', name: 'Blush', dark: false, serif: false,
    swatch: ['#fdf3f2', '#d97b8c', '#40282d'],
    bgTop: '#fdf3f2', bgBottom: '#f6dfe4', ink: '#40282d', muted: '#a57883',
    accent: '#d97b8c', frame: '#f1d1d7', grain: 0.16, shadowAlpha: 0.16, flat: false,
  },
  {
    key: 'mono', name: 'Mono', dark: false, serif: false,
    swatch: ['#ffffff', '#0a0a0a', '#0a0a0a'],
    bgTop: '#ffffff', bgBottom: '#f1f1f1', ink: '#0a0a0a', muted: '#8c8c8c',
    accent: '#0a0a0a', frame: '#dddddd', grain: 0, shadowAlpha: 0.16, flat: false,
  },
  {
    key: 'forest', name: 'Forest', dark: true, serif: true,
    swatch: ['#16211c', '#9dc4a3', '#eef4ef'],
    bgTop: '#16211c', bgBottom: '#080e0b', ink: '#eef4ef', muted: '#87a094',
    accent: '#9dc4a3', frame: '#26362d', grain: 0.42, shadowAlpha: 0.4, flat: false,
  },
  {
    key: 'paper', name: 'Paper', dark: false, serif: false,
    swatch: ['#ffffff', '#e2542c', '#141414'],
    bgTop: '#ffffff', bgBottom: '#ffffff', ink: '#141414', muted: '#9a9a9a',
    accent: '#e2542c', frame: '#141414', grain: 0, shadowAlpha: 0, flat: true,
  },
];
