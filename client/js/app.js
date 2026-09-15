import * as THREE from '/vendor/three.module.js';
import { RENDER } from './config.js';
import { loadSpaces } from './spaces.js';
import { initializeSpaceControls } from './spaces-ui.js';
import { createCourt, createEnvironment } from './court.js';
import { SafeZone } from './safe-zone.js';
import { initializeXR } from './xr.js';

const viewport = document.querySelector('#viewport');
const vrButton = document.querySelector('#enter-vr');
const xrStatus = document.querySelector('#xr-status');
const spaces = loadSpaces({ getItem: key => localStorage.getItem(key) });
const configuration = spaces.profiles[spaces.active].zone;

fetch('/api/health').then(response => {
  if (!response.ok) throw new Error('Server unavailable');
  return response.json();
}).then(data => {
  document.querySelector('#server-status').textContent = data.ok ? 'Local HTTPS ready' : 'Server unavailable';
}).catch(() => { document.querySelector('#server-status').textContent = 'Server unavailable'; });

try {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, RENDER.maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setFramebufferScaleFactor(RENDER.framebufferScale);
  renderer.xr.setFoveation(RENDER.foveation);
  viewport.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '3D racquetball court with mint dashed standing boundary');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe4e4df);
  const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 50);
  // Physical room tracking stays at 1:1 scale. No artificial movement in VR.
  const rig = new THREE.Group();
  rig.name = 'tracking-rig';
  rig.add(camera);
  scene.add(rig);
  scene.add(createCourt(renderer));
  createEnvironment(renderer, scene);
  const safeZone = new SafeZone(scene, configuration);
  initializeSpaceControls(spaces, zone => safeZone.update(zone));

  let yaw = 0;
  let pitch = -0.4;
  let dragging = false;
  let previousX = 0;
  let previousY = 0;
  const desktopPose = () => {
    camera.position.set(0, 3.3, 5.8);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  };
  const resetView = () => { yaw = 0; pitch = -0.4; desktopPose(); };
  resetView();
  document.querySelector('#reset-view').addEventListener('click', resetView);
  renderer.domElement.addEventListener('pointerdown', event => {
    if (renderer.xr.isPresenting) return;
    dragging = true; previousX = event.clientX; previousY = event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', event => {
    if (!dragging || renderer.xr.isPresenting) return;
    yaw -= (event.clientX - previousX) * 0.003;
    pitch = THREE.MathUtils.clamp(pitch - (event.clientY - previousY) * 0.003, -1.15, 0.7);
    previousX = event.clientX; previousY = event.clientY;
    desktopPose();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) renderer.domElement.addEventListener(type, () => { dragging = false; });
  const resize = () => {
    if (renderer.xr.isPresenting) return;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(viewport);
  resize();
  renderer.xr.addEventListener('sessionend', () => { resetView(); resize(); });
  await initializeXR({
    xr: navigator.xr, secure: window.isSecureContext, renderer, button: vrButton, status: xrStatus,
    onEnter() { dragging = false; camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0); camera.updateMatrixWorld(); },
    onExit() { resetView(); resize(); }
  });
  // No allocations, shadows, postprocessing, or network work in the Phase 1 loop.
  renderer.setAnimationLoop(() => { renderer.render(scene, camera); });
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    vrButton.disabled = true;
    xrStatus.textContent = 'Graphics context lost. Reload the page to restore the court.';
  });
} catch (error) {
  console.error(error);
  const message = document.querySelector('#render-error');
  message.hidden = false;
  message.textContent = `Court rendering could not start: ${error.message}`;
  vrButton.disabled = true;
  vrButton.textContent = 'Graphics unavailable';
  xrStatus.textContent = 'Use a browser with WebGL 2 enabled, then reload.';
}
