# Racquetball VR — Phase 1

A local HTTPS/WebXR court prototype for Meta Quest 2. This phase provides the visual court and configurable standing footprint. Multiplayer, controller input, calibration, ball physics, audio, and proximity alerts belong to Phases 2–5 and are not implemented yet. Use this phase as a **solo environment preview**.

## Run

Requires **Node.js 22+**. From the project directory:

```powershell
cd server
npm ci
npm start
```

The server listens on all IPv4 interfaces on port 3000 and prints available LAN URLs. Open `https://<server-LAN-IP>:3000` on the headset, using the same Wi-Fi/LAN. All runtime scripts and generated textures are local; npm requires internet only for initial installation. No CDN, bundler, or cloud service is needed.

On Windows, `./start.ps1` from the project root also starts the installed server, selecting Node 22+ or the Codex bundled runtime when available. The machine's pre-existing system Node 12 is too old. You can pass `-NodePath 'C:\path\to\node.exe'` explicitly.

If the headset cannot reach the server, check the LAN address, guest-network/client isolation, and Windows Firewall permission for Node TCP port 3000 on your private network. No firewall or certificate trust settings are changed automatically.

### Self-signed HTTPS

First startup generates an RSA/SHA-256 certificate in `server/certs`, valid for 90 days. Subject Alternative Names include localhost, loopback, and detected IPv4 LAN addresses. Certificates are reused, or renewed if near expiry or missing a current LAN IP. `LAN_IPS` can add comma-separated IPs before launch. `npm run certs` forces regeneration; `PORT` changes the port.

The private key stays outside the public asset directory and is ignored by Git. Never distribute it. On Windows, key access inherits the directory ACL; POSIX mode 0600 is requested where supported.

Self-signed certificates are not trusted automatically. Review the certificate warning for your own server and accept it if Quest Browser offers that option. Certificate acceptance behavior differs across browser versions; it does **not** by itself prove WebXR works. If WebXR stays blocked, establish certificate trust on the device using its supported development workflow. The page checks `isSecureContext` and `isSessionSupported` and reports request failures. Do not disable browser security globally.

## Court and standing footprint

- Regulation proportions: **20 ft wide × 40 ft long × 20 ft high**, or 6.096 × 12.192 × 6.096 meters.
- Polished procedural maple floor, off-white walls/ceiling, overhead fixtures, red service and short lines at 15 and 20 feet from the front wall, and service-box markings.
- Editable physical-space profiles in feet: **Garage 15 × 20 × 7**, **Driveway 25 × 40 × 15**, **Living room 10 × 15 × 10** (width × depth × overhead clearance), plus Custom. Each profile retains its own physical measurements and standing rectangle in this browser. Garage is selected on first use.
- Mint dashed standing outline with a translucent halo. A configurable edge inset starts at **1 ft on each side** as a planning allowance, not a validated player/swing safety margin. Applying physical measurements refits the standing rectangle to the smaller of the inset footprint and the regulation court's existing 10 cm edge clearance. The full driveway dimensions are preserved even though its width exceeds the court.
- Physical measurements and the standing rectangle appear together in a top-down diagram. Overhead clearance records the lowest obstruction; it does not resize the virtual ceiling or trigger live alerts in this phase.
- Standing width, depth (meters), X/Z center, and yaw remain editable. Apply validates the rotated rectangle against both the physical footprint minus inset and the court. Court dimensions remain fixed. Old standing settings migrate only if they fit the garage profile.
- Coordinates: meters, +Y up, court center at `(0,0,0)`, front wall at Z = −6.096. Positive yaw follows Three.js rotation about +Y.
- Drag the desktop preview to look around; Reset view restores the camera.
- Enter VR explicitly requests `immersive-vr` with **required `local-floor`**. Physical tracking stays at 1:1 scale, without locomotion. Session exit restores the desktop camera.

The footprint is a visual guide. It does not measure the garage, align headsets, enforce boundaries, or replace Quest's system boundary. Until calibration exists, its placement is relative to the headset's session reference space. Leave clearance from walls and obstacles and keep the system boundary enabled.

### Requirements for multiple locations

Physical dimensions, player movement areas, and ball-playing dimensions must remain separate. A larger physical profile must not be silently truncated to match the regulation scene. A smaller profile must not scale tracked movement. These settings do not yet select a compact or assisted ball mode, allocate two player areas, or establish that two-player swings fit in a location.

In the shared-space phase, the host must share one selected profile and configuration version with both clients. Changing locations or physical layout invalidates calibration and player readiness. The clearance value must be used by future height warnings independently of the rendered 20 ft ceiling. Location switching requires a fresh alignment check; saved dimensions do not constitute saved physical alignment.

## Architecture and audio execution plan

`server/server.js` serves a restricted client directory over native HTTPS; Three.js is exposed through two allowlisted local module URLs. `certificates.js` owns LAN certificate generation. `client/js/config.js` holds dimensions and validation, `court.js` builds static geometry/materials, `safe-zone.js` rebuilds only when settings change, `xr.js` owns the session lifecycle, and `app.js` connects the UI and renderer.

For Phase 4, `audio.js` will expose a `SpatialAudio` class:

1. Create/resume one `AudioContext` during an explicit user gesture. Fetch and decode three locally served impact clips once into an AudioBuffer cache.
2. Use a fixed pool of voices, each with `PannerNode → GainNode → master GainNode → destination`. Configure HRTF panning and inverse-distance attenuation in meters; recycle the oldest/quietest voice when the pool is full.
3. Update `AudioListener` position, forward, and up from the **headset world pose**, using reusable vectors in the render loop. Use short AudioParam ramps to avoid abrupt changes.
4. A collision callback calls `playImpact(kind, worldPosition, strength, eventId)`. Set the voice's panner at the contact point, attach a one-shot `AudioBufferSourceNode`, and play the cached clip. Source nodes are necessarily created per sound, while panners, gains, and buffers are reused.
5. Deduplicate predicted/server-confirmed collision IDs, throttle repeated contacts, and stop/disconnect active source nodes on session end. Both collision points and the listener must use the same calibrated world coordinates.

The Phase 1 render loop allocates no application vectors or geometry, caps desktop pixel ratio at 1.5, sets XR framebuffer scale to 1, and requests foveation 1. It avoids dynamic shadows and postprocessing. Actual headset frame pacing still needs measurement.

## Phase gates

1. **Current:** HTTPS, court, configurable footprint, local-floor VR entry. Run automated checks and complete the physical headset checks below before advancing.
2. WebSocket Player 1/2 assignment and tracked head/controller avatars.
3. Manual calibration and shared-origin verification. **A single shared point determines translation, not yaw.** Add a shared facing direction (controller orientation held along a marked axis), or a second physical point, to align both coordinate frames. Validate independent measurements before enabling shared play; do not claim mathematically perfect alignment from one corner tap.
4. Single server-authoritative ball spawn, local hit prediction, ball physics, distinct positional audio.
5. 1.37 m cross-player tracked-point warnings, haptics, stale-tracking handling, and Quest profiling.

## Verification

```powershell
cd server
npm test
```

The Node tests cover regulation/standing-zone math, rotated-footprint rejection, LAN SANs/certificate reuse, verified TLS requests, local asset delivery, method/path restrictions, and mocked XR success/exit/reentry/denial/reference-space failure paths. A mocked session is not a hardware WebXR test.

An optional desktop integration check is available at `server/test/browser-smoke.mjs`. With the server running and Playwright available, run `node test/browser-smoke.mjs` from `server`. Set `PLAYWRIGHT_MODULE` to an installed Playwright package path if needed and `BROWSER_CHANNEL=msedge` to use installed Edge. The isolated automated browser context accepts the development certificate; it does not change browser or system trust. The check covers WebGL 2 initialization, console errors, local-only asset requests, configuration persistence/validation, drag/reset controls, and mobile overflow, and saves screenshots in `artifacts/`.

**Physical Quest gate (pending until run on a headset):**

- Open the printed HTTPS LAN URL on Quest 2; resolve certificate trust and confirm the page reports local HTTPS ready.
- Enter VR and confirm immersive rendering with a floor-aligned `local-floor` reference space. Check floor height and 1:1 movement while staying clear of obstacles.
- Verify the floor material, regulation room proportions, service/short lines, and visibility of the standing-zone dashes.
- Exit, change width/depth/position/rotation, and reenter. Confirm the court stays fixed, the outline updates, and refresh preserves settings.
- Exit and reenter again; check denied-permission recovery and observe sustained frame pacing on the headset.

No Phase 2 work should begin until these Phase 1 hardware checks pass.

API references: [Three.js WebXRManager](https://threejs.org/docs/pages/WebXRManager.html), [MDN requestSession](https://developer.mozilla.org/en-US/docs/Web/API/XRSystem/requestSession), [WebXR permissions and security](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Permissions_and_security).
