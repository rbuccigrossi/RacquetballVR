import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Room, TRACKING_TIMEOUT, validPose } from '../room.js';
import { createServer } from '../server.js';
import { Calibration, solveAlignment, centerAlignment, validateAnchors } from '../../client/js/calibration.js';
import { transformPoint, transformQuaternion, rotateVector, composeAlignment } from '../../client/js/math.js';
import { SPACE_PRESETS, fitStandingZone } from '../../client/js/spaces.js';
import { BALL_RADIUS, stepBall, sweepRacquet, hitVelocity, STEP, RACQUET_MOUNT, racquetPose } from '../../client/js/physics.js';

const config = { space: SPACE_PRESETS.garage, zone: fitStandingZone(SPACE_PRESETS.garage), label: 'Garage' };
const targets = [[-0.6, 0.1, -0.3], [0.7, 0.9, -0.5]];
test('solo session uses the real ball physics with one player and no shared anchors', () => {
  const room = new Room();
  room.join('a', config, 'right', 'solo');
  const send = (message, time = 1000) => room.handle('a', { rev: room.rev, anchorVersion: room.anchorVersion, ...message }, time);
  assert.equal(room.snapshot().mode, 'solo');
  assert.throws(() => room.join('b', config), /session is active/);
  send({ type: 'soloAligned' });
  send({ type: 'pose', seq: 1, pose: makePose() });
  send({ type: 'ready' });
  assert.equal(room.paused, false); assert.equal(room.anchors, null);
  send({ type: 'spawn' }); const id = room.ball.id, y = room.ball.p[1];
  room.update(1001, 5); assert.ok(room.ball.p[1] < y);
  send({ type: 'spawn' }); assert.equal(room.ball.id, id + 1);
  send({ type: 'pause' }); assert.equal(room.paused, true);
  send({ type: 'ready' }); assert.equal(room.paused, false);
  send({ type: 'pose', seq: 2, pose: { head: makePose().head, left: null, right: null } });
  room.update(1050, 2); assert.equal(room.paused, false);
  room.update(1400, 2); assert.equal(room.paused, true);
  room.leave('a'); room.join('b', config, 'right', 'shared');
  assert.equal(room.snapshot().mode, 'shared');
  assert.throws(() => room.handle('b', { type: 'soloAligned', rev: room.rev, anchorVersion: room.anchorVersion }), /requires A\/B/);
  assert.equal(room.healthy(1400), false);
});
test('server shares a centered standing area even when a client has old offsets', () => {
  const room = new Room();
  room.join('a', { ...config, zone: { width: 2, depth: 3, x: 0.5, z: 0.8, yaw: 0 } });
  assert.deepEqual(room.snapshot().config.zone, { width: 2, depth: 3, x: 0, z: 0, yaw: 0 });
});
test('racquet tip points forward and front face left; physics uses the identical mount', () => {
  assert.deepEqual(rotateVector([0, 0, 0], [0, 1, 0], RACQUET_MOUNT), [0, 0, -1]);
  assert.deepEqual(rotateVector([0, 0, 0], [0, 0, 1], RACQUET_MOUNT), [-1, 0, 0]);
  const pose = racquetPose({ center: [0, 0, 0], normal: [0, 0, 0] }, { p: [0, 1, 0], q: [0, 0, 0, 1] });
  assert.deepEqual(pose.center, [0, 1, -0.27]);
  assert.deepEqual(pose.normal, [-1, 0, 0]);
});
const makePose = (x = 0) => ({ head: { p: [x, 1.7, 0], q: [0, 0, 0, 1] }, left: { p: [x - 0.3, 1.2, 0], q: [0, 0, 0, 1] }, right: { p: [x + 0.3, 1.2, 0], q: [0, 0, 0, 1] } });
function prepared() {
  const events = [];
  const room = new Room(event => events.push(event));
  room.join('a', config); room.join('b', config);
  room.handle('a', { type: 'defineAnchors', rev: room.rev, anchorVersion: room.anchorVersion, points: targets }, 1000);
  for (const [i, id] of ['a', 'b'].entries()) {
    room.handle(id, { type: 'calibrated', rev: room.rev, anchorVersion: room.anchorVersion, error: 0.01 }, 1000);
    room.handle(id, { type: 'pose', rev: room.rev, anchorVersion: room.anchorVersion, seq: 1, pose: makePose(i ? 1 : -1) }, 1000);
  }
  for (const id of ['a', 'b']) room.handle(id, { type: 'ready', rev: room.rev }, 1000);
  return { room, events, send: (id, message, time = 1000) => room.handle(id, { rev: room.rev, anchorVersion: room.anchorVersion, ...message }, time) };
}

test('arbitrary anchors at different heights align independent origins and an unsampled room point', () => {
  const points = [...targets, [1.5, 1.7, 2]];
  for (const yaw of [-2.1, 0.6]) {
    const offset = [1.2, 0.04, -0.8];
    const raw = points.map(p => transformPoint([0, 0, 0], p.map((n, i) => n - offset[i]), { yaw: -yaw, offset: [0, 0, 0] }));
    const alignment = solveAlignment(raw[0], raw[1], targets[0], targets[1]);
    for (let j = 0; j < 3; j++) {
      const mapped = transformPoint([0, 0, 0], raw[j], alignment);
      assert.ok(mapped.every((n, i) => Math.abs(n - points[j][i]) < 1e-8));
    }
    const q = [0, 0, 0, 0];
    transformQuaternion(q, [0, Math.sin(-yaw / 2), 0, Math.cos(-yaw / 2)], alignment.yaw);
    assert.ok(Math.abs(q[1]) < 1e-8 && Math.abs(q[3] - 1) < 1e-8);
  }
  assert.throws(() => solveAlignment([0, 0.1, 0], [0.7, 0.1, 0], ...targets), /do not match/);
  assert.match(validateAnchors([[0, 0, 0], [0, 1, 0]]), /farther to the side/);
  assert.match(validateAnchors([[NaN, 0, 0], targets[1]]), /valid/);
});

test('reference headset establishes room center and facing without moving the floor', () => {
  const head = { p: [2, 1.7, -3], q: [0, Math.sin(0.7), 0, Math.cos(0.7)] };
  const alignment = centerAlignment(head);
  const p = transformPoint([0, 0, 0], head.p, alignment);
  assert.ok(Math.hypot(p[0], p[2]) < 1e-8); assert.equal(p[1], 1.7);
  const q = [0, 0, 0, 0];
  transformQuaternion(q, head.q, alignment.yaw);
  assert.ok(Math.abs(q[1]) < 1e-8);
});

test('two-point calibration averages stable samples, rejects mismatched spacing and retries B', () => {
  const calibration = new Calibration(config.space, { targets });
  const sample = (point, start) => {
    calibration.startSample(start);
    for (let i = 1; i <= 40; i++) calibration.sample(point, start + i * 16);
  };
  sample(targets[0], 0);
  sample(targets[1].map((n, i) => i === 0 ? n + 0.4 : n), 1000);
  assert.equal(calibration.complete, false);
  assert.match(calibration.error, /do not match/);
  assert.equal(calibration.stage, 1);
  sample(targets[1], 2000);
  assert.equal(calibration.complete, true);
  calibration.reset(config.space, { targets });
  calibration.startSample(0);
  for (let i = 1; i <= 40; i++) calibration.sample([i * 0.02, 0.1, 0], i * 16);
  assert.equal(calibration.stage, 0);
  assert.match(calibration.error, /moved/);
});

test('reference player freely chooses and publishes two points; follower waits for them', () => {
  const follower = new Calibration(config.space);
  follower.startSample(0); assert.equal(follower.collecting, false);
  assert.match(follower.error, /Waiting/);
  const alignment = { yaw: 0.3, offset: [0.2, 0, -0.1] };
  const calibration = new Calibration(config.space, { defining: true, alignment });
  for (let point = 0; point < 2; point++) {
    calibration.startSample(point * 1000);
    for (let frame = 1; frame <= 24; frame++) calibration.sample(targets[point], point * 1000 + frame * 16);
  }
  assert.equal(calibration.complete, true);
  for (let i = 0; i < 2; i++) {
    const expected = transformPoint([0, 0, 0], targets[i], alignment);
    assert.ok(expected.every((n, j) => Math.abs(n - calibration.targets[i][j]) < 1e-8));
  }
});

test('shared anchor revisions invalidate both players and reject stale alignment or poses', () => {
  const { room, send } = prepared();
  const anchorVersion = room.anchorVersion;
  assert.throws(() => send('b', { type: 'defineAnchors', points: targets }), /reference player/);
  send('a', { type: 'invalidate' });
  assert.equal(room.anchors, null); assert.equal(room.paused, true);
  assert.ok([...room.players.values()].every(p => !p.calibrated && !p.ready && !p.pose && !p.previousPose));
  assert.throws(() => send('b', { type: 'calibrated', error: 0, anchorVersion }), /changed/);
  assert.throws(() => send('a', { type: 'defineAnchors', points: targets, anchorVersion }), /changed/);
  send('a', { type: 'defineAnchors', points: targets });
  send('a', { type: 'pose', seq: 2, pose: makePose(), anchorVersion });
  assert.equal(room.players.get('a').pose, null);
  room.leave('a'); assert.equal(room.anchorOwner, 2); assert.equal(room.anchors, null);
  send('b', { type: 'defineAnchors', points: targets });
  assert.deepEqual(room.anchors, targets);
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
  room.ball.p = [-0.7, 1.2, -0.27]; room.ball.v = [-3, 0, 0];
  const hit = { type: 'hit', ballId: room.ball.id, ballRevision: 0, contact: [...room.ball.p], normal: [1, 0, 0], eventId: 'one' };
  send('a', hit);
  assert.equal(room.ball.revision, 1); assert.ok(room.ball.v[0] > 0);
  send('b', hit); assert.equal(room.ball.revision, 1);
  assert.equal(events.filter(e => e.kind === 'racquet').length, 1);
  send('b', { type: 'spawn' }); const replacement = structuredClone(room.ball);
  send('a', hit, 1200); assert.deepEqual(room.ball, replacement);
});

test('fast delayed hit uses incoming flight history even after the server ball bounces off a wall', () => {
  const { room, send } = prepared();
  assert.equal(room.speed, 85);
  send('a', { type: 'spawn' });
  room.ball.p = [-0.6, 1.2, -0.27]; room.ball.v = [-85, 0, 0];
  room.update(1034, 4);
  assert.ok(room.ball.v[0] > 0, 'server has already reached the wall');
  const contact = [-0.7, 1.2 - 9.81 / 120 * (0.1 / 85), -0.27];
  const hit = { type: 'hit', ballId: room.ball.id, ballRevision: 0, contact, normal: [1, 0, 0], eventId: 'fast' };
  send('a', { ...hit, contact: [-0.7, 1.4, -0.27] }, 1034);
  assert.equal(room.ball.revision, 0, 'near the racquet but off the actual ball path');
  send('a', hit, 1034);
  assert.equal(room.ball.revision, 1);
  assert.ok(room.ball.v[0] > 33 && room.ball.v[0] < 34, 'impulse uses -85 m/s incoming, not the already reflected velocity');
  send('a', { type: 'speed', value: 20 }, 1034); room.update(1035, 1);
  assert.ok(Math.hypot(...room.ball.v) <= 20);
  assert.throws(() => send('a', { type: 'speed', value: 86 }), /2–85/);
});

test('stale tracking, loss, recenter and disconnect pause play and clear readiness', () => {
  const { room, send } = prepared();
  send('a', { type: 'spawn' }); const p = [...room.ball.p];
  room.update(1000 + TRACKING_TIMEOUT + 1, 2);
  assert.equal(room.paused, true); assert.deepEqual(room.ball.p, p);
  assert.ok([...room.players.values()].every(player => !player.ready));
  assert.throws(() => send('a', { type: 'ready' }, 1400), /connected/);
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
  assert.throws(() => send('a', { type: 'speed', value: Infinity }), /2–85/);
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
  a.send({ type: 'defineAnchors', rev, anchorVersion: state.anchorVersion, points: targets });
  const { anchorVersion } = await waitFor(b, m => m.type === 'state' && m.anchors);
  for (const [i, client] of [a, b].entries()) {
    client.send({ type: 'calibrated', rev, anchorVersion, error: 0.01 });
    client.send({ type: 'pose', rev, anchorVersion, seq: 1, pose: makePose(i) });
  }
  await waitFor(a, m => m.type === 'state' && m.players.every(p => p.tracked));
  a.send({ type: 'ready', rev }); b.send({ type: 'ready', rev });
  await waitFor(a, m => m.type === 'state' && !m.paused);
  a.send({ type: 'spawn', rev, anchorVersion }); b.send({ type: 'spawn', rev, anchorVersion });
  const final = await waitFor(a, m => m.type === 'state' && m.ball?.id === 2);
  assert.equal(final.ball.id, (await waitFor(b, m => m.type === 'state' && m.ball?.id === 2)).ball.id);
  b.ws.close();
  const disconnected = await waitFor(a, m => m.type === 'state' && m.players.length === 1 && m.reason.includes('left'));
  assert.equal(disconnected.paused, true); assert.equal(disconnected.ball, null);
});

test('partial tracking keeps play running and never spawns or hits with a missing hand', () => {
  const { room, send } = prepared();
  send('a', { type: 'spawn' });
  const id = room.ball.id;
  for (let seq = 2; seq <= 10; seq++) {
    const time = 1000 + seq * 40;
    send('a', { type: 'pose', seq, pose: { head: null, left: null, right: null } }, time);
    send('b', { type: 'pose', seq, pose: { ...makePose(1), left: null } }, time);
    room.update(time, 2);
    assert.equal(room.paused, false);
  }
  send('a', { type: 'spawn' }, 1400); assert.equal(room.ball.id, id);
  send('a', { type: 'hit', ballId: id, ballRevision: 0, contact: [...room.ball.p], eventId: 'lost' }, 1400);
  assert.equal(room.ball.revision, 0);
  assert.ok([...room.players.values()].every(p => p.ready && p.calibrated));
  assert.ok(room.tick > 0);
});

test('room recenter preserves alignment for both players and rejects stale coordinates', () => {
  const { room, send, events } = prepared();
  const oldVersion = room.anchorVersion, shift = { yaw: 0.8, offset: [0.7, 0, -0.3] };
  const oldHead = [...room.players.get('a').pose.head.p];
  assert.throws(() => send('b', { type: 'recenter', shift }), /Player 1/);
  send('a', { type: 'spawn' });
  send('a', { type: 'recenter', shift });
  assert.equal(room.ball, null); assert.equal(room.paused, false);
  assert.ok([...room.players.values()].every(p => p.calibrated && p.ready));
  assert.deepEqual(room.players.get('a').pose.head.p, transformPoint([0, 0, 0], oldHead, shift));
  assert.deepEqual(room.anchors[0], transformPoint([0, 0, 0], targets[0], shift));
  assert.equal(events.at(-1).type, 'roomShift');
  send('a', { type: 'spawn', anchorVersion: oldVersion }); assert.equal(room.ball, null);
  assert.throws(() => send('a', { type: 'recenter', shift, anchorVersion: oldVersion }), /changed/);
  send('a', { type: 'invalidate', clearAnchors: false });
  assert.ok(room.anchors); assert.equal(room.players.get('b').calibrated, true);
});

test('reference reset composition maps new raw poses into unchanged shared coordinates', () => {
  const original = { yaw: -0.7, offset: [1, 0.02, -2] };
  const newToOld = { yaw: 1.1, offset: [-0.5, 0.1, 0.8] };
  const raw = [0.4, 1.6, -0.9];
  const expected = transformPoint([0, 0, 0], transformPoint([0, 0, 0], raw, newToOld), original);
  const actual = transformPoint([0, 0, 0], raw, composeAlignment(original, newToOld));
  assert.ok(actual.every((n, i) => Math.abs(n - expected[i]) < 1e-8));
});
