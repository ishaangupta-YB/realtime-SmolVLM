// Per-question state derived from raw answers: smoothing, the current winner, how long it has
// held, and a short history for the trend strips. Cards render from it and triggers read it.

import { optionsOf } from "./schema.js";

const HISTORY_MS = 90_000;

function rawProbabilities(question, answer) {
  if (!answer) return null;
  if (question.type === "noul") {
    const p = Number(answer.noul);
    return Number.isFinite(p) ? { true: p, false: 1 - p } : null;
  }
  return answer.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : null;
}

export class Tracker {
  constructor() {
    this.questions = {};
    this.items = new Map();
    this.alpha = 1;
  }

  reset(questions) {
    this.questions = questions;
    this.items = new Map(
      Object.entries(questions).map(([id, question]) => [
        id,
        { id, question, options: optionsOf(question), probs: null, raw: null, key: null, since: 0, history: [], updated: 0 },
      ]),
    );
  }

  setSmoothing(alpha) {
    this.alpha = alpha;
  }

  /** Fold one response into the state. Returns [{id, from, to}] for questions whose answer changed. */
  ingest(answers, now = performance.now()) {
    const changes = [];
    for (const item of this.items.values()) {
      const raw = rawProbabilities(item.question, answers?.[item.id]);
      if (!raw) continue;
      const probs = {};
      for (const option of item.options) {
        const p = Number(raw[option.id]) || 0;
        const previous = item.probs?.[option.id];
        probs[option.id] = previous === undefined ? p : previous + this.alpha * (p - previous);
      }
      item.raw = raw;
      item.probs = probs;
      item.updated = now;
      const view = this.view(item.id);
      if (view.key !== item.key) {
        if (item.key !== null) changes.push({ id: item.id, from: item.key, to: view.key, view });
        item.key = view.key;
        item.since = now;
      }
      item.history.push({ t: now, key: view.key, value: view.value, confidence: view.confidence });
      while (item.history.length && now - item.history[0].t > HISTORY_MS) item.history.shift();
    }
    return changes;
  }

  /**
   * The derived answer for one question:
   *  key        winning option id (noul: "true"/"false", score: nearest level)
   *  label      human text for the winner
   *  confidence probability of the winner
   *  value      0..1 for the trend line (noul: P(yes), score: position on the scale, choice: confidence)
   */
  view(id) {
    const item = this.items.get(id);
    if (!item?.probs) return null;
    const { question, options, probs } = item;
    if (question.type === "noul") {
      const yes = probs.true;
      return { key: yes >= 0.5 ? "true" : "false", label: yes >= 0.5 ? "Yes" : "No", confidence: Math.max(yes, 1 - yes), value: yes, yes, probs };
    }
    if (question.type === "score") {
      const levels = options.length;
      const total = options.reduce((sum, o) => sum + probs[o.id], 0) || 1;
      const expected = options.reduce((sum, o, i) => sum + (i * probs[o.id]) / total, 0);
      const nearest = Math.min(levels - 1, Math.max(0, Math.round(expected)));
      return {
        key: String(nearest),
        label: options[nearest].label,
        confidence: probs[String(nearest)] / total,
        value: levels > 1 ? expected / (levels - 1) : 0,
        expected,
        levels,
        probs,
      };
    }
    let best = options[0];
    for (const option of options) if (probs[option.id] > probs[best.id]) best = option;
    return { key: best.id, label: best.label, confidence: probs[best.id], value: probs[best.id], probs };
  }

  item(id) {
    return this.items.get(id);
  }
}
