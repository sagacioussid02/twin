from __future__ import annotations

from typing import Any, Dict, List, Optional

from agents.critic_agent import review_grounded_answer
from agents.router_agent import route_message
from agents.twin_response_agent import generate_twin_response
from source_memory import ensure_sources, retrieve_relevant_sources


def run_chat_orchestration(
    *,
    twin_data: Optional[dict],
    user_message: str,
    conversation: List[Dict[str, Any]],
    bedrock_client,
    model_id: str,
    personality_model: Optional[dict],
    twin_name: Optional[str],
    twin_title: Optional[str],
    response_style: str,
    corrections: Optional[List[dict]],
) -> Dict[str, Any]:
    """Coordinate router, retrieval, responder, and critic for chat."""
    route = route_message(user_message, conversation)
    sources = ensure_sources(twin_data) if twin_data else []
    retrieved_sources = (
        retrieve_relevant_sources(
            user_message,
            sources,
            limit=int(route.get("retrieval_limit", 3)),
        )
        if twin_data
        else []
    )

    answer = generate_twin_response(
        bedrock_client=bedrock_client,
        model_id=model_id,
        conversation=conversation,
        user_message=user_message,
        personality_model=personality_model,
        twin_name=twin_name,
        twin_title=twin_title,
        response_style=response_style,
        corrections=corrections,
        retrieved_sources=retrieved_sources,
        query_type=str(route["query_type"]),
    )

    critic = (
        review_grounded_answer(
            user_message=user_message,
            answer=answer,
            query_type=str(route["query_type"]),
            retrieved_sources=retrieved_sources,
        )
        if twin_data
        else {"grounding": None, "critic_notes": [], "critic_passed": True, "answer": answer}
    )

    return {
        "answer": critic["answer"],
        "route": route,
        "grounding": critic["grounding"],
        "critic_notes": critic["critic_notes"],
        "critic_passed": critic["critic_passed"],
        "retrieved_sources": retrieved_sources,
    }
