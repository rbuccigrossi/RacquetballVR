import test from 'node:test';
import assert from 'node:assert/strict';
import { BALL_MASS, BALL_RADIUS, BALL_DIAMETER, RACQUET_MASS, COURT_RESTITUTION, RACQUET_RESTITUTION, MAX_BALL_SPEED, STEP, stepBall, hitVelocity, sweepRacquet, predictBall, createRacquetSweep } from '../../client/js/physics.js';
import { COURT } from '../../client/js/config.js';

const close = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
test('finite-mass impulse conserves momentum, loses energy, and preserves tangential motion', () => {
  assert.equal(BALL_MASS, 0.04); assert.equal(BALL_DIAMETER, 0.057);
  const incoming = [2, -10, 3], paddle = [0, 5, 0];
  const out = hitVelocity(incoming, [0, 1, 0], paddle);
  const impulse = BALL_MASS * (out[1] - incoming[1]);
  const recoil = paddle[1] - impulse / RACQUET_MASS;
  close(BALL_MASS * out[1] + RACQUET_MASS * recoil, BALL_MASS * incoming[1] + RACQUET_MASS * paddle[1]);
  close(out[1] - recoil, RACQUET_RESTITUTION * 15);
  assert.ok(BALL_MASS * out[1] ** 2 + RACQUET_MASS * recoil ** 2 < BALL_MASS * 100 + RACQUET_MASS * 25);
  assert.equal(out[0], 2); assert.equal(out[2], 3);
  close(hitVelocity([0, -10, 0], [0, 1, 0], [0, 0, 0])[1], 3.923809523809524);
  assert.deepEqual(hitVelocity([0, 2, 0], [0, 1, 0], [0, 0, 0]), [0, 2, 0]);
  close(Math.hypot(...hitVelocity([0, -85, 0], [0, 1, 0], [0, 60, 0])), MAX_BALL_SPEED);
});

test('100-inch drop rebounds within the 68–72-inch specification', () => {
  const ball = { p: [0, BALL_RADIUS + 2.54, 0], v: [0, 0, 0] };
  let bounced = false, height = 0;
  for (let i = 0; i < 360; i++) {
    stepBall(ball, STEP, MAX_BALL_SPEED, kind => { if (kind === 'floor') bounced = true; });
    if (bounced) { height = Math.max(height, ball.p[1] - BALL_RADIUS); if (ball.v[1] < 0) break; }
  }
  const inches = height / 0.0254;
  assert.ok(inches >= 68 && inches <= 72, `Rebound ${inches} inches`);
});

test('all six court surfaces reflect the normal velocity with e=0.84, including 85 m/s impacts', () => {
  for (const axis of [0, 1, 2]) for (const side of [-1, 1]) {
    const ball = { p: [0, 2, 0], v: [0, 0, 0] };
    const wall = axis === 0 ? side * COURT.width / 2 : axis === 2 ? side * COURT.length / 2 : side < 0 ? 0 : COURT.height;
    ball.p[axis] = wall - side * (BALL_RADIUS + 0.005);
    ball.v[axis] = side * 85;
    stepBall(ball, 0.001);
    close(Math.abs(ball.v[axis]), COURT_RESTITUTION * (axis === 1 && side > 0 ? 85 - 9.81 * 0.001 : 85), 0.001);
    assert.equal(Math.sign(ball.v[axis]), -side);
    assert.ok(ball.p.every(Number.isFinite));
  }
});

test('racquet sweep detects either face at high speed, but rejects a separating near-contact', () => {
  const paddle = { center: [0, 1, 0], normal: [0, 0, 1] };
  for (const side of [-1, 1]) {
    const hit = sweepRacquet([0, 1, side * 0.5], [0, 1, -side * 0.5], paddle, paddle);
    close(hit.p[2], side * BALL_RADIUS); close(hit.normal[2], side);
  }
  assert.equal(sweepRacquet([0, 1, 0.02], [0, 1, 0.06], paddle, paddle), null);
});

test('wall and racquet events resolve in order, including a wall return within one slow XR frame', () => {
  const paddle = { center: [2.8, 2, 0], normal: [1, 0, 0] };
  const ball = { p: [2.9, 2, 0], v: [85, 0, 0] };
  let hits = 0;
  const sweep = createRacquetSweep((p, normal, incoming, outgoing) => {
    hits++; assert.ok(incoming[0] < 0); assert.ok(outgoing[0] > 0); assert.ok(normal[0] > 0);
  });
  predictBall(ball, 1 / 30, 85, paddle, paddle, sweep);
  assert.equal(hits, 1);
  assert.ok(ball.p[0] <= COURT.width / 2 - BALL_RADIUS);
});

test('time-scaled prediction slows ball travel without changing its wall-clock frame input', () => {
  const ball = { p: [0, 2, 0], v: [10, 0, 0] };
  predictBall(ball, 0.1, MAX_BALL_SPEED, null, null, null, 0.4);
  close(ball.p[0], 0.4, 1e-6);
});

test('85 m/s long simulation stays inside the court with bounded speed', () => {
  const ball = { p: [0, 2, 0], v: [50, 40, 55] };
  for (let i = 0; i < 5000; i++) {
    stepBall(ball, STEP);
    assert.ok(ball.p.every(Number.isFinite));
    assert.ok(Math.abs(ball.p[0]) <= COURT.width / 2 - BALL_RADIUS + 1e-6);
    assert.ok(Math.abs(ball.p[2]) <= COURT.length / 2 - BALL_RADIUS + 1e-6);
    assert.ok(ball.p[1] >= BALL_RADIUS - 1e-6 && ball.p[1] <= COURT.height - BALL_RADIUS + 1e-6);
    assert.ok(Math.hypot(...ball.v) <= 85 + 1e-6);
  }
});
