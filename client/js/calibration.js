import { FEET } from './config.js';
import { distance, transformPoint } from './math.js';

export const MARKER_HEIGHT = 0.10;
export const ALIGNMENT_TOLERANCE = 0.08;
export function calibrationTargets(space) {
  const a = [-space.width * FEET / 2, MARKER_HEIGHT, space.depth * FEET / 2];
  return [a, [a[0] + 1, a[1], a[2]], [a[0], a[1], a[2] - 1]];
}
export function solveAlignment(a, b, targetA) {
  const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
  if (Math.abs(length - 1) > 0.05 || Math.abs(b[1] - a[1]) > 0.04) throw new Error('A and B must be 1 meter apart at the same height. Retry calibration.');
  const yaw = Math.atan2(b[2] - a[2], b[0] - a[0]);
  const rotated = transformPoint([0, 0, 0], a, { yaw, offset: [0, 0, 0] });
  return { yaw, offset: targetA.map((value, i) => value - rotated[i]) };
}

export class Calibration {
  constructor(space) { this.reset(space); }
  reset(space) {
    this.targets = calibrationTargets(space);
    this.stage = 0;
    this.samples = [];
    this.points = [];
    this.collecting = false;
    this.alignment = null;
    this.error = null;
  }
  startSample(now) {
    if (this.collecting || this.stage >= 3) return;
    this.samples = [];
    this.started = now;
    this.collecting = true;
    this.error = null;
  }
  sample(point, now) {
    if (!this.collecting) return false;
    this.samples.push([...point]);
    if (now - this.started < 500) return false;
    this.collecting = false;
    if (this.samples.length < 15) { this.error = 'Tracking too slow. Hold steady and retry.'; return false; }
    const mean = [0, 0, 0];
    for (const sample of this.samples) for (let i = 0; i < 3; i++) mean[i] += sample[i] / this.samples.length;
    if (this.samples.some(sample => distance(sample, mean) > 0.025)) { this.error = 'Controller moved. Hold steady and press the right trigger again.'; return false; }
    this.points[this.stage] = mean;
    try {
      if (this.stage === 1) this.alignment = solveAlignment(this.points[0], mean, this.targets[0]);
      if (this.stage === 2) {
        this.residual = distance(transformPoint([0, 0, 0], mean, this.alignment), this.targets[2]);
        if (this.residual > ALIGNMENT_TOLERANCE) throw new Error('Third marker differs by more than 8 cm. Restart alignment.');
      }
      this.stage++;
      return true;
    } catch (error) { this.error = error.message; return false; }
  }
  get complete() { return this.stage === 3; }
  get instruction() {
    if (this.error) return this.error;
    if (this.collecting) return 'Hold the RIGHT controller still…';
    return [
      'A: Right controller over rear-left floor mark, grip center 10 cm high. Press RIGHT trigger.',
      'B: Move 1 meter RIGHT along the marked edge. Same height. Press RIGHT trigger.',
      'C: Return to A, then 1 meter FORWARD. Same height. Press RIGHT trigger.',
      'Aligned. Check each other’s hands, then press RIGHT grip to mark ready.'
    ][this.stage];
  }
}
