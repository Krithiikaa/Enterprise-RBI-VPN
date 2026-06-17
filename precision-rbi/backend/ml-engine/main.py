"""Precision RBI — ml-engine FastAPI service  [SRV-04]"""
import os
import json
import time

from fastapi import FastAPI
from pydantic import BaseModel
import redis.asyncio as aioredis

from scorer import score_url, load_blocklists

REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")
CACHE_TTL = int(os.environ.get("SCORE_CACHE_TTL", "3600"))
ISOLATE_THRESHOLD = int(os.environ.get("ISOLATE_THRESHOLD", "50"))
BLOCK_THRESHOLD = int(os.environ.get("BLOCK_THRESHOLD", "80"))

app = FastAPI(title="Precision RBI ml-engine", version="0.1.0")
_redis: aioredis.Redis | None = None
_boot = time.time()
_blocklist_count = 0


class ScoreRequest(BaseModel):
    url: str
    domain: str | None = None
    headers: dict | None = None
    body_snippet: str | None = None


@app.on_event("startup")
async def _startup():
    global _redis, _blocklist_count
    _blocklist_count = load_blocklists()
    try:
        _redis = aioredis.from_url(REDIS_URL, decode_responses=True)
        await _redis.ping()
    except Exception:
        _redis = None  # degrade to cacheless


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "0.1.0",
        "uptimeSec": int(time.time() - _boot),
        "blocklistEntries": _blocklist_count,
        "redis": bool(_redis),
        "thresholds": {"isolate": ISOLATE_THRESHOLD, "block": BLOCK_THRESHOLD},
    }


@app.post("/score")
async def score(req: ScoreRequest):
    from urllib.parse import urlparse
    host = (urlparse(req.url if "://" in req.url else "http://" + req.url).hostname or "").lower()
    cache_key = f"score:{host}"

    # Cache only the domain-level verdict (content scoring is per-request and not cached).
    if _redis and not req.body_snippet:
        try:
            cached = await _redis.get(cache_key)
            if cached:
                return {**json.loads(cached), "cached": True}
        except Exception:
            pass

    result = score_url(req.url, req.headers, req.body_snippet)
    decision = (
        "BLOCK" if result["score"] >= BLOCK_THRESHOLD
        else "ISOLATE" if result["score"] >= ISOLATE_THRESHOLD
        else "ALLOW"
    )
    out = {
        "score": result["score"],
        "category": result["category"],
        "reason": result["reason"],
        "decision": decision,
        "cached": False,
    }

    if _redis and not req.body_snippet:
        try:
            await _redis.set(cache_key, json.dumps({k: out[k] for k in ("score", "category", "reason", "decision")}), ex=CACHE_TTL)
        except Exception:
            pass
    return out
