// Decision cards. Built once per question set; each response only writes transforms and text.

import { cssVar, fitCanvas, h, hideTip, pct, pretty, showTip, textOf } from "./ui.js";
import { typeLabel } from "./schema.js";

const WINDOW_MS = 60_000;
const seriesVar = (index) => (index < 8 ? `var(--series-${index + 1})` : "var(--series-other)");

export class Cards {
  constructor(root, tracker) {
    this.root = root;
    this.tracker = tracker;
    this.refs = new Map();
    this.colors = {};
    this.refreshColors();
  }

  refreshColors() {
    const colors = { accent: cssVar("--accent"), grid: cssVar("--line"), surface: cssVar("--surface-2"), other: cssVar("--series-other") };
    for (let i = 0; i < 8; i++) colors[i] = cssVar(`--series-${i + 1}`);
    this.colors = colors;
    this.render(performance.now(), true);
  }

  optionColor(index) {
    return index < 8 ? this.colors[index] : this.colors.other;
  }

  build(questions) {
    this.refs.clear();
    const cards = [];
    for (const [id, question] of Object.entries(questions)) {
      const item = this.tracker.item(id);
      const refs = { id, question, item };
      const answerText = h("span", { class: "answer-text placeholder", text: "waiting" });
      const answerConf = h("span", { class: "answer-conf" });
      const swatch = h("span", { class: "answer-swatch", hidden: true });
      const steady = h("span", { class: "steady" });
      Object.assign(refs, { answerText, answerConf, swatch, steady });

      const instruction = textOf(question.instructions ?? id);
      const card = h(
        "article",
        { class: "card stale", dataset: { type: question.type }, "aria-label": pretty(id) },
        h("div", { class: "card-head" },
          h("span", { class: "q-title", text: pretty(id), title: id }),
          h("span", { class: "badge", text: typeLabel[question.type] }),
          steady,
        ),
        h("p", { class: "q-instr", text: instruction, title: instruction }),
        h("div", { class: "answer" }, swatch, answerText, answerConf),
        this.buildViz(question, item, refs),
        this.buildTrend(refs),
      );
      refs.card = card;
      this.refs.set(id, refs);
      cards.push(card);
    }
    if (!cards.length) cards.push(h("div", { class: "cards-empty", text: "No questions yet. Press E to add some." }));
    this.root.replaceChildren(...cards);
    requestAnimationFrame(() => this.render(performance.now(), true));
  }

  buildViz(question, item, refs) {
    if (question.type === "choice") {
      refs.rows = new Map();
      const list = h("ul", { class: "opts", style: item.options.length > 10 ? { maxHeight: "250px", overflowY: "auto" } : undefined });
      item.options.forEach((option, index) => {
        const fill = h("span", { class: "fill" });
        const value = h("span", { class: "pct", text: "–" });
        const description = question.criteria[option.id];
        const row = h(
          "li",
          { class: "opt", style: { "--c": seriesVar(index) }, title: description ? textOf(description) : option.label },
          h("span", { class: "swatch" }),
          h("span", { class: "label", text: option.label }),
          h("span", { class: "track" }, fill),
          value,
        );
        refs.rows.set(option.id, { row, fill, value, index });
        list.append(row);
      });
      return list;
    }
    if (question.type === "noul") {
      refs.meterFill = h("div", { class: "meter-fill" });
      return h("div", { class: "meter-wrap" },
        h("span", { text: "no" }),
        h("div", { class: "meter", role: "img", "aria-label": "probability of yes" }, refs.meterFill, h("div", { class: "meter-mid" })),
        h("span", { text: "yes" }),
      );
    }
    refs.levels = [];
    const bars = h("div", { class: "levels" });
    const axis = h("div", { class: "level-axis" });
    item.options.forEach((option, index) => {
      const bar = h("i");
      const level = h("div", { class: "level", title: `${index} · ${option.label}` }, bar);
      refs.levels.push({ level, bar });
      bars.append(level);
      axis.append(h("span", { text: String(index), title: option.label }));
    });
    refs.marker = h("div", { class: "scale-marker" });
    return h("div", {}, bars, axis, h("div", { class: "scale" }, refs.marker));
  }

  buildTrend(refs) {
    const canvas = h("canvas", { "aria-hidden": "true" });
    refs.canvas = canvas;
    canvas.addEventListener("mousemove", (event) => this.hover(refs, event));
    canvas.addEventListener("mouseleave", hideTip);
    return h("div", { class: "trend-wrap" }, canvas, h("div", { class: "trend-axis" }, h("span", { text: "60 s" }), h("span", { text: "now" })));
  }

  /** Write the latest state into the DOM. Cheap: transforms, text and one small canvas per card. */
  render(now, force = false) {
    for (const refs of this.refs.values()) {
      const view = this.tracker.view(refs.id);
      if (!view) continue;
      const { question, item } = refs;
      if (force || item.updated !== refs.drawnAt) {
        refs.drawnAt = item.updated;
        refs.card.classList.remove("stale");
        refs.answerText.classList.remove("placeholder");
        if (question.type === "choice") this.renderChoice(refs, view);
        else if (question.type === "noul") this.renderNoul(refs, view);
        else this.renderScore(refs, view);
        this.drawTrend(refs, now);
      }
      const held = (now - item.since) / 1000;
      refs.steady.textContent = `steady ${held < 10 ? held.toFixed(1) : Math.round(held)} s`;
    }
  }

  renderChoice(refs, view) {
    const winner = refs.rows.get(view.key);
    setText(refs.answerText, view.label);
    setText(refs.answerConf, pct(view.confidence));
    refs.swatch.hidden = false;
    refs.swatch.style.background = seriesVar(winner.index);
    for (const [id, entry] of refs.rows) {
      const p = view.probs[id] ?? 0;
      entry.fill.style.transform = `scaleX(${p.toFixed(4)})`;
      setText(entry.value, pct(p));
      entry.row.classList.toggle("top", id === view.key);
    }
  }

  renderNoul(refs, view) {
    setText(refs.answerText, view.label);
    refs.answerText.classList.toggle("yes", view.key === "true");
    refs.answerText.classList.toggle("no", view.key !== "true");
    setText(refs.answerConf, `P(yes) ${pct(view.yes)}`);
    refs.meterFill.style.transform = `scaleX(${view.yes.toFixed(4)})`;
  }

  renderScore(refs, view) {
    setText(refs.answerText, view.label);
    setText(refs.answerConf, `${view.expected.toFixed(2)} of ${view.levels - 1}`);
    refs.levels.forEach(({ level, bar }, index) => {
      const p = view.probs[String(index)] ?? 0;
      bar.style.transform = `scaleY(${Math.max(0.02, p).toFixed(4)})`;
      level.classList.toggle("top", String(index) === view.key);
    });
    refs.marker.style.left = `${(view.value * 100).toFixed(2)}%`;
  }

  drawTrend(refs, now) {
    if (this.root.classList.contains("compact")) return;
    const fitted = fitCanvas(refs.canvas);
    if (!fitted) return;
    const { ctx, width, height } = fitted;
    const history = refs.item.history;
    if (!history.length) return;
    const start = now - WINDOW_MS;
    const x = (t) => ((t - start) / WINDOW_MS) * width;

    if (refs.question.type === "choice") {
      // Ribbon: which option was winning, faded by how sure the model was.
      const top = 7, band = height - 14;
      for (let i = 0; i < history.length; i++) {
        const sample = history[i];
        const next = history[i + 1];
        const x0 = Math.max(0, x(sample.t));
        const x1 = next ? x(next.t) : width;
        if (x1 <= 0) continue;
        const entry = refs.rows.get(sample.key);
        ctx.globalAlpha = 0.3 + 0.7 * sample.confidence;
        ctx.fillStyle = this.optionColor(entry ? entry.index : 8);
        ctx.fillRect(x0, top, Math.max(1, x1 - x0), band);
      }
      ctx.globalAlpha = 1;
      return;
    }

    const y = (v) => height - 3 - v * (height - 6);
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y(0.5)) + 0.5);
    ctx.lineTo(width, Math.round(y(0.5)) + 0.5);
    ctx.stroke();

    const points = history.filter((s) => s.t >= start - 2000);
    if (!points.length) return;
    ctx.beginPath();
    points.forEach((s, i) => (i ? ctx.lineTo(x(s.t), y(s.value)) : ctx.moveTo(x(s.t), y(s.value))));
    ctx.lineTo(width, y(points[points.length - 1].value));
    const line = new Path2D();
    points.forEach((s, i) => (i ? line.lineTo(x(s.t), y(s.value)) : line.moveTo(x(s.t), y(s.value))));
    line.lineTo(width, y(points[points.length - 1].value));
    ctx.lineTo(width, height);
    ctx.lineTo(Math.max(0, x(points[0].t)), height);
    ctx.closePath();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = this.colors.accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.colors.accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(line);
    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(width - 4, y(last.value), 4, 0, Math.PI * 2);
    ctx.fillStyle = this.colors.accent;
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.colors.surface;
    ctx.fill();
    ctx.stroke();
  }

  hover(refs, event) {
    const history = refs.item.history;
    if (!history.length) return;
    const rect = refs.canvas.getBoundingClientRect();
    const now = performance.now();
    const t = now - WINDOW_MS + ((event.clientX - rect.left) / rect.width) * WINDOW_MS;
    let sample = null;
    for (const s of history) {
      if (s.t <= t) sample = s; else break;
    }
    if (!sample) { hideTip(); return; }
    const ago = Math.max(0, (now - sample.t) / 1000);
    const option = refs.item.options.find((o) => o.id === sample.key);
    let text;
    if (refs.question.type === "noul") text = `P(yes) ${pct(sample.value)}`;
    else if (refs.question.type === "score") text = `${option?.label ?? sample.key} · ${(sample.value * (refs.item.options.length - 1)).toFixed(2)}`;
    else text = `${option?.label ?? sample.key} · ${pct(sample.confidence)}`;
    showTip(event.clientX, rect.top, [h("span", { class: "muted", text: `${ago.toFixed(1)} s ago · ` }), h("b", { text })]);
  }

  markStale(stale) {
    for (const refs of this.refs.values()) refs.card.classList.toggle("stale", stale || !refs.item.probs);
  }

  /** [{id, label, confidence}] for snapshots. */
  summary() {
    const rows = [];
    for (const refs of this.refs.values()) {
      const view = this.tracker.view(refs.id);
      if (view) rows.push({ id: refs.id, label: view.label, confidence: view.confidence, type: refs.question.type, yes: view.yes });
    }
    return rows;
  }
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

