import * as THREE from '/vendor/three.module.js';
import { validateSafeZone } from './config.js';

export class SafeZone {
  constructor(scene, configuration) {
    this.group = new THREE.Group();
    this.group.name = 'safe-play-zone';
    this.core = new THREE.MeshBasicMaterial({ color: 0x50ffd1, depthWrite: false, toneMapped: false });
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
    const coreSegments = [], glowSegments = [];
    const strip = (width, depth, sx, sz, material, y = 0) => {
      (material === this.core ? coreSegments : glowSegments).push({ width, depth, sx, sz, y });
    };
    // A fixed cross makes the entry-defined center easy to find in passthrough.
    strip(0.5, 0.035, 0, 0, this.core, 0.001);
    strip(0.035, 0.5, 0, 0, this.core, 0.001);
    for (const side of [-1, 1]) {
      strip(w + 0.1, 0.12, 0, side * d / 2, this.glow);
      strip(0.12, d + 0.1, side * w / 2, 0, this.glow);
      const across = Math.ceil(w / 0.35);
      const along = Math.ceil(d / 0.35);
      for (let i = 0; i < across; i++) strip(w / across * 0.7, 0.035, -w / 2 + (i + 0.5) * w / across, side * d / 2, this.core, 0.001);
      for (let i = 0; i < along; i++) strip(0.035, d / along * 0.7, side * w / 2, -d / 2 + (i + 0.5) * d / along, this.core, 0.001);
    }
    // Two draw calls for the entire outline, regardless of the number of dashes.
    const transform = new THREE.Object3D();
    transform.rotation.x = -Math.PI / 2;
    for (const [segments, material] of [[coreSegments, this.core], [glowSegments, this.glow]]) {
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, segments.length);
      segments.forEach((segment, index) => {
        transform.position.set(segment.sx, segment.y, segment.sz); transform.scale.set(segment.width, segment.depth, 1); transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true; mesh.renderOrder = 2; this.group.add(mesh);
    }
  }
}
