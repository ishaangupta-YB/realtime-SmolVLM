"""Validate SystemOne questions before they reach a backend.

The rules follow the published ``@cf/cloudflare/clef-flash`` input schema, so a request that passes
here is accepted by Workers AI as well as by the local model. Errors carry a path such as
``questions.mood.criteria`` so the page can point at the exact field.
"""

from __future__ import annotations

import json
import re
from typing import Any

QUESTION_ID = re.compile(r"^[A-Za-z0-9_.\-]{1,100}$")
MAX_QUESTIONS = 64
CHOICE_OPTIONS = (2, 255)
SCORE_LEVELS = (2, 10)


class SchemaError(ValueError):
    def __init__(self, errors: list[tuple[str, str]]):
        self.errors = errors
        super().__init__("; ".join(f"{path}: {message}" for path, message in errors))

    def as_json(self) -> list[dict[str, str]]:
        return [{"path": path, "message": message} for path, message in self.errors]


def _is_json(value: Any) -> bool:
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return False
    return True


def _has_text(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    return value is not None and _is_json(value) and value not in ({}, [])


def validate_questions(questions: Any) -> dict[str, dict[str, Any]]:
    """Return a cleaned copy of ``questions`` or raise :class:`SchemaError` listing every problem.

    ``instructions`` may be omitted; it then defaults to the question id, which is what the local
    model does on its own and what Workers AI needs to see explicitly.
    """
    errors: list[tuple[str, str]] = []
    if not isinstance(questions, dict) or not questions:
        raise SchemaError([("questions", "must be an object with at least one question")])
    if len(questions) > MAX_QUESTIONS:
        errors.append(("questions", f"at most {MAX_QUESTIONS} questions, got {len(questions)}"))

    cleaned: dict[str, dict[str, Any]] = {}
    for question_id, question in questions.items():
        path = f"questions.{question_id}"
        if not isinstance(question_id, str) or not QUESTION_ID.match(question_id):
            errors.append((path, "id may only use letters, digits, '_', '.' and '-' (1 to 100 characters)"))
            continue
        if not isinstance(question, dict):
            errors.append((path, "must be an object"))
            continue
        kind = question.get("type")
        if kind not in ("noul", "choice", "score"):
            errors.append((f"{path}.type", "must be noul, choice or score"))
            continue

        instructions = question.get("instructions")
        if instructions is None or (isinstance(instructions, str) and not instructions.strip()):
            instructions = question_id
        elif not _has_text(instructions):
            errors.append((f"{path}.instructions", "must be a non-empty string, object or array"))
            continue
        item: dict[str, Any] = {"type": kind, "instructions": instructions}

        criteria = question.get("criteria")
        if kind == "noul":
            if criteria is not None:
                if not isinstance(criteria, dict) or set(criteria) - {"true", "false"}:
                    errors.append((f"{path}.criteria", "for noul, an object with only 'true' and/or 'false'"))
                    continue
                described = {key: value for key, value in criteria.items() if value is not None}
                if described:
                    item["criteria"] = described
        elif kind == "choice":
            if not isinstance(criteria, dict):
                errors.append((f"{path}.criteria", "for choice, an object mapping option id to description or null"))
                continue
            low, high = CHOICE_OPTIONS
            if not low <= len(criteria) <= high:
                errors.append((f"{path}.criteria", f"needs {low} to {high} options, got {len(criteria)}"))
                continue
            bad = [key for key in criteria if not isinstance(key, str) or not key.strip()]
            if bad:
                errors.append((f"{path}.criteria", "option ids must be non-empty strings"))
                continue
            if not all(value is None or _is_json(value) for value in criteria.values()):
                errors.append((f"{path}.criteria", "descriptions must be text, JSON or null"))
                continue
            item["criteria"] = dict(criteria)
        else:
            if not isinstance(criteria, list):
                errors.append((f"{path}.criteria", "for score, a list of level descriptions, lowest first"))
                continue
            low, high = SCORE_LEVELS
            if not low <= len(criteria) <= high:
                errors.append((f"{path}.criteria", f"needs {low} to {high} levels, got {len(criteria)}"))
                continue
            if not all(_has_text(level) for level in criteria):
                errors.append((f"{path}.criteria", "every level needs a description"))
                continue
            item["criteria"] = list(criteria)
        cleaned[question_id] = item

    if errors:
        raise SchemaError(errors)
    return cleaned


def validate_state(state: Any) -> Any:
    if state is None:
        raise SchemaError([("state", "is required (a string or JSON value)")])
    if not _is_json(state):
        raise SchemaError([("state", "must be a string or JSON value")])
    return state
