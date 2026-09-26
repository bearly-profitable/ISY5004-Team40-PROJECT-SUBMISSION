import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu, X, LogIn, ChevronRight } from 'lucide-react';
import { AppStep } from '../types';
import { gsap, prefersReducedMotion } from '../lib/motion';
import { useAuth } from '../lib/auth';
import { firstName } from '../lib/profile';
import { ProfileAvatar } from './ProfileAvatar';

interface NavbarProps {
  currentStep: AppStep;
  setStep: (step: AppStep) => void;
}

const NAV_ITEMS = [
  { label: 'Home', step: AppStep.LANDING },
  { label: 'Upload', step: AppStep.UPLOAD },
  { label: 'Gallery', step: AppStep.GALLERY },
  { label: 'Sessions', step: AppStep.SESSIONS },
];

export const Navbar: React.FC<NavbarProps> = ({ currentStep, setStep }) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const { user, profile, loading, signInWithGoogle } = useAuth();
  const hidden = useRef(false);
  const lastY = useRef(0);

  // Hide while scrolling down, return on the way back up. The landing page
  // keeps it, since its film is where people scroll the most.
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const hide = currentStep !== AppStep.LANDING && y > 80 && y > lastY.current + 6;
      const show = y < lastY.current - 4 || y < 80;
      if ((hide && !hidden.current) || (show && hidden.current)) {
        hidden.current = hide;
        gsap.to(navRef.current, {
          yPercent: hide ? -130 : 0,
          duration: prefersReducedMotion() ? 0 : 0.35,
          ease: 'power2.out',
        });
        if (hide) setMobileOpen(false);
      }
      lastY.current = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [currentStep]);

  // Slide the active-tab blob under whichever tab is current.
  useLayoutEffect(() => {
    const pills = pillsRef.current;
    const blob = indicatorRef.current;
    if (!pills || !blob) return;
    const active = pills.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) { gsap.set(blob, { opacity: 0 }); return; }
    gsap.to(blob, {
      x: active.offsetLeft,
      width: active.offsetWidth,
      opacity: 1,
      duration: prefersReducedMotion() ? 0 : 0.5,
      ease: 'elastic.out(1, 0.75)',
    });
  }, [currentStep]);

  useEffect(() => {
    if (!mobileOpen || !sheetRef.current || prefersReducedMotion()) return;
    const tl = gsap.timeline();
    tl.from(sheetRef.current, { y: -16, opacity: 0, scale: 0.97, duration: 0.3, ease: 'power3.out' })
      .from(sheetRef.current.querySelectorAll('[data-item]'),
        { y: 10, opacity: 0, stagger: 0.05, duration: 0.3, ease: 'power2.out' }, '-=0.15');
    return () => { tl.kill(); };
  }, [mobileOpen]);

  const go = (step: AppStep) => { setStep(step); setMobileOpen(false); };
  const onProfile = currentStep === AppStep.PROFILE;

  return (
    <>
      <nav ref={navRef} className="fixed top-0 inset-x-0 z-50 px-3 sm:px-5 pt-3" aria-label="Main">
        <div className="max-w-6xl mx-auto liquid-glass-heavy rounded-full h-14 pl-3 pr-2 sm:pl-4 flex items-center justify-between gap-3">
          <button onClick={() => go(AppStep.LANDING)} className="flex items-center gap-1.5 shrink-0 group" aria-label="Lumina home">
            <img src="/lumi/wave.webp" alt="" aria-hidden className="lumi-sprite h-10 w-auto -my-1 group-hover:-rotate-6 transition-transform duration-300" />
            <img src="/logo-wordmark.png" alt="Lumina" className="h-7 sm:h-8 w-auto" />
          </button>

          <div ref={pillsRef} className="relative hidden md:flex items-center gap-1 rounded-full bg-lumina-100/60 p-1">
            <div
              ref={indicatorRef}
              aria-hidden
              className="absolute left-0 top-1 bottom-1 rounded-full bg-white shadow-[0_2px_0_rgba(143,123,198,0.25),0_6px_16px_rgba(80,50,110,0.1)] opacity-0"
            />
            {NAV_ITEMS.map((item) => {
              const active = currentStep === item.step;
              return (
                <button
                  key={item.label}
                  onClick={() => go(item.step)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative z-10 px-4 py-1.5 rounded-full text-sm font-extrabold transition-colors duration-200 ${
                    active ? 'text-lumina-700' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            {!loading && (user ? (
              <button
                onClick={() => go(AppStep.PROFILE)}
                aria-current={onProfile ? 'page' : undefined}
                aria-label="Your profile"
                title="Your profile"
                className={`hidden sm:flex items-center gap-2 rounded-full pl-1 pr-3 py-1 transition-all duration-200 ${
                  onProfile
                    ? 'bg-white shadow-[0_2px_0_rgb(var(--lumina-500)/0.25),0_6px_16px_rgba(80,50,110,0.1)]'
                    : 'hover:bg-white/70'
                }`}
              >
                <ProfileAvatar
                  profile={profile}
                  size={36}
                  className={`ring-2 transition-transform duration-300 ${onProfile ? 'ring-lumina-400' : 'ring-white'}`}
                />
                <span className="text-sm font-extrabold text-slate-700 max-w-[7rem] truncate">
                  {firstName(profile, 'You')}
                </span>
              </button>
            ) : (
              <button onClick={signInWithGoogle} className="btn-jelly btn-jelly-sm hidden sm:inline-flex">
                <LogIn className="w-3.5 h-3.5" /> Log in
              </button>
            ))}
            <button
              className="md:hidden w-10 h-10 rounded-full bg-white/80 text-slate-700 flex items-center justify-center shadow-[0_2px_0_rgba(143,123,198,0.2)]"
              onClick={() => setMobileOpen((o) => !o)}
              aria-expanded={mobileOpen}
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div ref={sheetRef} className="md:hidden max-w-6xl mx-auto mt-2 liquid-glass-heavy rounded-[28px] p-3">
            <div data-item className="flex items-center gap-2 px-2 pb-2">
              <img src="/lumi/point.webp" alt="" aria-hidden className="lumi-sprite h-14 w-auto" />
              <span className="lumi-bubble text-sm" data-tail="left">Where to?</span>
            </div>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.label}
                data-item
                onClick={() => go(item.step)}
                aria-current={currentStep === item.step ? 'page' : undefined}
                className={`w-full text-left px-4 py-3.5 rounded-2xl text-base font-extrabold ${
                  currentStep === item.step ? 'bg-white text-lumina-700' : 'text-slate-600'
                }`}
              >
                {item.label}
              </button>
            ))}
            {!loading && (user ? (
              <button
                data-item
                onClick={() => go(AppStep.PROFILE)}
                aria-current={onProfile ? 'page' : undefined}
                className={`w-full mt-2 rounded-2xl p-3 flex items-center gap-3 text-left ${onProfile ? 'bg-white' : 'bg-white/60'}`}
              >
                <ProfileAvatar profile={profile} size={44} className="ring-2 ring-white shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-extrabold text-slate-800 truncate">
                    {profile?.display_name || user.email}
                  </span>
                  <span className="block text-xs text-slate-500">Your profile</span>
                </span>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>
            ) : (
              <button data-item onClick={signInWithGoogle} className="btn-jelly w-full mt-2">
                <LogIn className="w-4 h-4" /> Log in with Google
              </button>
            ))}
          </div>
        )}
      </nav>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden bg-slate-900/10 backdrop-blur-[2px]" onClick={() => setMobileOpen(false)} aria-hidden />
      )}
    </>
  );
};
