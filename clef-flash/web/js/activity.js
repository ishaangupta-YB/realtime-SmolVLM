// Activity log (triggers, answer changes, errors) and a recording of every decision for CSV export.

import { clock, download, h, icon } from "./ui.js";

const MAX_ENTRIES = 120;
const MAX_RECORDS = 20_000;
const KIND_ICON = { rule: "bolt", change: "dot", error: "warn", info: "info" };

export class Activity {
  constructor(list, meta) {
    this.list = list;
    this.meta = meta;
    this.entries = [];
    this.records = [];
    this.decisions = 0;
    this.render();
  }

  add(kind, message, thumbnail) {
    this.entries.unshift({ t: Date.now(), kind, message, thumbnail });
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.list.prepend(this.row(this.entries[0]));
    this.list.querySelector(".log-empty")?.remove();
    while (this.list.children.length > MAX_ENTRIES) this.list.lastElementChild.remove();
  }

  row(entry) {
    const message = h("span", { class: "msg", title: typeof entry.message === "string" ? entry.message : "" });
    if (typeof entry.message === "string") message.textContent = entry.message;
    else message.append(...entry.message);
    return h("li", { dataset: { kind: entry.kind } },
      h("time", { text: clock(entry.t) }),
      (() => { const s = icon(KIND_ICON[entry.kind] || "info"); s.classList.add("kind"); return s; })(),
      message,
      entry.thumbnail ? h("img", { src: entry.thumbnail, alt: "frame when it fired" }) : h("span"),
    );
  }

  render() {
    if (!this.entries.length) {
      this.list.replaceChildren(h("li", { class: "log-empty", text: "Nothing yet. Triggers you set up (G) land here, with the frame that fired them." }));
      return;
    }
    this.list.replaceChildren(...this.entries.map((entry) => this.row(entry)));
  }

  clear() {
    this.entries = [];
    this.records = [];
    this.decisions = 0;
    this.updateMeta();
    this.render();
  }

  /** Keep one row per answer for export. */
  record(seq, answers, timing) {
    const t = new Date().toISOString();
    this.decisions++;
    for (const [id, answer] of Object.entries(answers || {})) {
      let value, confidence;
      if (answer.type === "noul") { value = answer.noul >= 0.5 ? "true" : "false"; confidence = Math.max(answer.noul, 1 - answer.noul); }
      else if (answer.type === "choice") { value = answer.choice; confidence = answer.confidence; }
      else { value = answer.score; confidence = answer.confidence; }
      this.records.push([t, seq, id, answer.type, value, confidence, timing?.model_ms ?? ""]);
    }
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    if (this.decisions % 10 === 1) this.updateMeta();
  }

  updateMeta() {
    this.meta.textContent = this.decisions ? `${this.decisions.toLocaleString()} decisions recorded` : "triggers and events";
  }

  exportCsv() {
    const escape = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [["time", "seq", "question", "type", "answer", "confidence", "model_ms"], ...this.records].map((r) => r.map(escape).join(","));
    download(`clef-decisions-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`, lines.join("\n"), "text/csv");
    return this.records.length;
  }
}
