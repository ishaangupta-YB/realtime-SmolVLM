// WebSocket link to /api/stream with automatic reconnect.
// Text messages are JSON; frames are binary: 4-byte big-endian sequence number + image bytes.

export class Link extends EventTarget {
  constructor(path = "/api/stream") {
    super();
    this.url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
    this.socket = null;
    this.retry = 0;
    this.timer = null;
  }

  get open() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Bytes queued in the browser but not yet on the wire. */
  get backlog() {
    return this.socket?.bufferedAmount ?? 0;
  }

  connect() {
    clearTimeout(this.timer);
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.retry = 0;
      this.emit("open");
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      this.emit("message", message);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.emit("close");
      const delay = Math.min(5000, 400 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }

  send(message) {
    if (!this.open) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  async sendFrame(seq, blob) {
    if (!this.open) return false;
    const body = new Uint8Array(4 + blob.size);
    new DataView(body.buffer).setUint32(0, seq >>> 0);
    body.set(new Uint8Array(await blob.arrayBuffer()), 4);
    if (!this.open) return false;
    this.socket.send(body);
    return true;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, handler) {
    this.addEventListener(type, (event) => handler(event.detail));
  }
}
