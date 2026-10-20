// Wires the page together: sources -> pacer -> link -> results -> tracker -> cards / triggers / stats.

import { $, $$, clock, download, fitCanvas, h, hideDrawer, isTyping, ms, onDrawerChange, pretty, setupDrawers, showDrawer, store, toast, toggleDrawer, drawerOpen, pct } from "./ui.js";
import { validateQuestions } from "./schema.js";
import { DEFAULT_PRESET, PRESETS, clone } from "./presets.js";
import { FrameEncoder, Pacer, Sources, gridSize, imageTokens } from "./capture.js";
import { Link } from "./link.js";
import { Tracker } from "./tracker.js";
import { Cards } from "./cards.js";
import { Rules } from "./rules.js";
import { Activity } from "./activity.js";
import { Editor, readSharedSet } from "./editor.js";
import { Inspector } from "./inspector.js";
import { chime, speak } from "./sound.js";

// ---------------- state ----------------
const DEFAULT_SETTINGS = {
  detail: 352, fps: 0, quality: 0.8, cameraId: "", mirrorView: true, mirrorSent: false,
  pauseHidden: true, smoothing: 0.6, logChanges: false, sound: true, theme: "system", compact: false,
};
const settings = { ...DEFAULT_SETTINGS, ...store.get("settings", {}) };
const saveSettings = () => store.set("settings", settings);

let questions = store.get("questions", null);
if (!questions || validateQuestions(questions).length) questions = clone(DEFAULT_PRESET.questions);
let context = store.get("context", DEFAULT_PRESET.state);
let presetId = store.get("presetId", DEFAULT_PRESET.id);
let source = store.get("source", "camera");
let textState = store.get("textState", PRESETS.find((p) => p.source === "text").state);

let engine = null;
let paused = false;
let autoPaused = false;
let seq = 0;
const captures = new Map(); // seq -> {t, width, height}
const configWaiters = [];
const resultTimes = [];
const modelHistory = [];
let lastError = { message: "", t: 0 };
let renderQueued = false;
let lastResult = null;

// ---------------- modules ----------------
const link = new Link();
const sources = new Sources($("#video"), $("#still"));
const encoder = new FrameEncoder();
const tracker = new Tracker();
const cards = new Cards($("#cards"), tracker);
const activity = new Activity($("#log"), $("#logMeta"));
const pacer = new Pacer(captureAndSend);
const inspector = new Inspector({ getRequest: () => ({ questions, state: currentState(), hasImage: source !== "text" }) });
const rules = new Rules({ list: $("#rulesList"), onFire: fireRule, onChange: () => updateRulesMsg() });
const editor = new Editor({ getApplied: () => questions, apply: applyQuestions, getState: () => context });

// ---------------- helpers ----------------
const currentState = () => (source === "text" ? textState : context || "A live frame.");
const engineReady = () => engine?.status === "ready";
const maxSide = () => Math.min(settings.detail, engine?.limits?.max_side ?? 640);

function setLive(state, text) {
  $("#liveDot").dataset.state = state;
  $("#liveText").textContent = text;
}

function sendConfig(patch, onReply = () => {}) {
  if (!link.send({ type: "config", ...patch })) return false;
  configWaiters.push(onReply);
  return true;
}

// ---------------- questions ----------------
/**
 * Validate on the server, then switch to `next`. A `state` goes to the text box for text presets
 * and to the context field otherwise; `source` switches the input (text presets use "text").
 */
async function applyQuestions(next, { state, source: nextSource, presetId: nextPreset } = {}) {
  const errors = validateQuestions(next);
  if (errors.length) return { ok: false, errors };
  const reply = await new Promise((resolve) => {
    if (!sendConfig({ questions: next }, resolve)) resolve({ ok: true, offline: true });
    setTimeout(() => resolve({ ok: true, offline: true }), 5000);
  });
  if (!reply.ok) return reply;
  questions = next;
  store.set("questions", questions);
  presetId = nextPreset || "custom";
  store.set("presetId", presetId);
  if (typeof state === "string") {
    if (nextSource === "text") { textState = state; $("#textInput").value = textState; store.set("textState", textState); }
    else { context = state; $("#contextInput").value = context; store.set("context", context); }
  }
  rebuildQuestions();
  hideDrawer();
  if (nextSource && nextSource !== source) await switchSource(nextSource);
  else {
    if (typeof state === "string") sendConfig({ state: currentState() });
    rerunStill();
  }
  return { ok: true };
}

function rebuildQuestions() {
  tracker.reset(questions);
  cards.build(questions);
  rules.setQuestions(questions);
  const n = Object.keys(questions).length;
  $("#cardsMeta").textContent = `${n} question${n === 1 ? "" : "s"}`;
  renderPresetSelect();
}

function renderPresetSelect() {
  const select = $("#presetSelect");
  const options = PRESETS.map((p) => h("option", { value: p.id, text: p.name }));
  if (presetId === "custom" || !PRESETS.some((p) => p.id === presetId)) options.unshift(h("option", { value: "custom", text: "Custom set" }));
  select.replaceChildren(...options);
  select.value = PRESETS.some((p) => p.id === presetId) ? presetId : "custom";
}

// ---------------- sources ----------------
async function switchSource(next, file, { restart = false } = {}) {
  if (next === "image" && !file) {
    $("#fileInput").click(); // comes back here with the file; nothing changes if it is cancelled
    return;
  }
  if (!restart && next === source && sources.mode === next && next !== "image") return; // already showing it
  source = next;
  store.set("source", source === "text" ? "text" : "camera");
  for (const button of $$("#sourceSwitch button")) button.setAttribute("aria-pressed", String(button.dataset.source === next));
  pacer.stop();
  $("#textState").hidden = next !== "text";
  $("#stage").dataset.source = next;
  $("#contextInput").disabled = next === "text";
  $("#contextInput").title = next === "text" ? "In text mode the text box is the state" : "";
  $("#stage").classList.toggle("mirrored", settings.mirrorView && next === "camera");

  try {
    if (next === "camera") await sources.camera(settings.cameraId || undefined);
    else if (next === "screen") await sources.screen();
    else if (next === "image") await sources.image(file);
    else sources.text();
  } catch (error) {
    sources.stop();
    showEmpty(next, error);
    return;
  }
  $("#stageEmpty").hidden = true;
  $("#pausedVeil").hidden = !(paused && sources.live);
  sendConfig({ state: currentState() });
  updateFrameChip();
  if (next === "camera") populateCameras();
  if (sources.live) startLive();
  else if (next === "image") rerunStill();
  else if (next === "text") {
    setLive("idle", "text state");
    $("#textInput").focus();
    if (textState.trim()) runText();
  }
}

function showEmpty(mode, error) {
  const denied = error && /NotAllowed|Permission/i.test(`${error.name} ${error.message}`);
  const missing = error && /NotFound|Overconstrained/i.test(`${error.name}`);
  $("#emptyTitle").textContent = mode === "screen" ? "Screen sharing was not started" : denied ? "Camera access was blocked" : missing ? "No camera found" : "Point a camera at the world";
  $("#emptyText").textContent = denied
    ? "Allow camera access for this page in your browser's site settings, then try again. Or evaluate an image or plain text instead."
    : error
      ? `${error.message || error.name}. You can still evaluate an image or plain text.`
      : "Pick a source and every frame comes back with odds for each option of each question, computed in one pass of the model.";
  $("#stageEmpty").hidden = false;
  setLive("error", mode === "screen" ? "no screen" : "no camera");
  updateFrameChip();
}

function startLive() {
  if (paused || autoPaused) return;
  pacer.setMaxRate(settings.fps);
  pacer.start();
}

async function captureAndSend() {
  if (!link.open || !engineReady() || paused || autoPaused || !sources.live) return false;
  if (link.backlog > 2_000_000) return false; // the socket is congested; skip rather than queue
  const frame = sources.frame();
  if (!frame) return false;
  const encoded = await encoder.encode(frame.source, frame.width, frame.height, {
    maxSide: maxSide(),
    mirror: settings.mirrorSent && source === "camera",
    quality: settings.quality,
  });
  if (!encoded.blob) return false;
  const id = ++seq;
  captures.set(id, { t: performance.now(), width: encoded.width, height: encoded.height });
  if (captures.size > 30) captures.delete(captures.keys().next().value);
  return link.sendFrame(id, encoded.blob);
}

/** Image mode: evaluate the still once (again after questions or context change). */
async function rerunStill() {
  if (source === "text") {
    if ($("#textAuto").checked) runText();
    return;
  }
  if (source !== "image" || !link.open || !engineReady()) return;
  const frame = sources.frame();
  if (!frame) return;
  const encoded = await encoder.encode(frame.source, frame.width, frame.height, { maxSide: maxSide(), mirror: false, quality: 0.92 });
  const id = ++seq;
  captures.set(id, { t: performance.now(), width: encoded.width, height: encoded.height });
  setLive("busy", "deciding…");
  await link.sendFrame(id, encoded.blob);
}

function runText() {
  textState = $("#textInput").value;
  store.set("textState", textState);
  if (!textState.trim() || !link.open || !engineReady()) return;
  sendConfig({ state: textState });
  const id = ++seq;
  captures.set(id, { t: performance.now() });
  setLive("busy", "deciding…");
  link.send({ type: "tick", seq: id });
}

function updateFrameChip() {
  const frame = sources.frame();
  const chip = $("#frameChip");
  if (source === "text" || !frame) {
    chip.textContent = source === "text" ? "text only" : "–";
    return;
  }
  const [w, hgt] = gridSize(frame.width, frame.height, maxSide());
  chip.replaceChildren(h("b", { text: `${w}×${hgt}` }), ` · ${imageTokens(w, hgt)} image tokens`);
  updateDetailOptions(frame);
}

// ---------------- results ----------------
function onResult(message) {
  const now = performance.now();
  lastResult = message;
  const captured = captures.get(message.seq);
  const changes = tracker.ingest(message.answers, now);
  rules.evaluate(tracker, now);
  activity.record(message.seq, message.answers, message.timing);
  if (settings.logChanges) {
    for (const change of changes) {
      activity.add("change", [h("b", { text: pretty(change.id) }), ` → ${change.view.label} (${pct(change.view.confidence)})`]);
    }
  }
  // stats
  resultTimes.push(now);
  while (resultTimes.length && now - resultTimes[0] > 3000) resultTimes.shift();
  modelHistory.push(message.timing?.model_ms ?? 0);
  if (modelHistory.length > 40) modelHistory.shift();
  scheduleRender(captured ? now - captured.t : null);
  inspector.setResult(message);
  if (sources.live) pacer.finished();
  else setLive("live", source === "text" ? "answered" : "image answered");
  if (sources.live) $("#captureRing").animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 480, easing: "ease-out" });
}

function scheduleRender(age) {
  if (age !== null) scheduleRender.age = age;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const now = performance.now();
    cards.render(now);
    renderStats(scheduleRender.age);
  });
}

function renderStats(age) {
  const r = lastResult;
  if (!r) return;
  $("#statModel").replaceChildren(ms(r.timing?.model_ms), h("small", { text: "ms" }));
  $("#statAge").replaceChildren(age == null ? "–" : ms(age), h("small", { text: "ms" }));
  const rate = resultTimes.length > 1 ? (resultTimes.length - 1) / ((resultTimes.at(-1) - resultTimes[0]) / 1000) : 0;
  $("#statRate").textContent = sources.live && rate ? rate.toFixed(1) : "–";
  $("#statTokens").textContent = r.usage?.input_tokens ?? "–";
  if (sources.live && !paused) setLive("live", `live · #${r.seq}${r.dropped ? ` · ${r.dropped} skipped` : ""}`);
  drawSpark($("#statModelSpark"), modelHistory);
}

function drawSpark(canvas, values) {
  const fitted = fitCanvas(canvas);
  if (!fitted || values.length < 2) return;
  const { ctx, width, height } = fitted;
  const max = Math.max(...values) * 1.15 || 1;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * (width - 3);
    const y = height - 2 - (v / max) * (height - 4);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = cards.colors.accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();
}

function onError(message) {
  if (message.seq !== undefined && sources.live) pacer.finished(true);
  const now = Date.now();
  if (message.message !== lastError.message || now - lastError.t > 8000) {
    activity.add("error", message.message);
    if (message.message !== lastError.message) toast(message.message, { kind: "error" });
    lastError = { message: message.message, t: now };
  }
  setLive("error", "error · see Activity");
}

// ---------------- engine ----------------
function setEngine(next) {
  const wasReady = engineReady();
  engine = next;
  inspector.setEngine(engine);
  const pill = $("#engineText");
  const dot = $("#engineDot");
  const banner = $("#banner");
  banner.hidden = true;
  banner.dataset.kind = "warn";
  if (engine.status === "loading") {
    dot.dataset.state = "busy";
    pill.replaceChildren(h("b", { text: engine.backend }), ` · loading ${engine.model}…`);
    if (engine.backend === "local") {
      banner.hidden = false;
      $("#bannerText").textContent = "Loading clef-flash into memory (about 19 GB of weights). The first start takes a minute; frames start flowing as soon as it is ready.";
    }
  } else if (engine.status === "failed") {
    dot.dataset.state = "error";
    pill.replaceChildren(h("b", { text: engine.backend }), " · failed");
    banner.hidden = false;
    banner.dataset.kind = "error";
    $("#bannerText").textContent = `The backend failed to start: ${engine.error}`;
  } else {
    dot.dataset.state = engine.synthetic ? "demo" : "live";
    pill.replaceChildren(h("b", { text: engine.backend }), ` · ${engine.where}${engine.device ? ` · ${engine.device}` : ""}`);
    if (engine.synthetic) {
      banner.hidden = false;
      $("#bannerText").replaceChildren(
        h("b", { text: "Demo mode: these answers are synthetic. " }),
        "Download the model (",
        h("code", { text: "uv run hf download Cloudflare/clef-flash --local-dir weights/clef-flash" }),
        ") or set ",
        h("code", { text: "CLOUDFLARE_ACCOUNT_ID" }), " and ", h("code", { text: "CLOUDFLARE_API_TOKEN" }),
        " for Workers AI, then restart.",
      );
    }
  }
  $("#enginePill").title = engine.notes?.join(" · ") || "Backend details";
  updateDetailOptions(sources.frame());
  if (!wasReady && engineReady()) {
    if (sources.live) startLive();
    rerunStill();
  }
}

// ---------------- triggers ----------------
function fireRule(rule, description, view) {
  const actions = rule.actions || {};
  let thumb = null;
  if (actions.snapshot) thumb = snapshotCanvas(320)?.toDataURL("image/jpeg", 0.8) ?? null;
  activity.add("rule", [h("b", { text: description }), ` · ${view.label} ${pct(view.confidence)}`], thumb);
  if (actions.toast) toast(`${description}`, { kind: "rule" });
  if (actions.sound && settings.sound) chime();
  if (actions.speak) speak(`${pretty(rule.question)}: ${view.label}`);
}

function updateRulesMsg() {
  const n = rules.rules.filter((r) => r.enabled).length;
  $("#rulesMsg").textContent = n ? `${n} active` : "";
  $("#openRules").setAttribute("aria-pressed", String(n > 0));
}

// ---------------- snapshot ----------------
function snapshotCanvas(maxWidth = 1280) {
  const frame = sources.frame();
  const summary = cards.summary();
  let width = 960, height = 540;
  if (frame) {
    const scale = Math.min(1, maxWidth / frame.width);
    width = Math.round(frame.width * scale);
    height = Math.round(frame.height * scale);
  } else if (source !== "text") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, width, height);
  if (frame) {
    const mirror = settings.mirrorView && source === "camera";
    if (mirror) ctx.setTransform(-1, 0, 0, 1, width, 0);
    ctx.drawImage(frame.source, 0, 0, width, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (maxWidth < 600 || !summary.length) return canvas;
  const lineHeight = Math.max(20, Math.round(width / 48));
  const pad = Math.round(lineHeight * 0.8);
  ctx.font = `600 ${Math.round(lineHeight * 0.7)}px ui-sans-serif, system-ui, sans-serif`;
  const lines = summary.map((s) => `${pretty(s.id)}: ${s.label}  ${pct(s.type === "noul" ? s.yes : s.confidence)}`);
  const boxWidth = Math.min(width - pad * 2, Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2);
  const boxHeight = lines.length * lineHeight + pad * 1.5;
  ctx.fillStyle = "rgba(10, 12, 16, 0.72)";
  ctx.beginPath();
  ctx.roundRect(pad, height - boxHeight - pad, boxWidth, boxHeight, 12);
  ctx.fill();
  ctx.fillStyle = "#eceef4";
  lines.forEach((line, i) => ctx.fillText(line, pad * 2, height - boxHeight - pad + pad + lineHeight * (i + 0.7), boxWidth - pad * 2));
  return canvas;
}

function takeSnapshot() {
  const canvas = snapshotCanvas();
  if (!canvas) { toast("Nothing to capture yet", { kind: "error" }); return; }
  canvas.toBlob((blob) => {
    download(`clef-snapshot-${clock(Date.now()).replace(/:/g, "")}.png`, blob);
    toast("Snapshot saved", { kind: "ok" });
  }, "image/png");
}

// ---------------- pause ----------------
function setPaused(next) {
  paused = next;
  $("#pausedVeil").hidden = !paused || !sources.live;
  $("#pauseBtn").setAttribute("aria-pressed", String(paused));
  $("#pauseBtn").replaceChildren(iconUse(paused ? "play" : "pause"));
  cards.markStale(paused);
  if (paused) { pacer.stop(); setLive("idle", "paused"); }
  else if (sources.live) startLive();
}

function iconUse(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---------------- settings ----------------
const DETAILS = [256, 352, 448, 512, 640, 768, 1024];
function updateDetailOptions(frame) {
  const select = $("#setDetail");
  const limit = engine?.limits?.max_side ?? 640;
  const aspect = frame ? [frame.width, frame.height] : [16, 9];
  const values = DETAILS.filter((d) => d <= limit);
  if (!values.includes(settings.detail)) settings.detail = values.reduce((best, d) => (Math.abs(d - 352) < Math.abs(best - 352) ? d : best), values[0]);
  select.replaceChildren(...values.map((d) => {
    const [w, hgt] = gridSize(aspect[0] * 100, aspect[1] * 100, d);
    return h("option", { value: String(d), text: `${d} px  ·  ${w}×${hgt}  ·  ${imageTokens(w, hgt)} image tokens` });
  }));
  select.value = String(settings.detail);
}

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  const dark = settings.theme === "dark" || (settings.theme === "system" && !matchMedia("(prefers-color-scheme: light)").matches);
  $("#themeToggle").replaceChildren(iconUse(dark ? "sun" : "moon"));
  requestAnimationFrame(() => { cards.refreshColors(); if (lastResult) drawSpark($("#statModelSpark"), modelHistory); });
}

async function populateCameras() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const select = $("#setCamera");
    select.replaceChildren(h("option", { value: "", text: "Default camera" }),
      ...devices.map((d, i) => h("option", { value: d.deviceId, text: d.label || `Camera ${i + 1}` })));
    select.value = devices.some((d) => d.deviceId === settings.cameraId) ? settings.cameraId : "";
  } catch { /* device list unavailable */ }
}

function setupSettings() {
  const bind = (id, key, parse = (v) => v, onChange) => {
    const input = $(id);
    const isBox = input.type === "checkbox";
    if (isBox) input.checked = !!settings[key]; else input.value = String(settings[key]);
    input.addEventListener("change", () => {
      settings[key] = isBox ? input.checked : parse(input.value);
      saveSettings();
      onChange?.();
    });
  };
  bind("#setDetail", "detail", Number, () => { updateFrameChip(); rerunStill(); });
  bind("#setFps", "fps", Number, () => pacer.setMaxRate(settings.fps));
  bind("#setQuality", "quality", Number, () => ($("#qualityValue").textContent = settings.quality.toFixed(2)));
  $("#setQuality").addEventListener("input", (e) => ($("#qualityValue").textContent = Number(e.target.value).toFixed(2)));
  $("#qualityValue").textContent = settings.quality.toFixed(2);
  bind("#setCamera", "cameraId", String, () => { if (source === "camera") switchSource("camera", null, { restart: true }); });
  bind("#setMirrorSent", "mirrorSent");
  bind("#setHiddenPause", "pauseHidden");
  bind("#setSmoothing", "smoothing", Number, () => tracker.setSmoothing(settings.smoothing));
  bind("#setLogChanges", "logChanges");
  bind("#setSound", "sound");
  bind("#setTheme", "theme", String, applyTheme);
  tracker.setSmoothing(settings.smoothing);
  $("#resetQuestions").addEventListener("click", resetQuestions);
  $("#resetAll").addEventListener("click", () => {
    if (!confirm("Reset questions, triggers, saved sets and settings?")) return;
    for (const key of ["settings", "questions", "context", "presetId", "rules", "saved", "source", "textState"]) store.remove(key);
    location.hash = "";
    location.reload();
  });
}

function resetQuestions() {
  applyQuestions(clone(DEFAULT_PRESET.questions), { state: DEFAULT_PRESET.state, presetId: DEFAULT_PRESET.id }).then((r) => {
    if (r.ok) toast("Back to the default questions", { kind: "ok" });
  });
}

function setCompact(next) {
  settings.compact = next;
  saveSettings();
  $("#cards").classList.toggle("compact", next);
  $("#densityBtn").setAttribute("aria-pressed", String(next));
  if (!next) cards.render(performance.now(), true);
}

function setMirror(next) {
  settings.mirrorView = next;
  saveSettings();
  $("#mirrorBtn").setAttribute("aria-pressed", String(next));
  $("#stage").classList.toggle("mirrored", next && source === "camera");
}

// ---------------- wiring ----------------
function wire() {
  setupDrawers();
  setupSettings();

  $("#openEditor").addEventListener("click", () => toggleDrawer("editorDrawer"));
  $("#editBtn").addEventListener("click", () => showDrawer("editorDrawer"));
  $("#openRules").addEventListener("click", () => toggleDrawer("rulesDrawer"));
  $("#openInspector").addEventListener("click", () => toggleDrawer("inspectorDrawer"));
  $("#enginePill").addEventListener("click", () => toggleDrawer("inspectorDrawer"));
  $("#openSettings").addEventListener("click", () => toggleDrawer("settingsDrawer"));
  $("#openHelp").addEventListener("click", () => $("#helpDialog").showModal());
  $("#helpDialog [data-close]").addEventListener("click", () => $("#helpDialog").close());
  $("#themeToggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme && !matchMedia("(prefers-color-scheme: light)").matches);
    settings.theme = dark ? "light" : "dark";
    $("#setTheme").value = settings.theme;
    saveSettings();
    applyTheme();
  });
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => settings.theme === "system" && applyTheme());
  onDrawerChange((id, open) => {
    if (id === "editorDrawer" && open) editor.open();
    if (id === "inspectorDrawer") inspector.setVisible(open);
    if (id === "rulesDrawer" && open) rules.renderList();
    $("#openEditor").setAttribute("aria-pressed", String(drawerOpen() === "editorDrawer"));
    $("#openInspector").setAttribute("aria-pressed", String(drawerOpen() === "inspectorDrawer"));
    $("#openSettings").setAttribute("aria-pressed", String(drawerOpen() === "settingsDrawer"));
  });
  $("#addRule").addEventListener("click", () => {
    if (!rules.add()) toast("Add a question first", { kind: "error" });
    updateRulesMsg();
  });

  for (const button of $$("#sourceSwitch button")) button.addEventListener("click", () => switchSource(button.dataset.source));
  $("#emptyCamera").addEventListener("click", () => switchSource("camera"));
  $("#emptyImage").addEventListener("click", () => $("#fileInput").click());
  $("#emptyText2").addEventListener("click", () => switchSource("text"));
  $("#fileInput").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) switchSource("image", file);
  });
  sources.addEventListener("ended", (event) => { pacer.stop(); showEmpty(event.detail); });
  $("#video").addEventListener("resize", updateFrameChip);
  $("#video").addEventListener("loadedmetadata", updateFrameChip);

  $("#mirrorBtn").addEventListener("click", () => setMirror(!settings.mirrorView));
  $("#shotBtn").addEventListener("click", takeSnapshot);
  $("#pauseBtn").addEventListener("click", () => setPaused(!paused));
  $("#pausedVeil").addEventListener("click", () => setPaused(false));
  $("#densityBtn").addEventListener("click", () => setCompact(!settings.compact));
  $("#clearLog").addEventListener("click", () => activity.clear());
  $("#exportCsv").addEventListener("click", () => {
    const n = activity.exportCsv();
    toast(n ? `Exported ${n.toLocaleString()} rows` : "Nothing recorded yet", { kind: n ? "ok" : "info" });
  });

  // context: sent as the state with every frame
  const contextInput = $("#contextInput");
  contextInput.value = context;
  let contextTimer;
  contextInput.addEventListener("input", () => {
    clearTimeout(contextTimer);
    contextTimer = setTimeout(() => {
      context = contextInput.value;
      store.set("context", context);
      if (source !== "text") { sendConfig({ state: currentState() }); rerunStill(); }
    }, 350);
  });
  $("#presetSelect").addEventListener("change", (event) => {
    const preset = PRESETS.find((p) => p.id === event.target.value);
    if (preset) applyQuestions(clone(preset.questions), { state: preset.state, source: preset.source, presetId: preset.id });
  });

  // text state
  const textInput = $("#textInput");
  textInput.value = textState;
  let textTimer;
  textInput.addEventListener("input", () => {
    textState = textInput.value;
    store.set("textState", textState);
    if ($("#textAuto").checked) { clearTimeout(textTimer); textTimer = setTimeout(runText, 450); }
  });
  textInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runText(); } });
  $("#textRun").addEventListener("click", runText);

  // drag & drop and paste
  const stage = $("#stage");
  let depth = 0;
  stage.addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { depth++; $("#dropVeil").hidden = false; e.preventDefault(); } });
  stage.addEventListener("dragover", (e) => e.preventDefault());
  stage.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("#dropVeil").hidden = true; } });
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    $("#dropVeil").hidden = true;
    const file = [...e.dataTransfer.files].find((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    if (file) switchSource("image", file); else toast("Drop a PNG, JPEG or WebP image", { kind: "error" });
  });
  document.addEventListener("paste", (e) => {
    if (isTyping(e.target)) return;
    const file = [...(e.clipboardData?.files || [])].find((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    if (file) { switchSource("image", file); e.preventDefault(); }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && settings.pauseHidden && sources.live) { autoPaused = true; pacer.stop(); }
    else if (!document.hidden && autoPaused) { autoPaused = false; if (sources.live && !paused) startLive(); }
  });

  document.addEventListener("keydown", onKey);
}

function onKey(event) {
  if (event.key === "Escape") {
    if (drawerOpen()) { hideDrawer(); event.preventDefault(); }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    if (drawerOpen() === "editorDrawer") { editor.commit(); event.preventDefault(); }
    else if (source === "text") { runText(); event.preventDefault(); }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
  if ($("#helpDialog").open && event.key !== "?") return;
  const key = event.key;
  const actions = {
    " ": () => sources.live && setPaused(!paused),
    e: () => toggleDrawer("editorDrawer"),
    g: () => toggleDrawer("rulesDrawer"),
    i: () => toggleDrawer("inspectorDrawer"),
    ",": () => toggleDrawer("settingsDrawer"),
    s: takeSnapshot,
    m: () => setMirror(!settings.mirrorView),
    c: () => setCompact(!settings.compact),
    l: () => $("#themeToggle").click(),
    "?": () => ($("#helpDialog").open ? $("#helpDialog").close() : $("#helpDialog").showModal()),
    1: () => switchSource("camera"),
    2: () => switchSource("screen"),
    3: () => switchSource("image"),
    4: () => switchSource("text"),
    D: () => event.shiftKey && resetQuestions(),
  };
  const action = actions[key] ?? actions[key.toLowerCase()];
  if (action && !(key === "d" && !event.shiftKey)) {
    event.preventDefault();
    action();
  }
}

// ---------------- link ----------------
link.on("open", () => {
  sendConfig({ questions, state: currentState() }, (reply) => {
    if (reply.ok) return;
    toast("Saved questions were rejected by the server; loaded the defaults", { kind: "error" });
    applyQuestions(clone(DEFAULT_PRESET.questions), { state: DEFAULT_PRESET.state, presetId: DEFAULT_PRESET.id });
  });
  pacer.reset();
});

link.on("close", () => {
  configWaiters.splice(0).forEach((resolve) => resolve({ ok: true, offline: true }));
  $("#engineDot").dataset.state = "busy";
  $("#engineText").textContent = "reconnecting…";
  setLive("busy", "reconnecting");
  cards.markStale(true);
});

link.on("message", (message) => {
  switch (message.type) {
    case "hello":
    case "engine":
      setEngine(message.engine);
      break;
    case "config":
      (configWaiters.shift() || (() => {}))(message);
      break;
    case "started":
      if (sources.live) pacer.started(message.expected_ms);
      break;
    case "result":
      onResult(message);
      break;
    case "error":
      onError(message);
      break;
  }
});

// ---------------- boot ----------------
function boot() {
  wire();
  applyTheme();
  setMirror(settings.mirrorView);
  setCompact(settings.compact);
  const shared = readSharedSet();
  if (shared) {
    questions = shared.questions;
    if (typeof shared.state === "string") context = shared.state;
    presetId = "custom";
    history.replaceState(null, "", location.pathname);
    toast("Loaded the shared question set", { kind: "ok" });
  }
  $("#contextInput").value = context;
  rebuildQuestions();
  updateRulesMsg();
  link.connect();
  switchSource(source === "text" ? "text" : "camera");
}

boot();
