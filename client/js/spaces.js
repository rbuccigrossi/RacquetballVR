import { COURT, FEET, validateSafeZone } from './config.js';

// User-supplied clear dimensions in feet. Insets are editable planning margins,
// not a claim that a location is suitable for two players.
export const SPACE_PRESETS = Object.freeze({
  garage: Object.freeze({ label: 'Garage', width: 15, depth: 20, height: 7, inset: 1 }),
  driveway: Object.freeze({ label: 'Driveway', width: 25, depth: 40, height: 15, inset: 1 }),
  living: Object.freeze({ label: 'Living room', width: 10, depth: 15, height: 10, inset: 1 }),
  custom: Object.freeze({ label: 'Custom space', width: 15, depth: 20, height: 7, inset: 1 })
});
export const SPACE_STORAGE_KEY = 'racquetball-vr-spaces-v1';

export function validateSpace(space) {
  if (!space || !['width', 'depth', 'height', 'inset'].every(key => Number.isFinite(space[key]))) return 'Enter a finite number in every physical-space field.';
  if (space.width < 4 || space.depth < 4 || space.width > 200 || space.depth > 200) return 'Physical width and depth must be between 4 and 200 feet.';
  if (space.height < 1 || space.height > 100) return 'Overhead clearance must be between 1 and 100 feet.';
  if (space.inset < 0 || (Math.min(space.width, space.depth) - 2 * space.inset) * FEET < 1) return 'Reduce the edge inset to leave at least 1 meter of standing width and depth.';
  return null;
}

export function fitStandingZone(space) {
  return {
    width: Math.min((space.width - 2 * space.inset) * FEET, COURT.width - 0.2),
    depth: Math.min((space.depth - 2 * space.inset) * FEET, COURT.length - 0.2),
    x: 0, z: 0, yaw: 0
  };
}

export function validateStandingZone(zone, space) {
  const error = validateSafeZone(zone);
  if (error) return error;
  const angle = zone.yaw * Math.PI / 180;
  const extentX = Math.abs(Math.cos(angle)) * zone.width / 2 + Math.abs(Math.sin(angle)) * zone.depth / 2;
  const extentZ = Math.abs(Math.sin(angle)) * zone.width / 2 + Math.abs(Math.cos(angle)) * zone.depth / 2;
  const availableX = (space.width / 2 - space.inset) * FEET;
  const availableZ = (space.depth / 2 - space.inset) * FEET;
  if (Math.abs(zone.x) + extentX > availableX + 1e-8 || Math.abs(zone.z) + extentZ > availableZ + 1e-8) return 'The rotated standing area must fit inside the physical space after the edge inset.';
  return null;
}

export function loadSpaces(storage) {
  const state = { active: 'garage', profiles: {} };
  let saved;
  try { saved = JSON.parse(storage.getItem(SPACE_STORAGE_KEY)); } catch { /* Defaults if storage is unavailable. */ }
  for (const [key, preset] of Object.entries(SPACE_PRESETS)) {
    const candidate = saved?.profiles?.[key];
    const space = candidate && !validateSpace(candidate.space) ? { ...candidate.space } : { ...preset };
    const zone = candidate && !validateStandingZone(candidate.zone, space) ? { ...candidate.zone } : fitStandingZone(space);
    state.profiles[key] = { space, zone };
  }
  if (Object.hasOwn(SPACE_PRESETS, saved?.active)) state.active = saved.active;
  // Retain the old Phase 1 standing rectangle only when it fits the garage.
  if (!saved) {
    try {
      const old = JSON.parse(storage.getItem('racquetball-vr-safe-zone-v1'));
      if (old && !validateStandingZone(old, state.profiles.garage.space)) state.profiles.garage.zone = old;
    } catch { /* Invalid old data. */ }
  }
  return state;
}
