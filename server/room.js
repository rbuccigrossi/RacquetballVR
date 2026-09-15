import { validateSpace, validateStandingZone, centerStandingZone } from '../client/js/spaces.js';
import { BALL_RADIUS, STEP, stepBall, racquetPose, hitVelocity } from '../client/js/physics.js';
import { distance, dot } from '../client/js/math.js';
import { validateAnchors } from '../client/js/calibration.js';

export const TRACKING_TIMEOUT = 300;
const vector = (v, size, limit) => Array.isArray(v) && v.length === size && v.every(n => Number.isFinite(n) && Math.abs(n) <= limit);
export function validPose(pose) {
  return pose && ['head', 'left', 'right'].every(key => {
    const part = pose[key];
    return part && vector(part.p, 3, 100) && vector(part.q, 4, 1.01) && Math.abs(Math.hypot(...part.q) - 1) < 0.05;
  });
}
const copy = value => structuredClone(value);
const paddle = () => ({ center: [0, 0, 0], normal: [0, 0, 1] });

export class Room {
  constructor(broadcast = () => {}) {
    this.broadcast = broadcast;
    this.players = new Map();
    this.config = null;
    this.rev = 0;
    this.ball = null;
    this.ballId = 0;
    this.speed = 8;
    this.paused = true;
    this.reason = 'Join the sandbox and align both headsets.';
    this.tick = 0;
    this.eventId = 0;
    this.anchors = null; this.anchorOwner = null; this.anchorVersion = 0;
  }
  join(connection, config, hand = 'right') {
    if (this.players.has(connection)) return this.players.get(connection).id;
    if (this.players.size >= 2) throw new Error('Two players are already connected.');
    if (!this.players.size) {
      const zone = centerStandingZone(config?.zone);
      if (!config || validateSpace(config.space) || validateStandingZone(zone, config.space)) throw new Error('Select a valid physical space before joining.');
      this.config = copy({ space: config.space, zone, label: String(config.label || 'Shared space').slice(0, 40) });
      this.rev++;
      this.ball = null;
    }
    const id = this.players.size && [...this.players.values()][0].id === 1 ? 2 : 1;
    if (!this.players.size) { this.anchorOwner = id; this.clearAnchors(); }
    this.players.set(connection, { id, hand: hand === 'left' ? 'left' : 'right', ready: false, calibrated: false, tracked: false, pose: null, previousPose: null, lastPoseAt: 0, previousPoseAt: 0, seq: -1, lastHitAt: -Infinity });
    this.pause('A player joined. Check alignment and both mark ready.');
    return id;
  }
  leave(connection) {
    const id = this.players.get(connection)?.id;
    if (!this.players.delete(connection)) return;
    if (id === this.anchorOwner) { this.anchorOwner = [...this.players.values()][0]?.id ?? null; this.clearAnchors(); }
    this.pause('A player left. Ball paused.');
    this.ball = null;
    if (!this.players.size) this.config = null;
  }
  pause(reason) {
    this.paused = true;
    this.reason = reason;
    for (const player of this.players.values()) player.ready = false;
  }
  clearAnchors() {
    this.anchors = null; this.anchorVersion++;
    for (const player of this.players.values()) { player.calibrated = false; player.tracked = false; player.pose = null; player.previousPose = null; player.ready = false; }
  }
  healthy(now) {
    return this.players.size === 2 && [...this.players.values()].every(p => p.calibrated && p.tracked && now - p.lastPoseAt <= TRACKING_TIMEOUT);
  }
  handle(connection, message, now = Date.now()) {
    const player = this.players.get(connection);
    if (!player) throw new Error('Join the sandbox first.');
    if (message.type === 'pause') { this.pause('Paused by a player. Both mark ready to resume.'); return; }
    if (message.type === 'reset') { this.ball = null; return; }
    if (message.type === 'invalidate') {
      if (player.id === this.anchorOwner) this.clearAnchors();
      player.calibrated = false; player.tracked = false; player.pose = null; player.previousPose = null;
      this.pause('Alignment or tracking changed. Recalibrate before resuming.'); return;
    }
    if (message.type === 'lost') {
      player.tracked = false; player.pose = null; player.previousPose = null;
      this.pause('Tracking unavailable. Both mark ready when tracking returns.'); return;
    }
    if (message.rev !== this.rev) throw new Error('Room configuration changed. Rejoin and recalibrate.');
    if (message.type === 'defineAnchors') {
      if (player.id !== this.anchorOwner) throw new Error('Only the reference player can choose the two spots.');
      if (message.anchorVersion !== this.anchorVersion) throw new Error('Alignment changed. Choose the spots again.');
      const error = validateAnchors(message.points);
      if (error) throw new Error(error);
      this.clearAnchors(); this.anchors = copy(message.points);
      player.calibrated = true;
      this.pause('Two spots selected. Partner must match A and B; both verify alignment.');
      return;
    }
    if (message.type === 'calibrated') {
      if (!this.anchors || message.anchorVersion !== this.anchorVersion) throw new Error('The shared spots changed. Match the current A and B again.');
      if (!Number.isFinite(message.error) || message.error < 0 || message.error > 0.08) throw new Error('Alignment check must be within 8 cm.');
      player.calibrated = true; player.ready = false; return;
    }
    if (message.type === 'pose') {
      if (message.anchorVersion !== this.anchorVersion) return;
      if (!player.calibrated) return;
      if (!Number.isSafeInteger(message.seq) || message.seq <= player.seq) return;
      if (!validPose(message.pose)) throw new Error('Invalid tracking data.');
      player.previousPose = player.pose; player.previousPoseAt = player.lastPoseAt;
      player.pose = copy(message.pose); player.lastPoseAt = now; player.seq = message.seq; player.tracked = true;
      return;
    }
    if (message.type === 'ready') {
      if (!this.healthy(now)) throw new Error('Both players need fresh head and controller tracking plus verified alignment.');
      player.ready = true;
      if ([...this.players.values()].every(p => p.ready)) { this.paused = false; this.reason = 'Free play · either player can spawn or hit.'; }
      return;
    }
    if (message.type === 'speed') {
      if (!Number.isFinite(message.value) || message.value < 2 || message.value > 16) throw new Error('Ball speed must be 2–16 m/s.');
      this.speed = message.value; return;
    }
    if (message.type === 'hand') {
      if (!['left', 'right'].includes(message.value)) throw new Error('Invalid racquet hand.');
      player.hand = message.value; this.pause('Hand assignment changed. Both mark ready.'); return;
    }
    if (this.paused || !this.healthy(now)) throw new Error('Ball is paused. Both players must be aligned, tracked, and ready.');
    if (message.type === 'spawn') {
      const hand = player.hand === 'right' ? 'left' : 'right';
      const p = [...player.pose[hand].p];
      p[1] = Math.max(BALL_RADIUS + 0.02, p[1]);
      this.ball = { id: ++this.ballId, revision: 0, p, v: [0, 0, 0] };
      this.broadcast({ type: 'spawned', ball: copy(this.ball), by: player.id, requestId: message.requestId });
      return;
    }
    if (message.type === 'hit') {
      const ball = this.ball;
      if (!ball || message.ballId !== ball.id || message.ballRevision !== ball.revision) return;
      if (now - player.lastHitAt < 120 || !vector(message.contact, 3, 100)) return;
      if (typeof message.eventId !== 'string' || message.eventId.length > 80) return;
      // Bound lag compensation: contact must be near the current ball and a recent racquet.
      if (distance(message.contact, ball.p) > 0.15 + this.speed * 0.12) return;
      const current = racquetPose(paddle(), player.pose[player.hand]);
      if (distance(message.contact, current.center) > 0.42) return;
      const old = player.previousPose ? racquetPose(paddle(), player.previousPose[player.hand]) : current;
      const dt = (player.lastPoseAt - player.previousPoseAt) / 1000;
      const velocity = current.center.map((n, i) => dt > 0.005 && dt < 0.15 ? (n - old.center[i]) / dt : 0);
      const speed = Math.hypot(...velocity);
      if (speed > 18) return;
      const v = hitVelocity(ball.v, current.normal, velocity, this.speed);
      const direction = dot(v, current.normal) >= 0 ? 1 : -1;
      ball.p = message.contact.map((n, i) => n + current.normal[i] * direction * (BALL_RADIUS + 0.01));
      ball.v = v; ball.revision++; player.lastHitAt = now;
      this.broadcast({ type: 'impact', id: `hit:${player.id}:${message.eventId}`, kind: 'racquet', p: [...message.contact], strength: Math.hypot(...v), by: player.id, eventId: message.eventId });
    }
  }
  update(now = Date.now(), steps = 2) {
    for (const player of this.players.values()) {
      if (player.tracked && now - player.lastPoseAt > TRACKING_TIMEOUT) {
        player.tracked = false;
        this.pause('Tracking data unavailable. Both mark ready after tracking recovers.');
      }
    }
    if (!this.paused && !this.healthy(now)) this.pause('Waiting for both players and fresh tracking.');
    if (!this.paused) for (let step = 0; step < steps; step++) {
      stepBall(this.ball, STEP, this.speed, (kind, p, strength) => this.broadcast({ type: 'impact', id: ++this.eventId, kind, p: [...p], strength }));
      this.tick++;
    }
  }
  snapshot(now = Date.now()) {
    return { type: 'state', now, rev: this.rev, config: this.config, anchors: this.anchors, anchorOwner: this.anchorOwner, anchorVersion: this.anchorVersion, tick: this.tick, speed: this.speed, paused: this.paused, reason: this.reason, ball: this.ball, players: [...this.players.values()].map(({ id, hand, ready, calibrated, tracked, pose, lastPoseAt }) => ({ id, hand, ready, calibrated, tracked, pose, age: now - lastPoseAt })) };
  }
}
