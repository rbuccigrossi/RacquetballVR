import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createServer } from '../server.js';
import { ensureCertificates } from '../certificates.js';
import { COURT, DEFAULT_SAFE_ZONE, validateSafeZone } from '../../client/js/config.js';
import { initializeXR } from '../../client/js/xr.js';

test('regulation dimensions use real meters; standing dimensions are independent', () => {
  assert.equal(COURT.width, 6.096);
  assert.equal(COURT.length, 12.192);
  assert.equal(COURT.height, 6.096);
  assert.equal(validateSafeZone(DEFAULT_SAFE_ZONE), null);
  assert.equal(validateSafeZone({ ...DEFAULT_SAFE_ZONE, width: 2, depth: 3 }), null);
  assert.equal(COURT.width, 6.096);
});

test('standing area validates finite dimensions and rotated corners', () => {
  for (const override of [{ width: NaN }, { depth: 0 }, { x: Infinity }, { yaw: 181 }, { x: 3 }, { yaw: 45 }]) {
    assert.equal(typeof validateSafeZone({ ...DEFAULT_SAFE_ZONE, ...override }), 'string');
  }
  assert.equal(validateSafeZone({ width: 2, depth: 3, x: 0, z: 1, yaw: 45 }), null);
});

test('HTTPS serves only public local assets and uses a reusable LAN certificate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'racquetball-vr-test-'));
  const addresses = ['192.168.1.55'];
  const options = { directory, addresses };
  const server = await createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const cert = await readFile(join(directory, 'cert.pem'), 'utf8');
  const x509 = new X509Certificate(cert);
  assert.equal(x509.checkIP('192.168.1.55'), '192.168.1.55');
  assert.equal(x509.checkHost('localhost'), 'localhost');
  assert.equal(String((await ensureCertificates(options)).cert), cert);
  const request = (path, method = 'GET') => new Promise((resolve, reject) => {
    // Trust exactly our test certificate, with normal IP/hostname verification.
    const req = https.request({ hostname: '127.0.0.1', port: server.address().port, ca: cert, path, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
  for (const path of ['/', '/styles.css', '/js/app.js', '/js/court.js', '/js/safe-zone.js', '/js/config.js', '/js/xr.js', '/vendor/three.module.js', '/vendor/three.core.js']) {
    const result = await request(path);
    assert.equal(result.status, 200, path);
    assert.ok(result.body.length > 100, path);
  }
  const health = await request('/api/health');
  assert.equal(JSON.parse(health.body).phase, 'sandbox');
  assert.equal(health.headers['permissions-policy'], 'xr-spatial-tracking=(self)');
  assert.equal((await request('/', 'HEAD')).body, '');
  assert.equal((await request('/', 'POST')).status, 405);
  for (const path of ['/../server/certs/key.pem', '/%2e%2e/server/server.js', '/.git/config', '/js%5c..%5cserver.js', '/package.json']) {
    assert.equal((await request(path)).status, 403, path);
  }
  assert.equal((await request('/vendor/other.js')).status, 404);
  assert.equal((await request('/missing.js')).status, 404);
  assert.equal((await request('/%ZZ')).status, 400);
});

function xrHarness({ secure = true, supported = true, arSupported = false, failure = false, attachFailure = false, xrMissing = false } = {}) {
  let click;
  let ended;
  const calls = [];
  const session = { addEventListener(type, callback) { ended = callback; }, async end() { calls.push('end'); ended(); } };
  const button = { disabled: true, textContent: '', addEventListener(type, callback) { click = callback; } };
  const status = { textContent: '' };
  return {
    button, status, calls, click: () => click(),
    options: {
      secure, button, status,
      xr: xrMissing ? undefined : {
        async isSessionSupported(mode) { assert.ok(['immersive-vr', 'immersive-ar'].includes(mode)); return mode === 'immersive-ar' ? arSupported : supported; },
        async requestSession(mode, options) {
          calls.push({ mode, options });
          if (failure) throw new Error('Permission denied');
          return session;
        }
      },
      renderer: { xr: { async setSession(value) { assert.equal(value, session); if (attachFailure) throw new Error('No floor'); calls.push('attach'); } } },
      onEnter() { calls.push('enter'); }, onExit() { calls.push('exit'); }
    }
  };
}

test('XR explicitly requests immersive-vr + required local-floor and allows reentry', async () => {
  const h = xrHarness();
  await initializeXR(h.options);
  await h.click();
  assert.deepEqual(h.calls.find(call => typeof call === 'object'), { mode: 'immersive-vr', options: { requiredFeatures: ['local-floor'] } });
  assert.equal(h.button.textContent, 'Exit VR');
  await h.click();
  assert.equal(h.button.textContent, 'Enter VR ↗');
  await h.click();
  assert.equal(h.calls.filter(call => call === 'attach').length, 2);
});

for (const supported of [true, false]) {
  test(`passthrough capability ${supported ? 'selects floor-based AR' : 'falls back to VR'}`, async () => {
    const h = xrHarness({ arSupported: supported });
    h.options.passthrough = { checked: true, disabled: false };
    await initializeXR(h.options); await h.click();
    assert.deepEqual(h.calls.find(call => typeof call === 'object'), { mode: supported ? 'immersive-ar' : 'immersive-vr', options: { requiredFeatures: ['local-floor'] } });
    assert.equal(h.options.passthrough.disabled, !supported);
    assert.equal(h.options.passthrough.checked, supported);
  });
}

for (const [name, options] of [['insecure context', { secure: false }], ['unsupported device', { supported: false }], ['missing WebXR', { xrMissing: true }]]) {
  test(`XR keeps entry disabled for ${name}`, async () => {
    const h = xrHarness(options);
    await initializeXR(h.options);
    assert.equal(h.button.disabled, true);
    assert.ok(h.status.textContent.length > 20);
    assert.equal(h.calls.length, 0);
  });
}

for (const [name, options] of [['denied permissions', { failure: true }], ['failed reference-space setup', { attachFailure: true }]]) {
  test(`XR restores UI after ${name}`, async () => {
    const h = xrHarness(options);
    await initializeXR(h.options);
    await h.click();
    assert.equal(h.button.disabled, false);
    assert.match(h.status.textContent, /Unable to enter VR/);
    assert.equal(h.button.textContent, 'Enter VR ↗');
    if (options.attachFailure) assert.ok(h.calls.includes('end'));
  });
}
