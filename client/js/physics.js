import { COURT } from './config.js';
import { dot, rotateVector } from './math.js';
export const BALL_MASS = 0.04;
export const BALL_DIAMETER = 0.057;
export const BALL_RADIUS = BALL_DIAMETER / 2;
// Effective impact mass: the tracked handle itself is not simulated recoiling.
export const RACQUET_MASS = 0.17;
export const COURT_RESTITUTION = 0.84;
export const RACQUET_RESTITUTION = 0.72;
export const MAX_BALL_SPEED = 85;
export const MAX_RACQUET_SPEED = 60;
export const HIT_COOLDOWN_MS = 50;
export const SPEED_PRESETS = [8, 20, 40, MAX_BALL_SPEED];
export const BALL_TIME_SCALE_MIN = 0.4;
export const BALL_TIME_SCALE_MAX = 1;
export const BALL_TIME_SCALE_PRESETS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
export const RACQUET_RADIUS = 0.155;
// Model +Y (tip) becomes grip -Z (forward); model +Z (front face)
// becomes grip -X (left). Shared by local/remote meshes and server physics.
export const RACQUET_MOUNT = [-0.5, -0.5, 0.5, 0.5];
export const RACQUET_OFFSET = [0, 0, -0.27];
export const RACQUET_FACE_NORMAL = [-1, 0, 0];
export const STEP = 1 / 120;
const minimum = [-COURT.width / 2 + BALL_RADIUS, BALL_RADIUS, -COURT.length / 2 + BALL_RADIUS];
const maximum = [COURT.width / 2 - BALL_RADIUS, COURT.height - BALL_RADIUS, COURT.length / 2 - BALL_RADIUS];

export function clampVelocity(v, maxSpeed) {
  const speed = Math.hypot(...v);
  if (speed > maxSpeed) for (let i = 0; i < 3; i++) v[i] *= maxSpeed / speed;
}
// Continuous time-of-impact against six planes, with bounded work per fixed step.
export function stepBall(ball, dt, maxSpeed = MAX_BALL_SPEED, onImpact, racquet, onTravel) {
  if (!ball) return;
  for (let i = 0; i < 3; i++) ball.p[i] = Math.max(minimum[i], Math.min(maximum[i], ball.p[i]));
  if (ball.p[1] <= BALL_RADIUS + 0.0001 && Math.abs(ball.v[1]) < 0.12) {
    ball.v[1] = 0;
    ball.v[0] *= Math.max(0, 1 - dt * 1.2);
    ball.v[2] *= Math.max(0, 1 - dt * 1.2);
  } else ball.v[1] -= 9.81 * dt;
  clampVelocity(ball.v, maxSpeed);
  let remaining = dt;
  for (let count = 0; count < 8 && remaining > 1e-7; count++) {
    let time = remaining, axis = -1, side = 0;
    for (let i = 0; i < 3; i++) {
      const velocity = ball.v[i];
      if (Math.abs(velocity) < 1e-9) continue;
      const boundary = velocity > 0 ? maximum[i] : minimum[i];
      const candidate = (boundary - ball.p[i]) / velocity;
      if (candidate >= -1e-8 && candidate <= time) { time = Math.max(0, candidate); axis = i; side = velocity > 0 ? 1 : -1; }
    }
    // Test each uninterrupted flight segment, before the next wall bounce.
    // Sweeping the frame's start/end chord could invent or miss a racquet hit.
    if (racquet && !racquet.hit) {
      interpolateRacquet(racquet.start, racquet.previous, racquet.current, (dt - remaining) / dt);
      interpolateRacquet(racquet.end, racquet.previous, racquet.current, (dt - remaining + time) / dt);
      for (let i = 0; i < 3; i++) racquet.ballEnd[i] = ball.p[i] + ball.v[i] * time;
      const contact = sweepRacquet(ball.p, racquet.ballEnd, racquet.start, racquet.end);
      if (contact && dot(ball.v, contact.normal) - dot(racquet.velocity, contact.normal) < -0.001) {
        const consumed = time * contact.fraction;
        for (let i = 0; i < 3; i++) ball.p[i] = contact.p[i] + contact.normal[i] * 0.0001;
        const incoming = [...ball.v];
        ball.v = hitVelocity(incoming, contact.normal, racquet.velocity, maxSpeed);
        racquet.hit = true;
        racquet.onHit?.(contact.p, contact.normal, incoming, ball.v);
        remaining -= consumed;
        continue;
      }
    }
    onTravel?.(ball.p, ball.v, time);
    for (let i = 0; i < 3; i++) ball.p[i] += ball.v[i] * time;
    remaining -= time;
    if (axis < 0) break;
    const strength = Math.abs(ball.v[axis]);
    const floor = axis === 1 && side === -1;
    ball.v[axis] *= -COURT_RESTITUTION;
    ball.p[axis] += side * -0.00001;
    if (floor && Math.abs(ball.v[1]) < 0.12) ball.v[1] = 0;
    if (strength > 0.2) onImpact?.(floor ? 'floor' : 'wall', ball.p, strength);
  }
}

const paddle = () => ({ center: [0, 0, 0], normal: [0, 0, 1] });
export function createRacquetSweep(onHit) {
  return { previous: paddle(), current: paddle(), start: paddle(), end: paddle(), velocity: [0, 0, 0], ballEnd: [0, 0, 0], hit: false, onHit };
}
function interpolateRacquet(out, a, b, t) {
  for (let i = 0; i < 3; i++) {
    out.center[i] = a.center[i] + (b.center[i] - a.center[i]) * t;
    out.normal[i] = a.normal[i] + (b.normal[i] - a.normal[i]) * t;
  }
  const length = Math.hypot(...out.normal);
  for (let i = 0; i < 3; i++) out.normal[i] = length > 1e-8 ? out.normal[i] / length : b.normal[i];
}

export function predictBall(ball, dt, maxSpeed, previous, current, sweep, timeScale = 1) {
  // dt is wall-clock time so racquet motion remains real-time. Only the
  // ball's simulated clock is scaled for slow-motion practice.
  const scale = Number.isFinite(timeScale) ? Math.max(BALL_TIME_SCALE_MIN, Math.min(BALL_TIME_SCALE_MAX, timeScale)) : 1;
  const simulatedDt = dt * scale;
  const steps = Math.max(1, Math.ceil(simulatedDt / STEP));
  if (sweep) {
    sweep.hit = false;
    for (let i = 0; i < 3; i++) sweep.velocity[i] = (current.center[i] - previous.center[i]) / dt;
    if (Math.hypot(...sweep.velocity) > MAX_RACQUET_SPEED) sweep = null;
  }
  for (let i = 0; i < steps; i++) {
    if (sweep) {
      interpolateRacquet(sweep.previous, previous, current, i / steps);
      interpolateRacquet(sweep.current, previous, current, (i + 1) / steps);
    }
    stepBall(ball, simulatedDt / steps, maxSpeed, undefined, sweep);
  }
}

export function racquetPose(out, grip) {
  rotateVector(out.center, RACQUET_OFFSET, grip.q);
  for (let i = 0; i < 3; i++) out.center[i] += grip.p[i];
  rotateVector(out.normal, RACQUET_FACE_NORMAL, grip.q);
  return out;
}

// Relative sweep of ball and moving racquet disk. Rotation is sampled each XR frame.
export function sweepRacquet(ballPrevious, ballCurrent, previous, current) {
  const ax = ballPrevious[0] - previous.center[0], ay = ballPrevious[1] - previous.center[1], az = ballPrevious[2] - previous.center[2];
  const bx = ballCurrent[0] - current.center[0], by = ballCurrent[1] - current.center[1], bz = ballCurrent[2] - current.center[2];
  const d0 = ax * previous.normal[0] + ay * previous.normal[1] + az * previous.normal[2];
  const d1 = bx * current.normal[0] + by * current.normal[1] + bz * current.normal[2];
  const side = d0 >= 0 ? 1 : -1;
  const approach = (d1 - d0) * side;
  if (approach >= -1e-9 || d1 * side > BALL_RADIUS) return null;
  const fraction = Math.max(0, Math.min(1, (side * BALL_RADIUS - d0) / (d1 - d0)));
  const x = ax + (bx - ax) * fraction, y = ay + (by - ay) * fraction, z = az + (bz - az) * fraction;
  const normal = previous.normal.map((n, i) => n + (current.normal[i] - n) * fraction);
  const length = Math.hypot(...normal);
  if (length < 1e-8) return null;
  for (let i = 0; i < 3; i++) normal[i] /= length;
  const planeDistance = x * normal[0] + y * normal[1] + z * normal[2];
  const radial = Math.hypot(x - planeDistance * normal[0], y - planeDistance * normal[1], z - planeDistance * normal[2]);
  if (radial > RACQUET_RADIUS + BALL_RADIUS) return null;
  return { p: ballPrevious.map((value, i) => value + (ballCurrent[i] - value) * fraction), normal: normal.map(n => n * side), fraction };
}

export function hitVelocity(ballVelocity, normal, paddleVelocity, maxSpeed = MAX_BALL_SPEED) {
  const relative = dot(ballVelocity, normal) - dot(paddleVelocity, normal);
  // Normal points from the racquet toward the approaching ball. Separating
  // contacts receive no impulse. Tangential velocity is unchanged (no spin).
  const impulse = relative < 0 ? -(1 + RACQUET_RESTITUTION) * relative / (1 / BALL_MASS + 1 / RACQUET_MASS) : 0;
  const result = ballVelocity.map((value, i) => value + impulse / BALL_MASS * normal[i]);
  clampVelocity(result, maxSpeed);
  return result;
}
