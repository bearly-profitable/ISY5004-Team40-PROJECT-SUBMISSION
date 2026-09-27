
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface CarouselImage {
  url: string;
  label?: string;
}

interface GlassCarouselProps {
  images: CarouselImage[];
  autoPlay?: boolean;
  interval?: number;
  aspectRatio?: string;
  showDots?: boolean;
  showArrows?: boolean;
  className?: string;
  rounded?: string;
}

export const GlassCarousel: React.FC<GlassCarouselProps> = ({
  images,
  autoPlay = true,
  interval = 5000,
  aspectRatio = '16/9',
  showDots = true,
  showArrows = true,
  className = '',
  rounded = 'rounded-2xl',
}) => {
  const [current, setCurrent] = useState(0);
  const [loadedImages, setLoadedImages] = useState<Set<number>>(new Set());
  const touchStartX = useRef(0);
  const touchDeltaX = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const resetTimer = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoPlay && images.length > 1) {
      intervalRef.current = setInterval(() => {
        setCurrent((p) => (p + 1) % images.length);
      }, interval);
    }
  }, [autoPlay, interval, images.length]);

  useEffect(() => {
    resetTimer();
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [resetTimer]);

  const goTo = (i: number) => { setCurrent(i); resetTimer(); };
  const next = () => { setCurrent((p) => (p + 1) % images.length); resetTimer(); };
  const prev = () => { setCurrent((p) => (p - 1 + images.length) % images.length); resetTimer(); };

  const onTouchStart = (e: React.TouchEvent) => { touchStartX.current = e.touches[0].clientX; };
  const onTouchMove = (e: React.TouchEvent) => { touchDeltaX.current = e.touches[0].clientX - touchStartX.current; };
  const onTouchEnd = () => {
    if (Math.abs(touchDeltaX.current) > 50) {
      touchDeltaX.current > 0 ? prev() : next();
    }
    touchDeltaX.current = 0;
  };

  if (images.length === 0) return null;
  // The list can shrink under us (a filter); never sit past its end.
  const shown = current % images.length;

  return (
    <div
      className={`carousel-container liquid-glass-heavy glass-prismatic ${rounded} ${className}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div style={{ aspectRatio }}>
        <div
          className="carousel-track h-full"
          style={{
            width: `${images.length * 100}%`,
            transform: `translateX(-${(shown * 100) / images.length}%)`,
          }}
        >
          {images.map((img, i) => (
            <div
              key={i}
              className="relative h-full"
              style={{ width: `${100 / images.length}%` }}
            >
              {!loadedImages.has(i) && (
                <div className="absolute inset-0 skeleton" />
              )}
              <img
                src={img.url}
                alt={img.label || `Slide ${i + 1}`}
                className={`w-full h-full object-cover transition-opacity duration-300 ${loadedImages.has(i) ? '' : 'opacity-0'}`}
                loading="lazy"
                decoding="async"
                onLoad={() => setLoadedImages((prev) => new Set(prev).add(i))}
              />
              {/* Inactive slide overlay */}
              <div
                className="absolute inset-0 bg-black/20 transition-opacity duration-700"
                style={{ opacity: i === shown ? 0 : 1 }}
              />
              {img.label && (
                <div className="absolute bottom-0 inset-x-0 p-6 bg-gradient-to-t from-black/70 via-black/25 to-transparent">
                  <span className="text-white font-semibold text-lg drop-shadow-lg">{img.label}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Arrows */}
      {showArrows && images.length > 1 && (
        <>
          <button
            onClick={prev}
            className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full liquid-glass flex items-center justify-center text-white transition-all duration-300 hover:scale-110 hover:bg-white/20"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={next}
            className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full liquid-glass flex items-center justify-center text-white transition-all duration-300 hover:scale-110 hover:bg-white/20"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </>
      )}

      {/* Dots */}
      {showDots && images.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 carousel-dots liquid-glass rounded-full px-3 py-2">
          {images.map((_, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              className={`carousel-dot ${i === shown ? 'active' : ''}`}
            />
          ))}
        </div>
      )}
    </div>
  );
};
