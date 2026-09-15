// Runs the production Sandbox class with two synthetic XRFrame streams and real
// WSS connections. This exercises controller flow, not native WebXR or hardware.
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = await mkdtemp(join(tmpdir(), 'racquetball-browser-'));
const server = await createServer({ directory, addresses: [] });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `https://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined, args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const solo = process.argv.includes('--solo');
try {
  const pages = [];
  for (let i = 0; i < (solo ? 1 : 2); i++) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/js/app.js', route => route.fulfill({ contentType: 'text/javascript', body: '// Test harness supplies synthetic XR frames.' }));
    await page.goto(url);
    await page.evaluate(async index => {
      const THREE = await import('/vendor/three.module.js');
      const { Sandbox } = await import('/js/sandbox.js');
      const { composeAlignment } = await import('/js/math.js');
      const { SafeZone } = await import('/js/safe-zone.js');
      const { loadSpaces } = await import('/js/spaces.js');
      const { initializeSpaceControls } = await import('/js/spaces-ui.js');
      const spaces = loadSpaces({ getItem: () => null });
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), rig = new THREE.Group();
      rig.add(camera); scene.add(rig);
      scene.background = new THREE.Color(0xaaaaaa);
      const court = new THREE.Group(); court.name = 'regulation-court'; scene.add(court);
      const reference = new EventTarget(), session = new EventTarget(), xr = new EventTarget();
      session.visibilityState = 'visible';
      session.environmentBlendMode = 'alpha-blend';
      const sources = ['left', 'right'].map(hand => ({ handedness: hand, gripSpace: { hand }, gamepad: { buttons: Array.from({ length: 6 }, () => ({ pressed: false })), hapticActuators: [{ pulse: async () => { window.sim.pulses++; return true; } }] } }));
      session.inputSources = sources;
      xr.getSession = () => session; xr.getReferenceSpace = () => reference;
      const renderer = { xr };
      const safeZone = new SafeZone(scene, spaces.profiles.garage.zone);
      initializeSpaceControls(spaces, zone => safeZone.update(zone));
      const sandbox = new Sandbox({ scene, camera, rig, renderer, safeZone, spaces });
      let yaw = index ? -0.7 : 0.4, offset = index ? [-0.6, -0.02, 1.3] : [1.2, 0.03, -0.7];
      const raw = {}, physical = {};
      function position(key, p) {
        physical[key] = p;
        const x = p[0] - offset[0], z = p[2] - offset[2];
        raw[key] = { position: { x: Math.cos(yaw) * x - Math.sin(yaw) * z, y: p[1] - offset[1], z: Math.sin(yaw) * x + Math.cos(yaw) * z }, orientation: { x: 0, y: Math.sin(-yaw / 2), z: 0, w: Math.cos(yaw / 2) } };
      }
      const x = index ? 0.9 : -0.9;
      position('head', [x, 1.65, 0]); position('left', [x - 0.25, 1.15, 0]); position('right', [x + 0.25, 1.15, 0]);
      const frame = {
        getViewerPose: () => window.sim.lost ? null : ({ transform: raw.head, emulatedPosition: false }),
        getPose: space => window.sim.controllersLost || window.sim.missing === space.hand ? null : ({ transform: raw[space.hand], emulatedPosition: false })
      };
      window.sim = { sandbox, position, sources, reference, frame, session, pulses: 0, lost: false, controllersLost: index === 0,
        start() { sandbox.startSession(); this.timer = setInterval(() => sandbox.update(performance.now(), frame), 16); },
        resetOrigin(delta, known = true) {
          const next = composeAlignment({ yaw, offset }, delta); yaw = next.yaw; offset = next.offset;
          for (const [key, p] of Object.entries(physical)) position(key, p);
          const event = new Event('reset');
          event.transform = known ? { position: { x: delta.offset[0], y: delta.offset[1], z: delta.offset[2] }, orientation: { x: 0, y: Math.sin(delta.yaw / 2), z: 0, w: Math.cos(delta.yaw / 2) } } : null;
          reference.dispatchEvent(event);
        },
        press(hand, button, down) { sources.find(source => source.handedness === hand).gamepad.buttons[button].pressed = down; }
      };
    }, i);
    if (solo) {
      await page.locator('#play-mode').selectOption('solo');
      await page.evaluate(() => { window.sim.controllersLost = false; });
    }
    await page.getByRole('button', { name: solo ? 'Start solo practice' : 'Join shared sandbox' }).click();
    await page.waitForFunction(() => window.sim.sandbox.network.id !== null && window.sim.sandbox.network.state?.config);
    await page.evaluate(() => window.sim.start());
    if (i === 0 && !solo) {
      await page.waitForFunction(() => window.sim.sandbox.seedAlignment);
      await page.evaluate(() => {
        window.sim.entryAlignment = structuredClone(window.sim.sandbox.seedAlignment);
        window.sim.position('head', [0.4, 1.65, 0.6]);
        window.sim.controllersLost = false;
      });
      await page.waitForFunction(() => window.sim.sandbox.poseValid);
      await page.evaluate(() => window.sim.sandbox.restartCalibration());
      await page.waitForFunction(() => window.sim.sandbox.network.state.anchors === null);
      assert.deepEqual(await page.evaluate(() => window.sim.sandbox.seedAlignment), await page.evaluate(() => window.sim.entryAlignment));
      await page.evaluate(() => window.sim.position('head', [-0.9, 1.65, 0]));
    }
    await page.waitForFunction(() => window.sim.sandbox.poseValid);
  }
  const tap = async (page, hand, index) => {
    await page.evaluate(([hand, index]) => window.sim.press(hand, index, true), [hand, index]);
    await page.waitForTimeout(50);
    await page.evaluate(([hand, index]) => window.sim.press(hand, index, false), [hand, index]);
    await page.waitForTimeout(30);
  };
  if (solo) {
    const page = pages[0];
    await page.waitForFunction(() => window.sim.sandbox.calibration.complete && window.sim.sandbox.network.state.players[0].tracked);
    assert.equal(await page.locator('#shared-alignment-guide').isVisible(), false);
    assert.ok(await page.locator('#solo-guide').isVisible());
    assert.equal(await page.evaluate(() => window.sim.sandbox.network.state.anchors), null);
    assert.equal(await page.evaluate(() => window.sim.sandbox.markers.group.visible), false);
    await tap(page, 'right', 1);
    await page.waitForFunction(() => !window.sim.sandbox.network.state.paused && window.sim.sandbox.court.visible);
    await page.evaluate(() => { window.sim.position('left', [-0.65, 1.3, -0.27]); window.sim.position('right', [-0.8, 1.3, 0]); });
    await page.waitForTimeout(80);
    await tap(page, 'left', 0);
    await page.waitForFunction(() => window.sim.sandbox.ball?.id === 1);
    for (const x of [-0.71, -0.62, -0.53]) {
      await page.evaluate(x => window.sim.position('right', [x, 1.3, 0]), x);
      await page.waitForTimeout(20);
    }
    await page.waitForFunction(() => window.sim.sandbox.network.state.ball?.revision > 0 && window.sim.sandbox.hitId > 0);
    await tap(page, 'right', 1);
    await page.waitForFunction(() => window.sim.sandbox.network.state.paused);
    await tap(page, 'right', 1);
    await page.waitForFunction(() => !window.sim.sandbox.network.state.paused);
    await page.evaluate(() => { window.sim.controllersLost = true; });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.sim.sandbox.network.state.paused), false);
    await page.evaluate(() => { window.sim.controllersLost = false; window.sim.position('head', [0.3, 1.65, 0.2]); });
    await tap(page, 'right', 5);
    await page.waitForFunction(() => window.sim.sandbox.calibration.complete && Math.hypot(window.sim.sandbox.world.head.p[0], window.sim.sandbox.world.head.p[2]) < 0.001 && !window.sim.sandbox.ball);
    await page.evaluate(() => window.sim.resetOrigin({ yaw: 0.3, offset: [0.2, 0, -0.4] }, false));
    await page.waitForFunction(() => window.sim.sandbox.calibration.complete && window.sim.sandbox.network.state.players[0].calibrated);
    assert.equal(await page.evaluate(() => window.sim.sandbox.network.state.anchors), null);
    await page.getByRole('button', { name: 'Leave sandbox' }).click();
    await page.waitForFunction(() => window.sim.sandbox.network.id === null);
    await page.locator('#play-mode').selectOption('shared');
    await page.getByRole('button', { name: 'Join shared sandbox' }).click();
    await page.waitForFunction(() => window.sim.sandbox.network.state?.mode === 'shared' && window.sim.sandbox.network.id !== null);
    assert.equal(await page.evaluate(() => window.sim.sandbox.calibration.complete), false);
    assert.equal(await page.evaluate(() => window.sim.sandbox.network.state.paused), true);
    console.log('PASS: solo browser: no A/B, one-player ready/spawn/predicted hit accepted by server, pause/resume, controller loss, in-VR recenter/reset, return to shared mode requires calibration.');
  } else {
  const physicalPoints = [[-0.5, 0.9, -0.5], [0.6, 1.1, -0.3]];
  assert.ok(await pages[0].evaluate(() => window.sim.sandbox.markers.group.visible && window.sim.sandbox.scene.background === null && !window.sim.sandbox.court.visible));
  assert.ok(await pages[0].evaluate(() => window.sim.sandbox.safeZone.group.visible));
  assert.equal(await pages[1].evaluate(() => window.sim.sandbox.safeZone.group.visible), false);
  for (const page of pages) {
    await page.evaluate(() => { window.sim.missing = 'left'; });
    await page.waitForFunction(() => window.sim.sandbox.calibration.defining || window.sim.sandbox.calibration.targets);
    for (let marker = 0; marker < 2; marker++) {
      await page.evaluate(point => window.sim.position('right', point), physicalPoints[marker]);
      await tap(page, 'right', 0);
      await page.waitForFunction(stage => window.sim.sandbox.calibration.stage === stage, marker + 1);
    }
    assert.equal(await page.evaluate(() => window.sim.sandbox.markers.group.visible), false);
    assert.ok(await page.evaluate(() => window.sim.sandbox.safeZone.group.visible && !window.sim.sandbox.court.visible));
    await page.evaluate(() => { window.sim.missing = null; });
  }
  for (let i = 0; i < 2; i++) {
    await pages[i].evaluate(index => window.sim.position('right', [index ? 1.15 : -0.65, 1.15, 0]), i);
    await pages[i].waitForFunction(() => window.sim.sandbox.network.state.players.every(p => p.calibrated && p.tracked));
  }
  await pages[0].waitForFunction(() => window.sim.sandbox.remote.group.visible);
  const accuracy = await pages[0].evaluate(() => Math.abs(window.sim.sandbox.remote.head.position.x - 1.8));
  assert.ok(accuracy < 0.001, `Remote avatar offset ${accuracy}`);
  for (const page of pages) await tap(page, 'right', 1);
  await pages[0].waitForFunction(() => window.sim.sandbox.network.state.paused === false);
  await pages[0].waitForFunction(() => window.sim.sandbox.court.visible && window.sim.sandbox.scene.background !== null);
  await tap(pages[0], 'left', 0);
  await pages[1].waitForFunction(() => window.sim.sandbox.ball?.id === 1);
  await tap(pages[1], 'left', 0);
  await pages[0].waitForFunction(() => window.sim.sandbox.ball?.id === 2);
  // Sweep the production local racquet through a freshly spawned ball. The
  // prediction must be accepted by the real server and reach the second client.
  await pages[0].evaluate(() => {
    window.sim.position('left', [-0.65, 1.3, -0.27]);
    window.sim.position('right', [-0.8, 1.3, 0]);
  });
  await pages[0].waitForTimeout(80);
  await tap(pages[0], 'left', 0);
  await pages[0].waitForFunction(() => window.sim.sandbox.ball?.id === 3);
  for (const x of [-0.71, -0.62, -0.53]) {
    await pages[0].evaluate(x => window.sim.position('right', [x, 1.3, 0]), x);
    await pages[0].waitForTimeout(20);
  }
  await pages[1].waitForFunction(() => window.sim.sandbox.network.state.ball?.id === 3 && window.sim.sandbox.network.state.ball.revision > 0);
  assert.ok(await pages[0].evaluate(() => window.sim.sandbox.hitId > 0));
  await tap(pages[1], 'left', 4);
  await pages[0].waitForFunction(() => window.sim.sandbox.network.state.speed === 8);

  await pages[0].locator('#racquet-hand').selectOption('left');
  await pages[1].waitForFunction(() => window.sim.sandbox.remote.racquet.parent === window.sim.sandbox.remote.left && window.sim.sandbox.network.state.paused);
  for (const page of pages) await tap(page, 'right', 1);
  await pages[0].waitForFunction(() => !window.sim.sandbox.network.state.paused);
  await tap(pages[0], 'right', 0);
  await pages[1].waitForFunction(() => window.sim.sandbox.ball?.id === 4);
  assert.ok(await pages[0].evaluate(() => {
    const audio = window.sim.sandbox.audio;
    return audio.context.state === 'running' && audio.voices.length === 12 && Math.abs(audio.context.listener.positionX.value) < 0.03;
  }));

  // Nearby players can ready and play with no proximity visuals or haptics.
  await tap(pages[0], 'right', 1);
  await pages[0].waitForFunction(() => window.sim.sandbox.network.state.paused);
  await tap(pages[0], 'left', 1);
  for (const page of pages) await page.evaluate(() => {
    window.sim.position('head', [-0.9, 1.65, 0]);
    window.sim.position('left', [-1, 1.2, 0]);
    window.sim.position('right', [-0.8, 1.2, 0]);
  });
  await pages[0].waitForTimeout(150);
  for (const page of pages) await page.evaluate(() => { window.sim.pulses = 0; });
  for (const page of pages) await tap(page, 'right', 1);
  await pages[0].waitForFunction(() => !window.sim.sandbox.network.state.paused);
  await pages[0].waitForTimeout(750);
  for (const page of pages) {
    assert.ok(await page.evaluate(() => window.sim.sandbox.remote.group.visible && !window.sim.sandbox.remote.halo.visible && Math.abs(window.sim.sandbox.world.head.p[0]) < 0.001));
    assert.equal(await page.evaluate(() => window.sim.pulses), 0);
  }
  const tick = await pages[0].evaluate(() => window.sim.sandbox.network.state.tick);
  await pages[1].evaluate(() => { window.sim.missing = 'right'; });
  await pages[0].waitForFunction(() => window.sim.sandbox.remote.group.visible && !window.sim.sandbox.remote.right.visible && window.sim.sandbox.remote.left.visible && window.sim.sandbox.remote.head.visible);
  await pages[1].evaluate(() => { window.sim.controllersLost = true; window.sim.lost = true; });
  await pages[0].waitForFunction(() => !window.sim.sandbox.remote.group.visible);
  await pages[0].waitForTimeout(450);
  assert.ok(await pages[0].evaluate(tick => !window.sim.sandbox.network.state.paused && window.sim.sandbox.network.state.tick > tick, tick));
  await pages[1].evaluate(() => { window.sim.controllersLost = false; window.sim.lost = false; window.sim.missing = null; });
  await pages[0].waitForFunction(() => window.sim.sandbox.remote.head.visible && window.sim.sandbox.remote.right.visible);
  assert.ok(await pages[0].evaluate(() => window.sim.sandbox.network.state.players.every(p => p.calibrated && p.ready)));
  await pages[1].evaluate(() => { window.sim.session.visibilityState = 'hidden'; window.sim.session.dispatchEvent(new Event('visibilitychange')); });
  await pages[0].waitForFunction(() => window.sim.sandbox.network.state.paused);
  assert.ok(await pages[0].evaluate(() => window.sim.sandbox.network.state.players.every(p => p.calibrated)));
  await pages[1].evaluate(() => { window.sim.session.visibilityState = 'visible'; window.sim.session.dispatchEvent(new Event('visibilitychange')); });
  await pages[0].waitForFunction(() => window.sim.sandbox.network.state.players.every(p => p.tracked));
  for (const page of pages) await tap(page, 'right', 1);
  await pages[0].waitForFunction(() => !window.sim.sandbox.network.state.paused);
  await tap(pages[0], 'left', 1);
  await pages[1].waitForFunction(() => window.sim.sandbox.ball === null);
  // P2's known tracking-origin change preserves alignment without any samples.
  await pages[1].evaluate(() => window.sim.resetOrigin({ yaw: 0.65, offset: [0.4, 0.02, -0.5] }));
  await pages[0].waitForTimeout(120);
  assert.ok(await pages[1].evaluate(() => window.sim.sandbox.calibration.complete && Math.abs(window.sim.sandbox.world.head.p[0]) < 0.001));
  // P1's system reset centers the shared room at their current physical spot.
  const version = await pages[0].evaluate(() => window.sim.sandbox.anchorVersion);
  await pages[0].evaluate(() => { window.sim.position('head', [0.2, 1.65, 0.3]); window.sim.resetOrigin({ yaw: -0.4, offset: [-0.3, 0.01, 0.6] }); });
  for (const page of pages) await page.waitForFunction(version => window.sim.sandbox.anchorVersion > version, version);
  await pages[0].waitForFunction(() => Math.hypot(window.sim.sandbox.world.head.p[0], window.sim.sandbox.world.head.p[2]) < 0.001 && window.sim.sandbox.calibration.complete);
  await pages[1].evaluate(() => window.sim.position('head', [0.2, 1.65, 0.3]));
  await pages[1].waitForFunction(() => Math.hypot(window.sim.sandbox.world.head.p[0], window.sim.sandbox.world.head.p[2]) < 0.001);
  // Hold B is an in-game fallback, distinct from tap B's calibration retry.
  await pages[0].evaluate(() => { window.sim.position('head', [0.4, 1.65, -0.1]); window.sim.press('right', 5, true); });
  await pages[0].waitForTimeout(1100);
  await pages[0].evaluate(() => window.sim.press('right', 5, false));
  await pages[0].waitForFunction(() => window.sim.sandbox.calibration.complete && Math.hypot(window.sim.sandbox.world.head.p[0], window.sim.sandbox.world.head.p[2]) < 0.001);
  await pages[1].evaluate(() => window.sim.position('head', [0.4, 1.65, -0.1]));
  await pages[1].waitForFunction(() => Math.hypot(window.sim.sandbox.world.head.p[0], window.sim.sandbox.world.head.p[2]) < 0.001);
  // A missing reset delta requires only this player's in-VR A/B rematch.
  await pages[1].evaluate(() => window.sim.resetOrigin({ yaw: -0.2, offset: [0.1, 0, 0.2] }, false));
  await pages[0].waitForFunction(() => window.sim.sandbox.network.state.paused && window.sim.sandbox.network.state.players.some(p => !p.calibrated));
  assert.equal(await pages[1].evaluate(() => window.sim.sandbox.calibration.stage), 0);
  assert.ok(await pages[0].evaluate(() => window.sim.sandbox.calibration.complete));
  for (let marker = 0; marker < 2; marker++) {
    await pages[1].evaluate(point => window.sim.position('right', point), physicalPoints[marker]);
    await tap(pages[1], 'right', 0);
    await pages[1].waitForFunction(stage => window.sim.sandbox.calibration.stage === stage, marker + 1);
  }
  await tap(pages[0], 'right', 5);
  assert.equal(await pages[0].evaluate(() => window.sim.sandbox.calibration.stage), 0);
  assert.ok(await pages[1].evaluate(() => window.sim.sandbox.calibration.complete));
  await pages[0].evaluate(() => window.sim.resetOrigin({ yaw: 0.1, offset: [0.3, 0, -0.1] }, false));
  for (const page of pages) await page.waitForFunction(() => !window.sim.sandbox.network.state.anchors && window.sim.sandbox.network.state.players.every(p => !p.calibrated) && window.sim.sandbox.calibration.stage === 0);
  console.log('PASS: two production clients: one-controller calibration, partial/all-pose loss without pausing, automatic avatar recovery, suspension/resume without recalibration, system recenter with origin transforms, shared center through hold B, in-VR A/B fallback for unknown reset transforms, tap-B retry, spawning/hits, audio and disabled proximity cues.');
  }
  for (const page of pages) await page.evaluate(() => { clearInterval(window.sim.timer); window.sim.sandbox.network.leave(); });
  assert.deepEqual(errors, []);
  console.log('This does not verify native XR presentation, physical alignment accuracy, real controller latency, or Quest frame pacing.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
