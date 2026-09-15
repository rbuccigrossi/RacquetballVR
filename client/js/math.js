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
  out[0] = c * point[0] + s * point[2] + alignment.offset[0];
  out[1] = point[1] + alignment.offset[1];
  out[2] = -s * point[0] + c * point[2] + alignment.offset[2];
  return out;
}
export function transformQuaternion(out, q, yaw) {
  const s = Math.sin(yaw / 2), c = Math.cos(yaw / 2);
  out[0] = c * q[0] + s * q[2];
  out[1] = c * q[1] + s * q[3];
  out[2] = c * q[2] - s * q[0];
  out[3] = c * q[3] - s * q[1];
}
