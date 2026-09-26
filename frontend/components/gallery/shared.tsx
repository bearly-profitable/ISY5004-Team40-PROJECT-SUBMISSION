import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, ImageOff, Sparkles, User } from 'lucide-react';
import type { FaceBox, Photo } from '../../types';
import type { EnhanceStyle } from '../../lib/analysisApi';
import { gsap, prefersReducedMotion } from '../../lib/motion';

/* ------------------------------------------------
   Enhancement state, shared with the cards

   Only the moment cards use it, so it travels by context instead of being
   prop-drilled through every view.
   ------------------------------------------------ */
export interface EnhanceEntry {
  url: string;
  identityScore?: number | null;
  warning?: string | null;
}

export interface EnhanceContextValue {
  enabled: boolean;
  entries: Record<string, EnhanceEntry>;
  pending: Record<string, boolean>;
  showOriginal: Record<string, boolean>;
  enhance: (photoId: string, style?: EnhanceStyle) => void;
  revert: (photoId: string) => void;
  toggleOriginal: (photoId: string) => void;
}

export const EnhanceContext = React.createContext<EnhanceContextValue>({
  enabled: false,
  entries: {},
  pending: {},
  showOriginal: {},
  enhance: () => {},
  revert: () => {},
  toggleOriginal: () => {},
});

export const useEnhance = () => React.useContext(EnhanceContext);

/* ------------------------------------------------
   Focal points: where the faces are in each photo (0..1 fractions), so
   cropped tiles keep heads in frame instead of cutting them off.
   ------------------------------------------------ */
export type Focal = [number, number];
export const FocalContext = React.createContext<Map<string, Focal>>(new Map());
export const useFocal = (photoId: string): Focal | undefined => React.useContext(FocalContext).get(photoId);

/** Centre of all the face boxes found in each photo. */
export function focalPoints(identities: Array<{ faceBoxes?: Record<string, FaceBox> }>): Map<string, Focal> {
  const sums = new Map<string, { x: number; y: number; n: number }>();
  for (const person of identities) {
    for (const [photoId, [x1, y1, x2, y2]] of Object.entries(person.faceBoxes ?? {})) {
      const s = sums.get(photoId) ?? { x: 0, y: 0, n: 0 };
      s.x += (x1 + x2) / 2;
      s.y += (y1 + y2) / 2;
      s.n += 1;
      sums.set(photoId, s);
    }
  }
  const out = new Map<string, Focal>();
  sums.forEach((s, id) => out.set(id, [s.x / s.n, s.y / s.n]));
  return out;
}

export const focalStyle = (focal?: Focal): React.CSSProperties | undefined =>
  focal ? { objectPosition: `${(focal[0] * 100).toFixed(1)}% ${(focal[1] * 100).toFixed(1)}%` } : undefined;

/* ------------------------------------------------
   Downloads
   ------------------------------------------------ */

/** Save a file under its own name. `<a download>` is ignored cross-origin
 *  (the browser would navigate away to the image), so fetch it into a blob. */
export async function downloadUrl(url: string, name: string): Promise<void> {
  let href = url;
  let revoke = false;
  if (!url.startsWith('blob:')) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        href = URL.createObjectURL(await response.blob());
        revoke = true;
      }
    } catch {
      // Fall back to opening the file; the browser can still save it.
    }
  }
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  if (!revoke && !href.startsWith('blob:')) a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export function downloadPhoto(photo: Photo, index = 0): Promise<void> {
  return downloadUrl(photo.fullUrl ?? photo.url, photo.name?.trim() || `photo-${index + 1}.jpg`);
}

/* ------------------------------------------------
   Toasts (portaled so ancestor transforms can never trap them)
   ------------------------------------------------ */
export type Toast = { id: number; message: string; kind: 'success' | 'error' | 'info' };

export const ToastStack: React.FC<{ toasts: Toast[] }> = ({ toasts }) => createPortal(
  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[400] flex flex-col items-center gap-2 pointer-events-none w-[calc(100%-2rem)] sm:w-auto">
    {toasts.map((toast) => (
      <div
        key={toast.id}
        className="rounded-2xl bg-slate-900/90 text-white backdrop-blur-md px-4 py-2.5 shadow-xl shadow-black/20 flex items-center gap-2.5 text-sm font-semibold max-w-full"
        data-anim="fade-up"
      >
        {toast.kind === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-300 flex-shrink-0" />}
        {toast.kind === 'error' && <AlertTriangle className="w-4 h-4 text-red-300 flex-shrink-0" />}
        {toast.kind === 'info' && <Sparkles className="w-4 h-4 text-lumina-300 flex-shrink-0" />}
        <span className="min-w-0">{toast.message}</span>
      </div>
    ))}
  </div>,
  document.body,
);

/* ------------------------------------------------
   Img — a photo that fades in once its pixels have actually arrived.

   The box around it always has its final size (tiles set an aspect ratio),
   so a slow image never shifts the layout, and a failed one shows an icon
   instead of an endless skeleton.
   ------------------------------------------------ */
interface ImgProps {
  src: string;
  alt: string;
  className?: string;
  /** Above-the-fold images load immediately and at high priority. */
  eager?: boolean;
  onAspect?: (aspect: number) => void;
  draggable?: boolean;
  focal?: Focal;
}

export const Img: React.FC<ImgProps> = ({ src, alt, className = '', eager, onAspect, draggable = false, focal }) => {
  const ref = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  const onAspectRef = useRef(onAspect);
  onAspectRef.current = onAspect;

  const reveal = (img: HTMLImageElement) => {
    if (img.dataset.shown === src) return;
    img.dataset.shown = src;
    if (img.naturalHeight > 0) onAspectRef.current?.(img.naturalWidth / img.naturalHeight);
    if (prefersReducedMotion()) {
      gsap.set(img, { opacity: 1 });
      return;
    }
    gsap.fromTo(img, { opacity: 0, scale: 1.045 }, {
      opacity: 1, scale: 1, duration: 0.65, ease: 'power2.out', clearProps: 'transform',
    });
  };

  // New source: hide until it loads. A cached image may already be complete
  // before React attaches onLoad, so check for that too.
  useLayoutEffect(() => {
    const img = ref.current;
    if (!img) return;
    setFailed(false);
    delete img.dataset.shown;
    gsap.set(img, { opacity: 0 });
    if (img.complete && img.naturalWidth > 0) reveal(img);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  return (
    <>
      <img
        ref={ref}
        src={src}
        alt={alt}
        draggable={draggable}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={eager ? 'high' : 'auto'}
        className={`g-img ${className}`}
        style={focalStyle(focal)}
        onLoad={(e) => reveal(e.currentTarget)}
        onError={() => setFailed(true)}
      />
      {failed && (
        <span className="absolute inset-0 flex items-center justify-center text-slate-300" aria-hidden>
          <ImageOff className="w-6 h-6" />
        </span>
      )}
    </>
  );
};

/* ------------------------------------------------
   FaceRing — spotlight circle over a person's face.
   bbox is normalised [x1,y1,x2,y2]; the overlay replicates the image's
   object-fit: cover mapping, so it stays on the face at any tile size.
   ------------------------------------------------ */
export const FaceRing: React.FC<{ bbox: FaceBox; imageAspect: number | null; focal?: Focal }> = ({ bbox, imageAspect, focal }) => {
  const ref = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const [ring, setRing] = useState<{ left: number; top: number; size: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !imageAspect) return;
    const compute = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (!cw || !ch) return;
      const ca = cw / ch;
      const dispW = imageAspect > ca ? ch * imageAspect : cw;
      const dispH = imageAspect > ca ? ch : cw / imageAspect;
      // Matches the image's object-position (centred unless it has a focal point).
      const offX = (cw - dispW) * (focal?.[0] ?? 0.5);
      const offY = (ch - dispH) * (focal?.[1] ?? 0.5);
      const [x1, y1, x2, y2] = bbox;
      const cx = offX + ((x1 + x2) / 2) * dispW;
      const cy = offY + ((y1 + y2) / 2) * dispH;
      const size = Math.max((x2 - x1) * dispW, (y2 - y1) * dispH) * 1.6;
      setRing({ left: cx - size / 2, top: cy - size / 2, size });
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bbox, imageAspect, focal]);

  useEffect(() => {
    if (!ring || !ringRef.current || prefersReducedMotion()) return;
    gsap.fromTo(ringRef.current, { scale: 1.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: 'expo.out' });
  }, [ring === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!imageAspect) return null;
  return (
    <div ref={ref} className="absolute inset-0 pointer-events-none z-[3]">
      {ring && (
        <div
          ref={ringRef}
          className="absolute rounded-full"
          style={{
            left: ring.left,
            top: ring.top,
            width: ring.size,
            height: ring.size,
            border: '2px solid rgba(255,255,255,0.95)',
            boxShadow: '0 0 0 9999px rgba(23, 15, 31, 0.42), 0 0 18px rgba(255,255,255,0.5)',
          }}
        />
      )}
    </div>
  );
};

/* ------------------------------------------------
   Face avatar
   ------------------------------------------------ */
export const FaceAvatar: React.FC<{ faceThumb?: string | null; label: string; size?: 'xs' | 'sm' | 'md' }> = ({
  faceThumb, label, size = 'md',
}) => {
  const dim = size === 'md' ? 'w-12 h-12 sm:w-14 sm:h-14' : size === 'sm' ? 'w-9 h-9 sm:w-10 sm:h-10' : 'w-7 h-7';
  if (faceThumb) {
    return (
      <div className={`${dim} rounded-full overflow-hidden flex-shrink-0 bg-slate-100`}>
        <img src={faceThumb} alt={label} className="w-full h-full object-cover" draggable={false} />
      </div>
    );
  }
  return (
    <div className={`${dim} rounded-full flex-shrink-0 flex items-center justify-center bg-lumina-100`}>
      <User className="w-1/2 h-1/2 text-lumina-400" />
    </div>
  );
};
