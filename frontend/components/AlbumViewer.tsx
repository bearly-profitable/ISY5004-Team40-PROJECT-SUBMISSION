/**
 * The album, as a book you page through.
 *
 * Design decisions that matter:
 *
 * - **It renders the plan, not the PDF.** `/api/collage/{job}/plan` returns the
 *   geometry the ReportLab pass draws, so the flip-book and the download are
 *   the same album without rasterising anything or waiting for an export.
 * - **Everything is drawn at PDF point size and scaled once.** The page div is
 *   595x842pt (A4 landscape) and a single `transform: scale()` fits it to the
 *   viewport, so every child can use the planner's raw numbers. No unit maths,
 *   no rounding drift between the two renderers.
 * - **Spreads, not pages.** A photo album is a physical object; showing one
 *   page at a time loses that. The cover sits alone on the right, like a closed
 *   book, and content pages pair up from there.
 * - **The flip is one leaf with two faces.** A single absolutely-positioned
 *   element hinged at the spine carries the outgoing page on its front and the
 *   incoming page on its back, rotating through `rotateY`. The static halves
 *   underneath already show the destination spread, so when the leaf lands
 *   there is nothing to swap and no flash.
 * - **Reduced motion is honoured** — the leaf is skipped entirely and the
 *   spread cross-fades instead.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, Loader2, X, Check } from 'lucide-react';

import { enhancedPhotoUrl, sessionPhotoUrl, xiaoheiUrl } from '../lib/analysisApi';
import type {
  AlbumCharacter, AlbumPage, AlbumPlan, AlbumPortrait, AlbumTile, CollageTheme,
} from '../lib/analysisApi';

const FLIP_MS = 720;

/** Serif themes print in Times; Georgia is the closest thing a browser has. */
const SERIF_STACK = 'Georgia, "Times New Roman", Times, serif';
const SANS_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';

type Palette = AlbumPlan['theme'];

/* ------------------------------------------------------------------ *
   Helpers
 * ------------------------------------------------------------------ */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return reduced;
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Letter-spaced uppercase runs, the way the PDF sets its small labels. */
const tracked = (size: number, spacing: number): React.CSSProperties => ({
  fontFamily: SANS_STACK,
  fontSize: size,
  letterSpacing: spacing,
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
});

/** Mirrors `_gradient_background`: a vertical ramp, an accent glow bled in from
 *  the upper left, and film grain on the themes that ask for it. */
function pageBackground(theme: Palette): React.CSSProperties {
  // 小黑's style DNA forbids gradients, glows and texture outright, and the
  // Paper theme is built to honour it: one flat colour, nothing else.
  if (theme.flat) return { background: theme.bgTop };
  const layers = [
    `radial-gradient(60% 55% at 32% 2%, ${withAlpha(theme.accent, theme.dark ? 0.15 : 0.1)} 0%, transparent 70%)`,
    `linear-gradient(180deg, ${theme.bgTop} 0%, ${theme.bgBottom} 100%)`,
  ];
  return { backgroundImage: layers.join(', ') };
}

function grainOverlay(theme: Palette): React.CSSProperties | null {
  if (!theme.grain || theme.flat) return null;
  // feTurbulence gives the same broadband speckle as the Pillow noise pass,
  // without shipping a texture.
  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140">` +
      `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3"/></filter>` +
      `<rect width="140" height="140" filter="url(#n)"/></svg>`,
  );
  return {
    backgroundImage: `url("data:image/svg+xml,${svg}")`,
    opacity: 0.032 * theme.grain * 3,
    mixBlendMode: theme.dark ? 'screen' : 'multiply',
  };
}

function tileSrc(jobId: string, tile: AlbumTile): string {
  return tile.enhanced
    ? enhancedPhotoUrl(jobId, tile.photoId)
    : sessionPhotoUrl(jobId, tile.photoId, 800);
}

/** 小黑, fetched from the backend at the size he is drawn.
 *
 *  The PDF draws him in-process; the browser cannot run that code, so it asks
 *  for the same drawing over HTTP. He is requested at twice the page scale so
 *  he stays crisp when the spread is large. */
const Character: React.FC<{ theme: Palette; character: AlbumCharacter; scale: number }> = ({
  theme, character, scale,
}) => {
  const src = xiaoheiUrl(character.pose, {
    w: character.w * Math.max(1, scale) * 2,
    h: character.h * Math.max(1, scale) * 2,
    seed: character.seed,
    body: character.body,
    facing: character.facing,
    ink: theme.ink,
    eye: theme.bgTop,
  });
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      style={{
        position: 'absolute',
        left: character.x,
        top: character.top,
        width: character.w,
        height: character.h,
      }}
    />
  );
};

/** One face on the cast page, cropped to a circle around the face box. */
const Portrait: React.FC<{
  jobId: string; theme: Palette; portrait: AlbumPortrait;
}> = ({ jobId, theme, portrait }) => {
  // Mirror the backend crop: a square around the face with room for a head,
  // expressed as a background-position/size so the browser does the cropping.
  let position = '50% 42%';
  let size = 'cover';
  if (portrait.face?.length === 4) {
    const [x1, y1, x2, y2] = portrait.face;
    position = `${((x1 + x2) / 2) * 100}% ${((y1 + y2) / 2) * 100}%`;
    const span = Math.max(x2 - x1, y2 - y1) * 1.15 * 2;
    size = `${Math.max(100, 100 / Math.max(span, 0.05))}%`;
  }

  return (
    <div style={{ position: 'absolute', left: portrait.x, top: portrait.top }}>
      <div
        style={{
          width: portrait.size,
          height: portrait.size,
          borderRadius: '50%',
          backgroundImage: `url(${sessionPhotoUrl(jobId, portrait.photoId, 400)})`,
          backgroundSize: size,
          backgroundPosition: position,
          backgroundRepeat: 'no-repeat',
          border: `${theme.flat ? 0.9 : 0.5}px solid ${withAlpha(theme.frame, theme.flat ? 1 : 0.8)}`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: portrait.size + 6,
          left: -6,
          width: portrait.size + 12,
          textAlign: 'center',
          fontFamily: SANS_STACK,
          fontSize: 7.4,
          fontWeight: 700,
          color: withAlpha(theme.ink, 0.92),
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {portrait.name}
      </div>
    </div>
  );
};

/** A chapter or cast heading: display title, accent rule, count beneath. */
const DisplayHeading: React.FC<{
  theme: Palette; display: string; title: string; subtitle: string;
  top: number; measure: number; margin: number;
}> = ({ theme, display, title, subtitle, top, measure, margin }) => {
  const size = Math.max(18, Math.min(38, 1180 / Math.max(title.length, 8)));
  return (
    <div style={{ position: 'absolute', left: margin, top, width: measure }}>
      <div style={{ fontFamily: display, fontSize: size, lineHeight: 1.04, color: theme.ink }}>
        {title}
      </div>
      <div style={{ width: 54, height: 2, background: withAlpha(theme.accent, 0.95), marginTop: 12 }} />
      {subtitle && (
        <div style={{ marginTop: 7, color: theme.muted, ...tracked(7, 1.8) }}>{subtitle}</div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ *
   One page
 * ------------------------------------------------------------------ */

interface PageProps {
  jobId: string;
  plan: AlbumPlan;
  theme: Palette;
  page: AlbumPage | null;
  /** Which edge sits against the spine, for the gutter shadow. */
  side: 'left' | 'right';
}

const AlbumPageView: React.FC<PageProps & { scale: number }> = ({
  jobId, plan, theme, page, side, scale,
}) => {
  const { width, height, margin, captionHeight, captionGap } = plan.page;
  // Flat themes square the corners off and drop the shadow, the way the PDF does.
  const cornerRadius = theme.flat ? 0 : plan.page.cornerRadius;
  const grain = grainOverlay(theme);
  const display = theme.serif ? SERIF_STACK : SANS_STACK;

  // A page past the end of the album: the back of the last leaf.
  if (!page) {
    return (
      <div style={{ width, height, ...pageBackground(theme), position: 'relative' }}>
        {grain && <div style={{ position: 'absolute', inset: 0, ...grain }} />}
      </div>
    );
  }

  const isCover = page.kind === 'cover';
  // The PDF shrinks the title until it fits 76% of the measure; approximate
  // that here rather than measuring text, which would force a layout pass.
  const titleSize = Math.max(20, Math.min(46, 1500 / Math.max(plan.title.length, 10)));

  return (
    <div
      style={{
        width,
        height,
        position: 'relative',
        overflow: 'hidden',
        ...pageBackground(theme),
      }}
    >
      {grain && <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', ...grain }} />}

      {/* Spine shading: the inner edge of a bound page never catches the light. */}
      <div
        style={{
          display: theme.flat ? 'none' : 'block',
          position: 'absolute',
          top: 0,
          bottom: 0,
          [side === 'left' ? 'right' : 'left']: 0,
          width: 26,
          background: `linear-gradient(${side === 'left' ? '270deg' : '90deg'}, ${withAlpha(
            theme.dark ? '#000000' : '#5a5148',
            theme.dark ? 0.38 : 0.13,
          )}, transparent)`,
          pointerEvents: 'none',
          zIndex: 3,
        }}
      />

      {isCover ? (
        <CoverContent plan={plan} theme={theme} display={display} titleSize={titleSize} />
      ) : (
        <PageChrome plan={plan} theme={theme} pageNumber={page.number} />
      )}

      {/* A divider is mostly empty on purpose: it is a breath between two
          events, and 小黑 is the one carrying the album across the gap. */}
      {(page.kind === 'chapter' || page.kind === 'cast') && (
        <DisplayHeading
          theme={theme}
          display={display}
          title={page.pageTitle}
          subtitle={page.pageSubtitle}
          top={page.kind === 'cast' ? margin + 46 : height * 0.42 - 38}
          measure={(width - margin * 2) * (page.character ? 0.48 : 0.72)}
          margin={margin}
        />
      )}

      {page.character && (
        <Character theme={theme} character={page.character} scale={scale} />
      )}

      {page.portraits.map((portrait) => (
        <Portrait
          key={`${portrait.castIndex}-${portrait.name}`}
          jobId={jobId}
          theme={theme}
          portrait={portrait}
        />
      ))}

      {page.tiles.map((tile) => {
        const labelled = tile.photoH < tile.h;
        return (
          <React.Fragment key={`${tile.photoId}-${tile.number}-${tile.x}`}>
            <div
              style={{
                position: 'absolute',
                left: tile.x,
                top: tile.top,
                width: tile.w,
                height: tile.photoH,
                borderRadius: cornerRadius,
                overflow: 'hidden',
                border: `${theme.flat ? 0.9 : 0.5}px solid ${withAlpha(theme.frame, theme.flat ? 1 : 0.7)}`,
                boxShadow: theme.shadowAlpha
                  ? `0 2.4px 6px ${withAlpha('#000000', theme.shadowAlpha)}`
                  : 'none',
                background: withAlpha(theme.frame, 0.4),
              }}
            >
              <img
                src={tileSrc(jobId, tile)}
                alt={tile.caption || `Photo ${tile.number}`}
                draggable={false}
                loading="eager"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </div>

            {labelled && !isCover && (
              <div
                style={{
                  position: 'absolute',
                  left: tile.x,
                  top: tile.top + tile.photoH + captionGap,
                  width: tile.w,
                  height: captionHeight,
                  display: 'flex',
                  gap: 5,
                  alignItems: 'flex-start',
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    fontFamily: SANS_STACK,
                    fontSize: 6,
                    fontWeight: 700,
                    color: withAlpha(theme.accent, 0.9),
                    lineHeight: '11px',
                    flexShrink: 0,
                  }}
                >
                  {String(tile.number).padStart(2, '0')}
                </span>
                <span style={{ minWidth: 0, flex: 1, lineHeight: '8px' }}>
                  <span
                    style={{
                      display: 'block',
                      fontFamily: SANS_STACK,
                      fontSize: 7.3,
                      fontWeight: 700,
                      color: withAlpha(theme.ink, 0.92),
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      lineHeight: '11px',
                    }}
                  >
                    {tile.caption}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      fontFamily: SANS_STACK,
                      fontSize: 6.3,
                      color: withAlpha(theme.muted, 0.95),
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      lineHeight: '8px',
                    }}
                  >
                    {tile.subcaption}
                  </span>
                </span>
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};

/** Running head, folio and footer — mirrors `_draw_page_chrome`. */
const PageChrome: React.FC<{ plan: AlbumPlan; theme: Palette; pageNumber: number }> = ({
  plan, theme, pageNumber,
}) => {
  const { width, height, margin } = plan.page;
  const top = margin + 7;
  return (
    <>
      <div
        style={{
          position: 'absolute', left: margin, top: top - 6,
          color: withAlpha(theme.muted, 0.9), ...tracked(6.6, 1.6),
        }}
      >
        {plan.title.slice(0, 56)}
      </div>
      <div
        style={{
          position: 'absolute', right: margin, top: top - 6,
          color: theme.accent, fontWeight: 700, ...tracked(6.6, 1.4),
        }}
      >
        {String(pageNumber).padStart(2, '0')} / {String(plan.totalPages).padStart(2, '0')}
      </div>
      <div
        style={{
          position: 'absolute', left: margin, right: margin, top: margin + 15,
          height: 0.5, background: withAlpha(theme.frame, 0.85),
        }}
      />
      {plan.footer && (
        <div
          style={{
            position: 'absolute', left: margin, top: height - margin * 0.44 - 6,
            color: withAlpha(theme.muted, 0.75), ...tracked(5.8, 1.3),
          }}
        >
          {plan.footer}
        </div>
      )}
    </>
  );
};

/** Masthead, display title, stat rail and corner marks — mirrors `_draw_cover`. */
const CoverContent: React.FC<{
  plan: AlbumPlan; theme: Palette; display: string; titleSize: number;
}> = ({ plan, theme, display, titleSize }) => {
  const { width, height, margin, coverStripBottom } = plan.page;
  const innerW = width - margin * 2;
  const stripH = height * 0.43;
  const railTop = height - (coverStripBottom + stripH + 22) - 6;

  return (
    <>
      {/* masthead */}
      <div
        style={{
          position: 'absolute', left: margin, top: margin + 12,
          width: 5, height: 5, borderRadius: '50%', background: theme.accent,
        }}
      />
      <div
        style={{
          position: 'absolute', left: margin + 12, top: margin + 9,
          color: theme.accent, fontWeight: 700, ...tracked(7.6, 2.8),
        }}
      >
        Lumina
      </div>
      <div
        style={{
          position: 'absolute', right: margin, top: margin + 9,
          color: withAlpha(theme.muted, 0.85), ...tracked(6.8, 1.9),
        }}
      >
        Photo Album
      </div>
      <div
        style={{
          position: 'absolute', left: margin, right: margin, top: margin + 30,
          height: 0.8, background: withAlpha(theme.accent, 0.55),
        }}
      />

      {/* display title */}
      <div
        style={{
          position: 'absolute', left: margin, top: margin + 46,
          width: innerW * 0.76,
          fontFamily: display, fontSize: titleSize, lineHeight: 1.02,
          color: theme.ink,
        }}
      >
        {plan.title}
      </div>
      {plan.subtitle && (
        <div
          style={{
            position: 'absolute', left: margin,
            top: margin + 46 + titleSize * 1.35,
            color: theme.muted, ...tracked(7.6, 1.9),
          }}
        >
          {plan.subtitle.slice(0, 74)}
        </div>
      )}

      {/* stat rail */}
      <div
        style={{
          position: 'absolute', left: margin, top: railTop,
          display: 'flex', alignItems: 'flex-start', gap: 26,
        }}
      >
        {plan.stats.map((stat, i) => (
          <div key={stat.label} style={{ display: 'flex', gap: 26 }}>
            {i > 0 && (
              <div style={{ width: 0.6, height: 18, background: withAlpha(theme.frame, 0.9) }} />
            )}
            <div>
              <div
                style={{
                  fontFamily: display, fontSize: 14.5, fontWeight: 700,
                  color: withAlpha(theme.ink, 0.95), lineHeight: '17px',
                }}
              >
                {stat.value}
              </div>
              <div style={{ color: theme.muted, marginTop: 2, ...tracked(6.1, 1.6) }}>
                {stat.label}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          position: 'absolute', right: margin, top: railTop + 3,
          width: 70, height: 2.2, background: withAlpha(theme.accent, 0.95),
        }}
      />

      {/* corner marks */}
      {([['left', 'bottom'], ['right', 'top']] as const).map(([h, v]) => (
        <div
          key={`${h}${v}`}
          style={{
            position: 'absolute',
            [h]: margin - 9, [v]: margin - 9,
            width: 7, height: 7,
            [`border${h === 'left' ? 'Left' : 'Right'}`]: `0.7px solid ${withAlpha(theme.accent, 0.5)}`,
            [`border${v === 'top' ? 'Top' : 'Bottom'}`]: `0.7px solid ${withAlpha(theme.accent, 0.5)}`,
          } as React.CSSProperties}
        />
      ))}
    </>
  );
};

/** A page scaled to fit, with all of its children still in PDF points. */
const ScaledPage: React.FC<PageProps & { scale: number }> = ({ scale, ...props }) => (
  <div
    style={{
      width: props.plan.page.width * scale,
      height: props.plan.page.height * scale,
      overflow: 'hidden',
      flexShrink: 0,
    }}
  >
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
      <AlbumPageView {...props} scale={scale} />
    </div>
  </div>
);

/* ------------------------------------------------------------------ *
   The book
 * ------------------------------------------------------------------ */

interface AlbumViewerProps {
  jobId: string;
  plan: AlbumPlan;
  themes: CollageTheme[];
  themeKey: string;
  onThemeChange: (key: string) => void;
  onDownload: () => void;
  downloading: boolean;
  onClose: () => void;
}

const AlbumViewer: React.FC<AlbumViewerProps> = ({
  jobId, plan, themes, themeKey, onThemeChange, onDownload, downloading, onClose,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const [spread, setSpread] = useState(0);
  const [flip, setFlip] = useState<{ dir: 'next' | 'prev'; from: number } | null>(null);
  const [scale, setScale] = useState(0.5);
  const shellRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  const { width: pageW, height: pageH } = plan.page;
  const lastSpread = Math.ceil((plan.pages.length - 1) / 2);

  /** The theme the viewer paints with: the local pick when the user has moved
   *  on from the plan's, so restyling never waits for a refetch. */
  const theme: Palette = useMemo(() => {
    const picked = themes.find((t) => t.key === themeKey);
    if (!picked || picked.key === plan.theme.key) return plan.theme;
    const { swatch, ...palette } = picked;
    return palette;
  }, [themes, themeKey, plan.theme]);

  const pageAt = useCallback(
    (index: number): AlbumPage | null => plan.pages[index] ?? null,
    [plan.pages],
  );
  const leftOf = useCallback(
    (s: number) => (s === 0 ? null : pageAt(2 * s - 1)),
    [pageAt],
  );
  const rightOf = useCallback(
    (s: number) => (s === 0 ? pageAt(0) : pageAt(2 * s)),
    [pageAt],
  );

  /* ---- fit the spread to the viewport ---- */
  useEffect(() => {
    const fit = () => {
      const el = shellRef.current;
      if (!el) return;
      const available = el.clientWidth - 32;
      const availableH = el.clientHeight - 32;
      setScale(Math.max(0.12, Math.min(available / (pageW * 2), availableH / pageH)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [pageW, pageH]);

  /* ---- turning ---- */
  const turn = useCallback(
    (dir: 'next' | 'prev') => {
      if (flip) return;                                   // one leaf at a time
      const target = dir === 'next' ? spread + 1 : spread - 1;
      if (target < 0 || target > lastSpread) return;

      if (reducedMotion) {
        setSpread(target);
        return;
      }
      setFlip({ dir, from: spread });
      setSpread(target);
      timer.current = window.setTimeout(() => setFlip(null), FLIP_MS);
    },
    [flip, spread, lastSpread, reducedMotion],
  );

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); turn('next'); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); turn('prev'); }
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turn, onClose]);

  /* ---- preload the neighbouring spreads so a flip never stalls ---- */
  useEffect(() => {
    for (const s of [spread + 1, spread + 2, spread - 1]) {
      for (const page of [leftOf(s), rightOf(s)]) {
        page?.tiles.forEach((tile) => { new Image().src = tileSrc(jobId, tile); });
      }
    }
  }, [spread, jobId, leftOf, rightOf]);

  /* ---- what the static halves and the moving leaf show ----
     During a turn the halves already display the destination spread, and the
     leaf carries the two faces that sweep between them. */
  const staticLeft = flip?.dir === 'next' ? leftOf(flip.from) : leftOf(spread);
  const staticRight = flip?.dir === 'prev' ? rightOf(flip.from) : rightOf(spread);

  const leafFront = flip
    ? (flip.dir === 'next' ? rightOf(flip.from) : rightOf(spread))
    : null;
  const leafBack = flip
    ? (flip.dir === 'next' ? leftOf(spread) : leftOf(flip.from))
    : null;

  const canPrev = spread > 0;
  const canNext = spread < lastSpread;

  const face: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    backfaceVisibility: 'hidden',
    WebkitBackfaceVisibility: 'hidden',
    overflow: 'hidden',
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex flex-col"
      style={{
        background: theme.dark
          ? 'radial-gradient(circle at 50% 30%, #23212e 0%, #0b0a10 75%)'
          : 'radial-gradient(circle at 50% 30%, #f3eff7 0%, #d8d2e0 80%)',
        animation: 'fadeInUp 0.25s ease both',
      }}
    >
      {/* ---- top bar ---- */}
      <div className="flex items-center gap-3 px-5 py-3.5 flex-shrink-0">
        <div className="min-w-0 flex-1">
          <p
            className="text-sm font-semibold tracking-tight truncate"
            style={{ color: theme.dark ? '#f2f0f7' : '#231f2e' }}
          >
            {plan.title}
          </p>
          <p className="text-[11px] truncate" style={{ color: theme.muted }}>
            {spread === 0
              ? 'Cover'
              : `Pages ${leftOf(spread)?.number ?? '–'}–${rightOf(spread)?.number ?? leftOf(spread)?.number ?? '–'} of ${plan.totalPages}`}
          </p>
        </div>

        {/* live theme switch: restyles the plan already in hand */}
        <div className="hidden sm:flex items-center gap-1.5">
          {themes.map((t) => (
            <button
              key={t.key}
              onClick={() => onThemeChange(t.key)}
              title={t.name}
              className="w-7 h-7 rounded-lg border overflow-hidden flex items-center justify-center transition-transform hover:scale-110"
              style={{
                background: t.swatch[0],
                borderColor: t.key === themeKey ? t.swatch[1] : 'rgba(128,128,128,0.35)',
                borderWidth: t.key === themeKey ? 2 : 1,
              }}
            >
              {t.key === themeKey && <Check className="w-3 h-3" style={{ color: t.swatch[1] }} />}
            </button>
          ))}
        </div>

        <button
          onClick={onDownload}
          disabled={downloading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] font-bold uppercase tracking-[0.12em] disabled:opacity-50 transition-opacity"
          style={{ background: theme.accent, color: theme.dark ? '#14121c' : '#ffffff' }}
        >
          {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          PDF
        </button>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full flex items-center justify-center transition-colors"
          style={{
            background: theme.dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)',
            color: theme.muted,
          }}
          title="Close (Esc)"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ---- the book ---- */}
      <div ref={shellRef} className="flex-1 flex items-center justify-center min-h-0 px-4">
        <div
          style={{
            position: 'relative',
            width: pageW * 2 * scale,
            height: pageH * scale,
            perspective: 2600,
            filter: `drop-shadow(0 26px 50px ${withAlpha('#000000', theme.dark ? 0.6 : 0.3)})`,
          }}
        >
          <div style={{ display: 'flex', transformStyle: 'preserve-3d' }}>
            <ScaledPage
              jobId={jobId} plan={plan} theme={theme} page={staticLeft} side="left" scale={scale}
            />
            <ScaledPage
              jobId={jobId} plan={plan} theme={theme} page={staticRight} side="right" scale={scale}
            />
          </div>

          {/* the turning leaf */}
          {flip && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: pageW * scale,
                width: pageW * scale,
                height: pageH * scale,
                transformStyle: 'preserve-3d',
                transformOrigin: 'left center',
                animation: `${flip.dir === 'next' ? 'albumLeafForward' : 'albumLeafBack'} ${FLIP_MS}ms cubic-bezier(0.42, 0, 0.28, 1) both`,
                zIndex: 5,
              }}
            >
              <div style={face}>
                <ScaledPage
                  jobId={jobId} plan={plan} theme={theme} page={leafFront} side="right" scale={scale}
                />
                {/* light rolls off the leaf as it lifts */}
                <div className="album-leaf-sheen" style={{ position: 'absolute', inset: 0 }} />
              </div>
              <div style={{ ...face, transform: 'rotateY(180deg)' }}>
                <ScaledPage
                  jobId={jobId} plan={plan} theme={theme} page={leafBack} side="left" scale={scale}
                />
                <div className="album-leaf-sheen album-leaf-sheen--back" style={{ position: 'absolute', inset: 0 }} />
              </div>
            </div>
          )}

          {/* click targets sit above the pages but below the leaf */}
          <button
            onClick={() => turn('prev')}
            disabled={!canPrev}
            aria-label="Previous page"
            style={{ position: 'absolute', inset: '0 50% 0 0', cursor: canPrev ? 'w-resize' : 'default', zIndex: 4 }}
          />
          <button
            onClick={() => turn('next')}
            disabled={!canNext}
            aria-label="Next page"
            style={{ position: 'absolute', inset: '0 0 0 50%', cursor: canNext ? 'e-resize' : 'default', zIndex: 4 }}
          />
        </div>
      </div>

      {/* ---- footer controls ---- */}
      <div className="flex items-center justify-center gap-4 py-4 flex-shrink-0">
        <button
          onClick={() => turn('prev')}
          disabled={!canPrev}
          className="w-10 h-10 rounded-full flex items-center justify-center disabled:opacity-25 transition-opacity"
          style={{ background: theme.dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)', color: theme.ink }}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-1.5">
          {Array.from({ length: lastSpread + 1 }, (_, i) => (
            <button
              key={i}
              onClick={() => !flip && setSpread(i)}
              aria-label={i === 0 ? 'Cover' : `Spread ${i}`}
              className="rounded-full transition-all duration-300"
              style={{
                width: i === spread ? 20 : 6,
                height: 6,
                background: i === spread ? theme.accent : withAlpha(theme.muted, 0.45),
              }}
            />
          ))}
        </div>

        <button
          onClick={() => turn('next')}
          disabled={!canNext}
          className="w-10 h-10 rounded-full flex items-center justify-center disabled:opacity-25 transition-opacity"
          style={{ background: theme.dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)', color: theme.ink }}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>,
    document.body,
  );
};

export default AlbumViewer;
