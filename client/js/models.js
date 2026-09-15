import * as THREE from '/vendor/three.module.js';
import { RACQUET_MOUNT } from './physics.js';
import { transformPoint } from './math.js';

const material = color => new THREE.MeshBasicMaterial({ color, depthTest: false, toneMapped: false });
function mesh(parent, geometry, mat, x = 0, y = 0, z = 0) {
  const item = new THREE.Mesh(geometry, mat);
  item.position.set(x, y, z); item.renderOrder = 15; parent.add(item); return item;
}
export function createRacquet(color = 0x95eaca, overlay = true) {
  const group = new THREE.Group();
  group.quaternion.fromArray(RACQUET_MOUNT);
  const frame = new THREE.MeshBasicMaterial({ color, depthTest: !overlay, toneMapped: false });
  const grip = new THREE.MeshBasicMaterial({ color: 0x26393f, depthTest: !overlay });
  mesh(group, new THREE.CylinderGeometry(0.018, 0.022, 0.22, 8), grip, 0, 0.04, 0);
  const ring = mesh(group, new THREE.TorusGeometry(0.155, 0.009, 6, 32), frame, 0, 0.27, 0);
  ring.scale.y = 1.06;
  const points = [];
  for (let i = -4; i <= 4; i++) {
    const x = i * 0.03, length = Math.sqrt(0.15 ** 2 - x ** 2);
    points.push(x, 0.27 - length, 0, x, 0.27 + length, 0);
    points.push(-length, 0.27 + x, 0, length, 0.27 + x, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const strings = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xd0e5ee, transparent: true, opacity: 0.7, depthTest: !overlay }));
  strings.renderOrder = 15; group.add(strings);
  return group;
}

export class Avatar {
  constructor(scene, color = 0x83c8ff) {
    this.group = new THREE.Group();
    this.mat = material(color);
    this.head = new THREE.Group();
    mesh(this.head, new THREE.SphereGeometry(0.12, 16, 12), this.mat);
    mesh(this.head, new THREE.BoxGeometry(0.18, 0.055, 0.05), material(0x162838), 0, 0.02, -0.11);
    mesh(this.head, new THREE.ConeGeometry(0.025, 0.1, 6), this.mat, 0, -0.055, -0.12).rotation.x = -Math.PI / 2;
    this.left = new THREE.Group(); this.right = new THREE.Group();
    const handShape = new THREE.SphereGeometry(0.055, 12, 8);
    mesh(this.left, handShape, this.mat); mesh(this.right, handShape, this.mat);
    this.torso = mesh(this.group, new THREE.CylinderGeometry(0.18, 0.14, 0.45, 10), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.45, depthTest: false }));
    this.racquet = createRacquet(color);
    this.right.add(this.racquet);
    this.group.add(this.head, this.left, this.right);
    this.halo = mesh(this.group, new THREE.SphereGeometry(0.25, 16, 10), new THREE.MeshBasicMaterial({ color: 0xff634e, wireframe: true, depthTest: false, transparent: true, opacity: 0.8 }));
    this.group.visible = false;
    scene.add(this.group);
  }
  update(player, warning = false) {
    this.group.visible = Boolean(player?.tracked && player?.calibrated && player.pose && player.age < 300);
    if (!this.group.visible) return;
    for (const key of ['head', 'left', 'right']) {
      this[key].position.fromArray(player.pose[key].p);
      this[key].quaternion.fromArray(player.pose[key].q);
    }
    if (this.racquet.parent !== this[player.hand]) this[player.hand].add(this.racquet);
    this.torso.position.copy(this.head.position); this.torso.position.y -= 0.43;
    this.halo.position.copy(this.head.position); this.halo.visible = warning;
    this.mat.color.setHex(warning ? 0xff8064 : 0x83c8ff);
  }
}

export class HeadsetHUD {
  constructor(camera) {
    this.canvas = document.createElement('canvas'); this.canvas.width = 1200; this.canvas.height = 320;
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.293), new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, toneMapped: false }));
    this.plane.position.set(0, -0.37, -1.15); this.plane.renderOrder = 100; camera.add(this.plane); this.plane.visible = false;
  }
  set(text, warning = false) {
    if (this.previous === text && this.warning === warning) return;
    this.previous = text; this.warning = warning;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, 1200, 320); ctx.fillStyle = warning ? '#521e18ee' : '#102720eb'; ctx.fillRect(0, 0, 1200, 320);
    ctx.strokeStyle = warning ? '#ff9075' : '#8cddb6'; ctx.lineWidth = 4; ctx.strokeRect(3, 3, 1194, 314);
    ctx.fillStyle = '#f3fff7'; ctx.font = '30px sans-serif';
    const words = text.split(/\s+/); let line = '', y = 45;
    for (const word of words) {
      if (ctx.measureText(`${line}${word} `).width > 1120) { ctx.fillText(line, 30, y); y += 39; line = ''; }
      line += `${word} `;
    }
    ctx.fillText(line, 30, y); this.texture.needsUpdate = true;
  }
}

export class CalibrationMarkers {
  constructor(scene) {
    this.point = [0, 0, 0];
    this.suggestions = [[-0.45, 0.9144, -0.55], [0.45, 0.9144, -0.55]];
    this.group = new THREE.Group(); this.group.visible = false; scene.add(this.group);
    this.markers = ['A', 'B'].map(letter => {
      const group = new THREE.Group();
      mesh(group, new THREE.SphereGeometry(0.045, 16, 12), material(0xffd275));
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false }));
      label.scale.set(0.5, 0.125, 1); label.position.y = 0.13; label.renderOrder = 90; group.add(label);
      this.group.add(group); return { group, canvas, texture, letter };
    });
  }
  update(calibration, alignment) {
    this.group.visible = Boolean(calibration && !calibration.complete);
    if (!this.group.visible) return;
    for (let i = 0; i < 2; i++) {
      const marker = this.markers[i];
      let p = calibration.defining ? null : calibration.targets?.[i];
      if (calibration.defining && i < calibration.stage) p = transformPoint(this.point, calibration.points[i], alignment);
      const mode = p ? (calibration.defining ? 'saved' : 'approximate') : 'suggested';
      marker.group.visible = calibration.defining || Boolean(p);
      marker.group.position.fromArray(p || this.suggestions[i]);
      const text = `${marker.letter} · ${mode}`;
      if (marker.text !== text) {
        marker.text = text;
        const ctx = marker.canvas.getContext('2d'); ctx.clearRect(0, 0, 512, 128); ctx.fillStyle = '#162a23ee'; ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = '#ffe0a2'; ctx.font = 'bold 36px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(text, 256, 78); marker.texture.needsUpdate = true;
      }
    }
  }
}
