// Question editor: a form builder, raw JSON, and a library of presets and saved sets.
// Edits stay in a draft until applied; the server validates again before using them.

import { $, $$, copyText, download, h, icon, pretty, setupTabs, store, textOf, toast } from "./ui.js";
import { estimateTokens, validateQuestions } from "./schema.js";
import { PRESETS, clone } from "./presets.js";

const ID_PATTERN = /^[A-Za-z0-9_.\-]{1,100}$/;

// ---- draft model <-> SystemOne questions ----
function parseLoose(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^[{[]/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch { /* plain text */ }
  }
  return trimmed;
}
const showValue = (value) => (value === null || value === undefined ? "" : textOf(value));

function toDraft(questions) {
  return Object.entries(questions).map(([id, q]) => ({
    id,
    type: q.type,
    instructions: showValue(q.instructions),
    options: q.type === "choice" ? Object.entries(q.criteria || {}).map(([oid, d]) => ({ id: oid, desc: showValue(d) })) : [],
    levels: q.type === "score" ? (q.criteria || []).map(showValue) : [],
    yes: q.type === "noul" ? showValue(q.criteria?.true) : "",
    no: q.type === "noul" ? showValue(q.criteria?.false) : "",
  }));
}

function fromDraft(draft) {
  const questions = {};
  for (const item of draft) {
    const q = { type: item.type };
    const instructions = parseLoose(item.instructions);
    if (instructions !== null) q.instructions = instructions;
    if (item.type === "choice") {
      q.criteria = {};
      for (const option of item.options) q.criteria[option.id.trim()] = parseLoose(option.desc);
    } else if (item.type === "score") {
      q.criteria = item.levels.map((level) => parseLoose(level) ?? "");
    } else {
      const yes = parseLoose(item.yes), no = parseLoose(item.no);
      if (yes !== null || no !== null) {
        q.criteria = {};
        if (yes !== null) q.criteria.true = yes;
        if (no !== null) q.criteria.false = no;
      }
    }
    questions[item.id.trim()] = q;
  }
  return questions;
}

function draftErrors(draft) {
  const errors = new Map();
  const seen = new Set();
  draft.forEach((item, index) => {
    const add = (message) => { if (!errors.has(index)) errors.set(index, message); };
    const id = item.id.trim();
    if (!ID_PATTERN.test(id)) add("Id: letters, digits, _ . - only");
    else if (seen.has(id)) add("Another question already uses this id");
    seen.add(id);
    if (item.type === "choice") {
      const ids = item.options.map((o) => o.id.trim());
      if (ids.length < 2) add("A choice needs at least 2 options");
      else if (ids.some((o) => !o)) add("Every option needs an id");
      else if (new Set(ids).size !== ids.length) add("Option ids must be unique");
    }
    if (item.type === "score") {
      if (item.levels.length < 2 || item.levels.length > 10) add("A score needs 2 to 10 levels");
      else if (item.levels.some((l) => !l.trim())) add("Every level needs a description");
    }
  });
  return errors;
}

const newQuestion = (draft) => {
  let n = draft.length + 1;
  while (draft.some((q) => q.id === `question_${n}`)) n++;
  return { id: `question_${n}`, type: "noul", instructions: "", options: [{ id: "first", desc: "" }, { id: "second", desc: "" }], levels: ["low", "medium", "high"], yes: "", no: "" };
};

export class Editor {
  constructor({ getApplied, apply, getState }) {
    this.getApplied = getApplied; // () => questions
    this.apply = apply; // async (questions, {state, source}) => {ok, errors}
    this.getState = getState; // () => current context
    this.draft = [];
    this.tab = "builder";
    this.builder = $("#builder");
    this.json = $("#jsonEditor");
    this.msg = $("#editorMsg");
    this.applyBtn = $("#editorApply");
    this.selectTab = setupTabs($("#editorDrawer"), (name) => this.switchTab(name));

    $("#addQuestion").addEventListener("click", () => {
      this.draft.push(newQuestion(this.draft));
      this.renderBuilder();
      $$(".qblock .input", this.builder).at(-3)?.focus();
    });
    this.applyBtn.addEventListener("click", () => this.commit());
    $("#editorRevert").addEventListener("click", () => this.load(this.getApplied()));
    this.json.addEventListener("input", () => this.checkJson());
    this.json.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); document.execCommand("insertText", false, "  "); }
    });
    $("#jsonFormat").addEventListener("click", () => {
      const parsed = this.parseJson();
      if (parsed) { this.json.value = JSON.stringify(parsed, null, 2); this.checkJson(); }
    });
    $("#jsonCopy").addEventListener("click", async () => toast((await copyText(this.json.value)) ? "Questions copied" : "Copy failed", { kind: "ok" }));
    $("#jsonExport").addEventListener("click", () => download("clef-questions.json", this.json.value || JSON.stringify(this.currentQuestions(), null, 2), "application/json"));
    $("#jsonImport").addEventListener("click", () => $("#jsonFile").click());
    $("#jsonFile").addEventListener("change", async (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      if (!file) return;
      const text = await file.text();
      this.selectTab("json");
      this.json.value = text;
      this.checkJson();
    });
    $("#jsonShare").addEventListener("click", async () => {
      const questions = this.currentQuestions();
      if (!questions) return;
      const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ questions, state: this.getState() }))))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const url = `${location.origin}${location.pathname}#set=${payload}`;
      toast((await copyText(url)) ? "Share link copied. It opens with these questions." : "Copy failed", { kind: "ok" });
    });
    $("#saveSet").addEventListener("click", () => this.saveCurrent());
    $("#saveName").addEventListener("keydown", (e) => { if (e.key === "Enter") this.saveCurrent(); });
    this.renderPresets();
    this.renderSaved();
  }

  /** Called when the drawer opens. */
  open() {
    this.load(this.getApplied());
  }

  load(questions) {
    this.draft = toDraft(clone(questions));
    this.json.value = JSON.stringify(questions, null, 2);
    if (this.tab === "json") this.checkJson(); else this.renderBuilder();
    this.status();
  }

  switchTab(name) {
    const previous = this.tab;
    if (previous === "json" && name !== "json") {
      const parsed = this.parseJson();
      if (parsed && !validateQuestions(parsed).length) this.draft = toDraft(parsed);
      else if (name === "builder") {
        this.tab = "json";
        this.selectTab("json");
        this.setMsg("Fix the JSON before switching to the builder", "error");
        return;
      }
    }
    if (previous === "builder" && name === "json") this.json.value = JSON.stringify(fromDraft(this.draft), null, 2);
    this.tab = name;
    if (name === "builder") this.renderBuilder();
    if (name === "json") this.checkJson();
    if (name === "library") this.renderSaved();
    this.status();
  }

  currentQuestions() {
    if (this.tab === "json") return this.parseJson();
    return fromDraft(this.draft);
  }

  parseJson() {
    try {
      const value = JSON.parse(this.json.value);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }

  checkJson() {
    const list = $("#jsonErrors");
    let errors;
    let parsed;
    try { parsed = JSON.parse(this.json.value); } catch (e) { errors = [{ path: "JSON", message: e.message }]; }
    if (!errors) errors = validateQuestions(parsed);
    this.json.classList.toggle("invalid", errors.length > 0);
    list.replaceChildren(...errors.slice(0, 6).map((e) => h("li", {}, h("code", { text: e.path }), ` ${e.message}`)));
    this.status(errors.length ? errors : null);
  }

  status(jsonErrors) {
    if (this.tab === "library") { this.applyBtn.disabled = true; this.setMsg("Pick a set to apply it"); return; }
    const questions = this.currentQuestions();
    const errors = jsonErrors ?? (this.tab === "builder" ? [...draftErrors(this.draft).values()] : null) ?? [];
    const invalid = !questions || errors.length > 0 || validateQuestions(questions || {}).length > 0;
    this.applyBtn.disabled = invalid;
    if (invalid) {
      this.setMsg(errors.length ? `${errors.length} problem${errors.length > 1 ? "s" : ""} to fix` : "Not valid yet", "error");
      return;
    }
    const n = Object.keys(questions).length;
    this.setMsg(`${n} question${n === 1 ? "" : "s"} · about ${estimateTokens(questions, this.getState())} prompt tokens plus the image`);
  }

  setMsg(text, kind = "") {
    this.msg.textContent = text;
    this.msg.className = `msg ${kind}`;
  }

  async commit() {
    const questions = this.currentQuestions();
    if (!questions || this.applyBtn.disabled) return;
    this.applyBtn.disabled = true;
    const result = await this.apply(questions);
    this.applyBtn.disabled = false;
    if (result.ok) {
      this.setMsg("Applied", "ok");
      this.load(questions);
    } else {
      this.setMsg(result.errors?.map((e) => `${e.path}: ${e.message}`).join(" · ") || "The server rejected these questions", "error");
    }
    return result.ok;
  }

  // ---------- builder ----------
  renderBuilder() {
    const errors = draftErrors(this.draft);
    this.builder.replaceChildren(...this.draft.map((item, index) => this.renderBlock(item, index, errors.get(index))));
    this.status();
  }

  renderBlock(item, index, error) {
    const changed = (rerender = false) => {
      if (rerender) this.renderBuilder();
      else {
        const errors = draftErrors(this.draft);
        const block = this.builder.children[index];
        block?.classList.toggle("invalid", errors.has(index));
        const slot = block?.querySelector(".qerr");
        if (slot) { slot.textContent = errors.get(index) || ""; slot.hidden = !errors.has(index); }
        this.status();
      }
    };
    const input = (value, placeholder, onInput, extra = {}) =>
      h("input", { class: "input", value, placeholder, spellcheck: false, ...extra, on: { input: (e) => { onInput(e.target.value); changed(); } } });

    const move = (delta) => {
      const target = index + delta;
      if (target < 0 || target >= this.draft.length) return;
      [this.draft[index], this.draft[target]] = [this.draft[target], this.draft[index]];
      changed(true);
    };
    const head = h("div", { class: "qblock-head" },
      h("span", { class: "num", text: String(index + 1) }),
      input(item.id, "question_id", (v) => (item.id = v), { class: "input grow", "aria-label": "Question id" }),
      h("div", { class: "types", role: "group", "aria-label": "Type" },
        ...[["noul", "Yes / no"], ["choice", "Choice"], ["score", "Score"]].map(([type, label]) =>
          h("button", { "aria-pressed": String(item.type === type), text: label, on: { click: () => { item.type = type; changed(true); } } }))),
      h("button", { class: "mini", title: "Move up", "aria-label": "Move up", on: { click: () => move(-1) } }, icon("up")),
      h("button", { class: "mini", title: "Move down", "aria-label": "Move down", on: { click: () => move(1) } }, icon("down")),
      h("button", { class: "mini", title: "Duplicate", "aria-label": "Duplicate", on: { click: () => { const copy = clone(item); copy.id = `${item.id}_copy`; this.draft.splice(index + 1, 0, copy); changed(true); } } }, icon("copyplus")),
      h("button", { class: "mini", title: "Delete", "aria-label": "Delete question", on: { click: () => { this.draft.splice(index, 1); changed(true); } } }, icon("trash")),
    );

    const body = h("div", { class: "qblock-body" },
      h("p", { class: "qerr", text: error || "", hidden: !error }),
      h("label", { class: "field" }, h("span", { text: "Instruction" }),
        input(item.instructions, `Defaults to "${pretty(item.id) || "the id"}"`, (v) => (item.instructions = v))),
    );

    if (item.type === "choice") {
      const list = h("div", { class: "optlist" });
      item.options.forEach((option, i) => {
        list.append(h("div", { class: "optrow" },
          h("span", { class: "idx", text: String(i + 1) }),
          input(option.id, "option_id", (v) => (option.id = v), { "aria-label": "Option id" }),
          input(option.desc, "description (optional)", (v) => (option.desc = v), { class: "input desc", "aria-label": "Option description" }),
          h("button", { class: "mini", title: "Remove option", "aria-label": "Remove option", on: { click: () => { item.options.splice(i, 1); changed(true); } } }, icon("close")),
        ));
      });
      body.append(h("div", { class: "field" }, h("span", { class: "field-label", text: "Options" }), list,
        h("div", { class: "row" },
          h("button", { class: "btn small", on: { click: () => { item.options.push({ id: `option_${item.options.length + 1}`, desc: "" }); changed(true); } } }, icon("plus"), "Option"),
          h("small", { class: "hint", text: "Leave descriptions empty to keep prompts short." }))));
    } else if (item.type === "score") {
      const list = h("div", { class: "optlist" });
      item.levels.forEach((level, i) => {
        list.append(h("div", { class: "optrow", style: { gridTemplateColumns: "22px minmax(0,1fr) auto auto" } },
          h("span", { class: "idx", text: String(i) }),
          input(level, `level ${i}`, (v) => (item.levels[i] = v), { "aria-label": `Level ${i}` }),
          h("button", { class: "mini", title: "Move up", "aria-label": "Move level up", on: { click: () => { if (i) { [item.levels[i - 1], item.levels[i]] = [item.levels[i], item.levels[i - 1]]; changed(true); } } } }, icon("up")),
          h("button", { class: "mini", title: "Remove level", "aria-label": "Remove level", on: { click: () => { item.levels.splice(i, 1); changed(true); } } }, icon("close")),
        ));
      });
      body.append(h("div", { class: "field" }, h("span", { class: "field-label", text: "Levels, lowest first" }), list,
        h("button", { class: "btn small", style: { justifySelf: "start" }, on: { click: () => { item.levels.push(""); changed(true); } } }, icon("plus"), "Level")));
    } else {
      body.append(h("div", { class: "field" }, h("span", { class: "field-label", text: "What yes and no mean (optional)" }),
        h("div", { class: "row" },
          input(item.yes, "yes means…", (v) => (item.yes = v), { class: "input grow" }),
          input(item.no, "no means…", (v) => (item.no = v), { class: "input grow" }))));
    }
    return h("div", { class: `qblock${error ? " invalid" : ""}` }, head, body);
  }

  // ---------- library ----------
  renderPresets() {
    $("#presetGrid").replaceChildren(...PRESETS.map((preset) =>
      h("button", { class: "preset", on: { click: () => this.usePreset(preset) } },
        h("b", { text: preset.name }),
        h("span", { text: preset.blurb }),
        h("span", { class: "meta", text: `${Object.keys(preset.questions).length} questions${preset.source === "text" ? " · text state" : ""}` }))));
  }

  async usePreset(preset) {
    const result = await this.apply(clone(preset.questions), { state: preset.state, source: preset.source, presetId: preset.id });
    if (result.ok) toast(`Loaded “${preset.name}”`, { kind: "ok" });
  }

  saveCurrent() {
    const name = $("#saveName").value.trim() || `Set ${new Date().toLocaleString()}`;
    const saved = store.get("saved", []);
    saved.unshift({ name, questions: this.getApplied(), state: this.getState(), at: Date.now() });
    store.set("saved", saved.slice(0, 50));
    $("#saveName").value = "";
    this.renderSaved();
    toast(`Saved “${name}”`, { kind: "ok" });
  }

  renderSaved() {
    const saved = store.get("saved", []);
    const list = $("#savedList");
    if (!saved.length) {
      list.replaceChildren(h("p", { class: "hint", text: "Sets you save live in this browser." }));
      return;
    }
    list.replaceChildren(...saved.map((set, index) =>
      h("div", { class: "saved-row" },
        h("b", { text: set.name, title: set.name }),
        h("span", { class: "hint", text: `${Object.keys(set.questions || {}).length} q` }),
        h("button", { class: "btn small", text: "Use", on: { click: async () => { const r = await this.apply(clone(set.questions), { state: set.state }); if (r.ok) toast(`Loaded “${set.name}”`, { kind: "ok" }); } } }),
        h("button", { class: "mini", title: "Delete", "aria-label": `Delete ${set.name}`, on: { click: () => { const all = store.get("saved", []); all.splice(index, 1); store.set("saved", all); this.renderSaved(); } } }, icon("trash")),
      )));
  }
}

/** Read a set shared through the URL (#set=...), if any. */
export function readSharedSet() {
  const match = location.hash.match(/#set=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  try {
    const base64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const value = JSON.parse(decodeURIComponent(escape(atob(base64))));
    if (value?.questions && !validateQuestions(value.questions).length) return value;
  } catch { /* ignore a malformed link */ }
  return null;
}
