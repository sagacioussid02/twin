from __future__ import annotations

from typing import Any, Dict, List

from source_memory import classify_query


def route_message(user_message: str, _conversation: List[Dict[str, Any]] | None = None) -> Dict[str, Any]:
    """Classify a user request and annotate routing flags for downstream agents.

    Conversation context is accepted for future routing logic but is not currently used.
    """
    query_type = classify_query(user_message)
    lowered = user_message.lower()

    flags: List[str] = []
    if query_type in {"factual", "mixed"}:
        flags.append("needs_evidence")
    if query_type in {"advisory", "mixed"}:
        flags.append("decision_question")
    if any(token in lowered for token in ("wrong", "incorrect", "not right", "source", "cite", "evidence")):
        flags.append("correction_sensitive")
    if len(lowered.strip()) < 18:
        flags.append("short_query")

    retrieval_limit = 3
    if query_type == "mixed":
        retrieval_limit = 4
    elif "correction_sensitive" in flags:
        retrieval_limit = 5

    return {
        "query_type": query_type,
        "intent_flags": flags,
        "retrieval_limit": retrieval_limit,
    }
