// Original synthesized impact timbres, cached once. Replace buffers with locally
// decoded recordings later; these are not presented as recorded racquetball audio.
export class SpatialAudio {
  constructor() { this.voices = []; this.buffers = {}; this.index = 0; this.enabled = true; }
  async unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain(); this.master.gain.value = 0.45; this.master.connect(this.context.destination);
      for (let i = 0; i < 12; i++) {
        const panner = this.context.createPanner();
        panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 1; panner.maxDistance = 30; panner.rolloffFactor = 1;
        const gain = this.context.createGain(); panner.connect(gain); gain.connect(this.master);
        this.voices.push({ panner, gain, source: null });
      }
      let seed = 991;
      const noise = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2147483648 - 1; };
      for (const [kind, frequency, decay] of [['floor', 170, 22], ['wall', 420, 32], ['racquet', 950, 48]]) {
        const buffer = this.context.createBuffer(1, this.context.sampleRate * 0.22, this.context.sampleRate);
        const samples = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) {
          const t = i / this.context.sampleRate;
          samples[i] = (0.6 * noise() * Math.exp(-t * 95) + 0.35 * Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t * decay));
        }
        this.buffers[kind] = buffer;
      }
    }
    await this.context.resume();
  }
  listener(position, forward, up) {
    if (!this.context || this.context.state !== 'running') return;
    const listener = this.context.listener, t = this.context.currentTime;
    if (listener.positionX) {
      for (let i = 0; i < 3; i++) {
        const axis = 'XYZ'[i];
        listener[`position${axis}`].setTargetAtTime(position[i], t, 0.01);
        listener[`forward${axis}`].setTargetAtTime(forward[i], t, 0.01);
        listener[`up${axis}`].setTargetAtTime(up[i], t, 0.01);
      }
    } else { listener.setPosition(...position); listener.setOrientation(...forward, ...up); }
  }
  play(kind, position, strength) {
    if (!this.enabled || !this.context || this.context.state !== 'running') return;
    const voice = this.voices[this.index++ % this.voices.length];
    voice.source?.stop(); voice.source?.disconnect();
    const source = this.context.createBufferSource(); source.buffer = this.buffers[kind] || this.buffers.wall;
    const t = this.context.currentTime;
    voice.panner.positionX.setValueAtTime(position[0], t); voice.panner.positionY.setValueAtTime(position[1], t); voice.panner.positionZ.setValueAtTime(position[2], t);
    voice.gain.gain.setValueAtTime(Math.min(1, Math.max(0.08, strength / 10)), t);
    source.connect(voice.panner); source.onended = () => { source.disconnect(); if (voice.source === source) voice.source = null; };
    voice.source = source; source.start();
  }
  stop() { for (const voice of this.voices) { voice.source?.stop(); voice.source?.disconnect(); voice.source = null; } }
}
