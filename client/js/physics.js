import { COURT } from './config.js';
import { dot, rotateVector } from './math.js';
export const BALL_RADIUS = 0.0286;
export const RACQUET_RADIUS = 0.155;
export const RACQUET_OFFSET = [0, 0.27, 0];
const faceNormal = [0, 0, 1];
export const STEP = 1 / 120;
const minimum = [-COURT.width / 2 + BALL_RADIUS, BALL_RADIUS, -COURT.length / 2 + BALL_RADIUS];
const maximum = [COURT.width / 2 - BALL_RADIUS, COURT.height - BALL_RADIUS, COURT.length / 2 - BALL_RADIUS];

export function clampVelocity(v, maxSpeed) {
  const speed = Math.hypot(...v);
  if (speed > maxSpeed) for (let i = 0; i < 3; i++) v[i] *= maxSpeed / speed;
}
// Continuous time-of-impact against six planes, with bounded work per fixed step.
export function stepBall(ball, dt, maxSpeed = 8, onImpact) {
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
    for (let i = 0; i < 3; i++) ball.p[i] += ball.v[i] * time;
    remaining -= time;
    if (axis < 0) break;
    const strength = Math.abs(ball.v[axis]);
    const floor = axis === 1 && side === -1;
    ball.v[axis] *= -(floor ? 0.76 : 0.88);
    ball.p[axis] += side * -0.00001;
    if (floor && Math.abs(ball.v[1]) < 0.12) ball.v[1] = 0;
    if (strength > 0.2) onImpact?.(floor ? 'floor' : 'wall', ball.p, strength);
  }
}

export function racquetPose(out, grip) {
  rotateVector(out.center, RACQUET_OFFSET, grip.q);
  for (let i = 0; i < 3; i++) out.center[i] += grip.p[i];
  rotateVector(out.normal, faceNormal, grip.q);
  return out;
}

// Relative sweep of ball and moving racquet disk. Rotation is sampled each XR frame.
export function sweepRacquet(ballPrevious, ballCurrent, previous, current) {
  const ax = ballPrevious[0] - previous.center[0], ay = ballPrevious[1] - previous.center[1], az = ballPrevious[2] - previous.center[2];
  const bx = ballCurrent[0] - current.center[0], by = ballCurrent[1] - current.center[1], bz = ballCurrent[2] - current.center[2];
  const d0 = ax * previous.normal[0] + ay * previous.normal[1] + az * previous.normal[2];
  const d1 = bx * current.normal[0] + by * current.normal[1] + bz * current.normal[2];
  if (d0 * d1 > 0 && Math.min(Math.abs(d0), Math.abs(d1)) > BALL_RADIUS + 0.015) return null;
  const fraction = Math.abs(d0 - d1) > 1e-7 ? Math.max(0, Math.min(1, d0 / (d0 - d1))) : 1;
  const x = ax + (bx - ax) * fraction, y = ay + (by - ay) * fraction, z = az + (bz - az) * fraction;
  const planeDistance = x * current.normal[0] + y * current.normal[1] + z * current.normal[2];
  const radial = Math.hypot(x - planeDistance * current.normal[0], y - planeDistance * current.normal[1], z - planeDistance * current.normal[2]);
  if (radial > RACQUET_RADIUS + BALL_RADIUS) return null;
  return ballPrevious.map((value, i) => value + (ballCurrent[i] - value) * fraction);
}

export function hitVelocity(ballVelocity, normal, paddleVelocity, maxSpeed) {
  const relative = dot(ballVelocity, normal) - dot(paddleVelocity, normal);
  const result = ballVelocity.map((value, i) => value - 1.85 * relative * normal[i]);
  clampVelocity(result, maxSpeed);
  return result;
}
