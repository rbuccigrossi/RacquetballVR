# Racquetball VR — shared sandbox MVP

Two players share a local HTTPS/WebXR racquetball court. Both can spawn or hit the same ball at any time. There are no scores, turns, serve restrictions, or assigned player areas.

**Solo practice** uses the same court, ball physics, racquet prediction, and audio with one headset.

## Quick solo practice

1. Select your physical space and choose **Solo practice** under Play mode.
2. Click **Start solo practice**, stand at the center facing forward, and **Enter VR**.
3. In VR, move either controller to the world-space **START** sign and squeeze the trigger. Press the opposite-hand trigger to drop a ball and hit it with the right racquet. No A/B calibration or second headset is needed.
4. Right grip/A pauses or resumes; left grip/Y clears the ball; X hides or shows the sign. Use the browser speed slider to change the cap. Tap or hold B to recenter at your current position/facing. Hand switching works as in shared play.

Temporary controller loss does not pause practice. System resets recover inside VR without A/B samples. The server still runs all ball physics so this tests the same behavior as shared play. Only one solo session or one shared room runs on this server at a time. When ready for two players, leave solo practice, choose **Two players**, and join with both headsets for normal A/B alignment. Switching modes does not reuse solo alignment for shared play.

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
2. The first player stands **at the center of the clear physical footprint**, facing the intended front wall, when entering. This establishes the court's center and direction; the headset supplies floor height.
3. Tap **Join shared sandbox**, then **Enter VR**, on each headset. The first joiner chooses the reference spots. Leave **See the physical room during setup and pauses** checked to use passthrough when supported. Identify the physical spots before entering if passthrough is unavailable.
4. The reference player chooses **A anywhere on the floor or stationary furniture**, rests their right controller against it, and presses the **right trigger**. Hold still briefly while it samples. Repeat at **B**, another distinct spot to the side. Different heights are fine; no fixed distance or height needs measuring. Wider horizontal separation improves direction accuracy. If the points are too close or vertically stacked, the headset asks for a farther spot B.
5. Tell your partner exactly which physical spots are A and B. Your partner touches those same spots in that order, using the **same part of the right controller and matching its direction**, and presses right trigger at each. The app samples the tracked grip center, so repeatable controller placement matters. Keep the reference objects stationary until both finish. Suggested A/B spheres begin around 3 feet high; the first player's spheres move to the chosen spots. The partner's floating labels are **approximate until aligned**: use the physical objects as the reference.
6. **Before swinging, verify each other's head and both hands at several locations across the footprint.** The two-point fit rejects endpoint errors above 8 cm and horizontal baselines shorter than 40 cm. These are prototype acceptance thresholds, not a guarantee of physical alignment. The two samples calculate translation and yaw; they are not an independent alignment check. Incorrect spots with similar spacing can still pass. Press B to restart if the real and virtual positions disagree.
7. Find the **mint floor outline, center cross, and START sign**, which remain visible over passthrough after alignment and while paused. Both players must be calibrated before the sign's START button unlocks. Either player can touch START with either controller; one press starts the shared session once both players are tracked. There is no player-distance requirement to start.
8. Press the **left trigger** to replace any existing ball with a new ball at the left hand. It immediately drops under gravity. Hit it with the right-hand racquet. Either player may spawn or hit, at any time during active play.

Do not hold a physical racquet: the controller has a virtual racquet attached. With the controller held flat pointing forward, the racquet tip points away from you and its front face points left. The visual mesh and collision surface use the same grip-space mount, including on your partner's avatar.

Passthrough uses a floor-based `immersive-ar` session when the browser supports it. Setup, pauses, and tracking loss reveal the physical room; active play renders the court in the same session. Unsupported browsers use `immersive-vr`. Quest 2 passthrough is grayscale. See [Meta's WebXR mixed reality documentation](https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/).

## Controls

| Input | Action |
|---|---|
| Right trigger during alignment | Choose or match physical spot A, then B |
| Either controller trigger on the world-space START sign | Start or resume the session when paused; the button unlocks after calibration |
| Opposite-hand trigger during active play | Replace the single ball at that hand |
| Right grip **or A** | Pause when playing; also remains a setup shortcut |
| Left grip **or Y** | Clear the ball |
| **X** | Hide or show the world-space instruction sign |
| Tap **B** | Retry your A/B alignment inside VR; pauses the ball, keeps your partner's alignment |
| Hold **B** for 1 second (Player 1) | Recenter the shared room at your current position/facing; preserves both alignments and clears the ball |
| Hold Meta/Oculus button | System recenter; see behavior below |
| Browser Maximum ball speed slider | Set shared speed ceiling from 2–85 m/s; default 85 |
| Browser Ball time slider | Scale ball flight, gravity, and bounces from 0.4× to 1.0×; default 1.0×. Tracking and swings stay real-time |
| Browser Racquet hand | Switch racquet/spawn hands; pauses until both mark ready |
| Browser Positional sound | Mute/unmute locally |
| Browser Player proximity | Disabled during physics/playability testing |
| Browser Leave sandbox | Free the player slot and clear/pause the shared ball |

Grip/A/X/Y/B commands keep the same physical controller assignments when racquet hands are switched. A ball spawn is a trigger press, not a repeated action while holding the trigger.

### Recenter and retry without leaving VR

Player 1 can stand at the desired center, face forward, and hold B for one second. This moves the shared court for both players, including the shared reference spots, while keeping their physical alignment. It clears the current ball. A short B press instead repeats only your own A/B samples against the existing physical references. Calibration samples need the **right controller only**, once the headset has established its floor reference. The other controller and the other headset need not be tracked during your samples. The headsets never need to see each other.

The system Meta/Oculus recenter is handled through WebXR's reference-space `reset` event. When the browser supplies the origin-change transform, Player 1's next valid head pose becomes the shared center; Player 2's system reset preserves the room center and their alignment. Browsers may report a reset without a transform, and reset events do not identify which system action caused them. In that case, stay in VR and repeat A/B: Player 1 establishes a new center/pair for both players; Player 2 only rematches the existing pair. Hold B is the direct in-game option that avoids changing the headset's tracking reference. See the [WebXR reset-event definition](https://www.w3.org/TR/webxr/#xrreferencespaceevent-interface).

## Shared presence and feedback

- The opponent has a directionally visible head/visor, both tracked controller hands, and a racquet. A wireframe torso is **an approximation**, not tracked anatomy.
- Opponent meshes remain visible through court geometry. Poses use the freshest received data; there is no long smoothing delay that would conceal movement. LAN transmission and rendering still introduce latency.
- The ball has a translucent motion streak from its previous rendered position to its current position. The streak is visual-only and resets when a ball is replaced.
- Setup and pause help lives on a stationary sign three feet in front of the court center and four feet above the floor. Its START button is disabled until calibration is complete and accepts either controller.
- **Player proximity detection is temporarily disabled**: no nearby-player halo, color change, message, or haptics. Head, hands, and racquet tracking remain visible. The implementation is retained behind `PLAYER_PROXIMITY_ENABLED` in `client/js/config.js` for later re-enabling.
- Calibrated head and controller positions produce warnings near the physical inset, outside the standing outline, or within 20 cm of overhead clearance. These are cues, not collision barriers or full-body/swing tracking.
- Each head/hand pose is independently available or missing. Missing or emulated poses hide only those avatar parts (torso follows head availability). The shared ball, readiness, and calibration continue during temporary tracking loss, including when all poses are unavailable but XR frames/session updates continue. Recovery is automatic. An unavailable spawning hand cannot spawn; an unavailable racquet cannot hit. Recovered racquets start a fresh movement sample so reacquisition does not count as a swing.
- Session hiding/suspension, stale session updates, and disconnection still pause the ball, without invalidating alignment for a brief interruption. Both mark ready after those interruptions. Tracking loss during a calibration sample only retries that spot. A/B alignment and recenter recovery happen inside the current VR session.
- A normal B retry keeps the shared spots and the other player's alignment. A reference-player reset with an unknown origin change clears the shared spots and requires a new pair. If the reference player leaves the room, the remaining player becomes the reference player and chooses a fresh pair. Versioned anchor messages prevent old samples/poses/hits from restoring stale alignment.
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

The physical footprint and court are centered together; the scene uses meters, +Y up, and front wall at Z = −6.096. Player 1's first valid headset pose at VR entry establishes the footprint center and forward direction, even before controllers become available. Manual calibration retries preserve that center; Player 1 can deliberately move it using recenter. Choose A/B wherever convenient; their positions do not define the footprint's corners or center. Previously saved standing-area offsets are cleared; width, depth, and rotation remain adjustable. Physical height controls overhead warnings, not the rendered court ceiling. Location controls are locked while joined; leave to edit them. The shared profile remains authoritative until the room empties, so both players should leave before selecting a different location.

**Ball collisions still use the regulation court.** This MVP does not add compact-court physics, return guidance, amplified movement, or teleportation. A return may leave the physically reachable area in smaller spaces; spawn a replacement instead of chasing it outside your clear area. These gameplay adaptations can be evaluated after trying the sandbox.

## Physics, audio, and performance

- The server owns canonical ball state, accepted hit ordering, and spawn IDs. Either player can request a replacement; simultaneous requests resolve to one newest ball. Old ball IDs/revisions cannot apply stale hits.
- Each client predicts a new ball and local racquet contact immediately, then reconciles with server state. Hit requests are checked against recent ball flight segments, swept racquet position, face direction, approaching relative velocity, tracked swing speed, cooldown, and ball revision. A bounded 64-segment history and 125 ms forward prediction follow wall bounces; a 120 ms history window recovers incoming velocity when the server has already advanced past a hit. Contact must be within 12 cm of a tested flight segment; the tolerance does not grow with the speed cap. This is prototype plausibility checking, not competitive anti-cheat.
- Server physics runs at 120 Hz. Client prediction subdivides each XR frame into steps no longer than 1/120 second and resolves racquet contact before the next wall bounce. This avoids using a misleading straight line across a frame containing multiple bounces. Hit cooldown is 50 ms and tracking jumps above 60 m/s racquet-center speed are rejected. Fast rotations remain approximated by interpolated disk normals and center velocity.
- Head/controller poses are sampled every XR frame and sent at a capped rate of 45/s; the server publishes state around 30/s. Application queues are bounded and superseded outgoing poses are skipped. Tracking expires after 300 ms. Server stalls pause play rather than simulating a large catch-up interval.
- Distinct **original synthesized** floor, wall, and racquet impacts are cached in one AudioContext. Twelve reusable HRTF PannerNode/GainNode voices provide distance attenuation. The listener follows calibrated headset position and orientation. Predicted racquet sound is deduplicated against its server confirmation. These sounds are not recordings; realistic recorded clips remain a future refinement.
- Boundary dashes use two instanced draw calls. Pose vectors, scene meshes, and prediction scratch state are reused; network serialization, collision events, audio source creation, calibration, and UI updates still allocate. The renderer keeps the existing foveation, capped pixel ratio, static lighting, and no dynamic shadows/postprocessing.

### Physics tuning

| Parameter | Value |
|---|---|
| Ball mass / diameter | 0.040 kg / 0.057 m |
| Floor, walls, ceiling restitution | 0.84 |
| Racquet effective impact mass | 0.170 kg |
| Racquet-ball restitution | 0.72 |
| Maximum ball speed | 85 m/s by default; lower practice caps available |
| Ball time scale | 1.0× by default; adjustable from 0.4× to 1.0× |

The ball dimensions/mass and the 68–72-inch rebound from a 100-inch drop follow [USA Racquetball's ball specification, rule 2.2](https://assets.contentstack.io/v3/assets/blteb7d012fc7ebef7f/blt3872fce6b9efc1a5/68ae385c981e96747729f351/USAR_Rulebook_%28New_Rule_C.4%29.pdf). A restitution of 0.84 gives an ideal height ratio of 0.7056; the simulated drop test also passes that range. Applying this value to every surface/speed is a modeling approximation, not an official wall coefficient.

Racquet contact uses the normal impulse `J = -(1 + e) * relativeNormalVelocity / (1 / ballMass + 1 / racquetMass)`. Separating contacts receive no impulse; tangential ball velocity is preserved. The finite-mass model accounts for recoil during the impulse, but the rendered racquet remains attached to the tracked hand. Its effective mass and restitution are tuning assumptions: a held racquet also depends on grip, arm, inertia, and impact location. For example, a 10 m/s ball hitting a stationary racquet rebounds at about 3.92 m/s in this model; a racquet moving normally at 10 m/s sends a stationary ball away at about 13.92 m/s.

The speed ceiling never accelerates a gentle shot. There is no artificial swing multiplier or minimum outgoing speed. Air drag, spin, string deformation, and off-center rotational recoil are not modeled yet. The new values are a physically motivated baseline to assess on the headset, not a claim of measured professional-shot accuracy.

The ball time slider scales gravity, flight distance, and bounce timing on the authoritative server and client prediction. Head/controller tracking and racquet swing velocity continue on wall-clock time, so a real-time swing can meet a slower-moving ball.

## Architecture

| Module | Responsibility |
|---|---|
| `server/server.js`, `certificates.js` | Restricted local HTTPS asset delivery and certificates |
| `server/multiplayer.js`, `room.js` | WebSocket sessions, two slots, readiness, authoritative state |
| `client/js/network.js` | Same-origin WSS connection and freshness |
| `client/js/calibration.js`, `math.js` | Stable two-point samples, yaw/translation transform, pair consistency check |
| `client/js/sandbox.js` | XR tracking/input, prediction, avatars, stationary sign, warnings, lifecycle |
| `client/js/physics.js` | Shared ball and racquet physics functions |
| `client/js/models.js`, `audio.js` | Head/hands/racquet/HUD and spatial sound |
| `client/js/spaces.js`, `spaces-ui.js` | Saved physical profiles and standing geometry |

## Verification

```powershell
cd server
npm test
```

Node tests cover HTTPS/certificates, path restrictions, physical profiles, mocked VR/passthrough entry and fallback, independent calibration origins, arbitrary anchor heights, noisy samples, anchor invalidation, racquet mounting, ball/racquet sweeps, simultaneous spawns, hit revision checks, tracking failure, malformed packets, and two actual WSS clients.

Optional browser tests require Playwright. Set `PLAYWRIGHT_MODULE` to an installed package path if necessary and `BROWSER_CHANNEL=msedge` to use installed Edge:

```powershell
node test/browser-smoke.mjs
node test/browser-sandbox.mjs
node test/browser-sandbox.mjs --solo
```

`browser-smoke.mjs` uses the running port-3000 server to verify rendering, local assets, profile controls, and responsive layout; screenshots go in `artifacts/`. `browser-sandbox.mjs` starts a separate ephemeral HTTPS server, runs production client logic with two synthetic XRFrame streams, and verifies entry-center retention with delayed controllers and calibration retries, shared center alignment, passthrough outline visibility, nearby ready/play without proximity cues, avatars, spawning, prediction/server acceptance, hand switching, audio, tracking recovery, and recenter invalidation. Test browsers accept their development certificates without altering global trust.

**Still requires physical Quest testing:** actual alignment across the space, controller/racquet grip orientation, simultaneous headset tracking, perceived network/hit latency, positional sound quality, haptic support, and sustained frame pacing. Begin with stationary avatar checks, then slow controlled hits. Automated synthetic-frame tests do not establish physical colocation accuracy or headset performance.

References: [Three.js WebXRManager](https://threejs.org/docs/pages/WebXRManager.html), [WebXR reference spaces](https://www.w3.org/TR/webxr/#xrreferencespace-interface), [Web Audio spatialization](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Web_audio_spatialization_basics).
