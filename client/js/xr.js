// Kept independent of Three.js so session support / failure paths can be verified.
export async function initializeXR({ xr, secure, renderer, button, status, onEnter, onExit, passthrough = null }) {
  let session = null;
  let busy = false;
  let arSupported = false;
  const report = message => { status.textContent = message; };
  const reset = () => {
    session = null;
    button.textContent = 'Enter VR ↗';
    button.disabled = false;
    onExit();
    report('Ready. Stand in your cleared area and face the front wall before entering.');
  };
  if (!secure) {
    button.textContent = 'HTTPS required';
    report('Open the HTTPS LAN address and resolve certificate trust on this headset.');
    return;
  }
  if (!xr) {
    button.textContent = 'Open on your Quest';
    report('WebXR is unavailable here. The desktop court preview is still interactive.');
    return;
  }
  try {
    if (!await xr.isSessionSupported('immersive-vr')) {
      button.textContent = 'VR headset unavailable';
      report('Use Meta Quest Browser inside the headset to enter VR.');
      return;
    }
  } catch (error) {
    button.textContent = 'WebXR check failed';
    report(`Check headset permissions and certificate trust. ${error.message}`);
    return;
  }
  reset();
  if (passthrough) {
    try { arSupported = await xr.isSessionSupported('immersive-ar'); } catch { /* VR remains available. */ }
    passthrough.disabled = !arSupported;
    if (!arSupported) { passthrough.checked = false; report('VR ready. Passthrough unavailable here; identify the physical spots before entering.'); }
  }
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      if (session) {
        await session.end();
      } else {
        // Required, never silently fall back to a non-floor space.
        session = await xr.requestSession(arSupported && passthrough?.checked ? 'immersive-ar' : 'immersive-vr', { requiredFeatures: ['local-floor'] });
        session.addEventListener('end', reset, { once: true });
        onEnter();
        await renderer.xr.setSession(session);
        button.textContent = 'Exit VR';
        report('VR active · follow the headset instructions. Use the system menu to exit.');
      }
    } catch (error) {
      if (session) { try { await session.end(); } catch { /* Already ended. */ } }
      reset();
      report(`Unable to enter VR: ${error.message}. Check permissions, floor tracking, and certificate trust, then retry.`);
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
}
