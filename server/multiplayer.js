import { WebSocketServer, WebSocket } from 'ws';
import { Room } from './room.js';

export function attachMultiplayer(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536) ws.send(JSON.stringify(data)); };
  const broadcast = data => { for (const ws of wss.clients) if (ws.joined) send(ws, data); };
  const room = new Room(broadcast);
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || (req.headers.origin && req.headers.origin !== `https://${req.headers.host}`)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    let windowStart = Date.now(), count = 0;
    ws.on('message', raw => {
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; count = 0; }
      if (++count > 120) { ws.close(1008, 'Message rate exceeded'); return; }
      try {
        const message = JSON.parse(raw.toString());
        if (!message || typeof message.type !== 'string') throw new Error('Invalid message.');
        if (message.type === 'join') {
          const id = room.join(ws, message.config, message.hand, message.mode);
          ws.joined = true;
          send(ws, { type: 'joined', id });
        } else room.handle(ws, message, now);
        if (message.type !== 'pose') broadcast(room.snapshot(now));
      } catch (error) { send(ws, { type: 'error', message: error.message }); }
    });
    ws.on('error', () => {});
    ws.on('close', () => { room.leave(ws); broadcast(room.snapshot()); });
  });
  let previous = performance.now(), accumulator = 0, lastSnapshot = 0;
  const timer = setInterval(() => {
    const time = performance.now(), now = Date.now();
    const elapsed = (time - previous) / 1000; previous = time;
    if (elapsed > 0.2) { room.pause('Server stalled. Both mark ready to resume.'); accumulator = 0; }
    accumulator += Math.min(elapsed, 0.05);
    const steps = Math.floor(accumulator * 120); accumulator -= steps / 120;
    room.update(now, steps);
    if (time - lastSnapshot >= 1000 / 30) { broadcast(room.snapshot(now)); lastSnapshot = time; }
  }, 8);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 5000);
  timer.unref(); heartbeat.unref();
  server.on('close', () => { clearInterval(timer); clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); });
  return { room, wss };
}
