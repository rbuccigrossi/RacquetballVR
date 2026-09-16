import * as THREE from '/vendor/three.module.js';
import { Network } from './network.js';
import { Calibration, centerAlignment } from './calibration.js';
import { Avatar, createRacquet, InstructionSign, CalibrationMarkers } from './models.js';
import { SpatialAudio } from './audio.js';
import { BALL_RADIUS, STEP, racquetPose, predictBall, createRacquetSweep, HIT_COOLDOWN_MS } from './physics.js';
import { FEET, PLAYER_PROXIMITY_ENABLED } from './config.js';
import { distance, rotateVector, transformPoint, transformQuaternion, composeAlignment } from './math.js';

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
    this.tracked = { head: false, left: false, right: false };
    this.packet = { head: null, left: null, right: null };
    this.currentPaddle = paddle(); this.previousPaddle = paddle();
    this.racquetSweep = createRacquetSweep((contact, normal, incoming, outgoing) => {
      const eventId = String(++this.hitId), now = this.hitTime;
      // Send the current grip pose before the hit, rather than using a stale
      // 45 Hz pose to validate a fast swing on the server.
      if (now - this.lastSend > 5) {
        this.network.send({ type: 'pose', anchorVersion: this.anchorVersion, seq: ++this.network.sequence, pose: this.packet });
        this.lastSend = now;
      }
      this.network.send({ type: 'hit', anchorVersion: this.anchorVersion, ballId: this.ball.id, ballRevision: this.ball.revision, contact, normal, eventId });
      this.pendingHit = { ballId: this.ball.id, revision: this.ball.revision, at: now };
      this.lastHit = now; this.predictedSoundId = eventId;
      this.audio.play('racquet', contact, Math.hypot(...outgoing)); this.haptic(now, 0.25);
    });
    this.forward = [0, 0, -1]; this.up = [0, 1, 0];
    this.lastFrame = 0; this.lastSend = 0; this.lastHit = 0; this.hitId = 0; this.poseValid = false;
    this.lastHaptic = 0; this.ball = null; this.pendingHit = null; this.localPaused = true; this.hand = 'right';
    this.remote = new Avatar(scene);
    this.localHands = { left: new THREE.Group(), right: new THREE.Group() };
    for (const hand of Object.values(this.localHands)) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0xc5edac, depthTest: false }));
      mesh.renderOrder = 14; hand.add(mesh); hand.visible = false; scene.add(hand);
    }
    this.racquet = createRacquet(); this.localHands.right.add(this.racquet);
    this.ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 16, 12), new THREE.MeshStandardMaterial({ color: 0x2386ff, roughness: 0.35, emissive: 0x082e66 }));
    this.ballMesh.visible = false; scene.add(this.ballMesh);
    // A short translucent capsule bridges the ball's last rendered position
    // to its current position. It is visual-only and never participates in
    // collision tests.
    this.streakMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.003, 1, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0x54a8ff, transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.streakMesh.visible = false; this.streakMesh.renderOrder = 1; scene.add(this.streakMesh);
    this.streakAxis = new THREE.Vector3(0, 1, 0);
    this.streakPrevious = new THREE.Vector3(); this.streakCurrent = new THREE.Vector3(); this.streakDirection = new THREE.Vector3(); this.streakMidpoint = new THREE.Vector3();
    this.streakBallId = null; this.streakValid = false;
    this.sign = new InstructionSign(scene);
    this.signHidden = false; this.lastPaused = true;
    this.markers = new CalibrationMarkers(scene);
    this.background = scene.background; this.court = scene.getObjectByName('regulation-court');
    this.anchorVersion = -1; this.seedAlignment = null; this.pendingAnchors = null;
    this.calibration = null; this.configRev = -1; this.hasPaddle = false;
    this.bindUI(); this.bindNetwork();
    renderer.xr.addEventListener('sessionstart', () => this.startSession());
    renderer.xr.addEventListener('sessionend', () => this.endSession());
    document.querySelector('#enter-vr').addEventListener('click', () => this.audio.unlock().catch(() => {}));
  }
  toggleSign() {
    this.signHidden = !this.signHidden;
  }
  startButtonPressed(hand) {
    if (!this.tracked[hand]) return false;
    const alignment = this.calibration?.alignment || this.seedAlignment || identity;
    transformPoint(this.world[hand].p, this.raw[hand].p, alignment);
    return this.sign.containsButton(this.world[hand].p);
  }
  updateSign(state) {
    const paused = Boolean(state?.paused);
    if (paused && !this.lastPaused) this.signHidden = false;
    this.lastPaused = paused;
    const complete = Boolean(this.calibration?.complete);
    const allCalibrated = state?.mode === 'solo'
      ? complete
      : Boolean(state?.players?.length >= 2 && state.players.every(player => player.calibrated));
    const visible = Boolean(state && (paused || !complete) && !this.signHidden);
    const enabled = Boolean(visible && complete && allCalibrated && this.network.fresh && state.players.every(player => player.tracked));
    this.sign.set({ visible, enabled, mode: state?.mode, reason: state?.reason, playerCount: state?.players?.length || 0, calibrated: allCalibrated });
  }
  updateBallStreak() {
    if (!this.ballMesh.visible || !this.ball) {
      this.streakMesh.visible = false; this.streakValid = false; this.streakBallId = null; return;
    }
    this.streakCurrent.fromArray(this.ball.p);
    if (this.streakBallId !== this.ball.id || !this.streakValid) {
      this.streakPrevious.copy(this.streakCurrent); this.streakBallId = this.ball.id; this.streakValid = true; this.streakMesh.visible = false; return;
    }
    this.streakDirection.subVectors(this.streakCurrent, this.streakPrevious);
    const length = this.streakDirection.length();
    if (length < 0.002) this.streakMesh.visible = false;
    else {
      this.streakMidpoint.addVectors(this.streakPrevious, this.streakCurrent).multiplyScalar(0.5);
      this.streakMesh.position.copy(this.streakMidpoint);
      this.streakMesh.quaternion.setFromUnitVectors(this.streakAxis, this.streakDirection.normalize());
      this.streakMesh.scale.set(1, length, 1); this.streakMesh.visible = true;
    }
    this.streakPrevious.copy(this.streakCurrent);
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
    this.modeSelect = document.querySelector('#play-mode');
    this.modeSelect.addEventListener('change', () => this.renderMode());
    this.renderMode();
    this.joinButton.addEventListener('click', () => {
      if (this.network.id !== null) { this.network.leave(); return; }
      const chosen = this.spaces.profiles[this.spaces.active];
      this.status.textContent = 'Connecting to the local sandbox…';
      this.network.join({ ...chosen, label: this.spaces.active }, this.hand, this.modeSelect.value);
      this.audio.unlock().catch(() => {});
    });
    document.querySelector('#restart-alignment').addEventListener('click', () => this.restartCalibration());
    document.querySelector('#ready-player').addEventListener('click', () => this.readyOrPause());
    document.querySelector('#clear-ball').addEventListener('click', () => this.network.send({ type: 'reset' }));
    document.querySelector('#ball-speed').addEventListener('change', event => this.network.send({ type: 'speed', value: Number(event.target.value) }));
    document.querySelector('#ball-time-scale').addEventListener('change', event => this.network.send({ type: 'timeScale', value: Number(event.target.value) }));
    document.querySelector('#racquet-hand').addEventListener('change', event => {
      this.hand = event.target.value; this.localHands[this.hand].add(this.racquet); this.hasPaddle = false;
      if (this.network.id !== null) this.network.send({ type: 'hand', value: this.hand });
    });
    document.querySelector('#sound-enabled').addEventListener('change', event => { this.audio.enabled = event.target.checked; if (!event.target.checked) this.audio.stop(); });
  }
  renderMode() {
    const solo = this.modeSelect.value === 'solo';
    document.querySelector('#join-help').textContent = solo ? 'Choose your physical space, start solo practice, then enter VR from the room center. Touch START on the sign with either controller to begin.' : 'First player to join shares their selected space. Join here before entering VR on each headset. Leave to edit location settings.';
    document.querySelector('#shared-alignment-guide').hidden = solo;
    document.querySelector('#solo-guide').hidden = !solo;
    document.querySelector('#restart-alignment').textContent = solo ? 'Recenter court' : 'Restart alignment';
    if (this.network.id === null) this.joinButton.textContent = solo ? 'Start solo practice' : 'Join shared sandbox';
  }
  prepareSolo() {
    if (this.network.state?.mode !== 'solo' || !this.seedAlignment || !this.calibration || this.calibration.complete) return;
    this.calibration.solo = true;
    this.calibration.alignment = this.seedAlignment;
    this.calibration.stage = 2;
    this.calibration.residual = 0;
    this.network.send({ type: 'soloAligned', anchorVersion: this.anchorVersion });
    this.updateUI();
  }
  bindNetwork() {
    this.network.addEventListener('joined', () => {
      this.joinButton.textContent = `Leave sandbox · Player ${this.network.id}`;
      this.modeSelect.disabled = true;
      for (const input of document.querySelectorAll('#space-form input, #space-form select, #space-form button, #zone-form input, #zone-form button')) input.disabled = true;
      for (const id of ['ready-player', 'clear-ball', 'restart-alignment', 'ball-speed', 'ball-time-scale']) document.getElementById(id).disabled = false;
    });
    this.network.addEventListener('state', event => {
      const state = event.detail;
      this.modeSelect.value = state.mode || 'shared'; this.renderMode();
      if (state.config && state.rev !== this.configRev) {
        this.configRev = state.rev;
        this.safeZone.update(state.config.zone);
        document.querySelector('#zone-size').textContent = `${state.config.zone.width.toFixed(2)} × ${state.config.zone.depth.toFixed(2)} m`;
        this.hasPaddle = false;
      }
      if (state.config && (state.anchorVersion !== this.anchorVersion || !this.calibration)) {
        const owner = state.anchorOwner === this.network.id;
        const defining = owner && !state.anchors;
        const acceptedOwnPoints = owner && this.pendingAnchors && JSON.stringify(state.anchors) === JSON.stringify(this.pendingAnchors);
        this.anchorVersion = state.anchorVersion;
        if (!acceptedOwnPoints) {
          this.calibration = new Calibration(state.config.space, { defining, targets: state.anchors, alignment: this.seedAlignment, solo: state.mode === 'solo' });
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
        this.pendingHit = null; this.pendingSpawn = null;
      }
      document.querySelector('#ball-speed').value = state.speed;
      document.querySelector('#speed-label').textContent = `${state.speed} m/s maximum`;
      const timeScale = Number.isFinite(state.timeScale) ? state.timeScale : 1;
      document.querySelector('#ball-time-scale').value = timeScale;
      document.querySelector('#ball-time-label').textContent = `${timeScale.toFixed(1)}× ball time`;
      const me = state.players.find(player => player.id === this.network.id);
      document.querySelector('#ready-player').textContent = state.paused ? (me?.ready ? 'Ready · waiting for partner' : 'Start / resume (browser)') : 'Pause ball';
      this.updateUI();
    });
    this.network.addEventListener('roomShift', event => {
      const { shift, fromVersion, anchorVersion } = event.detail;
      if (fromVersion !== this.anchorVersion) return; // Next state requests a fresh alignment if an event was missed.
      this.anchorVersion = anchorVersion;
      if (this.seedAlignment) this.seedAlignment = composeAlignment(shift, this.seedAlignment);
      if (this.calibration?.alignment) this.calibration.alignment = composeAlignment(shift, this.calibration.alignment);
      if (this.calibration?.targets) this.calibration.targets = this.calibration.targets.map(p => transformPoint([0, 0, 0], p, shift));
      if (this.pendingAnchors) this.pendingAnchors = this.pendingAnchors.map(p => transformPoint([0, 0, 0], p, shift));
      const alignment = this.calibration?.alignment || this.seedAlignment || identity;
      this.rig.rotation.y = alignment.yaw; this.rig.position.fromArray(alignment.offset);
      this.hasPaddle = false; this.ball = null; this.pendingHit = null; this.pendingSpawn = null;
    });
    this.network.addEventListener('impact', event => {
      const hit = event.detail;
      if (hit.by === this.network.id && hit.eventId === this.predictedSoundId) return;
      this.audio.play(hit.kind, hit.p, hit.strength);
    });
    this.network.addEventListener('disconnected', () => {
      this.localPaused = true; this.ball = null; this.ballMesh.visible = false; this.pendingHit = null; this.pendingSpawn = null;
      this.remote.group.visible = false; this.streakMesh.visible = false; this.streakValid = false; this.streakBallId = null; this.audio.stop(); this.hasPaddle = false; this.configRev = -1;
      // Keep the court stationary if the socket drops while the headset is on.
      // A new join still requires a new calibration before tracking is shared.
      if (this.calibration) { this.calibration.stage = 0; this.calibration.collecting = false; }
      this.modeSelect.disabled = false; this.renderMode();
      this.status.textContent = this.modeSelect.value === 'solo' ? 'Disconnected. Start solo practice to reconnect.' : 'Disconnected. Rejoin and recalibrate before playing.';
      for (const input of document.querySelectorAll('#space-form input, #space-form select, #space-form button, #zone-form input, #zone-form button')) input.disabled = false;
      for (const id of ['ready-player', 'clear-ball', 'restart-alignment', 'ball-speed', 'ball-time-scale']) document.getElementById(id).disabled = true;
    });
    this.network.addEventListener('error', event => { this.error = event.detail.message; this.errorUntil = performance.now() + 4000; this.status.textContent = this.error; });
  }
  startSession() {
    const session = this.renderer.xr.getSession();
    this.isPassthrough = session.environmentBlendMode === 'alpha-blend' || session.environmentBlendMode === 'additive';
    this.signHidden = false; this.lastPaused = true; this.sign.group.visible = true;
    this.seedAlignment = null; this.recenterPending = false;
    this.restartCalibration();
    this.reference = this.renderer.xr.getReferenceSpace();
    this.resetListener = event => this.referenceReset(event);
    this.reference?.addEventListener('reset', this.resetListener);
    this.visibilityListener = () => { if (session.visibilityState !== 'visible') this.loseTracking(); };
    session.addEventListener('visibilitychange', this.visibilityListener);
    this.audio.unlock().catch(() => {});
  }
  endSession() {
    this.network.send({ type: 'invalidate' });
    this.reference?.removeEventListener('reset', this.resetListener);
    this.calibration = null; this.seedAlignment = null; this.pendingAnchors = null;
    this.sign.group.visible = false; this.signHidden = false; this.lastPaused = true;
    this.ballMesh.visible = false; this.streakMesh.visible = false; this.streakValid = false; this.streakBallId = null; this.remote.group.visible = false;
    this.localPaused = true; this.poseValid = false; this.ball = null; this.hasPaddle = false;
    this.rig.position.set(0, 0, 0); this.rig.rotation.set(0, 0, 0);
    for (const hand of Object.values(this.localHands)) hand.visible = false;
    this.audio.stop();
    this.markers.group.visible = false;
    this.scene.background = this.background; if (this.court) this.court.visible = true; this.safeZone.group.visible = true;
  }
  restartCalibration(clearAnchors = false) {
    if (this.network.state?.mode === 'solo' && this.seedAlignment && !clearAnchors) { this.recenterRoom(); return; }
    this.network.send({ type: 'invalidate', clearAnchors });
    const space = this.network.state?.config?.space;
    this.pendingAnchors = null;
    const targets = clearAnchors ? null : this.network.state?.anchors;
    if (space) this.calibration = new Calibration(space, { defining: this.network.state.anchorOwner === this.network.id && !targets, targets, alignment: this.seedAlignment, solo: this.network.state.mode === 'solo' });
    this.poseValid = false; this.hasPaddle = false; this.localPaused = true; this.pendingHit = null;
    const alignment = this.seedAlignment || identity;
    this.rig.position.fromArray(alignment.offset); this.rig.rotation.set(0, alignment.yaw, 0);
    this.updateUI();
  }
  referenceReset(event) {
    const t = event.transform, q = t?.orientation, p = t?.position;
    // WebXR defines this as NEW reference coordinates -> OLD reference coordinates.
    // Floor spaces are gravity aligned. Unknown or tilted changes need fresh A/B.
    const known = q && p && [q.x, q.y, q.z, q.w, p.x, p.y, p.z].every(Number.isFinite) && Math.abs(q.x) < 0.02 && Math.abs(q.z) < 0.02;
    const owner = this.network.state?.anchorOwner === this.network.id;
    if (known && this.seedAlignment) {
      const delta = { yaw: 2 * Math.atan2(q.y, q.w), offset: [p.x, p.y, p.z] };
      this.seedAlignment = composeAlignment(this.seedAlignment, delta);
      if (this.calibration?.alignment) this.calibration.alignment = composeAlignment(this.calibration.alignment, delta);
      if (!this.calibration?.complete) this.restartCalibration();
      this.hasPaddle = false;
      const alignment = this.calibration?.alignment || this.seedAlignment;
      this.rig.rotation.y = alignment.yaw; this.rig.position.fromArray(alignment.offset);
      this.recenterPending = owner;
    } else {
      // No guess based on the previous frame: the player may have moved.
      // Stay in XR; owner starts a new center/pair, partner rematches existing A/B.
      this.seedAlignment = null;
      this.restartCalibration(owner);
    }
  }
  recenterRoom() {
    if (this.network.state?.anchorOwner !== this.network.id) {
      this.error = 'Player 1 sets the room center. Tap B to repeat your A/B alignment.';
      this.errorUntil = performance.now() + 4000; return;
    }
    if (!this.tracked.head) { this.recenterPending = true; return; }
    const alignment = this.calibration?.alignment || this.seedAlignment;
    if (!alignment) return;
    const head = part();
    transformPoint(head.p, this.raw.head.p, alignment);
    transformQuaternion(head.q, this.raw.head.q, alignment.yaw);
    this.network.send({ type: 'recenter', shift: centerAlignment(head), anchorVersion: this.anchorVersion });
    this.recenterPending = false; this.hasPaddle = false;
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
    this.safeZone.group.visible = Boolean(this.calibration?.complete || (this.calibration?.defining && this.seedAlignment));
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
    this.tracked.head = Boolean(viewer && !viewer.emulatedPosition && session.visibilityState === 'visible');
    if (this.tracked.head) readTransform(this.raw.head, viewer.transform);
    // Capture entry from the first valid HEAD pose, even if controllers are
    // temporarily unavailable. Calibration and manual retries keep this origin.
    if (!this.seedAlignment && this.tracked.head) {
      this.seedAlignment = centerAlignment(this.raw.head);
      if (this.calibration && !this.calibration.complete) this.calibration.alignment = this.seedAlignment;
      this.rig.rotation.y = this.seedAlignment.yaw; this.rig.position.fromArray(this.seedAlignment.offset);
    }
    this.sources.left = null; this.sources.right = null;
    this.tracked.left = false; this.tracked.right = false;
    for (const source of session.inputSources) {
      if (!hands.includes(source.handedness) || !source.gripSpace || !source.gamepad) continue;
      this.sources[source.handedness] = source;
      const tracked = frame.getPose(source.gripSpace, reference);
      if (tracked && !tracked.emulatedPosition && session.visibilityState === 'visible') { readTransform(this.raw[source.handedness], tracked.transform); this.tracked[source.handedness] = true; }
    }
    return this.tracked.head;
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
      const previous = this.buttons[hand];
      if (!this.sources[hand]) { previous.length = 0; continue; }
      const buttons = this.sources[hand].gamepad.buttons;
      for (let i = 0; i < buttons.length; i++) {
        const down = buttons[i].pressed;
        if (hand === 'right' && i === 5) {
          if (down && !previous[i]) { this.bStarted = now; this.bHeld = false; }
          if (down && !this.bHeld && now - this.bStarted >= 1000) { this.bHeld = true; this.recenterRoom(); }
          if (!down && previous[i] && !this.bHeld) this.restartCalibration();
          previous[i] = down; continue;
        }
        if (down && !previous[i]) {
          if (!this.calibration?.complete) {
            if (hand === 'right' && i === 0 && this.tracked.right && this.seedAlignment) this.calibration?.startSample(now);
          } else if (i === 0 && this.network.state?.paused && this.sign.enabled && this.startButtonPressed(hand)) this.network.send({ type: 'start' });
          else if (hand === 'right' && (i === 1 || i === 4)) this.readyOrPause();
          else if (hand === 'left' && (i === 1 || i === 5)) this.network.send({ type: 'reset' });
          else if (hand === 'left' && i === 4) this.toggleSign();
          else if (hand !== this.hand && i === 0 && this.tracked[hand] && !this.localPaused && this.network.fresh) {
            // Replace immediately with one provisional ball, then reconcile its ID.
            transformPoint(this.world[hand].p, this.raw[hand].p, this.calibration.alignment);
            this.pendingSpawn = { oldId: this.network.state?.ball?.id || 0, at: now };
            this.ball = { id: -1, revision: 0, p: [...this.world[hand].p], v: [0, 0, 0] }; this.pendingHit = null;
            this.network.send({ type: 'spawn', anchorVersion: this.anchorVersion, requestId: `${this.network.id}:${now}` });
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
    if (!frame || !session) { this.remote.group.visible = false; this.ballMesh.visible = false; this.streakMesh.visible = false; this.streakValid = false; this.streakBallId = null; this.sign.group.visible = false; return; }
    if (gap) this.hasPaddle = false;
    this.poseValid = this.readTracking(frame, session);
    this.prepareSolo();
    if (this.recenterPending && this.tracked.head) this.recenterRoom();
    this.input(now);
    if (this.calibration?.collecting && !this.tracked.right) {
      this.calibration.collecting = false; this.calibration.error = 'Right controller tracking lost. Hold it steady and press trigger to retry this spot.';
    }
    if (this.calibration?.collecting && this.calibration.sample(this.raw.right.p, now)) {
      const alignment = this.calibration.alignment;
      if (alignment) { this.rig.rotation.y = alignment.yaw; this.rig.position.fromArray(alignment.offset); }
      if (this.calibration.complete) {
        if (this.calibration.defining) {
          this.pendingAnchors = this.calibration.targets;
          this.network.send({ type: 'defineAnchors', anchorVersion: this.anchorVersion, points: this.pendingAnchors });
        } else this.network.send({ type: 'calibrated', anchorVersion: this.anchorVersion, error: this.calibration.residual });
      }
      this.updateUI();
    }
    const alignment = this.calibration?.alignment || this.seedAlignment || identity;
    this.markers.update(this.calibration, alignment);
    const setup = !this.tracked.head || !this.calibration?.complete || state?.paused || this.localPaused || !this.network.fresh;
    this.racquet.visible = Boolean(this.calibration?.complete);
    this.showPhysicalRoom(setup);
    for (const key of parts) {
      this.packet[key] = this.tracked[key] ? this.world[key] : null;
      if (key !== 'head') this.localHands[key].visible = this.tracked[key];
      if (!this.tracked[key]) continue;
      transformPoint(this.world[key].p, this.raw[key].p, alignment);
      transformQuaternion(this.world[key].q, this.raw[key].q, alignment.yaw);
      if (key !== 'head') {
        const mesh = this.localHands[key]; mesh.visible = true;
        mesh.position.fromArray(this.world[key].p); mesh.quaternion.fromArray(this.world[key].q);
      }
    }
    rotateVector(this.forward, forwardAxis, this.world.head.q); rotateVector(this.up, upAxis, this.world.head.q);
    if (this.tracked.head) this.audio.listener(this.world.head.p, this.forward, this.up);
    if (this.calibration?.complete && now - this.lastSend > 1000 / 45) {
      this.network.send({ type: 'pose', anchorVersion: this.anchorVersion, seq: ++this.network.sequence, pose: this.packet }); this.lastSend = now;
    }
    const other = state?.players.find(player => player.id !== this.network.id);
    const otherFresh = this.network.fresh && other?.tracked && other.age + now - this.network.lastStateAt < 300;
    let nearest = Infinity, warning = '';
    if (PLAYER_PROXIMITY_ENABLED && this.calibration?.complete && otherFresh) {
      for (const a of parts) for (const b of parts) if (this.tracked[a] && other.pose[b]) nearest = Math.min(nearest, distance(this.world[a].p, other.pose[b].p));
      if (nearest < this.proximityDistance) warning = `Partner nearby (${nearest.toFixed(1)} m between tracked points).`;
    }
    this.remote.update(otherFresh && this.calibration?.complete ? other : null, Boolean(warning));
    if (this.calibration?.complete && state?.config) {
      const space = state.config.space;
      for (const key of parts) {
        if (!this.tracked[key]) continue;
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
      const canHit = this.tracked[this.hand] && this.tracked.head && this.ball.id > 0 && this.hasPaddle && now - this.lastHit > HIT_COOLDOWN_MS && !this.pendingHit;
      this.hitTime = now;
      predictBall(this.ball, dt, state.speed, this.previousPaddle, this.currentPaddle, canHit ? this.racquetSweep : null, state.timeScale ?? 1);
    }
    for (let i = 0; i < 3; i++) { this.previousPaddle.center[i] = this.currentPaddle.center[i]; this.previousPaddle.normal[i] = this.currentPaddle.normal[i]; }
    this.hasPaddle = Boolean(active && this.tracked[this.hand] && this.tracked.head);
    this.ballMesh.visible = Boolean(this.ball && this.calibration?.complete && this.network.fresh);
    if (this.ballMesh.visible) this.ballMesh.position.fromArray(this.ball.p);
    this.updateBallStreak();
    this.updateSign(state);
  }
}
