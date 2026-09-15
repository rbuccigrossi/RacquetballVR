import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Room, TRACKING_TIMEOUT, validPose } from '../room.js';
import { createServer } from '../server.js';
import { Calibration, solveAlignment, calibrationTargets } from '../../client/js/calibration.js';
import { transformPoint, transformQuaternion } from '../../client/js/math.js';
import { SPACE_PRESETS, fitStandingZone } from '../../client/js/spaces.js';
import { BALL_RADIUS, stepBall, sweepRacquet, hitVelocity, STEP } from '../../client/js/physics.js';

const config = { space: SPACE_PRESETS.garage, zone: fitStandingZone(SPACE_PRESETS.garage), label: 'Garage' };
const makePose = (x = 0) => ({ head: { p: [x, 1.7, 0], q: [0, 0, 0, 1] }, left: { p: [x - 0.3, 1.2, 0], q: [0, 0, 0, 1] }, right: { p: [x + 0.3, 1.2, 0], q: [0, 0, 0, 1] } });
function prepared() {
  const events = [];
  const room = new Room(event => events.push(event));
  room.join('a', config); room.join('b', config);
  for (const [i, id] of ['a', 'b'].entries()) {
    room.handle(id, { type: 'calibrated', rev: room.rev, error: 0.01 }, 1000);
    room.handle(id, { type: 'pose', rev: room.rev, seq: 1, pose: makePose(i ? 1 : -1) }, 1000);
  }
  for (const id of ['a', 'b']) room.handle(id, { type: 'ready', rev: room.rev }, 1000);
  return { room, events, send: (id, message, time = 1000) => room.handle(id, { rev: room.rev, ...message }, time) };
}

test('two independent origins and yaw angles map to the same three markers', () => {
  const targets = calibrationTargets(config.space);
  for (const yaw of [-2.1, 0.6]) {
    const offset = [1.2, 0.04, -0.8];
    const raw = targets.map(p => transformPoint([0, 0, 0], p.map((n, i) => n - offset[i]), { yaw: -yaw, offset: [0, 0, 0] }));
    const alignment = solveAlignment(raw[0], raw[1], targets[0]);
    for (let j = 0; j < 3; j++) {
      const mapped = transformPoint([0, 0, 0], raw[j], alignment);
      assert.ok(mapped.every((n, i) => Math.abs(n - targets[j][i]) < 1e-8));
    }
    const q = [0, 0, 0, 0];
    transformQuaternion(q, [0, Math.sin(-yaw / 2), 0, Math.cos(-yaw / 2)], alignment.yaw);
    assert.ok(Math.abs(q[1]) < 1e-8 && Math.abs(q[3] - 1) < 1e-8);
  }
  assert.throws(() => solveAlignment([0, 0.1, 0], [0.7, 0.1, 0], targets[0]), /1 meter/);
});

test('calibration averages stable samples and independently rejects a bad third mark', () => {
  const calibration = new Calibration(config.space);
  const sample = (point, start) => {
    calibration.startSample(start);
    for (let i = 1; i <= 40; i++) calibration.sample(point, start + i * 16);
  };
  sample(calibration.targets[0], 0); sample(calibration.targets[1], 1000);
  sample(calibration.targets[2].map((n, i) => i === 0 ? n + 0.15 : n), 2000);
  assert.equal(calibration.complete, false);
  assert.match(calibration.error, /Third marker/);
  sample(calibration.targets[2], 3000);
  assert.equal(calibration.complete, true);
  calibration.reset(config.space);
  calibration.startSample(0);
  for (let i = 1; i <= 40; i++) calibration.sample([i * 0.02, 0.1, 0], i * 16);
  assert.equal(calibration.stage, 0);
  assert.match(calibration.error, /moved/);
});

test('fixed-step ball collides with walls, floor and ceiling without tunneling', () => {
  const ball = { p: [2.99, 1, 0], v: [16, 0, 0] }, impacts = [];
  stepBall(ball, STEP, 16, kind => impacts.push(kind));
  assert.ok(ball.v[0] < 0); assert.ok(ball.p[0] < 3.048 - BALL_RADIUS);
  assert.deepEqual(impacts, ['wall']);
  ball.p = [0, BALL_RADIUS + 0.01, 0]; ball.v = [0, -8, 0];
  stepBall(ball, STEP, 16, kind => impacts.push(kind));
  assert.ok(ball.v[1] > 0); assert.equal(impacts.at(-1), 'floor');
  ball.p = [0, 6.096 - BALL_RADIUS - 0.01, 0]; ball.v = [0, 8, 0];
  stepBall(ball, STEP, 16);
  assert.ok(ball.v[1] < 0);
  for (let i = 0; i < 5000; i++) {
    stepBall(ball, STEP, 16);
    assert.ok(ball.p.every(Number.isFinite));
    assert.ok(ball.p[1] >= BALL_RADIUS - 0.0001 && ball.p[1] <= 6.096 - BALL_RADIUS);
  }
});

test('relative racquet sweep catches a fast hand crossing and rejects a miss', () => {
  const old = { center: [0, 1, -0.3], normal: [0, 0, 1] };
  const next = { center: [0, 1, 0.3], normal: [0, 0, 1] };
  assert.ok(sweepRacquet([0, 1, 0], [0, 1, 0], old, next));
  assert.equal(sweepRacquet([1, 1, 0], [1, 1, 0], old, next), null);
  const v = hitVelocity([0, 0, -2], [0, 0, 1], [0, 0, 5], 8);
  assert.ok(v[2] > 0 && Math.hypot(...v) <= 8);
});

test('either player can replace the sole ball; simultaneous requests leave newest ID', () => {
  const { room, send } = prepared();
  send('a', { type: 'spawn' }); const first = room.ball.id;
  send('b', { type: 'spawn' });
  assert.equal(room.ball.id, first + 1);
  assert.deepEqual(room.ball.p, makePose(1).left.p);
  send('a', { type: 'reset' }); assert.equal(room.ball, null);
});

test('server accepts plausible hits once and rejects old ball IDs/revisions', () => {
  const { room, send, events } = prepared();
  send('a', { type: 'spawn' });
  room.ball.p = [-0.7, 1.47, 0]; room.ball.v = [0, 0, -3];
  const hit = { type: 'hit', ballId: room.ball.id, ballRevision: 0, contact: [...room.ball.p], eventId: 'one' };
  send('a', hit);
  assert.equal(room.ball.revision, 1); assert.ok(room.ball.v[2] > 0);
  send('b', hit); assert.equal(room.ball.revision, 1);
  assert.equal(events.filter(e => e.kind === 'racquet').length, 1);
  send('b', { type: 'spawn' }); const replacement = structuredClone(room.ball);
  send('a', hit, 1200); assert.deepEqual(room.ball, replacement);
});

test('stale tracking, loss, recenter and disconnect pause play and clear readiness', () => {
  const { room, send } = prepared();
  send('a', { type: 'spawn' }); const p = [...room.ball.p];
  room.update(1000 + TRACKING_TIMEOUT + 1, 2);
  assert.equal(room.paused, true); assert.deepEqual(room.ball.p, p);
  assert.ok([...room.players.values()].every(player => !player.ready));
  assert.throws(() => send('a', { type: 'ready' }, 1400), /fresh/);
  for (const id of ['a', 'b']) send(id, { type: 'pose', seq: 2, pose: makePose() }, 1500);
  send('a', { type: 'ready' }, 1500); send('b', { type: 'ready' }, 1500);
  assert.equal(room.paused, false);
  send('a', { type: 'lost' }, 1501); assert.equal(room.paused, true); assert.equal(room.players.get('a').calibrated, true);
  send('b', { type: 'invalidate' }); assert.equal(room.players.get('b').calibrated, false);
  room.leave('a'); assert.equal(room.ball, null);
});

test('room rejects third player, bad payloads and stale configurations', () => {
  const { room, send } = prepared();
  assert.throws(() => room.join('c', config), /Two players/);
  assert.throws(() => send('a', { type: 'speed', value: Infinity }), /2–16/);
  assert.throws(() => send('a', { type: 'pose', seq: 2, pose: {} }), /Invalid tracking/);
  assert.equal(validPose({ ...makePose(), head: { p: [NaN, 0, 0], q: [0, 0, 0, 1] } }), false);
  assert.throws(() => send('a', { type: 'spawn', rev: -1 }), /configuration changed/);
  const before = room.players.get('a').pose;
  send('a', { type: 'pose', seq: 0, pose: makePose(5) }); assert.equal(room.players.get('a').pose, before);
});

test('real WSS clients share roles, configuration, one ball, and disconnect pause', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'racquetball-wss-'));
  const server = await createServer({ directory, addresses: [] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.ws.terminate();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const connect = async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${server.address().port}/ws`, { rejectUnauthorized: false });
    const client = { ws, messages: [] }; clients.push(client);
    ws.on('message', raw => client.messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    client.send = data => ws.send(JSON.stringify(data));
    return client;
  };
  const waitFor = async (client, predicate) => {
    const started = Date.now();
    while (Date.now() - started < 2500) {
      const match = client.messages.find(predicate);
      if (match) return match;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Expected socket message not received: ${JSON.stringify(client.messages.slice(-2))}`);
  };
  const a = await connect(); a.send({ type: 'join', config });
  assert.equal((await waitFor(a, m => m.type === 'joined')).id, 1);
  const b = await connect(); b.send({ type: 'join', config: { ...config, label: 'Ignored by second joiner' } });
  assert.equal((await waitFor(b, m => m.type === 'joined')).id, 2);
  const state = await waitFor(b, m => m.type === 'state' && m.players.length === 2);
  assert.equal(state.config.label, 'Garage');
  const rev = state.rev;
  for (const [i, client] of [a, b].entries()) {
    client.send({ type: 'calibrated', rev, error: 0.01 });
    client.send({ type: 'pose', rev, seq: 1, pose: makePose(i) });
  }
  await waitFor(a, m => m.type === 'state' && m.players.every(p => p.tracked));
  a.send({ type: 'ready', rev }); b.send({ type: 'ready', rev });
  await waitFor(a, m => m.type === 'state' && !m.paused);
  a.send({ type: 'spawn', rev }); b.send({ type: 'spawn', rev });
  const final = await waitFor(a, m => m.type === 'state' && m.ball?.id === 2);
  assert.equal(final.ball.id, (await waitFor(b, m => m.type === 'state' && m.ball?.id === 2)).ball.id);
  b.ws.close();
  const disconnected = await waitFor(a, m => m.type === 'state' && m.players.length === 1 && m.reason.includes('left'));
  assert.equal(disconnected.paused, true); assert.equal(disconnected.ball, null);
});
