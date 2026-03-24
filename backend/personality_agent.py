"""
Personality Agent — detects role archetypes from job titles and reviews
twin responses to nudge tone/style toward the archetype.
"""

import json
import re
from pathlib import Path
from typing import Optional

# Load archetypes once at module level
_ARCHETYPES_PATH = Path(__file__).parent / "personalities" / "archetypes.json"
with open(_ARCHETYPES_PATH, "r", encoding="utf-8") as f:
    _ARCHETYPES: list[dict] = json.load(f)["archetypes"]

_ARCHETYPES_BY_ID: dict[str, dict] = {a["id"]: a for a in _ARCHETYPES}


def get_all_archetypes() -> list[dict]:
    """Return all archetypes (id + display_name) for frontend dropdown."""
    return [{"id": a["id"], "display_name": a["display_name"]} for a in _ARCHETYPES]


def get_archetype(archetype_id: str) -> Optional[dict]:
    return _ARCHETYPES_BY_ID.get(archetype_id)


def detect_archetype(title: str) -> Optional[dict]:
    """
    Match a job title string to the best archetype.
    Returns the archetype dict or None if no match.
    Strips 'at Company' suffix before matching.
    """
    if not title:
        return None

    # Strip "at <Company>" suffix — e.g. "Senior SWE at Acme" -> "Senior SWE"
    clean = re.sub(r"\s+at\s+.+$", "", title, flags=re.IGNORECASE).strip().lower()

    for archetype in _ARCHETYPES:
        for pattern in archetype["title_patterns"]:
            if pattern.lower() in clean:
                return archetype

    return None


def build_review_prompt(draft: str, archetype: dict, twin_context: str) -> str:
    traits = "\n".join(f"- {t}" for t in archetype["communication_traits"])
    return f"""You are a communication style reviewer for an AI digital twin.

This twin represents a **{archetype["display_name"]}**. Here is how someone in this role communicates:

{traits}

Their decision style: {archetype["decision_style"]}

Brief context about this specific person:
{twin_context}

---

Draft response from the twin:
{draft}

---

Your task: {archetype["review_instructions"]}

Return only the revised response. No preamble, no commentary, no meta-explanation.
Do not introduce markdown formatting — no **bold**, no bullet points, no headers. Plain prose only."""


def review_response(
    draft: str,
    archetype: dict,
    twin_context: str,
    bedrock_client,
    model_id: str,
) -> str:
    """
    Run the personality review step. Returns the refined response,
    or the original draft if the review call fails.
    """
    prompt_text = build_review_prompt(draft, archetype, twin_context)

    try:
        response = bedrock_client.converse(
            modelId=model_id,
            messages=[
                {
                    "role": "user",
                    "content": [{"text": prompt_text}],
                }
            ],
            inferenceConfig={
                "maxTokens": 1000,
                "temperature": 0.2,
                "topP": 0.9,
            },
        )
        return response["output"]["message"]["content"][0]["text"]
    except Exception as e:
        print(f"[personality_agent] Review step failed, returning draft: {e}")
        return draft
