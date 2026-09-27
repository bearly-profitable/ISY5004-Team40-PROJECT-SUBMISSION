import { loadFont as loadFraunces } from '@remotion/google-fonts/Fraunces';
import { loadFont as loadNunito } from '@remotion/google-fonts/Nunito';

// Lumina's own type pair: Fraunces for display, Nunito for text.
export const display = loadFraunces('normal', { weights: ['600', '700', '800'], subsets: ['latin'] }).fontFamily;
export const text = loadNunito('normal', { weights: ['600', '700', '800', '900'], subsets: ['latin'] }).fontFamily;
