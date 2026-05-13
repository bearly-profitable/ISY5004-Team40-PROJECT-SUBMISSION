
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Menu, X, ChevronDown, HardDrive, Upload } from 'lucide-react';
import { AppStep } from '../types';

interface NavbarProps {
  currentStep: AppStep;
  setStep: (step: AppStep) => void;
  onConnect: () => Promise<void> | void;
  onLocalUpload?: (files: FileList) => void;
  isConnecting?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentStep,
  setStep,
  onConnect,
  onLocalUpload,
  isConnecting = false,
}) => {
  const [scrolled, setScrolled] = useState(false);
  const [visible, setVisible] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const connectRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastScrollY = useRef(0);
  const isLanding = currentStep === AppStep.LANDING;

  // Hide on scroll down / show on scroll up (skip on landing)
  useEffect(() => {
    const onScroll = () => {
      const currentY = window.scrollY;
      setScrolled(currentY > 24);

      if (!isLanding) {
        const delta = currentY - lastScrollY.current;
        if (delta > 8) {
          // Scrolling down
          setVisible(false);
          setConnectOpen(false);
          setMobileOpen(false);
        } else if (delta < 0) {
          // Scrolling up
          setVisible(true);
        }
      }

      lastScrollY.current = currentY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [isLanding]);

  // Always visible on landing
  useEffect(() => {
    if (isLanding) setVisible(true);
  }, [isLanding]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (connectRef.current && !connectRef.current.contains(e.target as Node)) {
        setConnectOpen(false);
      }
    };
    if (connectOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [connectOpen]);

  const handleUploadClick = () => {
    setConnectOpen(false);
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0 && onLocalUpload) {
      onLocalUpload(e.target.files);
    }
    e.target.value = '';
  };

  const navItems = [
    { label: 'Overview', step: AppStep.LANDING },
    { label: 'Upload', step: AppStep.DRIVE_VIEW },
    { label: 'Gallery', step: AppStep.GALLERY },
  ];

  // Glass background classes when scrolled on non-landing pages
  const showGlass = scrolled && !isLanding;

  // Logo size: landing h-28, non-landing at top h-14, non-landing scrolled h-10
  const logoHeight = isLanding ? 'h-28' : scrolled ? 'h-10' : 'h-14';

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      <nav
        className={`fixed top-0 left-0 right-0 z-50 ${showGlass ? 'py-2' : 'py-3'} border-b border-transparent transition-all bg-transparent ${
          showGlass ? 'liquid-glass-light glass-prismatic-soft shadow-lg shadow-black/[0.06]' : ''
        }`}
        style={{
          transform: visible ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 350ms var(--smooth, cubic-bezier(0.4, 0, 0.2, 1)), padding 300ms ease, box-shadow 300ms ease, background 300ms ease',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between">
          {/* Logo */}
          <div
            className="flex items-center cursor-pointer group"
            onClick={() => setStep(AppStep.LANDING)}
          >
            <img
              src="/logo.png"
              alt="Lumina"
              className={`w-auto object-contain transition-all duration-300 group-hover:scale-105 ${logoHeight}`}
              style={isLanding ? { filter: 'drop-shadow(0 2px 12px rgba(0,0,0,0.3))' } : undefined}
            />
          </div>

          {/* Desktop nav pills */}
          <div className="hidden md:flex items-center">
            <div className={`rounded-full p-1 flex items-center gap-0.5 transition-all duration-300 glass-prismatic-soft ${
              isLanding
                ? 'bg-white/[0.08] backdrop-blur-2xl border border-white/[0.12]'
                : 'bg-white/[0.15] backdrop-blur-2xl border border-white/[0.3]'
            }`}>
              {navItems.map((item) => (
                <button
                  key={item.label}
                  onClick={() => setStep(item.step)}
                  className={`relative px-4 py-2 rounded-full text-[13px] font-medium tracking-wide transition-all duration-400 ${
                    currentStep === item.step
                      ? isLanding ? 'text-white' : 'text-lumina-700'
                      : isLanding
                      ? 'text-white/50 hover:text-white/80'
                      : 'text-slate-400 hover:text-slate-700'
                  }`}
                >
                  {currentStep === item.step && (
                    <div
                      className={`absolute inset-0 rounded-full ${
                        isLanding
                          ? 'bg-white/[0.14] backdrop-blur-xl border border-white/[0.2]'
                          : 'bg-white/[0.25] backdrop-blur-xl border border-white/[0.4]'
                      }`}
                      style={{ animation: 'scaleIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both' }}
                    />
                  )}
                  <span className="relative z-10">{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            {/* Connect dropdown */}
            <div className="relative hidden sm:block" ref={connectRef}>
              <button
                onClick={() => setConnectOpen((v) => !v)}
                disabled={isConnecting}
                className={`inline-flex items-center gap-1.5 px-5 py-2 rounded-full text-[13px] font-medium tracking-wide transition-all duration-300 backdrop-blur-xl hover:scale-[1.02] ${
                  isLanding
                    ? 'bg-white/[0.12] border border-white/[0.18] text-white hover:bg-white/[0.2]'
                    : 'bg-white/[0.15] border border-white/[0.3] text-slate-700 hover:bg-white/[0.25]'
                }`}
              >
                {isConnecting ? 'Connecting...' : 'Connect'}
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${connectOpen ? 'rotate-180' : ''}`} />
              </button>

              {connectOpen && (
                <div
                  className="absolute right-0 top-full mt-2 w-52 z-50 rounded-xl overflow-hidden shadow-xl shadow-black/15 border border-white/40"
                  style={{
                    background: 'rgba(255,255,255,0.92)',
                    backdropFilter: 'blur(20px)',
                    animation: 'scaleIn 0.15s cubic-bezier(0.34, 1.56, 0.64, 1) both',
                    transformOrigin: 'top right',
                  }}
                >
                  <button
                    onClick={() => { onConnect(); setConnectOpen(false); }}
                    disabled={isConnecting}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-sm text-slate-700 hover:bg-slate-100/80 transition-colors duration-150 text-left"
                  >
                    <HardDrive className="w-4 h-4 text-lumina-500 flex-shrink-0" />
                    <span className="font-medium">Google Drive</span>
                  </button>
                  <div className="h-px bg-slate-200/80 mx-3" />
                  <button
                    onClick={handleUploadClick}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-sm text-slate-700 hover:bg-slate-100/80 transition-colors duration-150 text-left"
                  >
                    <Upload className="w-4 h-4 text-lumina-500 flex-shrink-0" />
                    <span className="font-medium">Upload Files</span>
                  </button>
                </div>
              )}
            </div>

            <button
              className={`md:hidden w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300 backdrop-blur-xl ${
                isLanding
                  ? 'bg-white/[0.1] border border-white/[0.15] text-white'
                  : 'bg-white/[0.15] border border-white/[0.3] text-slate-600'
              }`}
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              <div className="relative w-4 h-4">
                <Menu
                  className={`w-4 h-4 absolute inset-0 transition-all duration-300 ${
                    mobileOpen ? 'opacity-0 rotate-90 scale-75' : 'opacity-100 rotate-0 scale-100'
                  }`}
                />
                <X
                  className={`w-4 h-4 absolute inset-0 transition-all duration-300 ${
                    mobileOpen ? 'opacity-100 rotate-0 scale-100' : 'opacity-0 -rotate-90 scale-75'
                  }`}
                />
              </div>
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile menu overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setMobileOpen(false)}>
          <div
            className="absolute inset-0 bg-white/[0.08] backdrop-blur-2xl backdrop-saturate-150 dark:bg-white/[0.05]"
            style={{ animation: 'fadeInUp 0.3s cubic-bezier(0.4, 0, 0.2, 1) both' }}
          />
          <div
            className="absolute top-16 left-4 right-4 liquid-glass-heavy rounded-2xl p-2 glass-prismatic"
            style={{ animation: 'scaleInBounce 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both' }}
            onClick={(e) => e.stopPropagation()}
          >
            {navItems.map((item, i) => (
              <button
                key={item.label}
                onClick={() => { setStep(item.step); setMobileOpen(false); }}
                className={`w-full text-left px-4 py-3.5 rounded-xl text-[13px] font-medium tracking-wide transition-all duration-300 ${
                  currentStep === item.step
                    ? 'bg-white/[0.25] text-slate-800'
                    : 'text-slate-500 hover:text-slate-800 hover:bg-white/[0.15]'
                }`}
                style={{ animation: `fadeInUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 60}ms both` }}
              >
                {item.label}
              </button>
            ))}
            <div className="mt-2 pt-2 border-t border-white/20 flex flex-col gap-1.5">
              <button
                onClick={() => { onConnect(); setMobileOpen(false); }}
                disabled={isConnecting}
                className="w-full flex items-center justify-center gap-2 bg-white/[0.2] backdrop-blur-xl border border-white/[0.35] text-slate-700 px-4 py-3 rounded-xl text-[13px] font-medium tracking-wide hover:bg-white/[0.3] transition-all duration-300"
                style={{ animation: 'fadeInUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) 180ms both' }}
              >
                <HardDrive className="w-3.5 h-3.5" />
                {isConnecting ? 'Connecting...' : 'Google Drive'}
              </button>
              <button
                onClick={() => { handleUploadClick(); setMobileOpen(false); }}
                className="w-full flex items-center justify-center gap-2 bg-white/[0.2] backdrop-blur-xl border border-white/[0.35] text-slate-700 px-4 py-3 rounded-xl text-[13px] font-medium tracking-wide hover:bg-white/[0.3] transition-all duration-300"
                style={{ animation: 'fadeInUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) 240ms both' }}
              >
                <Upload className="w-3.5 h-3.5" />
                Upload Files
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
