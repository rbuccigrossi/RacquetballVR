import { distance, transformPoint, rotateVector } from './math.js';

export const ALIGNMENT_TOLERANCE = 0.08;
export const MIN_BASELINE = 0.4;
export function validateAnchors(points) {
  if (!Array.isArray(points) || points.length !== 2 || !points.every(p => Array.isArray(p) && p.length === 3 && p.every(n => Number.isFinite(n) && Math.abs(n) < 100))) return 'Choose two valid stationary points.';
  if (Math.hypot(points[1][0] - points[0][0], points[1][2] - points[0][2]) < MIN_BASELINE) return 'Choose a second spot farther to the side, not directly above the first.';
  return null;
}

// Player 1 establishes the room center/facing from their initial headset pose.
// Floor height remains supplied by local-floor; anchor points may be any height.
export function centerAlignment(head) {
  const forward = rotateVector([0, 0, 0], [0, 0, -1], head.q);
  const yaw = Math.atan2(forward[0], -forward[2]);
  const rotated = transformPoint([0, 0, 0], head.p, { yaw, offset: [0, 0, 0] });
  return { yaw, offset: [-rotated[0], 0, -rotated[2]] };
}

export function solveAlignment(a, b, targetA, targetB) {
  const error = validateAnchors([a, b]) || validateAnchors([targetA, targetB]);
  if (error) throw new Error(error);
  const yaw = Math.atan2(b[2] - a[2], b[0] - a[0]) - Math.atan2(targetB[2] - targetA[2], targetB[0] - targetA[0]);
  const middle = a.map((n, i) => (n + b[i]) / 2);
  const targetMiddle = targetA.map((n, i) => (n + targetB[i]) / 2);
  const rotated = transformPoint([0, 0, 0], middle, { yaw, offset: [0, 0, 0] });
  const alignment = { yaw, offset: targetMiddle.map((n, i) => n - rotated[i]) };
  const residual = Math.max(distance(transformPoint([0, 0, 0], a, alignment), targetA), distance(transformPoint([0, 0, 0], b, alignment), targetB));
  if (residual > ALIGNMENT_TOLERANCE) throw new Error('The two spots do not match. Restart and touch the same A and B in the same order.');
  return { ...alignment, residual };
}

export class Calibration {
  constructor(space, options = {}) { this.reset(space, options); }
  reset(space, { defining = false, targets = null, alignment = null } = {}) {
    this.defining = defining;
    this.targets = targets;
    this.stage = 0;
    this.samples = [];
    this.points = [];
    this.collecting = false;
    this.alignment = alignment;
    this.error = null;
  }
  startSample(now) {
    if (this.collecting || this.complete) return;
    if (!this.defining && !this.targets) { this.error = 'Waiting for your partner to choose A and B.'; return; }
    this.samples = []; this.started = now; this.collecting = true; this.error = null;
  }
  sample(point, now) {
    if (!this.collecting) return false;
    this.samples.push([...point]);
    if (now - this.started < 350) return false;
    this.collecting = false;
    if (this.samples.length < 10) { this.error = 'Tracking too slow. Hold steady and retry.'; return false; }
    const mean = [0, 0, 0];
    for (const sample of this.samples) for (let i = 0; i < 3; i++) mean[i] += sample[i] / this.samples.length;
    if (this.samples.some(sample => distance(sample, mean) > 0.025)) { this.error = 'Controller moved. Hold steady and press the right trigger again.'; return false; }
    this.points[this.stage] = mean;
    try {
      if (this.stage === 1) {
        if (this.defining) {
          const error = validateAnchors(this.points);
          if (error) throw new Error(error);
          this.targets = this.points.map(p => transformPoint([0, 0, 0], p, this.alignment));
          this.residual = 0;
        } else {
          this.alignment = solveAlignment(this.points[0], mean, this.targets[0], this.targets[1]);
          this.residual = this.alignment.residual;
        }
      }
      this.stage++;
      return true;
    } catch (error) { this.error = error.message; return false; }
  }
  get complete() { return this.stage === 2; }
  get instruction() {
    if (this.error) return this.error;
    if (this.collecting) return 'Hold the RIGHT controller still…';
    if (this.complete) return 'Aligned. Check your partner’s real head and hands, then RIGHT grip to mark ready.';
    if (this.defining) return this.stage === 0
      ? 'Choose spot A on the floor or furniture. Rest your RIGHT controller against it and press trigger.'
      : 'Choose a different stationary spot B to the side. Rest your RIGHT controller against it and press trigger.';
    if (!this.targets) return 'Your partner is choosing two physical spots. Wait for A and B.';
    return `Touch the SAME physical spot ${this.stage === 0 ? 'A' : 'B'} your partner chose. Match controller position and direction, then RIGHT trigger. Floating labels are approximate until aligned.`;
  }
}
