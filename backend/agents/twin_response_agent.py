from __future__ import annotations

from typing import Dict, List, Optional

from botocore.exceptions import ClientError
from fastapi import HTTPException

from context import prompt
from source_memory import format_retrieved_sources


def generate_twin_response(
    *,
    bedrock_client,
    model_id: str,
    conversation: List[Dict],
    user_message: str,
    personality_model: Optional[dict] = None,
    twin_name: Optional[str] = None,
    twin_title: Optional[str] = None,
    response_style: str = "balanced",
    corrections: Optional[List[dict]] = None,
    retrieved_sources: Optional[List[dict]] = None,
    query_type: str = "factual",
    viewer_is_authenticated: bool = False,
) -> str:
    """Generate the twin's answer from personality context plus retrieved evidence."""
    messages = []

    system_prompt = prompt(
        personality_model=personality_model,
        twin_name=twin_name,
        twin_title=twin_title,
        response_style=response_style,
        corrections=corrections,
        viewer_is_authenticated=viewer_is_authenticated,
    )
    messages.append({
        "role": "user",
        "content": [{"text": f"System: {system_prompt}"}]
    })

    if retrieved_sources:
        evidence_block = format_retrieved_sources(retrieved_sources)
        messages.append({
            "role": "user",
            "content": [{
                "text": (
                    f"The user's latest request is classified as: {query_type}.\n"
                    f"{evidence_block}\n"
                    "If the evidence does not fully answer the question, say what is grounded and what is inferred."
                )
            }]
        })

    for msg in conversation[-50:]:
        messages.append({
            "role": msg["role"],
            "content": [{"text": msg["content"]}]
        })

    messages.append({
        "role": "user",
        "content": [{"text": user_message}]
    })

    try:
        response = bedrock_client.converse(
            modelId=model_id,
            messages=messages,
            inferenceConfig={
                "maxTokens": 2000,
                "temperature": 0.7,
                "topP": 0.9
            }
        )
        return response["output"]["message"]["content"][0]["text"]

    except ClientError as e:
        error_code = e.response['Error']['Code']
        if error_code == 'ValidationException':
            print(f"Bedrock validation error: {e}")
            raise HTTPException(status_code=400, detail="Invalid message format for Bedrock")
        elif error_code == 'AccessDeniedException':
            print(f"Bedrock access denied: {e}")
            raise HTTPException(status_code=403, detail="Access denied to Bedrock model")
        else:
            print(f"Bedrock error: {e}")
            raise HTTPException(status_code=500, detail="AI service error")
