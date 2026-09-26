import { MOOD_BPM, type Mood } from './storyboard';

/**
 * A soundtrack composed on the fly with an OfflineAudioContext: exactly as
 * long as the movie, on the same beat grid as the cuts, and royalty-free by
 * construction. Returns a WAV blob the movie's <Audio> plays and the exporter
 * muxes in as AAC.
 */

const SAMPLE_RATE = 44100;

/** MIDI note to Hz. */
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

interface MoodSpec {
  /** Chords as MIDI notes, one per bar. */
  chords: number[][];
  drums: boolean;
  pluck: 'guitar' | 'musicbox';
  reverb: number;
}

const MOODS: Record<Mood, MoodSpec> = {
  // I–V–vi–IV in C: bright, bouncy.
  sunny: {
    chords: [[60, 64, 67, 72], [55, 59, 62, 67], [57, 60, 64, 69], [53, 57, 60, 65]],
    drums: true,
    pluck: 'guitar',
    reverb: 0.28,
  },
  // Fmaj7–Em7–Dm7–Cmaj7: soft and wistful.
  dreamy: {
    chords: [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]],
    drums: false,
    pluck: 'musicbox',
    reverb: 0.45,
  },
};

function impulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let seed = ch + 1;
    for (let i = 0; i < length; i++) {
      seed = (seed * 16807) % 2147483647;
      data[i] = ((seed / 2147483647) * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 7;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 16807) % 2147483647;
    data[i] = (seed / 2147483647) * 2 - 1;
  }
  return buffer;
}

export async function composeSoundtrack({ mood, seconds, dropBeat }: { mood: Mood; seconds: number; dropBeat: number }): Promise<Blob> {
  const spec = MOODS[mood];
  const beat = 60 / MOOD_BPM[mood];
  const total = seconds + 0.05;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * SAMPLE_RATE), SAMPLE_RATE);

  // Master: gentle compression, fade in and out.
  const master = ctx.createGain();
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(0.9, 0.4);
  master.gain.setValueAtTime(0.9, Math.max(0.5, total - 2.4));
  master.gain.linearRampToValueAtTime(0, total);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 3;
  master.connect(comp).connect(ctx.destination);

  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx, mood === 'dreamy' ? 3.2 : 2.2, 2.6);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = spec.reverb;
  reverb.connect(reverbGain).connect(master);

  // Echo for the plucks: dotted-eighth feedback delay.
  const delay = ctx.createDelay(2);
  delay.delayTime.value = beat * 0.75;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.28;
  const delayOut = ctx.createGain();
  delayOut.gain.value = 0.22;
  delay.connect(feedback).connect(delay);
  delay.connect(delayOut).connect(master);

  const noise = noiseBuffer(ctx);
  const bars = Math.ceil(total / (beat * 4));
  const dropAt = Math.ceil(dropBeat / 4) * 4 * beat;
  const outroAt = total - beat * 4;

  const pad = (notes: number[], start: number, length: number) => {
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = mood === 'dreamy' ? 900 : 1400;
    filter.Q.value = 0.6;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(0.055, start + (mood === 'dreamy' ? 0.6 : 0.25));
    env.gain.setValueAtTime(0.055, start + length - 0.05);
    env.gain.linearRampToValueAtTime(0, start + length + 0.6);
    filter.connect(env);
    env.connect(master);
    env.connect(reverb);
    for (const note of notes) {
      for (const detune of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz(note);
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(start);
        osc.stop(start + length + 0.7);
      }
    }
  };

  const pluck = (note: number, start: number, gain: number) => {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const decay = spec.pluck === 'musicbox' ? 1.1 : 0.35;
    osc.type = spec.pluck === 'musicbox' ? 'sine' : 'triangle';
    osc.frequency.value = hz(note);
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    osc.connect(env);
    if (spec.pluck === 'musicbox') {
      // A quiet overtone gives the music-box ping.
      const bell = ctx.createOscillator();
      const bellEnv = ctx.createGain();
      bell.frequency.value = hz(note) * 4;
      bellEnv.gain.setValueAtTime(gain * 0.25, start);
      bellEnv.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
      bell.connect(bellEnv).connect(master);
      bell.start(start);
      bell.stop(start + 0.45);
    }
    env.connect(master);
    env.connect(delay);
    env.connect(reverb);
    osc.start(start);
    osc.stop(start + decay + 0.05);
  };

  const bass = (note: number, start: number, length: number) => {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = hz(note - 24);
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(0.22, start + 0.02);
    env.gain.exponentialRampToValueAtTime(0.02, start + length);
    osc.connect(env).connect(master);
    osc.start(start);
    osc.stop(start + length + 0.02);
  };

  const kick = (start: number) => {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.setValueAtTime(140, start);
    osc.frequency.exponentialRampToValueAtTime(42, start + 0.14);
    env.gain.setValueAtTime(0.55, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
    osc.connect(env).connect(master);
    osc.start(start);
    osc.stop(start + 0.32);
  };

  const hit = (start: number, type: 'clap' | 'hat' | 'shaker', gain: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();
    const length = type === 'clap' ? 0.16 : type === 'hat' ? 0.045 : 0.09;
    filter.type = type === 'clap' ? 'bandpass' : 'highpass';
    filter.frequency.value = type === 'clap' ? 1600 : 7000;
    env.gain.setValueAtTime(gain, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + length);
    src.connect(filter).connect(env);
    env.connect(master);
    if (type === 'clap') env.connect(reverb);
    src.start(start, (start * 7.13) % 0.8);
    src.stop(start + length + 0.01);
  };

  // Rising noise sweep into the drop.
  if (spec.drums && dropAt > beat * 2 && dropAt < outroAt) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(400, dropAt - beat * 2);
    filter.frequency.exponentialRampToValueAtTime(6000, dropAt);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, dropAt - beat * 2);
    env.gain.exponentialRampToValueAtTime(0.09, dropAt - 0.02);
    env.gain.linearRampToValueAtTime(0, dropAt + 0.02);
    src.connect(filter).connect(env).connect(master);
    src.start(dropAt - beat * 2);
    src.stop(dropAt + 0.05);
  }

  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * beat * 4;
    if (t0 >= total) break;
    const chord = spec.chords[bar % spec.chords.length];
    pad(chord, t0, beat * 4);
    const full = t0 >= dropAt && t0 < outroAt;

    // Arpeggio: eighths once the beat drops, quarters before.
    const steps = full ? 8 : 4;
    const pattern = [0, 1, 2, 3, 2, 1, 2, 3];
    for (let s = 0; s < steps; s++) {
      const at = t0 + s * (beat * 4 / steps);
      if (at >= total - 0.3) break;
      const note = chord[pattern[s % pattern.length] % chord.length] + 12;
      pluck(note, at, (full ? 0.07 : 0.06) * (s % 2 ? 0.75 : 1));
    }
    if (full || !spec.drums) bass(chord[0], t0, beat * 2);
    if (full || !spec.drums) bass(chord[0], t0 + beat * 2, beat * 2);

    if (spec.drums && full) {
      for (let b = 0; b < 4; b++) {
        const at = t0 + b * beat;
        if (b === 0 || b === 2) kick(at);
        if (b === 1 || b === 3) hit(at, 'clap', 0.3);
        hit(at, 'hat', 0.05);
        hit(at + beat / 2, 'hat', 0.08);
      }
    } else if (!spec.drums && t0 >= dropAt && t0 < outroAt) {
      for (let b = 0; b < 8; b++) hit(t0 + (b * beat) / 2, 'shaker', b % 2 ? 0.025 : 0.04);
    }
  }

  const rendered = await ctx.startRendering();
  return toWav(rendered);
}

function toWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = 44 + frames * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const text = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
