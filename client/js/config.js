export const FEET = 0.3048;
// Court center is (0,0,0); floor is Y=0; front wall faces +Z at Z=-length/2.
export const COURT = Object.freeze({ width: 20 * FEET, length: 40 * FEET, height: 20 * FEET });
// Standing footprint only. This neither changes the court nor establishes colocation.
export const DEFAULT_SAFE_ZONE = Object.freeze({ width: 4.8, depth: 4.8, x: 0, z: 0, yaw: 0 });
// Temporarily disabled while testing sandbox physics and playability.
export const PLAYER_PROXIMITY_ENABLED = false;
export const RENDER = Object.freeze({ maxPixelRatio: 1.5, framebufferScale: 1, foveation: 1 });

export function validateSafeZone(value) {
  if (!value || !['width', 'depth', 'x', 'z', 'yaw'].every(key => Number.isFinite(value[key]))) {
    return 'Enter a finite number in every field.';
  }
  if (value.width < 1 || value.depth < 1) return 'Width and depth must each be at least 1 meter.';
  if (value.yaw < -180 || value.yaw > 180) return 'Rotation must be between −180° and 180°.';
  const angle = value.yaw * Math.PI / 180;
  const halfX = (Math.abs(Math.cos(angle)) * value.width + Math.abs(Math.sin(angle)) * value.depth) / 2;
  const halfZ = (Math.abs(Math.sin(angle)) * value.width + Math.abs(Math.cos(angle)) * value.depth) / 2;
  if (Math.abs(value.x) + halfX > COURT.width / 2 - 0.1 || Math.abs(value.z) + halfZ > COURT.length / 2 - 0.1) {
    return 'The rotated footprint must fit inside the court with 10 cm clearance.';
  }
  return null;
}
