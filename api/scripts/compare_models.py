"""Compare local models on the same synthetic notes.

Usage: LLM_BASE_URL=... LLM_API_KEY=ollama python scripts/compare_models.py llama3.2:3b qwen2
Prints, per model: observations accepted, rejections by reason, rule disagreements, seconds.
"""
import sys
import urllib.error
import time
from collections import Counter
from datetime import date

from elo.contract import Note
from elo.extraction import ExtractionContext, ExtractionError, extract_with_llm
from elo.llm import OpenAICompatibleClient
from elo.packs import load_pack
from elo.privacy import PatientRegistry, PrivacyGate

NOTES = [
    "Pedro vestiu a camiseta na clínica sem assistência física, após instruções verbais.",
    "Pedro put on the shirt at the clinic with verbal prompts.",
    "A mãe relatou que em casa Pedro escovou os dentes sozinho.",
    "Na escola, Pedro escreveu o nome com ajuda física parcial.",
    "Pedro comeu com colher na clínica, sem ajuda.",
]

def main(models):
    reg = PatientRegistry()
    reg.add("patient", "Pedro Souza", "Paciente A")
    gate, pack = PrivacyGate(reg), load_pack()
    ctx = ExtractionContext(session_date=date.today())
    for model in models:
        client = OpenAICompatibleClient(__import__("os").environ["LLM_BASE_URL"], __import__("os").environ.get("LLM_API_KEY", "ollama"), model, timeout=180)
        ok, rej, flags, bad_json, t0 = 0, Counter(), 0, 0, time.time()
        for i, text in enumerate(NOTES):
            s = gate.process(text)
            note = Note(id=f"n{i}", session_id="s", original_text=text, sanitized_text=s.text)
            try:
                r = extract_with_llm(client, s, note, ctx, pack)
            except ExtractionError:
                bad_json += 1
                continue
            except urllib.error.URLError as exc:
                print(f"{model}: request failed ({exc}); is the model name installed?")
                break
            ok += len(r.observations)
            rej.update(x.reason for x in r.rejected)
            flags += len(r.flags)
            for f in r.flags:
                o = next(x for x in r.observations if x.id == f.observation_id)
                print(f"  [{model}] {f.kind}: {o.quote_sanitized!r} -> {o.assistance.value}/{o.environment.value}")
        print(f"{model}: accepted={ok} rejected={dict(rej)} flags={flags} bad_json={bad_json} seconds={time.time()-t0:.1f}")

if __name__ == "__main__":
    main(sys.argv[1:])
