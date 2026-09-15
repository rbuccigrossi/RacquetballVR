export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function rotateVector(out, v, q) {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + qy * tz - qz * ty;
  out[1] = y + qw * ty + qz * tx - qx * tz;
  out[2] = z + qw * tz + qx * ty - qy * tx;
  return out;
}
export function transformPoint(out, point, alignment) {
  const c = Math.cos(alignment.yaw), s = Math.sin(alignment.yaw);
  const [x, y, z] = point;
  out[0] = c * x + s * z + alignment.offset[0];
  out[1] = y + alignment.offset[1];
  out[2] = -s * x + c * z + alignment.offset[2];
  return out;
}
export function transformQuaternion(out, q, yaw) {
  const s = Math.sin(yaw / 2), c = Math.cos(yaw / 2);
  const [x, y, z, w] = q;
  out[0] = c * x + s * z;
  out[1] = c * y + s * w;
  out[2] = c * z - s * x;
  out[3] = c * w - s * y;
}

// Compose source -> intermediate -> destination, preserving 1:1 scale.
export function composeAlignment(outer, inner) {
  return { yaw: outer.yaw + inner.yaw, offset: transformPoint([0, 0, 0], inner.offset, outer) };
}
