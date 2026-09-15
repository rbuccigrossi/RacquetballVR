import * as THREE from '/vendor/three.module.js';
import { Network } from './network.js';
import { Calibration, centerAlignment } from './calibration.js';
import { Avatar, createRacquet, HeadsetHUD, CalibrationMarkers } from './models.js';
import { SpatialAudio } from './audio.js';
import { BALL_RADIUS, STEP, racquetPose, sweepRacquet, hitVelocity, stepBall } from './physics.js';
import { FEET, PLAYER_PROXIMITY_ENABLED } from './config.js';
import { distance, rotateVector, transformPoint, transformQuaternion } from './math.js';

const part = () => ({ p: [0, 0, 0], q: [0, 0, 0, 1] });
const pose = () => ({ head: part(), left: part(), right: part() });
const paddle = () => ({ center: [0, 0, 0], normal: [0, 0, 1] });
const identity = { yaw: 0, offset: [0, 0, 0] };
const parts = ['head', 'left', 'right'];
const hands = ['left', 'right'];
const forwardAxis = [0, 0, -1], upAxis = [0, 1, 0];
function readTransform(out, transform) {
  out.p[0] = transform.position.x; out.p[1] = transform.position.y; out.p[2] = transform.position.z;
  out.q[0] = transform.orientation.x; out.q[1] = transform.orientation.y; out.q[2] = transform.orientation.z; out.q[3] = transform.orientation.w;
}

export class Sandbox {
  constructor({ scene, camera, rig, renderer, safeZone, spaces }) {
    Object.assign(this, { scene, camera, rig, renderer, safeZone, spaces });
    this.network = new Network(); this.audio = new SpatialAudio();
    this.raw = pose(); this.world = pose(); this.sources = {}; this.buttons = { left: [], right: [] };
    this.currentPaddle = paddle(); this.previousPaddle = paddle(); this.ballPrevious = [0, 0, 0];
    this.forward = [0, 0, -1]; this.up = [0, 1, 0]; this.paddleVelocity = [0, 0, 0];
    this.lastFrame = 0; this.lastSend = 0; this.lastHit = 0; this.hitId = 0; this.accumulator = 0; this.poseValid = false;
    this.lastHUD = 0; this.lastHaptic = 0; this.ball = null; this.pendingHit = null; this.localPaused = true; this.hand = 'right';
    this.remote = new Avatar(scene);
    this.localHands = { left: new THREE.Group(), right: new THREE.Group() };
    for (const hand of Object.values(this.localHands)) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0xc5edac, depthTest: false }));
      mesh.renderOrder = 14; hand.add(mesh); hand.visible = false; scene.add(hand);
    }
    this.racquet = createRacquet(); this.localHands.right.add(this.racquet);
    this.ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 16, 12), new THREE.MeshStandardMaterial({ color: 0x2386ff, roughness: 0.35, emissive: 0x082e66 }));
    this.ballMesh.visible = false; scene.add(this.ballMesh);
    this.hud = new HeadsetHUD(camera);
    this.markers = new CalibrationMarkers(scene);
    this.background = scene.background; this.court = scene.getObjectByName('regulation-court');
    this.anchorVersion = -1; this.seedAlignment = null; this.pendingAnchors = null;
    this.calibration = null; this.configRev = -1; this.hasPaddle = false;
    this.bindUI(); this.bindNetwork();
    renderer.xr.addEventListener('sessionstart', () => this.startSession());
    renderer.xr.addEventListener('sessionend', () => this.endSession());
    document.querySelector('#enter-vr').addEventListener('click', () => this.audio.unlock().catch(() => {}));
  }
  bindUI() {
    this.proximityDistance = 1.37;
    document.querySelector('#proximity-distance').addEventListener('change', event => {
      const value = Number(event.target.value);
      this.proximityDistance = Number.isFinite(value) && value >= 0.2 && value <= 3 ? value : 1.37;
      event.target.value = this.proximityDistance;
    });
    this.status = document.querySelector('#sandbox-status');
    this.joinButton = document.querySelector('#join-room');
    this.joinButton.addEventListener('click', () => {
      if (this.network.id !== null) { this.network.leave(); return; }
      const chosen = this.spaces.profiles[this.spaces.active];
      this.status.textContent = 'Connecting to the local sandbox…';
      this.network.join({ ...chosen, label: this.spaces.active }, this.hand);
      this.audio.unlock().catch(() => {});
    });
    document.querySelector('#restart-alignment').addEventListener('click', () => this.restartCalibration());
    document.querySelector('#ready-player').addEventListener('click', () => this.readyOrPause());
    document.querySelector('#clear-ball').addEventListener('click', () => this.network.send({ type: 'reset' }));
    document.querySelector('#ball-speed').addEventListener('change', event => this.network.send({ type: 'speed', value: Number(event.target.value) }));
    document.querySelector('#racquet-hand').addEventListener('change', event => {
      this.hand = event.target.value; this.localHands[this.hand].add(this.racquet); this.hasPaddle = false;
      if (this.network.id !== null) this.network.send({ type: 'hand', value: this.hand });
    });
    document.querySelector('#sound-enabled').addEventListener('change', event => { this.audio.enabled = event.target.checked; if (!event.target.checked) this.audio.stop(); });
  }
  bindNetwork() {
    this.network.addEventListener('joined', () => {
      this.joinButton.textContent = `Leave sandbox · Player ${this.network.id}`;
      for (const input of document.querySelectorAll('#space-form input, #space-form select, #space-form button, #zone-form input, #zone-form button')) input.disabled = true;
      for (const id of ['ready-player', 'clear-ball', 'restart-alignment', 'ball-speed']) document.getElementById(id).disabled = false;
    });
    this.network.addEventListener('state', event => {
      const state = event.detail;
      if (state.config && state.rev !== this.configRev) {
        this.configRev = state.rev;
        this.safeZone.update(state.config.zone);
        document.querySelector('#zone-size').textContent = `${state.config.zone.width.toFixed(2)} × ${state.config.zone.depth.toFixed(2)} m`;
        this.hasPaddle = false;
      }
      if (state.config && (state.anchorVersion !== this.anchorVersion || !this.calibration)) {
        const defining = state.anchorOwner === this.network.id;
        const acceptedOwnPoints = defining && this.pendingAnchors && JSON.stringify(state.anchors) === JSON.stringify(this.pendingAnchors);
        this.anchorVersion = state.anchorVersion;
        if (!acceptedOwnPoints) {
          this.calibration = new Calibration(state.config.space, { defining, targets: state.anchors, alignment: this.seedAlignment });
          const alignment = this.seedAlignment || identity;
          this.rig.rotation.y = alignment.yaw; this.rig.position.fromArray(alignment.offset);
        }
        this.pendingAnchors = null; this.hasPaddle = false;
      }
      this.localPaused = state.paused;
      if (this.pendingSpawn && (!state.ball || state.ball.id <= this.pendingSpawn.oldId) && performance.now() - this.pendingSpawn.at < 1000 && !state.paused) {
        // Keep the one provisional replacement; never resurrect the old ball.
      } else if (!state.ball) { this.ball = null; this.pendingHit = null; }
      else if (!this.pendingHit || state.ball.id !== this.pendingHit.ballId || state.ball.revision > this.pendingHit.revision || performance.now() - this.pendingHit.at > 120 || state.paused) {
        this.ball = { ...state.ball, p: [...state.ball.p], v: [...state.ball.v] };
        this.pendingHit = null; this.pendingSpawn = null; this.accumulator = 0;
      }
      document.querySelector('#ball-speed').value = state.speed;
      document.querySelector('#speed-label').textContent = `${state.speed} m/s maximum`;
      const me = state.players.find(player => player.id === this.network.id);
      document.querySelector('#ready-player').textContent = state.paused ? (me?.ready ? 'Ready · waiting for partner' : 'Mark ready / resume') : 'Pause ball';
      this.updateUI();
    });
    this.network.addEventListener('impact', event => {
      const hit = event.detail;
      if (hit.by === this.network.id && hit.eventId === this.predictedSoundId) return;
      this.audio.play(hit.kind, hit.p, hit.strength);
    });
    this.network.addEventListener('disconnected', () => {
      this.localPaused = true; this.ball = null; this.ballMesh.visible = false; this.pendingHit = null; this.pendingSpawn = null;
      this.remote.group.visible = false; this.audio.stop(); this.hasPaddle = false; this.configRev = -1;
      // Keep the court stationary if the socket drops while the headset is on.
      // A new join still requires a new calibration before tracking is shared.
      if (this.calibration) { this.calibration.stage = 0; this.calibration.collecting = false; }
      this.joinButton.textContent = 'Join shared sandbox';
      this.status.textContent = 'Disconnected. Rejoin and recalibrate before playing.';
      for (const input of document.querySelectorAll('#space-form input, #space-form select, #space-form button, #zone-form input, #zone-form button')) input.disabled = false;
      for (const id of ['ready-player', 'clear-ball', 'restart-alignment', 'ball-speed']) document.getElementById(id).disabled = true;
    });
    this.network.addEventListener('error', event => { this.error = event.detail.message; this.errorUntil = performance.now() + 4000; this.status.textContent = this.error; });
  }
  startSession() {
    const session = this.renderer.xr.getSession();
    this.isPassthrough = session.environmentBlendMode === 'alpha-blend' || session.environmentBlendMode === 'additive';
    this.hud.plane.visible = true;
    this.seedAlignment = null; this.needsReentry = false;
    this.restartCalibration();
    this.reference = this.renderer.xr.getReferenceSpace();
    this.resetListener = () => {
      // A changed tracking reference cannot reuse the entry transform safely.
      // Require a new entry instead of silently moving the playing area.
      this.needsReentry = true;
      this.restartCalibration();
    };
    this.reference?.addEventListener('reset', this.resetListener);
    this.visibilityListener = () => { if (session.visibilityState !== 'visible') this.loseTracking(); };
    session.addEventListener('visibilitychange', this.visibilityListener);
    this.audio.unlock().catch(() => {});
  }
  endSession() {
    this.network.send({ type: 'invalidate' });
    this.reference?.removeEventListener('reset', this.resetListener);
    this.calibration = null; this.seedAlignment = null; this.pendingAnchors = null;
    this.hud.plane.visible = false; this.ballMesh.visible = false; this.remote.group.visible = false;
    this.localPaused = true; this.poseValid = false; this.ball = null; this.hasPaddle = false;
    this.rig.position.set(0, 0, 0); this.rig.rotation.set(0, 0, 0);
    for (const hand of Object.values(this.localHands)) hand.visible = false;
    this.audio.stop();
    this.markers.group.visible = false;
    this.scene.background = this.background; if (this.court) this.court.visible = true; this.safeZone.group.visible = true;
  }
  restartCalibration() {
    this.network.send({ type: 'invalidate' });
    const space = this.network.state?.config?.space;
    this.pendingAnchors = null;
    if (space) this.calibration = new Calibration(space, { defining: this.network.state.anchorOwner === this.network.id, targets: this.network.state.anchors, alignment: this.seedAlignment });
    this.poseValid = false; this.hasPaddle = false; this.localPaused = true; this.pendingHit = null;
    const alignment = this.seedAlignment || identity;
    this.rig.position.fromArray(alignment.offset); this.rig.rotation.set(0, alignment.yaw, 0);
    this.updateUI();
  }
  loseTracking() {
    if (this.poseValid) this.network.send({ type: 'lost' });
    this.poseValid = false; this.hasPaddle = false; this.localPaused = true;
    this.showPhysicalRoom(true);
    if (this.calibration?.collecting) { this.calibration.collecting = false; this.calibration.error = 'Tracking lost during sample. Hold still and retry.'; }
  }
  readyOrPause() {
    this.network.send({ type: this.network.state?.paused ? 'ready' : 'pause' });
    if (!this.network.state?.paused) this.localPaused = true;
  }
  showPhysicalRoom(setup) {
    const show = this.isPassthrough && setup;
    this.scene.background = show ? null : this.background;
    if (this.court) this.court.visible = !show;
    // The aligned floor guide remains over passthrough while players get ready.
    // Do not show an unaligned guide to the matching player.
    this.safeZone.group.visible = !this.needsReentry && Boolean(this.calibration?.complete || (this.calibration?.defining && this.seedAlignment));
  }
  updateUI() {
    const state = this.network.state;
    if (!state) return;
    const names = state.players.map(p => `P${p.id}: ${!p.calibrated ? 'alignment needed' : !p.tracked ? 'tracking unavailable' : p.ready ? 'ready' : 'aligned'}`).join(' · ');
    this.status.textContent = `${state.config?.label || 'Shared space'} · ${names}. ${state.reason}`;
    document.querySelector('#alignment-status').textContent = this.calibration?.instruction || 'Join the sandbox, then enter VR to align.';
    if (performance.now() < this.errorUntil) this.status.textContent = this.error;
  }
  readTracking(frame, session) {
    const reference = this.renderer.xr.getReferenceSpace();
    const viewer = frame.getViewerPose(reference);
    if (!viewer || viewer.emulatedPosition || session.visibilityState !== 'visible') return false;
    readTransform(this.raw.head, viewer.transform);
    // Capture entry from the first valid HEAD pose, even if controllers are
    // temporarily unavailable. Calibration and manual retries keep this origin.
    if (!this.seedAlignment) {
      this.seedAlignment = centerAlignment(this.raw.head);
      if (this.calibration && !this.calibration.complete) this.calibration.alignment = this.seedAlignment;
      this.rig.rotation.y = this.seedAlignment.yaw; this.rig.position.fromArray(this.seedAlignment.offset);
    }
    this.sources.left = null; this.sources.right = null;
    for (const source of session.inputSources) {
      if (!hands.includes(source.handedness) || !source.gripSpace || !source.gamepad) continue;
      const tracked = frame.getPose(source.gripSpace, reference);
      if (tracked && !tracked.emulatedPosition) { readTransform(this.raw[source.handedness], tracked.transform); this.sources[source.handedness] = source; }
    }
    return Boolean(this.sources.left && this.sources.right);
  }
  haptic(now, intensity = 0.8) {
    if (now - this.lastHaptic < 650) return;
    this.lastHaptic = now;
    for (const source of Object.values(this.sources)) {
      const actuator = source?.gamepad?.hapticActuators?.[0];
      try { actuator?.pulse(intensity, 130)?.catch(() => {}); } catch { /* Optional device capability. */ }
    }
  }
  input(now) {
    if (this.network.id === null) return;
    for (const hand of hands) {
      const buttons = this.sources[hand].gamepad.buttons;
      const previous = this.buttons[hand];
      for (let i = 0; i < buttons.length; i++) {
        const down = buttons[i].pressed;
        if (down && !previous[i]) {
          if (hand === 'right' && i === 5) this.restartCalibration();
          else if (!this.calibration?.complete) {
            if (hand === 'right' && i === 0) this.calibration?.startSample(now);
          } else if (hand === 'right' && (i === 1 || i === 4)) this.readyOrPause();
          else if (hand === 'left' && (i === 1 || i === 5)) this.network.send({ type: 'reset' });
          else if (hand === 'left' && i === 4) {
            const current = this.network.state?.speed || 8;
            this.network.send({ type: 'speed', value: current < 4 ? 4 : current < 8 ? 8 : current < 12 ? 12 : 4 });
          } else if (hand !== this.hand && i === 0 && !this.localPaused && this.network.fresh) {
            // Replace immediately with one provisional ball, then reconcile its ID.
            this.pendingSpawn = { oldId: this.network.state?.ball?.id || 0, at: now };
            this.ball = { id: -1, revision: 0, p: [...this.world[hand].p], v: [0, 0, 0] }; this.pendingHit = null;
            this.network.send({ type: 'spawn', requestId: `${this.network.id}:${now}` });
          }
        }
        previous[i] = down;
      }
    }
  }
  update(now, frame) {
    const session = this.renderer.xr.getSession();
    const dt = this.lastFrame ? Math.min(0.05, (now - this.lastFrame) / 1000) : STEP;
    const gap = this.lastFrame && now - this.lastFrame > 200;
    this.lastFrame = now;
    const state = this.network.state;
    if (!frame || !session) { this.remote.group.visible = false; this.ballMesh.visible = false; return; }
    this.hud.plane.visible = true;
    if (this.needsReentry) {
      this.showPhysicalRoom(true);
      this.remote.group.visible = false; this.ballMesh.visible = false; this.markers.group.visible = false;
      for (const hand of Object.values(this.localHands)) hand.visible = false;
      this.hud.set('Headset recentered. Exit and enter VR again. The reference player must enter from the room center, then choose A and B again.', true);
      return;
    }
    if (gap) this.loseTracking();
    if (!this.readTracking(frame, session)) {
      this.loseTracking(); this.remote.group.visible = false;
      for (const hand of Object.values(this.localHands)) hand.visible = false;
      this.hud.set('Tracking unavailable. Hold both controllers in view. Ball paused.', true);
      return;
    }
    this.poseValid = true;
    this.input(now);
    if (this.calibration?.collecting && this.calibration.sample(this.raw.right.p, now)) {
      const alignment = this.calibration.alignment;
      if (alignment) { this.rig.rotation.y = alignment.yaw; this.rig.position.fromArray(alignment.offset); }
      if (this.calibration.complete) {
        if (this.calibration.defining) {
          this.pendingAnchors = this.calibration.targets;
          this.network.send({ type: 'defineAnchors', points: this.pendingAnchors });
        } else this.network.send({ type: 'calibrated', error: this.calibration.residual });
      }
      this.updateUI();
    }
    const alignment = this.calibration?.alignment || this.seedAlignment || identity;
    this.markers.update(this.calibration, alignment);
    const setup = !this.calibration?.complete || state?.paused || this.localPaused || !this.network.fresh;
    this.racquet.visible = Boolean(this.calibration?.complete);
    this.showPhysicalRoom(setup);
    for (const key of parts) {
      transformPoint(this.world[key].p, this.raw[key].p, alignment);
      transformQuaternion(this.world[key].q, this.raw[key].q, alignment.yaw);
      if (key !== 'head') {
        const mesh = this.localHands[key]; mesh.visible = true;
        mesh.position.fromArray(this.world[key].p); mesh.quaternion.fromArray(this.world[key].q);
      }
    }
    rotateVector(this.forward, forwardAxis, this.world.head.q); rotateVector(this.up, upAxis, this.world.head.q);
    this.audio.listener(this.world.head.p, this.forward, this.up);
    if (this.calibration?.complete && now - this.lastSend > 1000 / 45) {
      this.network.send({ type: 'pose', seq: ++this.network.sequence, pose: this.world }); this.lastSend = now;
    }
    const other = state?.players.find(player => player.id !== this.network.id);
    const otherFresh = this.network.fresh && other?.tracked && other.age + now - this.network.lastStateAt < 300;
    let nearest = Infinity, warning = '';
    if (PLAYER_PROXIMITY_ENABLED && this.calibration?.complete && otherFresh) {
      for (const a of parts) for (const b of parts) nearest = Math.min(nearest, distance(this.world[a].p, other.pose[b].p));
      if (nearest < this.proximityDistance) warning = `Partner nearby (${nearest.toFixed(1)} m between tracked points).`;
    }
    this.remote.update(otherFresh && this.calibration?.complete ? other : null, Boolean(warning));
    if (this.calibration?.complete && state?.config) {
      const space = state.config.space;
      for (const key of parts) {
        const p = this.world[key].p;
        if (Math.abs(p[0]) > space.width * FEET / 2 - space.inset * FEET || Math.abs(p[2]) > space.depth * FEET / 2 - space.inset * FEET) warning = 'Near physical edge. Check your position.';
        const zone = state.config.zone, angle = zone.yaw * Math.PI / 180;
        const zx = Math.cos(angle) * (p[0] - zone.x) - Math.sin(angle) * (p[2] - zone.z);
        const zz = Math.sin(angle) * (p[0] - zone.x) + Math.cos(angle) * (p[2] - zone.z);
        if (Math.abs(zx) > zone.width / 2 || Math.abs(zz) > zone.depth / 2) warning = 'Outside the standing outline. Check your position.';
        if (p[1] > space.height * FEET - 0.2) warning = 'Near overhead clearance. Lower your hands.';
      }
    }
    if (warning) this.haptic(now);
    const active = this.calibration?.complete && this.network.fresh && !this.localPaused && !state?.paused && !gap;
    if (!this.network.fresh) this.localPaused = true;
    racquetPose(this.currentPaddle, this.world[this.hand]);
    if (this.ball && active) {
      for (let i = 0; i < 3; i++) this.ballPrevious[i] = this.ball.p[i];
      this.accumulator = Math.min(this.accumulator + dt, 0.05);
      while (this.accumulator >= STEP) { stepBall(this.ball, STEP, state.speed); this.accumulator -= STEP; }
      if (this.ball.id > 0 && this.hasPaddle && now - this.lastHit > 140 && !this.pendingHit) {
        const contact = sweepRacquet(this.ballPrevious, this.ball.p, this.previousPaddle, this.currentPaddle);
        if (contact) {
          for (let i = 0; i < 3; i++) this.paddleVelocity[i] = (this.currentPaddle.center[i] - this.previousPaddle.center[i]) / dt;
          if (Math.hypot(...this.paddleVelocity) < 18) {
            const eventId = String(++this.hitId);
            this.network.send({ type: 'hit', ballId: this.ball.id, ballRevision: this.ball.revision, contact, eventId });
            this.pendingHit = { ballId: this.ball.id, revision: this.ball.revision, at: now };
            this.ball.v = hitVelocity(this.ball.v, this.currentPaddle.normal, this.paddleVelocity, state.speed);
            this.ball.p = contact; this.lastHit = now; this.predictedSoundId = eventId;
            this.audio.play('racquet', contact, Math.hypot(...this.ball.v)); this.haptic(now, 0.25);
          }
        }
      }
    }
    for (let i = 0; i < 3; i++) { this.previousPaddle.center[i] = this.currentPaddle.center[i]; this.previousPaddle.normal[i] = this.currentPaddle.normal[i]; }
    this.hasPaddle = Boolean(active);
    this.ballMesh.visible = Boolean(this.ball && this.calibration?.complete && this.network.fresh);
    if (this.ballMesh.visible) this.ballMesh.position.fromArray(this.ball.p);
    if (now - this.lastHUD > 100) {
      this.lastHUD = now;
      let text;
      if (!this.network.id) text = 'Leave VR and join the shared sandbox on the setup page first.';
      else if (!this.network.fresh) text = 'Connection stale. Ball paused. Check your LAN connection.';
      else if (!this.calibration?.complete) text = this.calibration?.instruction || 'Waiting for shared room settings.';
      else text = `${warning || state.reason} ${state.paused ? 'Mint floor outline: play area. Cross: center. Check alignment. RIGHT grip: ready. ' : `${this.hand === 'right' ? 'LEFT' : 'RIGHT'} trigger: new ball. RIGHT grip: pause. `}LEFT grip: clear. X: speed. B: recalibrate. ${state.speed} m/s. P${this.network.id}.`;
      if (now < this.errorUntil) text = this.error;
      this.hud.set(text, Boolean(warning || !this.network.fresh));
    }
  }
}
