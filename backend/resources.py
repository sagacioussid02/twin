from pypdf import PdfReader
import json
from pathlib import Path
import os

DATA_DIR = Path(__file__).parent / "data"

# Read LinkedIn PDF
try:
    reader = PdfReader(DATA_DIR / "linkedin.pdf")
    linkedin = ""
    for page in reader.pages:
        text = page.extract_text()
        if text:
            linkedin += text
except FileNotFoundError:
    linkedin = "LinkedIn profile not available"

# Read core data files
try:
    with open(DATA_DIR / "summary.txt", "r", encoding="utf-8") as f:
        summary = f.read()
except FileNotFoundError:
    summary = "Summary not available"

try:
    with open(DATA_DIR / "style.txt", "r", encoding="utf-8") as f:
        style = f.read()
except FileNotFoundError:
    style = "Communication style not available"

try:
    with open(DATA_DIR / "facts.json", "r", encoding="utf-8") as f:
        facts = json.load(f)
except FileNotFoundError:
    facts = {"full_name": "Professional", "name": "Twin"}

# Dynamically load all markdown files
def load_markdown_file(filename):
    """Load a markdown file from data directory"""
    try:
        with open(DATA_DIR / filename, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return None

# Dynamically load all json files
def load_json_file(filename):
    """Load a JSON file from data directory"""
    try:
        with open(DATA_DIR / filename, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None

# Load all markdown files from data directory
bio = load_markdown_file("bio.md")
achievements = load_markdown_file("achievements.md")
work_experience = load_markdown_file("work_experience.md")
interests = load_markdown_file("interests.md")
communication_guide = load_markdown_file("communication_style.md")

# Load all JSON files from data directory
skills = load_json_file("skills.json")

# Load all additional markdown files dynamically
extra_markdown_files = {}
if DATA_DIR.exists():
    for file in DATA_DIR.glob("*.md"):
        filename = file.stem
        # Skip files we already loaded
        if filename not in ["bio", "achievements", "work_experience", "interests", "communication_style"]:
            extra_markdown_files[filename] = load_markdown_file(file.name)

# Load all additional JSON files dynamically
extra_json_files = {}
if DATA_DIR.exists():
    for file in DATA_DIR.glob("*.json"):
        filename = file.stem
        # Skip files we already loaded
        if filename not in ["facts", "skills"]:
            extra_json_files[filename] = load_json_file(file.name)