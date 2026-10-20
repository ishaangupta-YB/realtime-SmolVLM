// Frame sources (camera, screen, image), frame encoding, and capture pacing.

const TILE = 32;
const MIN_PIXELS = 256 * 256;

/** The size Clef resizes an image to (sides on a 32 px grid, at least ~256x256), capped at maxSide. */
export function gridSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  let w = Math.max(TILE, Math.round((width * scale) / TILE) * TILE);
  let h = Math.max(TILE, Math.round((height * scale) / TILE) * TILE);
  if (w * h < MIN_PIXELS) {
    const grow = Math.sqrt(MIN_PIXELS / (width * height));
    w = Math.ceil((width * grow) / TILE) * TILE;
    h = Math.ceil((height * grow) / TILE) * TILE;
  }
  return [w, h];
}

export const imageTokens = (w, h) => (w / TILE) * (h / TILE);

/** Draws a source onto a reusable canvas at the model's size and encodes it off the main thread when possible. */
export class FrameEncoder {
  constructor() {
    this.offscreen = typeof OffscreenCanvas !== "undefined";
    this.canvas = this.offscreen ? new OffscreenCanvas(TILE, TILE) : document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { alpha: false });
  }

  async encode(source, sourceWidth, sourceHeight, { maxSide, mirror, quality }) {
    const [w, h] = gridSize(sourceWidth, sourceHeight, maxSide);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.ctx;
    ctx.imageSmoothingQuality = "high";
    if (mirror) ctx.setTransform(-1, 0, 0, 1, w, 0); else ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(source, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const blob = this.offscreen
      ? await this.canvas.convertToBlob({ type: "image/jpeg", quality })
      : await new Promise((resolve) => this.canvas.toBlob(resolve, "image/jpeg", quality));
    return { blob, width: w, height: h };
  }
}

/** Owns the active source and the elements that show it. */
export class Sources extends EventTarget {
  constructor(video, still) {
    super();
    this.video = video;
    this.still = still;
    this.mode = null;
    this.stream = null;
    this.bitmap = null;
    this.stillUrl = null;
  }

  async camera(deviceId) {
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this._useStream(stream, "camera");
  }

  async screen() {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("screen capture is not supported in this browser");
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
    this._useStream(stream, "screen");
  }

  _useStream(stream, mode) {
    this.stop();
    this.stream = stream;
    this.mode = mode;
    this.video.srcObject = stream;
    this.video.hidden = false;
    this.video.play().catch(() => {});
    for (const track of stream.getVideoTracks()) {
      track.addEventListener("ended", () => {
        if (this.stream === stream) this.dispatchEvent(new CustomEvent("ended", { detail: mode }));
      });
    }
  }

  async image(file) {
    const bitmap = await createImageBitmap(file);
    this.stop();
    this.bitmap = bitmap;
    this.stillUrl = URL.createObjectURL(file);
    this.still.src = this.stillUrl;
    this.still.hidden = false;
    this.mode = "image";
  }

  text() {
    this.stop();
    this.mode = "text";
  }

  /** The current drawable and its natural size, or null when nothing is ready yet. */
  frame() {
    if (this.mode === "camera" || this.mode === "screen") {
      const { videoWidth: w, videoHeight: h } = this.video;
      return w && h && this.video.readyState >= 2 ? { source: this.video, width: w, height: h } : null;
    }
    if (this.mode === "image" && this.bitmap) return { source: this.bitmap, width: this.bitmap.width, height: this.bitmap.height };
    return null;
  }

  get live() {
    return this.mode === "camera" || this.mode === "screen";
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.video.hidden = true;
    this.bitmap?.close?.();
    this.bitmap = null;
    if (this.stillUrl) URL.revokeObjectURL(this.stillUrl);
    this.stillUrl = null;
    this.still.hidden = true;
    this.still.removeAttribute("src");
    this.mode = null;
  }
}

/**
 * Decides when to capture the next frame.
 *
 * The server answers one frame at a time and keeps only the newest waiting frame. When it starts a
 * frame it tells us how long it expects to take; we capture the next one just before that time is
 * up, so it is waiting the moment the model frees up: no idle gap, and no stale backlog.
 * At most one frame is ever waiting on the server.
 */
export class Pacer {
  constructor(capture) {
    this.capture = capture; // async () => boolean (true when a frame was sent)
    this.running = false;
    this.waiting = false; // a frame is on the server, not yet started
    this.timer = null;
    this.minInterval = 0;
    this.lastCapture = 0;
    this.encodeMs = 12;
    this.sentAt = 0;
  }

  setMaxRate(fps) {
    this.minInterval = fps > 0 ? 1000 / fps : 0;
  }

  start() {
    this.running = true;
    this.waiting = false;
    this.schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  reset() {
    this.waiting = false;
    if (this.running) this.schedule(0);
  }

  schedule(delay) {
    clearTimeout(this.timer);
    const sinceLast = performance.now() - this.lastCapture;
    const wait = Math.max(delay, this.minInterval - sinceLast, 0);
    this.timer = setTimeout(() => this.fire(), wait);
  }

  /** The server took our frame and expects to need `expectedMs`. */
  started(expectedMs) {
    this.waiting = false;
    if (!this.running) return;
    const lead = this.encodeMs + 15;
    this.schedule(expectedMs ? Math.max(0, expectedMs - lead) : 0);
  }

  /** A frame finished. If nothing is queued (the estimate was long), capture now. */
  finished(failed = false) {
    if (!this.running || this.waiting) return;
    this.schedule(failed ? 500 : 0);
  }

  async fire() {
    this.timer = null;
    if (!this.running) return;
    if (this.waiting) {
      // A frame is already queued. Check back later in case its acknowledgement is lost.
      const age = performance.now() - this.sentAt;
      if (age < 4000) {
        this.timer = setTimeout(() => this.fire(), 4000 - age);
        return;
      }
      this.waiting = false;
    }
    const begun = performance.now();
    this.lastCapture = begun;
    this.waiting = true;
    this.sentAt = begun;
    let sent = false;
    try { sent = await this.capture(); } catch { sent = false; }
    this.encodeMs = 0.8 * this.encodeMs + 0.2 * (performance.now() - begun);
    if (!sent) {
      this.waiting = false;
      if (this.running) this.schedule(120);
    }
  }
}
