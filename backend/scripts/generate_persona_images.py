"""
One-time script: generate AI portrait images for public personas using
Amazon Nova Canvas on Bedrock, then save to frontend/public/personas/.

Usage:
  cd backend
  python scripts/generate_persona_images.py

Requires AWS credentials with bedrock:InvokeModel access to
amazon.nova-canvas-v1:0 in us-east-1.
"""

import base64
import json
import os
import sys
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

REGION = os.getenv("DEFAULT_AWS_REGION", "us-east-1")
# Requires model access enabled in AWS Console → Bedrock → Model access
# Enable "Amazon Nova Canvas" (amazon.nova-canvas-v1:0)
MODEL_ID = "amazon.nova-canvas-v1:0"
IMAGE_EXT = "jpg"

OUT_DIR = Path(__file__).parent.parent.parent / "frontend" / "public" / "personas"
OUT_DIR.mkdir(parents=True, exist_ok=True)

PERSONAS = [
    {
        "slug": "gandhi",
        "prompt": (
            "Artistic portrait illustration of Mahatma Gandhi, Indian independence leader, "
            "bald elderly man with round wire-rimmed glasses and warm gentle expression, "
            "simple white shawl, soft warm lighting, painterly style, dignified and serene, "
            "high quality digital art"
        ),
        "json_path": Path(__file__).parent.parent / "public_personas" / "gandhi.json",
    },
    {
        "slug": "chaplin",
        "prompt": (
            "Artistic portrait illustration of Charlie Chaplin, silent film era comedian, "
            "iconic toothbrush mustache, bowler hat, black and white vintage aesthetic, "
            "expressive kind eyes, warm smile, classic Hollywood style, painterly illustration, "
            "high quality digital art"
        ),
        "json_path": Path(__file__).parent.parent / "public_personas" / "chaplin.json",
    },
    {
        "slug": "buffett",
        "prompt": (
            "Artistic portrait illustration of an elderly American investor and businessman, "
            "warm grandfatherly smile, conservative suit and tie, Omaha Nebraska setting, "
            "approachable and wise expression, soft natural light, painterly style, "
            "high quality digital art"
        ),
        "json_path": Path(__file__).parent.parent / "public_personas" / "buffett.json",
    },
]


def generate_image(bedrock, prompt: str) -> bytes:
    body = json.dumps({
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {
            "text": prompt,
            "negativeText": "blurry, distorted, low quality, text, watermark, signature, ugly, deformed",
        },
        "imageGenerationConfig": {
            "numberOfImages": 1,
            "height": 512,
            "width": 512,
            "quality": "standard",
            "cfgScale": 7.5,
            "seed": 42,
        },
    })
    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=body,
    )
    result = json.loads(response["body"].read())
    # Titan v2 returns images under "images"; Nova Canvas also uses "images"
    images = result.get("images") or result.get("artifacts", [])
    img = images[0]
    return base64.b64decode(img if isinstance(img, str) else img.get("base64", ""))


def update_json_image_url(json_path: Path, slug: str) -> None:
    with open(json_path) as f:
        data = json.load(f)
    data["image_url"] = f"/personas/{slug}.{IMAGE_EXT}"
    with open(json_path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  Updated {json_path.name} → image_url=/personas/{slug}.{IMAGE_EXT}")


def main():
    bedrock = boto3.client("bedrock-runtime", region_name=REGION)
    print(f"Generating persona images via {MODEL_ID} in {REGION}\n")

    for persona in PERSONAS:
        slug = persona["slug"]
        out_path = OUT_DIR / f"{slug}.{IMAGE_EXT}"

        if out_path.exists():
            print(f"[{slug}] Already exists at {out_path}, skipping generation.")
            update_json_image_url(persona["json_path"], slug)
            continue

        print(f"[{slug}] Generating... ", end="", flush=True)
        try:
            image_bytes = generate_image(bedrock, persona["prompt"])
            out_path.write_bytes(image_bytes)
            print(f"saved to {out_path}")
            update_json_image_url(persona["json_path"], slug)
        except ClientError as e:
            code = e.response["Error"]["Code"]
            msg = e.response["Error"]["Message"]
            print(f"FAILED ({code}: {msg})")
            print(f"  Tip: ensure {MODEL_ID} is enabled in Bedrock model access for {REGION}")
            sys.exit(1)

    print(f"\nDone. Commit the generated .{IMAGE_EXT} files and updated JSON files.")


if __name__ == "__main__":
    main()
