import React, { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { Lock } from 'lucide-react';
import { Lumi, LumiPose } from '../components/Lumi';
import { ScrollStory } from '../components/ScrollStory';
import { gsap, prefersReducedMotion } from '../lib/motion';

interface LandingProps {
  onGetStarted: () => void;
}

const FEATURES: { pose: LumiPose; title: string; body: string }[] = [
  { pose: 'search', title: 'Finds every face', body: 'Face and body recognition spot everyone, even when they turn away.' },
  { pose: 'tag', title: 'Knows who’s who', body: 'The same person across a whole album, grouped into one name you can edit.' },
  { pose: 'sort', title: 'Groups the moments', body: 'Photos gather into events, which get named for you: Beach, Dinner, Birthday.' },
  { pose: 'star', title: 'Picks the best shot', body: 'Sharpness, open eyes, pose and aesthetics decide the keeper for each person.' },
  { pose: 'point', title: 'Search in words', body: 'Type “sunset by the water” and Lumi finds the photo that matches.' },
  { pose: 'hang', title: 'Makes the album', body: 'A printable photo book, with Lumi dressed up for every chapter.' },
];

const STEPS: { pose: LumiPose; title: string; body: string }[] = [
  { pose: 'camera', title: 'Drop your photos', body: 'Drag in a batch from one trip or party.' },
  { pose: 'think', title: 'Lumi gets to work', body: 'A minute or so, depending on the batch.' },
  { pose: 'celebrate', title: 'Enjoy your gallery', body: 'Best shots, people and moments, sorted.' },
];

export const Landing: React.FC<LandingProps> = ({ onGetStarted }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = prefersReducedMotion();

  // Sections below the film reveal as they scroll in.
  useGSAP(() => {
    if (reduced) return;
    gsap.utils.toArray<HTMLElement>('[data-reveal]').forEach((el) => {
      gsap.from(el, {
        y: 40,
        opacity: 0,
        duration: 0.8,
        ease: 'power3.out',
        delay: Number(el.dataset.reveal || 0) * 0.08,
        scrollTrigger: { trigger: el, start: 'top 88%', once: true },
      });
    });
  }, { scope: rootRef });

  return (
    <div ref={rootRef} className="overflow-x-clip">
      <ScrollStory onGetStarted={onGetStarted} />

      {/* Meet Lumi */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-16 md:py-28 grid md:grid-cols-2 gap-8 md:gap-12 items-center">
        <div data-reveal className="order-2 md:order-1 text-center md:text-left">
          <span className="chip mb-4">Say hi</span>
          <h2 className="font-display text-4xl md:text-6xl font-bold text-slate-900 leading-[1.05] mb-5">
            This is <span className="text-lumi-gradient">Lumi</span>
          </h2>
          <p className="text-slate-600 text-base md:text-lg leading-relaxed mb-4 max-w-md mx-auto md:mx-0">
            A tiny photo-bun with a camera for a tummy and a very serious job: making
            sure nobody&rsquo;s best photo gets lost in the pile.
          </p>
          <p className="text-slate-500 text-sm md:text-base leading-relaxed max-w-md mx-auto md:mx-0">
            Lumi keeps you company all through Lumina: catching your uploads, narrating
            the analysis, and dressing up for every chapter of your album.
          </p>
        </div>
        <div data-reveal="1" className="order-1 md:order-2 relative aspect-square max-w-[440px] w-full mx-auto flex items-center justify-center">
          <div className="absolute inset-[8%] rounded-full bg-gradient-to-br from-lumina-200/70 via-blush-200/60 to-peach-200/60 blur-2xl" />
          {/* A soft contact shadow, so Lumi stands on the page. */}
          <div className="absolute bottom-[6%] left-1/2 -translate-x-1/2 w-[46%] h-[7%] rounded-[50%] bg-lumina-900/15 blur-md" />
          <img
            src="/lumi/hero.webp"
            alt="Lumi, a lavender bao-bun bear with a camera lens on its tummy"
            width={943}
            height={1550}
            className="lumi-sprite relative h-[92%] w-auto"
          />
        </div>
      </section>

      {/* What Lumi does */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-16 md:pb-28">
        <div data-reveal className="text-center mb-10 md:mb-14">
          <span className="chip mb-4">What Lumi does</span>
          <h2 className="font-display text-3xl md:text-5xl font-bold text-slate-900">
            A whole photo team, in one bun
          </h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {FEATURES.map((f, i) => (
            <article
              key={f.title}
              data-reveal={i % 3}
              className="liquid-glass rounded-[28px] p-5 md:p-6 flex items-center gap-4 hover:-translate-y-1 transition-transform duration-300"
            >
              <Lumi pose={f.pose} size={96} float={false} className="shrink-0" />
              <div>
                <h3 className="font-extrabold text-slate-900 text-lg mb-1">{f.title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed">{f.body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 pb-16 md:pb-28">
        <div data-reveal className="liquid-glass-heavy rounded-[36px] px-5 py-10 md:px-12 md:py-14">
          <h2 className="font-display text-3xl md:text-5xl font-bold text-slate-900 text-center mb-10">
            Three steps, zero sorting
          </h2>
          <ol className="grid md:grid-cols-3 gap-8 md:gap-6">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex flex-col items-center text-center">
                <Lumi pose={s.pose} size={130} float={false} />
                <span className="mt-3 w-7 h-7 rounded-full bg-lumina-500 text-white text-sm font-black flex items-center justify-center">
                  {i + 1}
                </span>
                <h3 className="font-extrabold text-slate-900 text-lg mt-3">{s.title}</h3>
                <p className="text-slate-500 text-sm mt-1 max-w-[16rem]">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Closing call */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 pb-20 md:pb-28 text-center">
        <div data-reveal className="flex flex-col items-center">
          <Lumi pose="wave" size={170} say="Ready when you are!" bubble="top" />
          <h2 className="font-display text-3xl md:text-5xl font-bold text-slate-900 mt-6 mb-6">
            Let&rsquo;s find your best shots
          </h2>
          <button className="btn-jelly text-base px-8 py-4" onClick={onGetStarted}>
            Start with your photos
          </button>
          <p className="flex items-center justify-center gap-1.5 text-xs font-bold text-slate-400 mt-6">
            <Lock className="w-3.5 h-3.5" /> Your photos are deleted automatically within 24 hours.
          </p>
        </div>
      </section>

      <footer className="border-t border-white/60 py-8 px-4 text-center text-xs font-bold text-slate-400 flex items-center justify-center gap-2">
        <img src="/lumi/sleepy.webp" alt="" aria-hidden className="lumi-sprite h-8 w-auto" />
        Lumina · Lumi does the sorting, you keep the memories.
      </footer>
    </div>
  );
};
