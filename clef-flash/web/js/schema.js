// SystemOne question schema: validation (same rules as the server) and option listing.

import { pretty, textOf } from "./ui.js";

const ID = /^[A-Za-z0-9_.\-]{1,100}$/;
const hasText = (v) => (typeof v === "string" ? v.trim().length > 0 : v !== null && v !== undefined && JSON.stringify(v) !== "{}" && JSON.stringify(v) !== "[]");

/** Returns [{path, message}] — empty when the questions are valid. */
export function validateQuestions(questions) {
  const errors = [];
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || !Object.keys(questions).length) {
    return [{ path: "questions", message: "must be an object with at least one question" }];
  }
  const ids = Object.keys(questions);
  if (ids.length > 64) errors.push({ path: "questions", message: `at most 64 questions, got ${ids.length}` });
  for (const id of ids) {
    const q = questions[id];
    const path = `questions.${id}`;
    if (!ID.test(id)) { errors.push({ path, message: "id may only use letters, digits, '_', '.' and '-'" }); continue; }
    if (!q || typeof q !== "object" || Array.isArray(q)) { errors.push({ path, message: "must be an object" }); continue; }
    if (!["noul", "choice", "score"].includes(q.type)) { errors.push({ path: `${path}.type`, message: "must be noul, choice or score" }); continue; }
    if (q.instructions !== undefined && q.instructions !== null && typeof q.instructions !== "string" && !hasText(q.instructions)) {
      errors.push({ path: `${path}.instructions`, message: "must be a non-empty string, object or array" });
    }
    const c = q.criteria;
    if (q.type === "noul") {
      if (c !== undefined && c !== null && (typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((k) => k !== "true" && k !== "false"))) {
        errors.push({ path: `${path}.criteria`, message: "for noul, an object with only 'true' and/or 'false'" });
      }
    } else if (q.type === "choice") {
      if (!c || typeof c !== "object" || Array.isArray(c)) errors.push({ path: `${path}.criteria`, message: "for choice, an object mapping option id to description or null" });
      else {
        const keys = Object.keys(c);
        if (keys.length < 2 || keys.length > 255) errors.push({ path: `${path}.criteria`, message: `needs 2 to 255 options, got ${keys.length}` });
        else if (keys.some((k) => !k.trim())) errors.push({ path: `${path}.criteria`, message: "option ids must be non-empty" });
      }
    } else {
      if (!Array.isArray(c)) errors.push({ path: `${path}.criteria`, message: "for score, a list of level descriptions, lowest first" });
      else if (c.length < 2 || c.length > 10) errors.push({ path: `${path}.criteria`, message: `needs 2 to 10 levels, got ${c.length}` });
      else if (!c.every(hasText)) errors.push({ path: `${path}.criteria`, message: "every level needs a description" });
    }
  }
  return errors;
}

/** Options in display order: [{id, label}]. Choice keeps the author's order. */
export function optionsOf(question) {
  if (question.type === "noul") return [{ id: "true", label: "yes" }, { id: "false", label: "no" }];
  if (question.type === "choice") return Object.keys(question.criteria || {}).map((id) => ({ id, label: pretty(id) }));
  return (question.criteria || []).map((level, index) => ({ id: String(index), label: textOf(level) }));
}

/** Rough prompt size for the questions (the model's tokenizer averages ~3.5 characters per token here). */
export function estimateTokens(questions, state) {
  let chars = 160 + textOf(state).length;
  for (const [id, q] of Object.entries(questions || {})) {
    chars += 60 + id.length + textOf(q.instructions ?? id).length;
    for (const option of optionsOf(q)) chars += 30 + option.id.length;
    if (q.type === "choice") for (const d of Object.values(q.criteria || {})) chars += textOf(d).length;
    if (q.type === "score") for (const d of q.criteria || []) chars += textOf(d).length;
  }
  return Math.round(chars / 3.5);
}

export const typeLabel = { noul: "yes / no", choice: "choice", score: "score" };
