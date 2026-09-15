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
try {
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/js/app.js', route => route.fulfill({ contentType: 'text/javascript', body: '// Test harness supplies synthetic XR frames.' }));
    await page.goto(url);
    await page.evaluate(async index => {
      const THREE = await import('/vendor/three.module.js');
      const { Sandbox } = await import('/js/sandbox.js');
      const { SafeZone } = await import('/js/safe-zone.js');
      const { loadSpaces } = await import('/js/spaces.js');
      const { initializeSpaceControls } = await import('/js/spaces-ui.js');
      const spaces = loadSpaces({ getItem: () => null });
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), rig = new THREE.Group();
      rig.add(camera); scene.add(rig);
      const reference = new EventTarget(), session = new EventTarget(), xr = new EventTarget();
      session.visibilityState = 'visible';
      const sources = ['left', 'right'].map(hand => ({ handedness: hand, gripSpace: { hand }, gamepad: { buttons: Array.from({ length: 6 }, () => ({ pressed: false })), hapticActuators: [{ pulse: async () => { window.sim.pulses++; return true; } }] } }));
      session.inputSources = sources;
      xr.getSession = () => session; xr.getReferenceSpace = () => reference;
      const renderer = { xr };
      const safeZone = new SafeZone(scene, spaces.profiles.garage.zone);
      initializeSpaceControls(spaces, zone => safeZone.update(zone));
      const sandbox = new Sandbox({ scene, camera, rig, renderer, safeZone, spaces });
      const yaw = index ? -0.7 : 0.4, offset = index ? [-0.6, -0.02, 1.3] : [1.2, 0.03, -0.7];
      const raw = {};
      function position(key, p) {
        const x = p[0] - offset[0], z = p[2] - offset[2];
        raw[key] = { position: { x: Math.cos(yaw) * x - Math.sin(yaw) * z, y: p[1] - offset[1], z: Math.sin(yaw) * x + Math.cos(yaw) * z }, orientation: { x: 0, y: Math.sin(-yaw / 2), z: 0, w: Math.cos(yaw / 2) } };
      }
      const x = index ? 0.9 : -0.9;
      position('head', [x, 1.65, 0]); position('left', [x - 0.25, 1.15, 0]); position('right', [x + 0.25, 1.15, 0]);
      const frame = {
        getViewerPose: () => window.sim.lost ? null : ({ transform: raw.head, emulatedPosition: false }),
        getPose: space => ({ transform: raw[space.hand], emulatedPosition: false })
      };
      window.sim = { sandbox, position, sources, reference, frame, session, pulses: 0, lost: false,
        start() { sandbox.startSession(); this.timer = setInterval(() => sandbox.update(performance.now(), frame), 16); },
        press(hand, button, down) { sources.find(source => source.handedness === hand).gamepad.buttons[button].pressed = down; }
      };
    }, i);
    await page.getByRole('button', { name: 'Join shared sandbox' }).click();
    await page.waitForFunction(() => window.sim.sandbox.network.id !== null && window.sim.sandbox.network.state?.config);
    await page.evaluate(() => window.sim.start());
  }
  const tap = async (page, hand, index) => {
    await page.evaluate(([hand, index]) => window.sim.press(hand, index, true), [hand, index]);
    await page.waitForTimeout(50);
    await page.evaluate(([hand, index]) => window.sim.press(hand, index, false), [hand, index]);
    await page.waitForTimeout(30);
  };
  for (const page of pages) {
    for (let marker = 0; marker < 3; marker++) {
      await page.evaluate(index => window.sim.position('right', window.sim.sandbox.calibration.targets[index]), marker);
      await tap(page, 'right', 0);
      await page.waitForFunction(stage => window.sim.sandbox.calibration.stage === stage, marker + 1);
    }
  }
  for (let i = 0; i < 2; i++) {
    await pages[i].evaluate(index => window.sim.position('right', [index ? 1.15 : -0.65, 1.15, 0]), i);
    await pages[i].waitForFunction(() => window.sim.sandbox.network.state.players.every(p => p.calibrated && p.tracked));
  }
  assert.ok(await pages[0].evaluate(() => window.sim.sandbox.remote.group.visible));
  const accuracy = await pages[0].evaluate(() => Math.abs(window.sim.sandbox.remote.head.position.x - 0.9));
  assert.ok(accuracy < 0.001, `Remote avatar offset ${accuracy}`);
  for (const page of pages) await tap(page, 'right', 1);
  await pages[0].waitForFunction(() => window.sim.sandbox.network.state.paused === false);
  await tap(pages[0], 'left', 0);
  await pages[1].waitForFunction(() => window.sim.sandbox.ball?.id === 1);
  await tap(pages[1], 'left', 0);
  await pages[0].waitForFunction(() => window.sim.sandbox.ball?.id === 2);
  // Sweep the production local racquet through a freshly spawned ball. The
  // prediction must be accepted by the real server and reach the second client.
  await pages[0].evaluate(() => {
    window.sim.position('left', [-0.65, 1.3, 0]);
    window.sim.position('right', [-0.65, 1.03, -0.15]);
  });
  await pages[0].waitForTimeout(80);
  await tap(pages[0], 'left', 0);
  await pages[0].waitForFunction(() => window.sim.sandbox.ball?.id === 3);
  for (const z of [-0.06, 0.03, 0.12]) {
    await pages[0].evaluate(z => window.sim.position('right', [-0.65, 1.03, z]), z);
    await pages[0].waitForTimeout(20);
  }
  await pages[1].waitForFunction(() => window.sim.sandbox.network.state.ball?.id === 3 && window.sim.sandbox.network.state.ball.revision > 0);
  assert.ok(await pages[0].evaluate(() => window.sim.sandbox.hitId > 0));
  await tap(pages[1], 'left', 4);
  await pages[0].waitForFunction(() => window.sim.sandbox.network.state.speed === 12);

  await pages[0].locator('#racquet-hand').selectOption('left');
  await pages[1].waitForFunction(() => window.sim.sandbox.remote.racquet.parent === window.sim.sandbox.remote.left && window.sim.sandbox.network.state.paused);
  for (const page of pages) await tap(page, 'right', 1);
  await pages[0].waitForFunction(() => !window.sim.sandbox.network.state.paused);
  await tap(pages[0], 'right', 0);
  await pages[1].waitForFunction(() => window.sim.sandbox.ball?.id === 4);
  assert.ok(await pages[0].evaluate(() => {
    const audio = window.sim.sandbox.audio;
    return audio.context.state === 'running' && audio.voices.length === 12 && Math.abs(audio.context.listener.positionX.value + 0.9) < 0.03;
  }));

  // Put one tracked hand near the other player: both representations and haptics update.
  await pages[1].evaluate(() => window.sim.position('left', [-0.8, 1.65, 0]));
  await pages[0].waitForFunction(() => window.sim.pulses > 0 && window.sim.sandbox.remote.halo.visible);
  await pages[1].evaluate(() => { window.sim.lost = true; });
  await pages[0].waitForFunction(() => window.sim.sandbox.network.state.paused && !window.sim.sandbox.remote.group.visible);
  assert.equal(await pages[1].evaluate(() => window.sim.sandbox.localPaused), true);
  await pages[1].evaluate(() => { window.sim.lost = false; });
  for (const page of pages) await page.waitForFunction(() => window.sim.sandbox.network.state.players.every(p => p.tracked));
  for (const page of pages) await tap(page, 'right', 1);
  await pages[0].waitForFunction(() => !window.sim.sandbox.network.state.paused);
  await tap(pages[0], 'left', 1);
  await pages[1].waitForFunction(() => window.sim.sandbox.ball === null);
  await pages[1].evaluate(() => window.sim.reference.dispatchEvent(new Event('reset')));
  await pages[0].waitForFunction(() => window.sim.sandbox.network.state.paused && window.sim.sandbox.network.state.players.some(p => !p.calibrated));
  assert.equal(await pages[1].evaluate(() => window.sim.sandbox.calibration.stage), 0);
  for (const page of pages) await page.evaluate(() => { clearInterval(window.sim.timer); window.sim.sandbox.network.leave(); });
  assert.deepEqual(errors, []);
  console.log('PASS: two production browser clients with synthetic XR frames: different-origin calibration, aligned avatars, ready/pause, either-player spawning, predicted hit accepted by server, hand swap, audio listener/pool, speed, clear, proximity haptics, tracking-loss recovery, reference-space reset.');
  console.log('This does not verify native XR presentation, physical alignment accuracy, real controller latency, or Quest frame pacing.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
