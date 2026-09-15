import * as THREE from '/vendor/three.module.js';
import { validateSafeZone } from './config.js';

export class SafeZone {
  constructor(scene, configuration) {
    this.group = new THREE.Group();
    this.group.name = 'safe-play-zone';
    this.core = new THREE.MeshBasicMaterial({ color: 0x50ffd1, depthWrite: false });
    this.glow = new THREE.MeshBasicMaterial({ color: 0x21efb3, transparent: true, opacity: 0.16, depthWrite: false });
    scene.add(this.group);
    this.update(configuration);
  }

  update(configuration) {
    const error = validateSafeZone(configuration);
    if (error) throw new Error(error);
    for (const child of [...this.group.children]) {
      child.geometry.dispose();
      this.group.remove(child);
    }
    const { width: w, depth: d, x, z, yaw } = configuration;
    this.group.position.set(x, 0.008, z);
    this.group.rotation.y = yaw * Math.PI / 180;
    const strip = (width, depth, sx, sz, material, y = 0) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(sx, y, sz);
      mesh.renderOrder = 2;
      this.group.add(mesh);
    };
    for (const side of [-1, 1]) {
      strip(w + 0.1, 0.12, 0, side * d / 2, this.glow);
      strip(0.12, d + 0.1, side * w / 2, 0, this.glow);
      const across = Math.ceil(w / 0.35);
      const along = Math.ceil(d / 0.35);
      for (let i = 0; i < across; i++) strip(w / across * 0.7, 0.035, -w / 2 + (i + 0.5) * w / across, side * d / 2, this.core, 0.001);
      for (let i = 0; i < along; i++) strip(0.035, d / along * 0.7, side * w / 2, -d / 2 + (i + 0.5) * d / along, this.core, 0.001);
    }
  }
}
