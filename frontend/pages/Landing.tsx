
import React, { useEffect, useRef } from 'react';

declare const gsap: any;
declare const THREE: any;

export const Landing: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;

    const loadScript = (src: string, globalName: string) =>
      new Promise<void>((res, rej) => {
        if ((window as any)[globalName]) { res(); return; }
        if (document.querySelector(`script[src="${src}"]`)) {
          const check = setInterval(() => {
            if ((window as any)[globalName]) { clearInterval(check); res(); }
          }, 50);
          setTimeout(() => { clearInterval(check); rej(new Error(`Timeout waiting for ${globalName}`)); }, 10000);
          return;
        }
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => setTimeout(() => res(), 100);
        s.onerror = () => rej(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
      });

    const loadScripts = async () => {
      try {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js', 'gsap');
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'THREE');
      } catch (e) {
        console.error('Failed to load scripts:', e);
        return;
      }
      if (alive) initApplication();
    };

    const initApplication = () => {
      /* ---- CONFIG ---- */
      const SLIDER_CONFIG = {
        transitionDuration: 2.5,
        autoSlideSpeed: 5000,
        glassRefractionStrength: 1.0,
        glassChromaticAberration: 1.0,
        glassBubbleClarity: 1.0,
        glassEdgeGlow: 1.0,
        glassLiquidFlow: 1.0,
        globalIntensity: 1.0,
        speedMultiplier: 1.0,
        distortionStrength: 1.0,
      };

      /* ---- STATE ---- */
      let currentSlideIndex = 0;
      let isTransitioning = false;
      let shaderMaterial: any;
      let renderer: any;
      let scene: any;
      let camera: any;
      let slideTextures: any[] = [];
      let texturesLoaded = false;
      let autoSlideTimer: any = null;
      let progressAnimation: any = null;
      let sliderEnabled = false;
      let animFrameId: number;

      const SLIDE_DURATION = () => SLIDER_CONFIG.autoSlideSpeed;
      const PROGRESS_UPDATE_INTERVAL = 50;
      const TRANSITION_DURATION = () => SLIDER_CONFIG.transitionDuration;

      const slides = [
        { title: 'Smart Stacking', description: 'Clusters similar photos together automatically using advanced visual similarity detection.', media: 'https://assets.codepen.io/7558/orange-portrait-001.jpg' },
        { title: 'Quality Ranking', description: 'Ranks every shot by lighting, composition, and sharpness to surface your best work.', media: 'https://assets.codepen.io/7558/orange-portrait-002.jpg' },
        { title: 'AI Powered', description: 'Driven by DINOv2 embeddings and YOLOv10 classification for intelligent photo analysis.', media: 'https://assets.codepen.io/7558/orange-portrait-003.jpg' },
        { title: 'Lightning Fast', description: 'Process hundreds of photos in seconds with an optimized machine learning pipeline.', media: 'https://assets.codepen.io/7558/orange-portrait-004.jpg' },
        { title: 'Privacy First', description: 'Your photos never leave Google Drive. Only metadata is analyzed, nothing is stored.', media: 'https://assets.codepen.io/7558/orange-portrait-005.jpg' },
        { title: 'Smart Gallery', description: 'Gallery-ready results beautifully curated, organized, and presented for you.', media: 'https://assets.codepen.io/7558/orange-portrait-006.jpg' },
      ];

      /* ---- SHADERS ---- */
      const vertexShader = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

      const fragmentShader = `
        uniform sampler2D uTexture1, uTexture2;
        uniform float uProgress;
        uniform vec2 uResolution, uTexture1Size, uTexture2Size;
        uniform float uGlobalIntensity, uSpeedMultiplier, uDistortionStrength;
        uniform float uGlassRefractionStrength, uGlassChromaticAberration, uGlassBubbleClarity, uGlassEdgeGlow, uGlassLiquidFlow;
        varying vec2 vUv;

        vec2 getCoverUV(vec2 uv, vec2 textureSize) {
          vec2 s = uResolution / textureSize;
          float scale = max(s.x, s.y);
          vec2 scaledSize = textureSize * scale;
          vec2 offset = (uResolution - scaledSize) * 0.5;
          return (uv * uResolution - offset) / scaledSize;
        }

        vec4 glassEffect(vec2 uv, float progress) {
          float time = progress * 5.0 * uSpeedMultiplier;
          vec2 uv1 = getCoverUV(uv, uTexture1Size);
          vec2 uv2 = getCoverUV(uv, uTexture2Size);
          float maxR = length(uResolution) * 0.85;
          float br = progress * maxR;
          vec2 p = uv * uResolution;
          vec2 c = uResolution * 0.5;
          float d = length(p - c);
          float nd = d / max(br, 0.001);
          float param = smoothstep(br + 3.0, br - 3.0, d);
          vec4 img;
          if (param > 0.0) {
            float ro = 0.08 * uGlassRefractionStrength * uDistortionStrength * uGlobalIntensity * pow(smoothstep(0.3 * uGlassBubbleClarity, 1.0, nd), 1.5);
            vec2 dir = (d > 0.0) ? (p - c) / d : vec2(0.0);
            vec2 distUV = uv2 - dir * ro;
            distUV += vec2(sin(time + nd * 10.0), cos(time * 0.8 + nd * 8.0)) * 0.015 * uGlassLiquidFlow * uSpeedMultiplier * nd * param;
            float ca = 0.02 * uGlassChromaticAberration * uGlobalIntensity * pow(smoothstep(0.3, 1.0, nd), 1.2);
            img = vec4(
              texture2D(uTexture2, distUV + dir * ca * 1.2).r,
              texture2D(uTexture2, distUV + dir * ca * 0.2).g,
              texture2D(uTexture2, distUV - dir * ca * 0.8).b,
              1.0
            );
            if (uGlassEdgeGlow > 0.0) {
              float rim = smoothstep(0.95, 1.0, nd) * (1.0 - smoothstep(1.0, 1.01, nd));
              img.rgb += rim * 0.08 * uGlassEdgeGlow * uGlobalIntensity;
            }
          } else {
            img = texture2D(uTexture2, uv2);
          }
          vec4 oldImg = texture2D(uTexture1, uv1);
          if (progress > 0.95) img = mix(img, texture2D(uTexture2, uv2), (progress - 0.95) / 0.05);
          return mix(oldImg, img, param);
        }

        void main() {
          gl_FragColor = glassEffect(vUv, uProgress);
        }
      `;

      /* ---- TEXT HELPERS ---- */
      const splitText = (text: string) =>
        text
          .split('')
          .map((char) => `<span style="display:inline-block;opacity:0">${char === ' ' ? '&nbsp;' : char}</span>`)
          .join('');

      const updateContent = (idx: number) => {
        const titleEl = document.getElementById('mainTitle');
        const descEl = document.getElementById('mainDesc');
        if (!titleEl || !descEl) return;

        gsap.to(titleEl.children, { y: -20, opacity: 0, duration: 0.5, stagger: 0.02, ease: 'power2.in' });
        gsap.to(descEl, { y: -10, opacity: 0, duration: 0.4, ease: 'power2.in' });

        setTimeout(() => {
          titleEl.innerHTML = splitText(slides[idx].title);
          descEl.textContent = slides[idx].description;
          gsap.set(titleEl.children, { opacity: 0 });
          gsap.set(descEl, { y: 20, opacity: 0 });

          const children = titleEl.children;
          switch (idx) {
            case 0:
              gsap.set(children, { y: 20 });
              gsap.to(children, { y: 0, opacity: 1, duration: 0.8, stagger: 0.03, ease: 'power3.out' });
              gsap.to(descEl, { y: 0, opacity: 1, duration: 0.8, delay: 0.2, ease: 'power3.out' });
              break;
            case 1:
              gsap.set(children, { y: -20 });
              gsap.to(children, { y: 0, opacity: 1, duration: 0.8, stagger: 0.03, ease: 'back.out(1.7)' });
              gsap.to(descEl, { y: 0, opacity: 1, duration: 0.8, delay: 0.2, ease: 'power3.out' });
              break;
            case 2:
              gsap.set(children, { filter: 'blur(10px)', scale: 1.5, y: 0 });
              gsap.to(children, { filter: 'blur(0px)', scale: 1, opacity: 1, duration: 1, stagger: { amount: 0.5, from: 'random' }, ease: 'power2.out' });
              gsap.to(descEl, { y: 0, opacity: 1, duration: 1, delay: 0.3, ease: 'power2.out' });
              break;
            case 3:
              gsap.set(children, { scale: 0, y: 0 });
              gsap.to(children, { scale: 1, opacity: 1, duration: 0.6, stagger: 0.05, ease: 'back.out(1.5)' });
              gsap.to(descEl, { y: 0, opacity: 1, duration: 0.8, delay: 0.2, ease: 'power3.out' });
              break;
            case 4:
              gsap.set(children, { rotationX: 90, y: 0, transformOrigin: '50% 50%' });
              gsap.to(children, { rotationX: 0, opacity: 1, duration: 0.8, stagger: 0.04, ease: 'power2.out' });
              gsap.to(descEl, { y: 0, opacity: 1, duration: 0.8, delay: 0.2, ease: 'power2.out' });
              break;
            case 5:
              gsap.set(children, { x: 30, y: 0 });
              gsap.to(children, { x: 0, opacity: 1, duration: 0.8, stagger: 0.03, ease: 'power3.out' });
              gsap.to(descEl, { y: 0, opacity: 1, duration: 0.8, delay: 0.2, ease: 'power3.out' });
              break;
            default:
              gsap.set(children, { y: 20 });
              gsap.to(children, { y: 0, opacity: 1, duration: 0.8, stagger: 0.03, ease: 'power3.out' });
              gsap.to(descEl, { y: 0, opacity: 1, duration: 0.8, delay: 0.2, ease: 'power3.out' });
          }
        }, 500);
      };

      /* ---- NAVIGATION ---- */
      const updateNavigationState = (idx: number) =>
        document.querySelectorAll('.slide-nav-item').forEach((el, i) => el.classList.toggle('active', i === idx));

      const updateSlideProgress = (idx: number, prog: number) => {
        const el = document.querySelectorAll('.slide-nav-item')[idx]?.querySelector('.slide-progress-fill') as HTMLElement;
        if (el) { el.style.width = `${prog}%`; el.style.opacity = '1'; }
      };

      const fadeSlideProgress = (idx: number) => {
        const el = document.querySelectorAll('.slide-nav-item')[idx]?.querySelector('.slide-progress-fill') as HTMLElement;
        if (el) { el.style.opacity = '0'; setTimeout(() => (el.style.width = '0%'), 300); }
      };

      const quickResetProgress = (idx: number) => {
        const el = document.querySelectorAll('.slide-nav-item')[idx]?.querySelector('.slide-progress-fill') as HTMLElement;
        if (el) {
          el.style.transition = 'width 0.2s ease-out';
          el.style.width = '0%';
          setTimeout(() => (el.style.transition = 'width 0.1s ease, opacity 0.3s ease'), 200);
        }
      };

      const updateCounter = (idx: number) => {
        const sn = document.getElementById('slideNumber');
        if (sn) sn.textContent = String(idx + 1).padStart(2, '0');
        const st = document.getElementById('slideTotal');
        if (st) st.textContent = String(slides.length).padStart(2, '0');
      };

      /* ---- SLIDE TRANSITION ---- */
      const navigateToSlide = (targetIndex: number) => {
        if (isTransitioning || targetIndex === currentSlideIndex) return;
        stopAutoSlideTimer();
        quickResetProgress(currentSlideIndex);

        const currentTexture = slideTextures[currentSlideIndex];
        const targetTexture = slideTextures[targetIndex];
        if (!currentTexture || !targetTexture) return;

        isTransitioning = true;
        shaderMaterial.uniforms.uTexture1.value = currentTexture;
        shaderMaterial.uniforms.uTexture2.value = targetTexture;
        shaderMaterial.uniforms.uTexture1Size.value = currentTexture.userData.size;
        shaderMaterial.uniforms.uTexture2Size.value = targetTexture.userData.size;

        updateContent(targetIndex);
        currentSlideIndex = targetIndex;
        updateCounter(currentSlideIndex);
        updateNavigationState(currentSlideIndex);

        gsap.fromTo(
          shaderMaterial.uniforms.uProgress,
          { value: 0 },
          {
            value: 1,
            duration: TRANSITION_DURATION(),
            ease: 'power2.inOut',
            onComplete: () => {
              shaderMaterial.uniforms.uProgress.value = 0;
              shaderMaterial.uniforms.uTexture1.value = targetTexture;
              shaderMaterial.uniforms.uTexture1Size.value = targetTexture.userData.size;
              isTransitioning = false;
              safeStartTimer(100);
            },
          },
        );
      };

      const handleSlideChange = () => {
        if (isTransitioning || !texturesLoaded || !sliderEnabled) return;
        navigateToSlide((currentSlideIndex + 1) % slides.length);
      };

      /* ---- AUTO-SLIDE TIMER ---- */
      const startAutoSlideTimer = () => {
        if (!texturesLoaded || !sliderEnabled) return;
        stopAutoSlideTimer();
        let progress = 0;
        const increment = (100 / SLIDE_DURATION()) * PROGRESS_UPDATE_INTERVAL;
        progressAnimation = setInterval(() => {
          if (!sliderEnabled) { stopAutoSlideTimer(); return; }
          progress += increment;
          updateSlideProgress(currentSlideIndex, progress);
          if (progress >= 100) {
            clearInterval(progressAnimation);
            progressAnimation = null;
            fadeSlideProgress(currentSlideIndex);
            if (!isTransitioning) handleSlideChange();
          }
        }, PROGRESS_UPDATE_INTERVAL);
      };

      const stopAutoSlideTimer = () => {
        if (progressAnimation) clearInterval(progressAnimation);
        if (autoSlideTimer) clearTimeout(autoSlideTimer);
        progressAnimation = null;
        autoSlideTimer = null;
      };

      const safeStartTimer = (delay = 0) => {
        stopAutoSlideTimer();
        if (sliderEnabled && texturesLoaded) {
          if (delay > 0) autoSlideTimer = setTimeout(startAutoSlideTimer, delay);
          else startAutoSlideTimer();
        }
      };

      /* ---- NAV BUILD ---- */
      const createSlidesNavigation = () => {
        const nav = document.getElementById('slidesNav');
        if (!nav) return;
        nav.innerHTML = '';
        slides.forEach((slide, i) => {
          const item = document.createElement('div');
          item.className = `slide-nav-item${i === 0 ? ' active' : ''}`;
          item.dataset.slideIndex = String(i);
          item.innerHTML = `<div class="slide-progress-line"><div class="slide-progress-fill"></div></div><div class="slide-nav-title">${slide.title}</div>`;
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isTransitioning && i !== currentSlideIndex) {
              stopAutoSlideTimer();
              quickResetProgress(currentSlideIndex);
              navigateToSlide(i);
            }
          });
          nav.appendChild(item);
        });
      };

      /* ---- TEXTURE LOADER ---- */
      const loadImageTexture = (src: string) =>
        new Promise<any>((resolve, reject) => {
          const l = new THREE.TextureLoader();
          l.load(
            src,
            (t: any) => {
              t.minFilter = t.magFilter = THREE.LinearFilter;
              t.userData = { size: new THREE.Vector2(t.image.width, t.image.height) };
              resolve(t);
            },
            undefined,
            reject,
          );
        });

      /* ---- RENDERER ---- */
      const initRenderer = async () => {
        const canvas = containerRef.current?.querySelector('.webgl-canvas') as HTMLCanvasElement;
        if (!canvas) return;

        scene = new THREE.Scene();
        camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        shaderMaterial = new THREE.ShaderMaterial({
          uniforms: {
            uTexture1: { value: null },
            uTexture2: { value: null },
            uProgress: { value: 0 },
            uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
            uTexture1Size: { value: new THREE.Vector2(1, 1) },
            uTexture2Size: { value: new THREE.Vector2(1, 1) },
            uGlobalIntensity: { value: SLIDER_CONFIG.globalIntensity },
            uSpeedMultiplier: { value: SLIDER_CONFIG.speedMultiplier },
            uDistortionStrength: { value: SLIDER_CONFIG.distortionStrength },
            uGlassRefractionStrength: { value: SLIDER_CONFIG.glassRefractionStrength },
            uGlassChromaticAberration: { value: SLIDER_CONFIG.glassChromaticAberration },
            uGlassBubbleClarity: { value: SLIDER_CONFIG.glassBubbleClarity },
            uGlassEdgeGlow: { value: SLIDER_CONFIG.glassEdgeGlow },
            uGlassLiquidFlow: { value: SLIDER_CONFIG.glassLiquidFlow },
          },
          vertexShader,
          fragmentShader,
        });

        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shaderMaterial));

        for (const s of slides) {
          try {
            slideTextures.push(await loadImageTexture(s.media));
          } catch {
            console.warn('Failed to load texture:', s.media);
          }
        }

        if (slideTextures.length >= 2) {
          shaderMaterial.uniforms.uTexture1.value = slideTextures[0];
          shaderMaterial.uniforms.uTexture2.value = slideTextures[1];
          shaderMaterial.uniforms.uTexture1Size.value = slideTextures[0].userData.size;
          shaderMaterial.uniforms.uTexture2Size.value = slideTextures[1].userData.size;
          texturesLoaded = true;
          sliderEnabled = true;
          containerRef.current?.querySelector('.slider-wrapper')?.classList.add('loaded');
          safeStartTimer(500);
        }

        const render = () => {
          animFrameId = requestAnimationFrame(render);
          renderer.render(scene, camera);
        };
        render();
      };

      /* ---- EVENT HANDLERS ---- */
      const onVisChange = () => {
        if (document.hidden) stopAutoSlideTimer();
        else if (!isTransitioning) safeStartTimer();
      };
      const onResize = () => {
        if (!renderer) return;
        renderer.setSize(window.innerWidth, window.innerHeight);
        shaderMaterial.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
      };

      document.addEventListener('visibilitychange', onVisChange);
      window.addEventListener('resize', onResize);

      /* ---- INIT ---- */
      createSlidesNavigation();
      updateCounter(0);

      const tEl = document.getElementById('mainTitle');
      const dEl = document.getElementById('mainDesc');
      if (tEl && dEl) {
        tEl.innerHTML = splitText(slides[0].title);
        dEl.textContent = slides[0].description;
        gsap.fromTo(tEl.children, { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 1, stagger: 0.03, ease: 'power3.out', delay: 0.5 });
        gsap.fromTo(dEl, { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 1, ease: 'power3.out', delay: 0.8 });
      }

      initRenderer();

      /* ---- CLEANUP ---- */
      cleanupRef.current = () => {
        sliderEnabled = false;
        stopAutoSlideTimer();
        document.removeEventListener('visibilitychange', onVisChange);
        window.removeEventListener('resize', onResize);
        if (animFrameId) cancelAnimationFrame(animFrameId);
        slideTextures.forEach((t) => t?.dispose?.());
        slideTextures = [];
        if (renderer) {
          renderer.dispose();
          renderer.forceContextLoss();
        }
        if (shaderMaterial) shaderMaterial.dispose();
        if (scene) {
          scene.traverse((obj: any) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
          });
        }
      };
    };

    loadScripts();

    return () => {
      alive = false;
      cleanupRef.current?.();
    };
  }, []);

  return (
    <div ref={containerRef}>
      <div className="slider-wrapper">
        <canvas className="webgl-canvas" />
        <div className="slider-vignette" />
        <span className="slide-number" id="slideNumber">01</span>
        <span className="slide-total" id="slideTotal">06</span>

        <div className="slide-content">
          <h1 className="slide-title" id="mainTitle" />
          <p className="slide-description" id="mainDesc" />
        </div>

        <nav className="slides-navigation" id="slidesNav" />
      </div>
    </div>
  );
};
