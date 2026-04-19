from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any, Dict, Iterable, List


_TOKEN_RE = re.compile(r"[a-z0-9']+")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
    "how", "i", "if", "in", "into", "is", "it", "me", "my", "of", "on",
    "or", "so", "that", "the", "their", "them", "they", "this", "to", "we",
    "what", "when", "where", "who", "why", "with", "would", "you", "your",
}


def _utcnow_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _normalize_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    elif isinstance(value, list):
        text = "\n".join(str(item).strip() for item in value if str(item).strip())
    elif isinstance(value, dict):
        text = "\n".join(
            f"{key}: {val}" for key, val in value.items() if str(val).strip()
        )
    else:
        text = str(value)
    return re.sub(r"\s+", " ", text).strip()


def _tokenize(text: str) -> List[str]:
    return [token for token in _TOKEN_RE.findall(text.lower()) if token not in _STOP_WORDS]


def _unique_preserve(values: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    result: List[str] = []
    for value in values:
        cleaned = value.strip().lower()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        result.append(value.strip())
    return result


def _infer_tags(source_type: str, title: str, content: str) -> List[str]:
    tags: List[str] = []
    title_lower = title.lower()
    content_lower = content.lower()
    keyword_map = {
        "leadership": ["lead", "manager", "executive", "founder", "team"],
        "product": ["product", "customer", "roadmap", "strategy", "growth"],
        "engineering": ["engineer", "backend", "frontend", "api", "system", "architecture"],
        "ai": ["ai", "llm", "ml", "machine learning", "bedrock", "model"],
        "communication": ["communication", "writing", "tone", "speak", "voice"],
        "decision-making": ["decision", "tradeoff", "risk", "choose", "judgment"],
        "values": ["value", "principle", "belief", "non-negotiable", "integrity"],
        "career": ["experience", "career", "role", "company", "achievement"],
    }
    if source_type in {"linkedin_parse", "resume_profile"}:
        tags.append("career")
    if source_type in {"deepen_interview", "manual_correction"}:
        tags.append("decision-making")
    if "linkedin" in title_lower:
        tags.append("career")
    for tag, cues in keyword_map.items():
        if any(cue in content_lower or cue in title_lower for cue in cues):
            tags.append(tag)
    return _unique_preserve(tags[:6])


def _chunk_text(content: str, max_chars: int = 320) -> List[Dict[str, Any]]:
    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(content) if s.strip()]
    if not sentences:
        sentences = [content.strip()] if content.strip() else []

    chunks: List[Dict[str, Any]] = []
    current = ""
    for sentence in sentences:
        proposed = f"{current} {sentence}".strip()
        if current and len(proposed) > max_chars:
            chunks.append({"chunk_id": uuid.uuid4().hex, "text": current})
            current = sentence
        else:
            current = proposed
    if current:
        chunks.append({"chunk_id": uuid.uuid4().hex, "text": current})
    return chunks[:8]


def make_source_item(
    *,
    source_type: str,
    title: str,
    content: Any,
    confidence: str = "medium",
    user_approved: bool = True,
    created_at: str | None = None,
) -> Dict[str, Any] | None:
    normalized = _normalize_text(content)
    if not normalized:
        return None
    tags = _infer_tags(source_type, title, normalized)
    chunks = _chunk_text(normalized)
    if not chunks:
        return None
    return {
        "source_id": uuid.uuid4().hex,
        "source_type": source_type,
        "title": title,
        "content": normalized,
        "created_at": created_at or _utcnow_iso(),
        "confidence": confidence,
        "tags": tags,
        "user_approved": user_approved,
        "chunks": chunks,
    }


def build_initial_sources(fields: Dict[str, Any], linkedin_parsed: Dict[str, Any] | None = None) -> List[Dict[str, Any]]:
    sources: List[Dict[str, Any]] = []
    mappings = [
        ("resume_profile", "Profile summary", [fields.get("bio"), fields.get("title")], "high"),
        ("experience_notes", "Experience", fields.get("experience"), "high"),
        ("skills_inventory", "Skills and expertise", fields.get("skills"), "high"),
        ("achievement_notes", "Achievements", fields.get("achievements"), "high"),
        ("values_profile", "Core values", fields.get("coreValues"), "high"),
        ("decision_notes", "Decision-making style", [fields.get("decisionStyle"), fields.get("pastDecisions")], "high"),
        ("communication_profile", "Communication style", [fields.get("communicationStyle"), fields.get("verbalQuirks")], "medium"),
        ("self_reported_blind_spots", "Blind spots", fields.get("blindSpots"), "medium"),
    ]
    for source_type, title, content, confidence in mappings:
        item = make_source_item(
            source_type=source_type,
            title=title,
            content=content,
            confidence=confidence,
        )
        if item:
            sources.append(item)

    if linkedin_parsed:
        item = make_source_item(
            source_type="linkedin_parse",
            title="LinkedIn profile",
            content=linkedin_parsed,
            confidence="medium",
        )
        if item:
            sources.append(item)

    return sources


def build_deepen_sources(new_fields: Dict[str, Any]) -> List[Dict[str, Any]]:
    mappings = [
        ("deepen_interview", "Hard decisions", new_fields.get("pastDecisions"), "high"),
        ("deepen_interview", "Non-negotiables", [new_fields.get("nonNegotiables"), new_fields.get("softPreferences")], "high"),
        ("deepen_interview", "Changed mind", new_fields.get("mindChange"), "high"),
    ]
    items: List[Dict[str, Any]] = []
    for source_type, title, content, confidence in mappings:
        item = make_source_item(
            source_type=source_type,
            title=title,
            content=content,
            confidence=confidence,
        )
        if item:
            items.append(item)
    return items


def build_correction_source(question: str, wrong_response: str, correction: str, created_at: str | None = None) -> Dict[str, Any] | None:
    return make_source_item(
        source_type="manual_correction",
        title="User correction",
        content={
            "question": question,
            "wrong_response": wrong_response,
            "preferred_correction": correction,
        },
        confidence="high",
        created_at=created_at,
    )


def merge_sources(existing_sources: List[Dict[str, Any]] | None, new_sources: List[Dict[str, Any]] | None) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    for source in (existing_sources or []) + (new_sources or []):
        content = _normalize_text(source.get("content", ""))
        key = (str(source.get("source_type", "")), content.lower())
        if not content or key in seen:
            continue
        seen.add(key)
        normalized_source = dict(source)
        normalized_source["content"] = content
        normalized_source["chunks"] = source.get("chunks") or _chunk_text(content)
        normalized_source["tags"] = source.get("tags") or _infer_tags(
            str(source.get("source_type", "")),
            str(source.get("title", "")),
            content,
        )
        normalized_source["source_id"] = source.get("source_id") or uuid.uuid4().hex
        normalized_source["created_at"] = source.get("created_at") or _utcnow_iso()
        normalized_source["confidence"] = source.get("confidence") or "medium"
        normalized_source["user_approved"] = bool(source.get("user_approved", True))
        merged.append(normalized_source)

    merged.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return merged[:40]


def ensure_sources(twin_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    existing = twin_data.get("sources")
    if isinstance(existing, list) and existing:
        return merge_sources(existing, [])

    personality_model = twin_data.get("personality_model") or {}
    ctx = personality_model.get("_context", {}) if isinstance(personality_model, dict) else {}
    synthesized = build_initial_sources(
        {
            "bio": ctx.get("bio"),
            "title": twin_data.get("title"),
            "skills": ctx.get("skills"),
            "experience": ctx.get("experience"),
            "achievements": ctx.get("achievements"),
            "coreValues": ctx.get("coreValues") or "\n".join(personality_model.get("core_values", []) or []),
            "decisionStyle": ctx.get("decisionStyle") or personality_model.get("decision_framework"),
            "pastDecisions": ctx.get("pastDecisions"),
            "communicationStyle": ctx.get("communicationStyle"),
            "verbalQuirks": ctx.get("verbalQuirks"),
            "blindSpots": ctx.get("blindSpots") or "\n".join(personality_model.get("blind_spots", []) or []),
        }
    )

    corrections = twin_data.get("corrections") or []
    correction_sources = [
        build_correction_source(
            question=str(c.get("question", "")),
            wrong_response=str(c.get("wrong_response", "")),
            correction=str(c.get("correction", "")),
            created_at=str(c.get("created_at", "")) or None,
        )
        for c in corrections
    ]
    return merge_sources([], synthesized + [item for item in correction_sources if item])


def classify_query(message: str) -> str:
    lowered = message.lower()
    factual_cues = [
        "what", "when", "where", "which", "tell me about", "experience", "background",
        "worked on", "skills", "resume", "bio", "who are", "did you",
    ]
    advisory_cues = [
        "should i", "what would you do", "how would you", "advice", "recommend",
        "approach", "handle", "decide", "tradeoff", "choose",
    ]
    factual = any(cue in lowered for cue in factual_cues)
    advisory = any(cue in lowered for cue in advisory_cues)
    if factual and advisory:
        return "mixed"
    if advisory:
        return "advisory"
    return "factual"


def retrieve_relevant_sources(message: str, sources: List[Dict[str, Any]], limit: int = 3) -> List[Dict[str, Any]]:
    query_tokens = set(_tokenize(message))
    if not query_tokens:
        return []

    best_by_source: Dict[Any, Dict[str, Any]] = {}
    for source in sources:
        source_id = source.get("source_id")
        for chunk in source.get("chunks", []):
            chunk_text = _normalize_text(chunk.get("text"))
            if not chunk_text:
                continue
            chunk_tokens = set(_tokenize(chunk_text))
            overlap = query_tokens & chunk_tokens
            score = len(overlap)
            if score == 0:
                continue
            if source.get("source_type") == "manual_correction":
                score += 2
            if source.get("confidence") == "high":
                score += 1

            candidate = {
                "source_id": source_id,
                "source_type": source.get("source_type"),
                "title": source.get("title"),
                "snippet": chunk_text[:320],
                "confidence": source.get("confidence", "medium"),
                "tags": source.get("tags", []),
                "score": score,
                "matched_terms": sorted(overlap)[:6],
            }
            current_best = best_by_source.get(source_id)
            if current_best is None or score > int(current_best["score"]):
                best_by_source[source_id] = candidate

    scored = list(best_by_source.values())
    scored.sort(key=lambda item: (-int(item["score"]), str(item["title"])))
    return scored[:limit]


def build_grounding_summary(query_type: str, retrieved_sources: List[Dict[str, Any]]) -> Dict[str, Any]:
    grounded = bool(retrieved_sources)
    source_count = len(retrieved_sources)
    if grounded and source_count >= 2:
        confidence_label = "high"
    elif grounded:
        confidence_label = "medium"
    else:
        confidence_label = "low"

    if grounded and query_type == "factual":
        grounding_mode = "grounded"
    elif grounded:
        grounding_mode = "grounded+inferred"
    else:
        grounding_mode = "uncertain"

    return {
        "answer_type": query_type,
        "confidence_label": confidence_label,
        "grounding_mode": grounding_mode,
    }


def format_retrieved_sources(retrieved_sources: List[Dict[str, Any]]) -> str:
    lines = [
        "Use the following retrieved evidence when it is relevant.",
        "Prefer these notes over unsupported assumptions, and mention uncertainty when the evidence is thin.",
    ]
    for index, source in enumerate(retrieved_sources, start=1):
        lines.append(
            f"[{index}] {source['title']} ({source['source_type']}, confidence={source['confidence']}): "
            f"{source['snippet']}"
        )
    return "\n".join(lines)
