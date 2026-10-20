// Triggers: "when <question> is <answer> (with at least p) for t seconds, do X".
// They fire once per episode: the condition has to break before the same trigger fires again.

import { h, clock, icon, pct, pretty, store } from "./ui.js";
import { optionsOf } from "./schema.js";

const HOLDS = [0, 0.5, 1, 2, 3, 5, 10];
const COOLDOWNS = [0, 5, 10, 30, 60, 300];
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
const ACTIONS = [
  ["toast", "Notify"],
  ["sound", "Chime"],
  ["speak", "Speak"],
  ["snapshot", "Snapshot"],
];

const uid = () => Math.random().toString(36).slice(2, 9);

export class Rules {
  constructor({ list, onFire, onChange }) {
    this.list = list;
    this.onFire = onFire;
    this.onChange = onChange;
    this.rules = store.get("rules", []);
    this.runtime = new Map();
    this.questions = {};
  }

  setQuestions(questions) {
    this.questions = questions;
    this.runtime.clear();
    this.renderList();
  }

  save() {
    store.set("rules", this.rules);
    this.onChange?.(this.rules);
  }

  add() {
    const [id, question] = Object.entries(this.questions)[0] || [];
    if (!id) return null;
    const rule = {
      id: uid(),
      enabled: true,
      question: id,
      option: question.type === "score" ? "at_least" : optionsOf(question)[0].id,
      threshold: question.type === "score" ? Math.max(1, optionsOf(question).length - 1) : 0.7,
      hold: 1,
      cooldown: 10,
      actions: { toast: true, sound: true, speak: false, snapshot: false },
    };
    this.rules.push(rule);
    this.save();
    this.renderList();
    return rule;
  }

  /** Check every rule against the tracker; called once per decision. */
  evaluate(tracker, now) {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const view = tracker.view(rule.question);
      const question = this.questions[rule.question];
      if (!view || !question) continue;
      const state = this.runtime.get(rule.id) || { since: null, armed: true, last: -Infinity };
      this.runtime.set(rule.id, state);
      const holds = this.holds(rule, question, view);
      if (!holds) {
        state.since = null;
        state.armed = true;
        continue;
      }
      state.since ??= now;
      if (state.armed && now - state.since >= rule.hold * 1000 && now - state.last >= rule.cooldown * 1000) {
        state.armed = false;
        state.last = now;
        rule.lastFired = Date.now();
        this.onFire(rule, this.describe(rule), view);
        this.updateFired(rule);
      }
    }
  }

  holds(rule, question, view) {
    if (question.type === "score") {
      return rule.option === "at_most" ? view.expected <= rule.threshold : view.expected >= rule.threshold;
    }
    const p = view.probs[rule.option];
    return p !== undefined && p >= rule.threshold;
  }

  describe(rule) {
    const question = this.questions[rule.question];
    if (!question) return `${pretty(rule.question)} (missing question)`;
    if (question.type === "score") {
      const level = optionsOf(question)[Math.round(rule.threshold)]?.label;
      return `${pretty(rule.question)} ${rule.option === "at_most" ? "≤" : "≥"} ${rule.threshold}${level ? ` (${level})` : ""}`;
    }
    const option = optionsOf(question).find((o) => o.id === rule.option);
    return `${pretty(rule.question)} is ${option ? option.label : rule.option} (≥ ${pct(rule.threshold)})`;
  }

  // ---------- UI ----------
  renderList() {
    if (!this.list) return;
    if (!this.rules.length) {
      this.list.replaceChildren(
        h("div", { class: "cards-empty" },
          h("b", { text: "No triggers yet" }),
          h("span", { class: "hint", text: "Example: when activity is on phone for 3 s, chime and log a snapshot." }),
        ),
      );
      return;
    }
    this.list.replaceChildren(...this.rules.map((rule) => this.renderRule(rule)));
  }

  renderRule(rule) {
    const question = this.questions[rule.question];
    const update = (patch, rerender = false) => {
      Object.assign(rule, patch);
      this.runtime.delete(rule.id);
      this.save();
      if (rerender) this.renderList();
      else summary.replaceChildren(...this.summaryNodes(rule));
    };

    const questionSelect = select(
      Object.keys(this.questions).map((id) => [id, pretty(id)]).concat(question ? [] : [[rule.question, `${pretty(rule.question)} (missing)`]]),
      rule.question,
      (value) => {
        const q = this.questions[value];
        update({
          question: value,
          option: q.type === "score" ? "at_least" : optionsOf(q)[0].id,
          threshold: q.type === "score" ? Math.max(1, optionsOf(q).length - 1) : 0.7,
        }, true);
      },
    );

    let answerSelect, thresholdControl;
    if (question?.type === "score") {
      answerSelect = select([["at_least", "at least"], ["at_most", "at most"]], rule.option, (v) => update({ option: v }));
      thresholdControl = h("input", {
        class: "input", type: "number", min: 0, max: optionsOf(question).length - 1, step: 0.25, value: rule.threshold,
        on: { change: (e) => update({ threshold: Number(e.target.value) || 0 }) },
      });
    } else {
      const options = question ? optionsOf(question).map((o) => [o.id, o.label]) : [[rule.option, rule.option]];
      answerSelect = select(options, rule.option, (v) => update({ option: v }));
      thresholdControl = select(THRESHOLDS.map((t) => [String(t), `≥ ${pct(t)}`]), String(rule.threshold), (v) => update({ threshold: Number(v) }));
    }

    const summary = h("p", { class: "rule-summary" }, ...this.summaryNodes(rule));
    const fired = h("span", { class: "rule-fired", dataset: { rule: rule.id }, text: rule.lastFired ? `last fired ${clock(rule.lastFired)}` : "not fired yet" });

    return h("div", { class: `rule${rule.enabled ? "" : " off"}` },
      h("div", { class: "row", style: { marginBottom: "8px" } },
        h("label", { class: "toggle" },
          h("input", { type: "checkbox", checked: rule.enabled, on: { change: (e) => update({ enabled: e.target.checked }, true) } }),
          "enabled"),
        fired,
        h("button", { class: "mini", title: "Delete trigger", "aria-label": "Delete trigger", on: { click: () => this.remove(rule.id) } }, icon("trash")),
      ),
      summary,
      h("div", { class: "rule-grid" },
        h("label", {}, "Question", questionSelect),
        h("label", {}, question?.type === "score" ? "Score is" : "Answer", answerSelect),
        h("label", {}, question?.type === "score" ? "Level" : "Probability", thresholdControl),
        h("label", {}, "Hold for", select(HOLDS.map((s) => [String(s), s ? `${s} s` : "instantly"]), String(rule.hold), (v) => update({ hold: Number(v) }))),
        h("label", {}, "Then wait", select(COOLDOWNS.map((s) => [String(s), s ? `${s} s before refiring` : "no cooldown"]), String(rule.cooldown), (v) => update({ cooldown: Number(v) }))),
      ),
      h("div", { class: "rule-actions" },
        ...ACTIONS.map(([key, label]) =>
          h("label", { class: "toggle" },
            h("input", { type: "checkbox", checked: !!rule.actions[key], on: { change: (e) => update({ actions: { ...rule.actions, [key]: e.target.checked } }) } }),
            label)),
      ),
    );
  }

  summaryNodes(rule) {
    const actions = ACTIONS.filter(([key]) => rule.actions[key]).map(([, label]) => label.toLowerCase());
    return [
      "When ", h("b", { text: this.describe(rule) }),
      rule.hold ? ` for ${rule.hold} s` : "",
      " → ", h("b", { text: actions.length ? actions.join(", ") : "log only" }),
    ];
  }

  updateFired(rule) {
    const node = this.list?.querySelector(`[data-rule="${rule.id}"]`);
    if (node) node.textContent = `last fired ${clock(rule.lastFired)}`;
    store.set("rules", this.rules);
  }

  remove(id) {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.runtime.delete(id);
    this.save();
    this.renderList();
  }
}

function select(options, value, onChange) {
  const node = h("select", { class: "select", on: { change: (e) => onChange(e.target.value) } },
    ...options.map(([v, label]) => h("option", { value: v, text: label })));
  node.value = value;
  return node;
}

