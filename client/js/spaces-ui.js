import { FEET } from './config.js';
import { SPACE_PRESETS, SPACE_STORAGE_KEY, fitStandingZone, validateSpace, validateStandingZone } from './spaces.js';

export function initializeSpaceControls(state, onChange) {
  const spaceForm = document.querySelector('#space-form');
  const zoneForm = document.querySelector('#zone-form');
  const preset = document.querySelector('#space-preset');
  const spaceStatus = document.querySelector('#space-status');
  const zoneStatus = document.querySelector('#zone-status');
  const active = () => state.profiles[state.active];
  const save = () => {
    try { localStorage.setItem(SPACE_STORAGE_KEY, JSON.stringify(state)); return 'Saved on this browser.'; }
    catch { return 'Applied for this session; browser storage unavailable.'; }
  };
  const read = (form, keys) => Object.fromEntries(keys.map(key => [key, form.elements[key].value === '' ? NaN : Number(form.elements[key].value)]));
  const report = (target, error) => { target.classList.toggle('error', Boolean(error)); target.textContent = error || ''; };
  const render = () => {
    const { space, zone } = active();
    preset.value = state.active;
    for (const key of ['width', 'depth', 'height', 'inset']) spaceForm.elements[key].value = space[key];
    for (const key of ['width', 'depth', 'x', 'z', 'yaw']) zoneForm.elements[key].value = Number(zone[key].toFixed(6));
    const fullWidth = space.width * FEET;
    const fullDepth = space.depth * FEET;
    const scale = Math.min(260 / fullWidth, 140 / fullDepth);
    const outline = document.querySelector('#physical-outline');
    for (const [key, value] of Object.entries({ x: 150 - fullWidth * scale / 2, y: 85 - fullDepth * scale / 2, width: fullWidth * scale, height: fullDepth * scale })) outline.setAttribute(key, value);
    const angle = zone.yaw * Math.PI / 180;
    const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
      const x = sx * zone.width / 2;
      const z = sz * zone.depth / 2;
      return `${150 + (zone.x + Math.cos(angle) * x + Math.sin(angle) * z) * scale},${85 + (zone.z - Math.sin(angle) * x + Math.cos(angle) * z) * scale}`;
    });
    document.querySelector('#standing-outline').setAttribute('points', points.join(' '));
    document.querySelector('#space-summary').textContent = `${SPACE_PRESETS[state.active].label}: ${space.width} × ${space.depth} ft · ${space.height} ft overhead`;
    document.querySelector('#zone-size').textContent = `${zone.width.toFixed(2)} × ${zone.depth.toFixed(2)} m`;
    document.querySelector('#space-diagram-title').textContent = `Physical footprint ${space.width} by ${space.depth} feet; standing area ${zone.width.toFixed(2)} by ${zone.depth.toFixed(2)} meters`;
    onChange(zone);
  };
  preset.addEventListener('change', () => {
    state.active = preset.value;
    report(zoneStatus, null);
    render();
    report(spaceStatus, null);
    spaceStatus.textContent = `Location loaded. ${save()}`;
  });
  spaceForm.addEventListener('submit', event => {
    event.preventDefault();
    const space = read(spaceForm, ['width', 'depth', 'height', 'inset']);
    const error = validateSpace(space);
    report(spaceStatus, error);
    if (error) return;
    active().space = space;
    // Physical edits explicitly refit the preview; retain all measured space.
    active().zone = fitStandingZone(space);
    render();
    report(zoneStatus, null);
    spaceStatus.textContent = `Physical space applied; standing area refitted to inset and court. ${save()}`;
  });
  zoneForm.addEventListener('submit', event => {
    event.preventDefault();
    const zone = read(zoneForm, ['width', 'depth', 'x', 'z', 'yaw']);
    const error = validateStandingZone(zone, active().space);
    report(zoneStatus, error);
    if (error) return;
    active().zone = zone;
    render();
    zoneStatus.textContent = `Standing area applied. ${save()}`;
  });
  render();
  spaceStatus.textContent = 'Full physical dimensions are saved independently of the regulation court. Calibrated headset play uses these dimensions for edge and overhead cues.';
}
