import { validateSpace, validateStandingZone, centerStandingZone } from '../client/js/spaces.js';
import { BALL_RADIUS, STEP, stepBall, racquetPose, hitVelocity, MAX_BALL_SPEED, MAX_RACQUET_SPEED, HIT_COOLDOWN_MS } from '../client/js/physics.js';
import { distance, dot, transformPoint, transformQuaternion } from '../client/js/math.js';
import { validateAnchors } from '../client/js/calibration.js';

export const TRACKING_TIMEOUT = 300;
const vector = (v, size, limit) => Array.isArray(v) && v.length === size && v.every(n => Number.isFinite(n) && Math.abs(n) <= limit);
export function validPose(pose) {
  return pose && ['head', 'left', 'right'].every(key => {
    const part = pose[key];
    return part === null || (part && vector(part.p, 3, 100) && vector(part.q, 4, 1.01) && Math.abs(Math.hypot(...part.q) - 1) < 0.05);
  });
}
const copy = value => structuredClone(value);
const paddle = () => ({ center: [0, 0, 0], normal: [0, 0, 1] });

export class Room {
  constructor(broadcast = () => {}) {
    this.broadcast = broadcast;
    this.players = new Map();
    this.config = null;
    this.mode = 'shared';
    this.rev = 0;
    this.ball = null;
    this.ballId = 0;
    this.speed = MAX_BALL_SPEED;
    this.flightHistory = Array.from({ length: 64 }, () => ({ p: [0, 0, 0], v: [0, 0, 0], duration: 0, at: -Infinity }));
    this.flightIndex = 0;
    this.paused = true;
    this.reason = 'Join the sandbox and align both headsets.';
    this.tick = 0;
    this.eventId = 0;
    this.anchors = null; this.anchorOwner = null; this.anchorVersion = 0;
  }
  join(connection, config, hand = 'right', mode = 'shared') {
    if (this.players.has(connection)) return this.players.get(connection).id;
    if (!['solo', 'shared'].includes(mode)) throw new Error('Choose Solo practice or Two players.');
    if (this.players.size && (this.mode === 'solo' || mode !== this.mode)) throw new Error('A different session is active. Leave that session before switching between solo and two players.');
    if (this.players.size >= 2) throw new Error('Two players are already connected.');
    if (!this.players.size) {
      const zone = centerStandingZone(config?.zone);
      if (!config || validateSpace(config.space) || validateStandingZone(zone, config.space)) throw new Error('Select a valid physical space before joining.');
      this.config = copy({ space: config.space, zone, label: String(config.label || 'Shared space').slice(0, 40) });
      this.mode = mode;
      this.rev++;
      this.ball = null;
    }
    const id = this.players.size && [...this.players.values()][0].id === 1 ? 2 : 1;
    if (!this.players.size) { this.anchorOwner = id; this.clearAnchors(); }
    this.players.set(connection, { id, hand: hand === 'left' ? 'left' : 'right', ready: false, calibrated: false, tracked: false, pose: null, previousPose: null, lastPoseAt: 0, previousPoseAt: 0, seq: -1, lastHitAt: -Infinity });
    this.pause(this.mode === 'solo' ? 'Solo practice. Enter VR, then press RIGHT grip to start.' : 'A player joined. Check alignment and both mark ready.');
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
    return this.players.size === (this.mode === 'solo' ? 1 : 2) && [...this.players.values()].every(p => p.calibrated && p.pose && now - p.lastPoseAt <= TRACKING_TIMEOUT);
  }
  handle(connection, message, now = Date.now()) {
    const player = this.players.get(connection);
    if (!player) throw new Error('Join the sandbox first.');
    if (message.type === 'pause') { this.pause(this.mode === 'solo' ? 'Paused. RIGHT grip to resume practice.' : 'Paused by a player. Both mark ready to resume.'); return; }
    if (message.type === 'reset') { this.ball = null; return; }
    if (message.type === 'invalidate') {
      if (player.id === this.anchorOwner && message.clearAnchors !== false) this.clearAnchors();
      player.calibrated = false; player.tracked = false; player.pose = null; player.previousPose = null;
      this.pause(this.mode === 'solo' ? 'Setting up your court. RIGHT grip to start when ready.' : 'Alignment or tracking changed. Recalibrate before resuming.'); return;
    }
    if (message.type === 'lost') {
      player.tracked = false; player.pose = null; player.previousPose = null;
      this.pause(this.mode === 'solo' ? 'Session interrupted. RIGHT grip to resume when back in VR.' : 'Tracking unavailable. Both mark ready when tracking returns.'); return;
    }
    if (message.rev !== this.rev) throw new Error('Room configuration changed. Rejoin and recalibrate.');
    if (message.type === 'soloAligned') {
      if (this.mode !== 'solo') throw new Error('Shared play requires A/B alignment.');
      if (message.anchorVersion !== this.anchorVersion) throw new Error('Court changed. Retry setup.');
      player.calibrated = true; player.ready = false; return;
    }
    if (message.type === 'recenter') {
      if (player.id !== this.anchorOwner) throw new Error('Player 1 controls the room center.');
      if (message.anchorVersion !== this.anchorVersion) throw new Error('Room alignment changed. Retry recenter.');
      const shift = message.shift;
      if (!shift || !Number.isFinite(shift.yaw) || Math.abs(shift.yaw) > Math.PI * 2 || !vector(shift.offset, 3, 100) || shift.offset[1] !== 0) throw new Error('Invalid room recenter.');
      const fromVersion = this.anchorVersion++;
      if (this.anchors) for (const point of this.anchors) transformPoint(point, point, shift);
      for (const p of this.players.values()) {
        if (p.pose) for (const part of Object.values(p.pose)) if (part) {
          transformPoint(part.p, part.p, shift); transformQuaternion(part.q, part.q, shift.yaw);
        }
        p.previousPose = null;
      }
      // Repositioning the court starts a fresh ball, retaining player alignment.
      this.ball = null;
      this.broadcast({ type: 'roomShift', fromVersion, anchorVersion: this.anchorVersion, shift });
      return;
    }
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
      player.pose = copy(message.pose); player.lastPoseAt = now; player.seq = message.seq; player.tracked = Object.values(player.pose).some(Boolean);
      return;
    }
    if (message.type === 'ready') {
      if (!this.healthy(now)) throw new Error(this.mode === 'solo' ? 'Enter VR and wait for the court to be ready.' : 'Both players must be aligned and connected to mark ready.');
      player.ready = true;
      if ([...this.players.values()].every(p => p.ready)) { this.paused = false; this.reason = this.mode === 'solo' ? 'Solo practice.' : 'Free play · either player can spawn or hit.'; }
      return;
    }
    if (message.type === 'speed') {
      if (!Number.isFinite(message.value) || message.value < 2 || message.value > MAX_BALL_SPEED) throw new Error(`Ball speed must be 2–${MAX_BALL_SPEED} m/s.`);
      this.speed = message.value; return;
    }
    if (message.type === 'hand') {
      if (!['left', 'right'].includes(message.value)) throw new Error('Invalid racquet hand.');
      player.hand = message.value; this.pause(this.mode === 'solo' ? 'Hand assignment changed. RIGHT grip to resume.' : 'Hand assignment changed. Both mark ready.'); return;
    }
    if (this.paused || !this.healthy(now)) throw new Error(this.mode === 'solo' ? 'Ball is paused. RIGHT grip to start practice.' : 'Ball is paused. Both players must be aligned, tracked, and ready.');
    if (message.type === 'spawn') {
      if (message.anchorVersion !== this.anchorVersion) return;
      const hand = player.hand === 'right' ? 'left' : 'right';
      if (!player.pose[hand]) return;
      const p = [...player.pose[hand].p];
      p[1] = Math.max(BALL_RADIUS + 0.02, p[1]);
      this.ball = { id: ++this.ballId, revision: 0, p, v: [0, 0, 0] };
      this.broadcast({ type: 'spawned', ball: copy(this.ball), by: player.id, requestId: message.requestId });
      return;
    }
    if (message.type === 'hit') {
      if (message.anchorVersion !== this.anchorVersion || !player.pose[player.hand]) return;
      const ball = this.ball;
      if (!ball || message.ballId !== ball.id || message.ballRevision !== ball.revision) return;
      if (now - player.lastHitAt < HIT_COOLDOWN_MS || !vector(message.contact, 3, 100)) return;
      if (typeof message.eventId !== 'string' || message.eventId.length > 80) return;
      if (!vector(message.normal, 3, 1.01) || Math.abs(Math.hypot(...message.normal) - 1) > 0.01) return;
      // Validate against actual flight segments (including bounces), rather
      // than a speed-dependent sphere that would grow to ten meters at 85 m/s.
      const incoming = this.incomingAt(message.contact, now);
      if (!incoming) return;
      const current = racquetPose(paddle(), player.pose[player.hand]);
      if (Math.abs(dot(message.normal, current.normal)) < 0.8) return;
      const old = player.previousPose?.[player.hand] ? racquetPose(paddle(), player.previousPose[player.hand]) : current;
      const movement = current.center.map((n, i) => n - old.center[i]);
      const lengthSquared = dot(movement, movement);
      const fraction = lengthSquared > 1e-9 ? Math.max(0, Math.min(1, dot(message.contact.map((n, i) => n - old.center[i]), movement) / lengthSquared)) : 1;
      if (distance(message.contact, old.center.map((n, i) => n + movement[i] * fraction)) > 0.3) return;
      const dt = (player.lastPoseAt - player.previousPoseAt) / 1000;
      const velocity = current.center.map((n, i) => dt > 0.005 && dt < 0.15 ? (n - old.center[i]) / dt : 0);
      const speed = Math.hypot(...velocity);
      if (speed > MAX_RACQUET_SPEED) return;
      if (dot(incoming, message.normal) - dot(velocity, message.normal) >= -0.001) return;
      const v = hitVelocity(incoming, message.normal, velocity, this.speed);
      ball.p = message.contact.map((n, i) => n + message.normal[i] * 0.0001);
      ball.v = v; ball.revision++; player.lastHitAt = now;
      this.broadcast({ type: 'impact', id: `hit:${player.id}:${message.eventId}`, kind: 'racquet', p: [...message.contact], strength: Math.hypot(...v), by: player.id, eventId: message.eventId });
    }
  }
  incomingAt(contact, now) {
    const ball = this.ball;
    let best = 0.12 ** 2, incoming = null;
    const check = (p, v, duration) => {
      const dx = contact[0] - p[0], dy = contact[1] - p[1], dz = contact[2] - p[2];
      const vv = dot(v, v);
      const t = vv > 1e-9 ? Math.max(0, Math.min(duration, (dx * v[0] + dy * v[1] + dz * v[2]) / vv)) : 0;
      const d2 = (dx - v[0] * t) ** 2 + (dy - v[1] * t) ** 2 + (dz - v[2] * t) ** 2;
      if (d2 < best) { best = d2; incoming = [...v]; }
    };
    check(ball.p, ball.v, 0);
    for (const segment of this.flightHistory) if (segment.id === ball.id && segment.revision === ball.revision && now - segment.at <= 120) check(segment.p, segment.v, segment.duration);
    // The predicting client can also be a few frames ahead of the server.
    const predicted = { p: [...ball.p], v: [...ball.v] };
    for (let i = 0; i < 15; i++) stepBall(predicted, STEP, this.speed, undefined, undefined, check);
    return incoming;
  }
  update(now = Date.now(), steps = 2) {
    for (const player of this.players.values()) {
      if (player.tracked && now - player.lastPoseAt > TRACKING_TIMEOUT) {
        player.tracked = false;
        this.pause(this.mode === 'solo' ? 'Session updates stopped. RIGHT grip to resume when connected.' : 'Tracking data unavailable. Both mark ready after tracking recovers.');
      }
    }
    if (!this.paused && !this.healthy(now)) this.pause(this.mode === 'solo' ? 'Waiting for your VR session. RIGHT grip to resume.' : 'Waiting for both players and fresh tracking.');
    if (!this.paused) for (let step = 0; step < steps; step++) {
      stepBall(this.ball, STEP, this.speed, (kind, p, strength) => this.broadcast({ type: 'impact', id: ++this.eventId, kind, p: [...p], strength }), undefined, (p, v, duration) => {
        const segment = this.flightHistory[this.flightIndex++ % this.flightHistory.length];
        for (let i = 0; i < 3; i++) { segment.p[i] = p[i]; segment.v[i] = v[i]; }
        segment.id = this.ball.id; segment.revision = this.ball.revision;
        segment.duration = duration; segment.at = now - (steps - step - 1) * STEP * 1000;
      });
      this.tick++;
    }
  }
  snapshot(now = Date.now()) {
    // Mode is authoritative; solo cannot silently admit a second headset.
    return { type: 'state', mode: this.mode, now, rev: this.rev, config: this.config, anchors: this.anchors, anchorOwner: this.anchorOwner, anchorVersion: this.anchorVersion, tick: this.tick, speed: this.speed, paused: this.paused, reason: this.reason, ball: this.ball, players: [...this.players.values()].map(({ id, hand, ready, calibrated, tracked, pose, lastPoseAt }) => ({ id, hand, ready, calibrated, tracked, pose, age: now - lastPoseAt })) };
  }
}
