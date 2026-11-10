"""Run the benchmark. Usage:
  python scripts/run_benchmark.py --mode rules --split dev
  python scripts/run_benchmark.py --mode llm --model qwen2.5:3b --split dev   (needs LLM_BASE_URL)
Run `--split eval` only once, at the end, after the rules/prompts are frozen.
"""
import argparse
import json
import os

from elo.benchmark import load_cases, run_case, summarize
from elo.llm import OpenAICompatibleClient

ap = argparse.ArgumentParser()
ap.add_argument("--mode", choices=["rules", "llm", "consensus"], default="rules")
ap.add_argument("--model", default=os.environ.get("LLM_MODEL", "qwen2.5:3b"))
ap.add_argument("--only-round", type=int, default=None)
ap.add_argument("--split", choices=["dev", "eval", "all"], default="dev")
a = ap.parse_args()
client = None
if a.mode != "rules":
    client = OpenAICompatibleClient(os.environ["LLM_BASE_URL"], os.environ.get("LLM_API_KEY", "ollama"), a.model, timeout=180)
import sys
cases = [c for c in load_cases(a.split) if a.only_round is None or c.get("round", 1) == a.only_round]
rows = []
for i, c in enumerate(cases, 1):
    rows.append(run_case(c, a.mode, client))
    print(f"[{i}/{len(cases)}] {c['id']}", file=sys.stderr, flush=True)
print(json.dumps({"mode": a.mode, "model": a.model if client else None, "split": a.split, **summarize(rows)}, indent=1))
