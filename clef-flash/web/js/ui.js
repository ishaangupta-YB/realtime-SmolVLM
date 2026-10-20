// Small DOM, storage and formatting helpers shared by every module.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** h("div", {class: "x", on: {click}}, child...) */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style" && typeof value === "object") {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith("--")) node.style.setProperty(prop, v); else node.style[prop] = v;
      }
    }
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "on") for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(name, size) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (size) { svg.setAttribute("width", size); svg.setAttribute("height", size); }
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---------- storage (every access can throw in private windows or with storage blocked) ----------
const PREFIX = "clefcam:";
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* not persisted */ }
  },
  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
  },
};

// ---------- formatting ----------
export const pretty = (id) => String(id).replace(/[_\-.]+/g, " ").trim();

export function pct(p) {
  if (p === undefined || p === null || Number.isNaN(p)) return "–";
  if (p >= 0.995) return ">99%";
  if (p > 0 && p < 0.005) return "<1%";
  return `${Math.round(p * 100)}%`;
}

export function ms(value) {
  if (value === undefined || value === null) return "–";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}`;
}

export function clock(t) {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function textOf(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- toasts ----------
export function toast(message, { kind = "info", timeout = 4200 } = {}) {
  const root = $("#toasts");
  const iconName = kind === "error" ? "warn" : kind === "ok" ? "check" : kind === "rule" ? "bolt" : "info";
  const node = h("div", { class: "toast", dataset: { kind } }, icon(iconName), h("div", {}, message));
  root.append(node);
  while (root.children.length > 4) root.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add("out");
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

// ---------- drawers ----------
let openDrawer = null;
let returnFocus = null;
const drawerListeners = new Set();

export function onDrawerChange(fn) { drawerListeners.add(fn); }

export function showDrawer(id) {
  const drawer = document.getElementById(id);
  if (openDrawer === drawer) return;
  if (openDrawer) hideDrawer();
  returnFocus = document.activeElement;
  drawer.classList.add("open");
  $("#scrim").classList.add("open");
  openDrawer = drawer;
  const focusable = drawer.querySelector("[autofocus], .tab[aria-selected='true'], input, textarea, select, button:not([data-close])");
  requestAnimationFrame(() => focusable?.focus({ preventScroll: true }));
  drawerListeners.forEach((fn) => fn(id, true));
}

export function hideDrawer() {
  if (!openDrawer) return;
  const id = openDrawer.id;
  // Focus must leave the drawer now; otherwise keys keep going to a hidden field until the browser notices.
  if (openDrawer.contains(document.activeElement)) document.activeElement.blur();
  openDrawer.classList.remove("open");
  $("#scrim").classList.remove("open");
  openDrawer = null;
  if (returnFocus && returnFocus !== document.body && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  drawerListeners.forEach((fn) => fn(id, false));
}

export function toggleDrawer(id) {
  if (openDrawer?.id === id) hideDrawer(); else showDrawer(id);
}

export const drawerOpen = () => openDrawer?.id || null;

export function setupDrawers() {
  $("#scrim").addEventListener("click", hideDrawer);
  for (const button of $$(".drawer [data-close]")) button.addEventListener("click", hideDrawer);
  // Keep Tab inside the open drawer.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !openDrawer) return;
    const items = $$("button, input, select, textarea, [tabindex]:not([tabindex='-1'])", openDrawer)
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
  });
}

export function setupTabs(root, onChange) {
  const tabs = $$(".tab", root);
  const select = (name) => {
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    for (const panel of $$("[data-panel]", root)) panel.hidden = panel.dataset.panel !== name;
    onChange?.(name);
  };
  for (const tab of tabs) tab.addEventListener("click", () => select(tab.dataset.tab));
  return select;
}

// ---------- tooltip ----------
export function showTip(x, y, content) {
  const tip = $("#tooltip");
  tip.replaceChildren(...(Array.isArray(content) ? content : [content]));
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.hidden = false;
}
export const hideTip = () => { $("#tooltip").hidden = true; };

// ---------- misc ----------
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { style: { position: "fixed", opacity: "0" } });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function download(name, data, type = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const isTyping = (target) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** Canvas sized for the device pixel ratio; returns a 2D context in CSS pixels. */
export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return null;
  const w = Math.round(width * dpr), hgt = Math.round(height * dpr);
  if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
