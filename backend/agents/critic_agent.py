from __future__ import annotations

from typing import Any, Dict, List

from source_memory import build_grounding_summary


def review_grounded_answer(
    *,
    user_message: str,
    answer: str,
    query_type: str,
    retrieved_sources: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Lightweight critic pass that preserves behavior while labeling trust."""
    grounding = build_grounding_summary(query_type, retrieved_sources)
    notes: List[str] = []

    if not retrieved_sources:
        notes.append("No supporting sources retrieved.")

    if query_type in {"advisory", "mixed"} and retrieved_sources:
        grounding["grounding_mode"] = "grounded+inferred"
        if grounding["confidence_label"] == "high":
            grounding["confidence_label"] = "medium"
        notes.append("Advice answers combine grounded context with inference.")

    if any(phrase in answer.lower() for phrase in ("i'm not sure", "i don't know", "uncertain")):
        grounding["confidence_label"] = "low"
        grounding["grounding_mode"] = "uncertain"
        notes.append("Answer explicitly signals uncertainty.")

    if len(user_message.strip()) < 12 and grounding["confidence_label"] == "high":
        grounding["confidence_label"] = "medium"
        notes.append("Short user query lowered confidence slightly.")

    return {
        "grounding": grounding,
        "critic_notes": notes,
        "critic_passed": True,
        "answer": answer,
    }
