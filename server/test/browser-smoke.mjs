// Optional desktop integration check: set PLAYWRIGHT_MODULE to an installed
// Playwright package path if it is not installed in this project.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined, args: ['--ignore-certificate-errors'] });
const output = fileURLToPath(new URL('../../artifacts/', import.meta.url));
await mkdir(output, { recursive: true });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  const origins = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => origins.add(new URL(request.url()).origin));
  await page.goto('https://localhost:3000', { waitUntil: 'networkidle' });
  await page.locator('canvas').waitFor();
  await page.getByText('Local HTTPS ready', { exact: true }).waitFor();
  assert.equal(await page.locator('#render-error').isVisible(), false);
  assert.ok(await page.locator('canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    return gl && gl.getError() === gl.NO_ERROR && gl.drawingBufferWidth > 0;
  }));
  assert.equal(await page.locator('#space-preset').inputValue(), 'garage');
  assert.equal(await page.locator('#space-height').inputValue(), '7');
  for (const [name, width, depth, height] of [['driveway', '25', '40', '15'], ['living', '10', '15', '10']]) {
    await page.locator('#space-preset').selectOption(name);
    assert.equal(await page.locator('#space-width').inputValue(), width);
    assert.equal(await page.locator('#space-depth').inputValue(), depth);
    assert.equal(await page.locator('#space-height').inputValue(), height);
  }
  await page.locator('#space-height').fill('11');
  await page.getByRole('button', { name: 'Apply physical space' }).click();
  await page.locator('#space-preset').selectOption('garage');
  await page.locator('#space-preset').selectOption('living');
  assert.equal(await page.locator('#space-height').inputValue(), '11');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#space-preset').inputValue(), 'living');
  assert.equal(await page.locator('#space-height').inputValue(), '11');
  await page.locator('#space-inset').fill('6');
  await page.getByRole('button', { name: 'Apply physical space' }).click();
  assert.match(await page.locator('#space-status').textContent(), /Reduce the edge inset/);
  await page.locator('#space-preset').selectOption('garage');
  await page.locator('#width').fill('3.5');
  await page.locator('#depth').fill('4.4');
  await page.getByRole('button', { name: 'Apply standing area' }).click();
  assert.equal(await page.locator('#zone-size').textContent(), '3.50 × 4.40 m');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#width').inputValue(), '3.5');
  assert.equal(await page.locator('#proximity-distance').isDisabled(), true);
  await page.getByText('Rotation', { exact: true }).click();
  await page.locator('#yaw').fill('45');
  await page.getByRole('button', { name: 'Apply standing area' }).click();
  assert.match(await page.locator('#zone-status').textContent(), /physical space/);
  await page.locator('#yaw').fill('0');
  await page.getByRole('button', { name: 'Apply standing area' }).click();
  await page.getByText('Rotation', { exact: true }).click();
  await page.mouse.move(950, 350);
  await page.mouse.down();
  await page.mouse.move(1020, 390, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Reset view' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${output}/court-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${output}/court-mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual([...origins], ['https://localhost:3000']);
  console.log('PASS: WebGL2 render, no console errors, local-only requests, location presets, overhead edits, per-profile persistence, physical/rotated footprint rejection, drag/reset, mobile layout.');
  console.log('Screenshots saved to artifacts/. Actual headset immersion remains unverified.');
} finally {
  await browser.close();
}
