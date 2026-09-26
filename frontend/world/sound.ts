/**
 * The island's sound: a looping music bed, footsteps, Lumi's voice and a few
 * effects, mixed with the Web Audio API.
 *
 * The recorded sounds in /world/sfx come from tools/mascot/phase6_world_sounds.py
 * (Lyria music and chimes, gpt-audio voice, Veo foley footsteps). Wind, the
 * sprint whoosh, the jump boing and the landing thud are synthesised here, so
 * they cost no downloads and can follow Lumi's speed exactly.
 */

const FILES = [
  'music', 'step1', 'step2', 'step3', 'step4', 'step5', 'step6',
  'ding', 'sparkle', 'flourish', 'voice_hup', 'voice_wheee', 'voice_ooh', 'voice_yay',
] as const;
type Sound = (typeof FILES)[number];

const MUTE_KEY = 'lumina-world-muted';
const MUSIC_LEVEL = 0.32;

export function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

export class WorldAudio {
  private ctx: AudioContext;
  private master: GainNode;
  private music: GainNode;
  private sfx: GainNode;
  private buffers = new Map<Sound, AudioBuffer>();
  private noise: AudioBuffer;
  private wind: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private lastStep = -1;
  private lastVoice = 0;
  muted: boolean;

  constructor() {
    this.ctx = new AudioContext();
    this.muted = readMuted();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    this.music = this.ctx.createGain();
    this.music.gain.value = MUSIC_LEVEL;
    this.music.connect(this.master);
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);

    // One second of white noise, reused by every synthesised sound.
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  /** Download and decode everything; a sound that fails simply stays silent. */
  async load(): Promise<void> {
    await Promise.all(FILES.map(async (name) => {
      try {
        const response = await fetch(`/world/sfx/${name}.mp3`);
        if (!response.ok) return;
        this.buffers.set(name, await this.ctx.decodeAudioData(await response.arrayBuffer()));
      } catch { /* optional */ }
    }));
  }

  /** Browsers start audio suspended until the page is interacted with. */
  resume(): void {
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* per-viewer nicety */ }
    this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.05);
    this.resume();
  }

  startMusic(): void {
    const buffer = this.buffers.get('music');
    if (!buffer || this.musicSource) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this.music);
    this.music.gain.setValueAtTime(0, this.ctx.currentTime);
    this.music.gain.linearRampToValueAtTime(MUSIC_LEVEL, this.ctx.currentTime + 2.5);
    src.start();
    this.musicSource = src;
  }

  /** Quieter music while a photo is open. */
  duck(on: boolean): void {
    this.music.gain.setTargetAtTime(on ? MUSIC_LEVEL * 0.35 : MUSIC_LEVEL, this.ctx.currentTime, 0.25);
  }

  private play(name: Sound, { volume = 1, rate = 1, delay = 0 } = {}): void {
    const buffer = this.buffers.get(name);
    if (!buffer || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(this.sfx);
    src.start(this.ctx.currentTime + delay);
  }

  /** Lumi's voice, not more than once every `gap` seconds. */
  private voice(name: Sound, volume: number, gap = 1.2): void {
    const now = this.ctx.currentTime;
    if (now - this.lastVoice < gap) return;
    this.lastVoice = now;
    this.play(name, { volume, rate: 0.97 + Math.random() * 0.06 });
  }

  private noiseBurst(duration: number, filter: BiquadFilterType, from: number, to: number, volume: number, q = 1): void {
    if (this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(volume, t + duration * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 0.5, duration + 0.05);
  }

  private tone(type: OscillatorType, from: number, to: number, duration: number, volume: number): void {
    if (this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.sfx);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /* ---- what the island calls ---- */

  step(sprinting: boolean): void {
    let pick = Math.floor(Math.random() * 6);
    if (pick === this.lastStep) pick = (pick + 1) % 6;
    this.lastStep = pick;
    this.play(`step${pick + 1}` as Sound, {
      volume: sprinting ? 0.75 : 0.55,
      rate: (sprinting ? 1.12 : 1) * (0.92 + Math.random() * 0.16),
    });
  }

  jump(): void {
    this.tone('sine', 260, 620, 0.16, 0.18); // springy boing
    this.noiseBurst(0.18, 'bandpass', 600, 2200, 0.12, 0.8);
    if (Math.random() < 0.7) this.voice('voice_hup', 0.8, 0.5);
  }

  land(impact: number): void {
    const k = Math.min(1, impact / 10);
    this.tone('sine', 140, 48, 0.16, 0.35 * k + 0.1); // soft thud
    this.noiseBurst(0.14, 'lowpass', 900, 200, 0.2 * k + 0.05);
    this.step(false);
  }

  sprintStart(): void {
    this.noiseBurst(0.42, 'bandpass', 350, 2600, 0.35, 1.4); // whoosh
    this.voice('voice_wheee', 0.7, 6);
  }

  /** Continuous wind that rises with speed (0 when still, 1 at full sprint). */
  setWind(amount: number): void {
    if (this.ctx.state !== 'running') return;
    if (!this.wind) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 0.7;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.sfx);
      src.start();
      this.wind = { gain, filter };
    }
    const t = this.ctx.currentTime;
    this.wind.gain.gain.setTargetAtTime(amount * amount * 0.22, t, 0.15);
    this.wind.filter.frequency.setTargetAtTime(500 + amount * 1400, t, 0.2);
  }

  photo(): void {
    this.play('sparkle', { volume: 0.7 });
    this.voice('voice_ooh', 0.55, 3);
  }

  board(): void {
    this.play('flourish', { volume: 0.7 });
    this.voice('voice_yay', 0.6, 3);
  }

  zone(): void {
    this.play('ding', { volume: 0.5 });
  }

  dispose(): void {
    this.ctx.close().catch(() => undefined);
  }
}
