export class Network extends EventTarget {
  constructor() { super(); this.id = null; this.state = null; this.lastStateAt = 0; this.sequence = 0; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  join(config, hand, mode = 'shared') {
    if (this.socket?.readyState === WebSocket.OPEN && this.id === null) {
      this.send({ type: 'join', config, hand, mode }); return;
    }
    if (this.socket && this.socket.readyState < 2) return;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.socket = socket;
    socket.addEventListener('open', () => this.send({ type: 'join', config, hand, mode }));
    socket.addEventListener('message', event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'joined') this.id = data.id;
      if (data.type === 'state') { this.state = data; this.lastStateAt = performance.now(); }
      this.emit(data.type, data);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.id = null; this.state = null; this.emit('disconnected');
    });
    socket.addEventListener('error', () => this.emit('error', { message: 'LAN connection failed. Check that the server is running.' }));
  }
  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > 16384) {
      if (message.type === 'pose') return false;
      if (this.socket.bufferedAmount > 65536) { this.socket.close(); return false; }
    }
    this.socket.send(JSON.stringify({ rev: this.state?.rev, anchorVersion: this.state?.anchorVersion, ...message }));
    return true;
  }
  leave() { this.socket?.close(); }
  get fresh() { return this.id !== null && performance.now() - this.lastStateAt < 300; }
}
