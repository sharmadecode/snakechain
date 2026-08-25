/**
 * Procedural Web Audio API Sound Synthesizer
 * Zero external audio assets required — instant, lag-free audio generation.
 */

class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private boostOsc: OscillatorNode | null = null;
  private boostGain: GainNode | null = null;
  private boostFilter: BiquadFilterNode | null = null;
  private isBoosting = false;
  private eatStreak = 0;
  private lastEatTime = 0;
  enabled = true;

  private init(): boolean {
    if (!this.enabled) return false;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return false;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.35, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    return true;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    if (!this.enabled && this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
      this.stopBoost();
    } else if (this.enabled && this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(0.35, this.ctx.currentTime);
    }
    return this.enabled;
  }

  /** Tiny UI blip for menu interactions (chain builder taps). */
  playTick(pitch = 720): void {
    if (!this.init() || !this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(pitch, t);
    gain.gain.setValueAtTime(0.06, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  /** Pleasant harmonic chime on eating food, pitch ascends on rapid combos */
  playEat(): void {
    if (!this.init() || !this.ctx || !this.masterGain) return;
    const now = performance.now();
    if (now - this.lastEatTime < 350) {
      this.eatStreak = Math.min(12, this.eatStreak + 1);
    } else {
      this.eatStreak = 0;
    }
    this.lastEatTime = now;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    // Pentatonic scale frequency calculation
    const baseFreq = 440 * Math.pow(2, (this.eatStreak * 2) / 12);
    osc.type = "sine";
    osc.frequency.setValueAtTime(baseFreq, t);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.4, t + 0.08);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(t);
    osc.stop(t + 0.1);
  }

  /** Start continuous low rocket/thruster hum when boosting */
  startBoost(): void {
    if (this.isBoosting || !this.init() || !this.ctx || !this.masterGain) return;
    this.isBoosting = true;

    const t = this.ctx.currentTime;
    this.boostOsc = this.ctx.createOscillator();
    this.boostFilter = this.ctx.createBiquadFilter();
    this.boostGain = this.ctx.createGain();

    this.boostOsc.type = "sawtooth";
    this.boostOsc.frequency.setValueAtTime(85, t);

    this.boostFilter.type = "lowpass";
    this.boostFilter.frequency.setValueAtTime(220, t);
    this.boostFilter.Q.setValueAtTime(3, t);

    this.boostGain.gain.setValueAtTime(0.01, t);
    this.boostGain.gain.linearRampToValueAtTime(0.18, t + 0.1);

    this.boostOsc.connect(this.boostFilter);
    this.boostFilter.connect(this.boostGain);
    this.boostGain.connect(this.masterGain);

    this.boostOsc.start(t);
  }

  /** Stop rocket hum */
  stopBoost(): void {
    if (!this.isBoosting || !this.ctx || !this.boostGain || !this.boostOsc) return;
    this.isBoosting = false;

    const t = this.ctx.currentTime;
    this.boostGain.gain.linearRampToValueAtTime(0.001, t + 0.08);
    const osc = this.boostOsc;
    setTimeout(() => {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        /* noop */
      }
    }, 100);
    this.boostOsc = null;
    this.boostGain = null;
    this.boostFilter = null;
  }

  /** Resonant deep explosion thud on player death */
  playDeath(): void {
    if (!this.init() || !this.ctx || !this.masterGain) return;
    this.stopBoost();
    const t = this.ctx.currentTime;

    // Sub-bass thud
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(30, t + 0.4);

    gain.gain.setValueAtTime(0.45, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(t);
    osc.stop(t + 0.5);

    // Noise burst for sizzle
    const bufferSize = this.ctx.sampleRate * 0.25;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(600, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + 0.25);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.25, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(this.masterGain);

    noise.start(t);
    noise.stop(t + 0.25);
  }

  /** Victorious chime when scoring a kill */
  playKill(): void {
    if (!this.init() || !this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    const chords = [523.25, 659.25, 783.99, 1046.5]; // C Major arpeggio
    chords.forEach((freq, idx) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      const noteTime = t + idx * 0.06;

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, noteTime);

      gain.gain.setValueAtTime(0.2, noteTime);
      gain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.2);

      osc.connect(gain);
      gain.connect(this.masterGain!);

      osc.start(noteTime);
      osc.stop(noteTime + 0.22);
    });
  }
}

export const audio = new SoundEngine();
