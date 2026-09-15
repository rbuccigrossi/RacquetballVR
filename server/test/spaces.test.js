import test from 'node:test';
import assert from 'node:assert/strict';
import { COURT, FEET } from '../../client/js/config.js';
import { SPACE_PRESETS, SPACE_STORAGE_KEY, fitStandingZone, loadSpaces, validateSpace, validateStandingZone } from '../../client/js/spaces.js';

test('all measured locations remain independent of court dimensions', () => {
  assert.deepEqual(['garage', 'driveway', 'living'].map(key => {
    const { width, depth, height } = SPACE_PRESETS[key]; return [width, depth, height];
  }), [[15, 20, 7], [25, 40, 15], [10, 15, 10]]);
  for (const space of Object.values(SPACE_PRESETS)) {
    assert.equal(validateSpace(space), null);
    assert.equal(validateStandingZone(fitStandingZone(space), space), null);
  }
  assert.equal(SPACE_PRESETS.driveway.width * FEET, 7.62);
  assert.equal(COURT.width, 6.096);
  assert.equal(fitStandingZone(SPACE_PRESETS.driveway).width, 5.896);
});

test('physical validation accounts for rotated standing area and editable inset', () => {
  const space = SPACE_PRESETS.garage;
  const zone = { width: 3.5, depth: 4.4, x: 0, z: 0, yaw: 0 };
  assert.equal(validateStandingZone(zone, space), null);
  assert.match(validateStandingZone({ ...zone, yaw: 45 }, space), /physical space/);
  assert.match(validateStandingZone({ ...zone, x: 0.5 }, space), /physical space/);
  for (const override of [{ height: NaN }, { height: 0 }, { width: Infinity }, { inset: -1 }, { inset: 7 }]) {
    assert.equal(typeof validateSpace({ ...space, ...override }), 'string');
  }
});

test('profiles retain independent edits and reject invalid persisted values', () => {
  const storage = new Map();
  const adapter = { getItem: key => storage.get(key) ?? null };
  const state = loadSpaces(adapter);
  state.active = 'living';
  state.profiles.living.space.height = 11;
  storage.set(SPACE_STORAGE_KEY, JSON.stringify(state));
  const restored = loadSpaces(adapter);
  assert.equal(restored.active, 'living');
  assert.equal(restored.profiles.living.space.height, 11);
  assert.equal(restored.profiles.garage.space.height, 7);
  state.profiles.living.zone.width = 100;
  state.profiles.driveway.space.height = null;
  storage.set(SPACE_STORAGE_KEY, JSON.stringify(state));
  const repaired = loadSpaces(adapter);
  assert.equal(validateStandingZone(repaired.profiles.living.zone, repaired.profiles.living.space), null);
  assert.equal(repaired.profiles.driveway.space.height, 15);
});

test('old settings are migrated only if they fit; blocked storage uses defaults', () => {
  const invalidOld = { width: 4.8, depth: 4.8, x: 0, z: 0.8, yaw: 0 };
  const state = loadSpaces({ getItem: key => key === SPACE_STORAGE_KEY ? null : JSON.stringify(invalidOld) });
  assert.deepEqual(state.profiles.garage.zone, fitStandingZone(SPACE_PRESETS.garage));
  const validOld = { width: 2, depth: 3, x: 0, z: 0, yaw: 0 };
  assert.deepEqual(loadSpaces({ getItem: key => key === SPACE_STORAGE_KEY ? null : JSON.stringify(validOld) }).profiles.garage.zone, validOld);
  assert.equal(loadSpaces({ getItem() { throw new Error('Blocked'); } }).active, 'garage');
});
