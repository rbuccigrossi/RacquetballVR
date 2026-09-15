# Racquetball VR — shared sandbox MVP

Two players share a local HTTPS/WebXR racquetball court. Both can spawn or hit the same ball at any time. There are no scores, turns, serve restrictions, or assigned player areas.

## Run and connect

Requires **Node.js 22+**:

```powershell
cd server
npm ci
npm start
```

Open the printed `https://<server-LAN-IP>:3000` address in Meta Quest Browser on **both headsets**, on the same LAN. All scripts, textures, sound synthesis, physics, and multiplayer traffic are local. Internet is needed only to install npm dependencies.

On this Windows machine, `./start.ps1` selects Node 22+ or the available Codex bundled runtime. The pre-existing system Node 12 is too old. An explicit executable can be passed with `-NodePath 'C:\path\to\node.exe'`.

The server binds to all IPv4 interfaces. If connection fails, check the LAN IP, Wi-Fi client isolation, and private-network firewall access for Node TCP 3000. No firewall or system trust settings are changed automatically.

Self-signed RSA/SHA-256 certificates are generated in `server/certs`, reused for up to 90 days, and renewed when near expiry or missing a current LAN IP. They include localhost, loopback, and detected IPv4 LAN addresses. `LAN_IPS` can supply additional comma-separated addresses; `PORT` changes the listening port; `npm run certs` forces renewal. Resolve the certificate warning/trust on each headset. Never share `key.pem`; certificates and private keys are outside the public directory and ignored by Git.

## First two-headset session

1. **Choose the physical profile on the first headset before joining.** It becomes the shared room configuration. On the second headset, use the same LAN URL; its local profile does not override the joined room.
2. **Prepare three floor marks:** facing your intended front wall, A is the rear-left corner of the measured physical footprint. B is exactly **1 meter (3 ft 3.37 in) to the right of A**. C is exactly **1 meter forward of A**. Make a right angle; C is not forward of B.
3. Use a measured support to place the **center of the right controller grip 10 cm (3.94 in) above each mark**. Both players must use the same repeatable controller reference point. The support must not obscure controller tracking; remove it from the movement area before playing.
4. Tap **Join shared sandbox**, then **Enter VR**, on each headset. Only two players may join. The first gets Player 1, the second Player 2.
5. Follow the headset panel: sample A, then B, then C with the **right trigger**. After each press, hold the controller steady for half a second. Both players perform all three samples. B establishes direction; C verifies the transform independently.
6. **Before swinging, verify each other's head and both hands at several locations across the footprint.** The controller samples must span 1 meter within 5 cm, be within 4 cm vertically, and the third-point error must be at most 8 cm. These are prototype acceptance thresholds, not a guarantee of safe physical alignment. Near-marker agreement does not prove agreement at the far side of the room.
7. Both press **right grip** to mark ready. The ball remains paused until two calibrated players have fresh headset and both-controller tracking and have both marked ready.
8. Press the **left trigger** to replace any existing ball with a new ball at the left hand. It immediately drops under gravity. Hit it with the right-hand racquet. Either player may spawn or hit, at any time during active play.

Do not hold a physical racquet: the controller has a virtual racquet attached. The rendered racquet and hand share the controller's grip pose.

## Controls

| Input | Action |
|---|---|
| Right trigger during alignment | Sample the next mark |
| Opposite-hand trigger during active play | Replace the single ball at that hand |
| Right grip **or A** | Mark ready when paused; pause when playing |
| Left grip **or Y** | Clear the ball |
| **X** | Cycle maximum ball speed through 4, 8, and 12 m/s |
| **B** | Restart alignment and pause both players |
| Browser Ball speed slider | Set shared maximum speed from 2–16 m/s |
| Browser Racquet hand | Switch racquet/spawn hands; pauses until both mark ready |
| Browser Positional sound | Mute/unmute locally |
| Browser Nearby warning | Adjust local tracked-point warning distance, default 1.37 m |
| Browser Leave sandbox | Free the player slot and clear/pause the shared ball |

Grip/A/X/Y/B commands keep the same physical controller assignments when racquet hands are switched. A ball spawn is a trigger press, not a repeated action while holding the trigger.

## Shared presence and feedback

- The opponent has a directionally visible head/visor, both tracked controller hands, and a racquet. A wireframe torso is **an approximation**, not tracked anatomy.
- Opponent meshes remain visible through court geometry. Poses use the freshest received data; there is no long smoothing delay that would conceal movement. LAN transmission and rendering still introduce latency.
- Nearby tracked points produce an orange head halo and hand/head color change, a headset message, and brief strong haptics where supported. There is no opaque flashing sphere and no forced division into player lanes.
- Calibrated head and controller positions produce warnings near the physical inset, outside the standing outline, or within 20 cm of overhead clearance. These are cues, not collision barriers or full-body/swing tracking.
- Missing or emulated headset/controller tracking, session visibility loss, stale network data, disconnection, and reference-space resets stop active play. Stale opponent avatars are hidden instead of displayed as current. Readiness is cleared; ordinary tracking recovery requires both players to mark ready again.
- Reference-space reset/recenter, leaving VR, reconnecting, or changing physical locations requires fresh calibration. Dimensions are saved; calibration is not persisted. A network drop does not intentionally reposition the court while the headset is on.
- Keep the headset's system boundary enabled. Verify alignment before each session. A software pause cannot stop a physical swing.

## Locations and court

Saved editable physical profiles (width × depth × lowest overhead clearance):

| Location | Feet |
|---|---|
| Garage | 15 × 20 × 7 |
| Driveway | 25 × 40 × 15 |
| Living room | 10 × 15 × 10 |
| Custom | Editable |

Physical measurements remain independent of the **20 × 40 × 20 ft** regulation court. The initial editable edge inset is **1 ft per side**, a planning allowance rather than validated player/swing clearance. The standing rectangle fits inside both the inset physical footprint and the court's existing 10 cm edge clearance. Full physical measurements are retained even when the driveway is wider than the virtual court.

The physical footprint and court are centered together; the scene uses meters, +Y up, and front wall at Z = −6.096. Calibration maps physical mark A to the footprint's rear-left corner. Physical height controls overhead warnings, not the rendered court ceiling. Location controls are locked while joined; leave to edit them. The shared profile remains authoritative until the room empties, so both players should leave before selecting a different location.

**Ball collisions still use the regulation court.** This MVP does not add compact-court physics, return guidance, amplified movement, or teleportation. A return may leave the physically reachable area in smaller spaces; spawn a replacement instead of chasing it outside your clear area. These gameplay adaptations can be evaluated after trying the sandbox.

## Physics, audio, and performance

- The server owns canonical ball state, accepted hit ordering, and spawn IDs. Either player can request a replacement; simultaneous requests resolve to one newest ball. Old ball IDs/revisions cannot apply stale hits.
- Each client predicts a new ball and local racquet contact immediately, then reconciles with server state. Hit requests are checked against current ball/racquet proximity, recent tracked motion, speed limits, cooldown, and ball revision. Latency compensation is bounded to 120 ms; it is prototype plausibility checking, not competitive anti-cheat.
- Shared physics runs at 120 Hz with swept time-of-impact against six court planes, gravity, inelastic bounces, and a maximum-speed setting. Racquet contacts use a relative ball/moving-disk sweep; fast rotations are approximated by frame samples. This is a lightweight model, without string deformation, spin, or full continuous rotational collision solving.
- Head/controller poses are sampled every XR frame and sent at a capped rate of 45/s; the server publishes state around 30/s. Application queues are bounded and superseded outgoing poses are skipped. Tracking expires after 300 ms. Server stalls pause play rather than simulating a large catch-up interval.
- Distinct **original synthesized** floor, wall, and racquet impacts are cached in one AudioContext. Twelve reusable HRTF PannerNode/GainNode voices provide distance attenuation. The listener follows calibrated headset position and orientation. Predicted racquet sound is deduplicated against its server confirmation. These sounds are not recordings; realistic recorded clips remain a future refinement.
- Boundary dashes use two instanced draw calls. Pose vectors, scene meshes, and prediction scratch state are reused; network serialization, collision events, audio source creation, calibration, and UI updates still allocate. The renderer keeps the existing foveation, capped pixel ratio, static lighting, and no dynamic shadows/postprocessing.

## Architecture

| Module | Responsibility |
|---|---|
| `server/server.js`, `certificates.js` | Restricted local HTTPS asset delivery and certificates |
| `server/multiplayer.js`, `room.js` | WebSocket sessions, two slots, readiness, authoritative state |
| `client/js/network.js` | Same-origin WSS connection and freshness |
| `client/js/calibration.js`, `math.js` | Stable samples, yaw/translation transform, third-marker check |
| `client/js/sandbox.js` | XR tracking/input, prediction, avatars, warnings, lifecycle |
| `client/js/physics.js` | Shared ball and racquet physics functions |
| `client/js/models.js`, `audio.js` | Head/hands/racquet/HUD and spatial sound |
| `client/js/spaces.js`, `spaces-ui.js` | Saved physical profiles and standing geometry |

## Verification

```powershell
cd server
npm test
```

Node tests cover HTTPS/certificates, path restrictions, physical profiles, mocked XR entry/exit, independent calibration origins, noisy samples, ball/racquet sweeps, simultaneous spawns, hit revision checks, tracking failure, malformed packets, and two actual WSS clients.

Optional browser tests require Playwright. Set `PLAYWRIGHT_MODULE` to an installed package path if necessary and `BROWSER_CHANNEL=msedge` to use installed Edge:

```powershell
node test/browser-smoke.mjs
node test/browser-sandbox.mjs
```

`browser-smoke.mjs` uses the running port-3000 server to verify rendering, local assets, profile controls, and responsive layout; screenshots go in `artifacts/`. `browser-sandbox.mjs` starts a separate ephemeral HTTPS server, runs production client logic with two synthetic XRFrame streams, and verifies controller-driven calibration, avatars, spawning, prediction/server acceptance, hand switching, audio listener/pool, speed, clearing, haptics, tracking recovery, and recenter invalidation. Test browsers accept their development certificates without altering global trust.

**Still requires physical Quest testing:** actual alignment across the space, controller/racquet grip orientation, simultaneous headset tracking, perceived network/hit latency, positional sound quality, haptic support, and sustained frame pacing. Begin with stationary avatar checks, then slow controlled hits. Automated synthetic-frame tests do not establish physical colocation accuracy or headset performance.

References: [Three.js WebXRManager](https://threejs.org/docs/pages/WebXRManager.html), [WebXR reference spaces](https://www.w3.org/TR/webxr/#xrreferencespace-interface), [Web Audio spatialization](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Web_audio_spatialization_basics).
