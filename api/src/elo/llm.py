"""A small OpenAI-compatible chat client (standard library only).

Works with any provider that exposes /chat/completions. Configure with environment
variables LLM_BASE_URL, LLM_API_KEY and LLM_MODEL. The key is never logged or shown in repr.
"""

from __future__ import annotations

import json
import os
import urllib.request


class OpenAICompatibleClient:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self.model = model
        self.timeout = timeout

    @classmethod
    def from_env(cls) -> "OpenAICompatibleClient | None":
        base, key, model = (os.environ.get(k) for k in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"))
        if not (base and key and model):
            return None
        return cls(base, key, model, timeout=float(os.environ.get("LLM_TIMEOUT", "180")))

    def __repr__(self) -> str:
        return f"OpenAICompatibleClient(base_url={self.base_url!r}, model={self.model!r})"

    def complete_json(self, system: str, user: str) -> str:
        payload = {
            "model": self.model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self._api_key}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310 (fixed https endpoint from config)
            body = json.loads(resp.read().decode("utf-8"))
        return body["choices"][0]["message"]["content"]
