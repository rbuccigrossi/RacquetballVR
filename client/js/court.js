import * as THREE from '/vendor/three.module.js';
import { COURT, FEET } from './config.js';

function box(parent, width, height, depth, x, y, z, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

// Original, deterministic maple plank map; generated once, with no network assets.
function hardwood(renderer) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  let seed = 1729;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  for (let col = 0; col < 16; col++) {
    const offset = Math.floor(random() * 256);
    for (let row = -1; row < 4; row++) {
      const y = row * 320 + offset;
      const tone = Math.floor(random() * 22);
      ctx.fillStyle = `rgb(${203 + tone},${163 + tone},${108 + tone})`;
      ctx.fillRect(col * 64, y, 64, 320);
      ctx.strokeStyle = 'rgba(91,57,25,0.28)';
      ctx.strokeRect(col * 64 + 0.5, y + 0.5, 63, 319);
      for (let grain = 0; grain < 28; grain++) {
        const gx = col * 64 + random() * 62 + 1;
        ctx.strokeStyle = `rgba(99,61,24,${0.025 + random() * 0.075})`;
        ctx.beginPath(); ctx.moveTo(gx, y);
        ctx.bezierCurveTo(gx + random() * 6, y + 100, gx - random() * 6, y + 220, gx, y + 320);
        ctx.stroke();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 4);
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

export function createCourt(renderer) {
  const group = new THREE.Group();
  group.name = 'regulation-court';
  const { width: w, length: l, height: h } = COURT;
  const wall = new THREE.MeshStandardMaterial({ color: 0xf3f2ec, roughness: 0.78 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xd1d2ce, roughness: 0.5 });
  const red = new THREE.MeshBasicMaterial({ color: 0xb52b32 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, l), new THREE.MeshStandardMaterial({
    map: hardwood(renderer), roughness: 0.22, metalness: 0.03
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.name = 'hardwood-floor';
  group.add(floor);
  box(group, w + 0.2, h, 0.12, 0, h / 2, -l / 2 - 0.06, wall);
  box(group, 0.12, h, l, -w / 2 - 0.06, h / 2, 0, wall);
  box(group, 0.12, h, l, w / 2 + 0.06, h / 2, 0, wall);
  box(group, w, h, 0.12, 0, h / 2, l / 2 + 0.06, wall);
  box(group, w, 0.12, l, 0, h + 0.06, 0, wall);
  for (const x of [-w / 2 + 0.012, w / 2 - 0.012]) box(group, 0.022, 0.08, l, x, 0.04, 0, trim);
  box(group, w, 0.08, 0.025, 0, 0.04, -l / 2 + 0.012, trim);
  // Service line 15 feet from front wall; short line 20 feet from front wall.
  const lineWidth = 1.5 / 12 * FEET;
  for (const feet of [15, 20]) box(group, w, 0.002, lineWidth, 0, 0.002, -l / 2 + feet * FEET, red);
  for (const side of [-1, 1]) {
    for (const inset of [1.5, 3]) box(group, lineWidth, 0.002, 5 * FEET, side * (w / 2 - inset * FEET), 0.002, -2.5 * FEET, red);
  }
  const fixture = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const x of [-1.6, 1.6]) {
    for (const z of [-4, 0, 4]) {
      box(group, 0.32, 0.025, 1.8, x, h - 0.03, z, fixture);
    }
  }
  group.add(new THREE.HemisphereLight(0xffffff, 0xa99370, 2.3));
  const light = new THREE.DirectionalLight(0xfff9e9, 2.0);
  light.position.set(-1, h - 0.5, -2);
  group.add(light);
  return group;
}

export function createEnvironment(renderer, scene) {
  // Small static lightbox environment gives the polished floor reflected highlights.
  const room = new THREE.Scene();
  room.background = new THREE.Color(0xaaa8a0);
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const x of [-2, 2]) for (const z of [-4, 0, 4]) box(room, 0.45, 0.03, 2, x, 3, z, white);
  const generator = new THREE.PMREMGenerator(renderer);
  const target = generator.fromScene(room, 0.06);
  scene.environment = target.texture;
  generator.dispose();
  room.traverse(object => { if (object.isMesh) object.geometry.dispose(); });
  white.dispose();
  return target;
}
