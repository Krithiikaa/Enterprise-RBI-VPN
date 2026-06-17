"""Precision RBI — risk scorer  [SRV-04]

Heuristic, explainable URL + content risk scoring. No network calls at runtime;
blocklists are loaded from ./blocklists/*.txt bundled at build time (HC-06).

Honest note: this is a transparent heuristic, not a trained model. It catches
obvious phishing / obfuscation / suspicious infrastructure and is meant to be
tuned against your own traffic. See ARCHITECTURE.md §6/§7.
"""
import math
import os
import re
from collections import Counter
from urllib.parse import urlparse

_BLOCKLIST: set[str] = set()
_SUSPICIOUS_TLDS = {
    "zip", "mov", "xyz", "top", "tk", "ml", "ga", "cf", "gq", "work", "click",
    "country", "kim", "cricket", "science", "party", "gdn", "review", "loan",
}
_BRAND_TOKENS = (
    "paypal", "apple", "microsoft", "google", "amazon", "netflix", "bank",
    "secure", "login", "signin", "verify", "account", "update", "wallet",
    "coinbase", "metamask", "office365", "outlook",
)
_SHORTENERS = {"bit.ly", "tinyurl.com", "goo.gl", "t.co", "ow.ly", "is.gd", "buff.ly"}


def load_blocklists(path: str = None) -> int:
    """Load every *.txt under the blocklists dir. One domain per line, '#' comments."""
    path = path or os.path.join(os.path.dirname(__file__), "blocklists")
    _BLOCKLIST.clear()
    if not os.path.isdir(path):
        return 0
    for fn in os.listdir(path):
        if not fn.endswith(".txt"):
            continue
        with open(os.path.join(path, fn), "r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip().lower()
                if line and not line.startswith("#"):
                    # tolerate hosts-file format "0.0.0.0 domain"
                    parts = line.split()
                    _BLOCKLIST.add(parts[-1])
    return len(_BLOCKLIST)


def _shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    counts = Counter(s)
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def extract_features(url: str) -> dict:
    p = urlparse(url if "://" in url else "http://" + url)
    host = (p.hostname or "").lower()
    labels = host.split(".") if host else []
    tld = labels[-1] if labels else ""
    domain = ".".join(labels[-2:]) if len(labels) >= 2 else host
    path = p.path or ""
    query = p.query or ""

    return {
        "url": url,
        "host": host,
        "domain": domain,
        "tld": tld,
        "subdomain_depth": max(0, len(labels) - 2),
        "host_len": len(host),
        "host_entropy": round(_shannon_entropy(host), 3),
        "path_depth": len([s for s in path.split("/") if s]),
        "query_params": len([q for q in query.split("&") if q]),
        "special_chars": len(re.findall(r"[^a-zA-Z0-9./:?=&_-]", url)),
        "digit_ratio": round(sum(c.isdigit() for c in host) / max(1, len(host)), 3),
        "has_punycode": host.startswith("xn--") or ".xn--" in host,
        "is_ip_literal": bool(re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host)),
        "has_at": "@" in url,
        "url_len": len(url),
    }


def score_url(url: str, headers: dict | None = None, body_snippet: str | None = None) -> dict:
    f = extract_features(url)
    score = 0
    reasons = []

    # Hard signals -------------------------------------------------------------
    if f["domain"] in _BLOCKLIST or f["host"] in _BLOCKLIST:
        return {"score": 100, "category": "MALWARE", "reason": "domain on bundled blocklist", "features": f}

    if f["is_ip_literal"]:
        score += 35; reasons.append("raw IP literal as host")
    if f["has_at"]:
        score += 30; reasons.append("'@' in URL (credential-confusion)")
    if f["has_punycode"]:
        score += 25; reasons.append("punycode host (possible homograph)")

    # Infrastructure heuristics ------------------------------------------------
    if f["tld"] in _SUSPICIOUS_TLDS:
        score += 18; reasons.append(f"high-risk TLD .{f['tld']}")
    if f["subdomain_depth"] >= 4:
        score += 15; reasons.append("deep subdomain nesting")
    if f["host_entropy"] > 3.6 and f["host_len"] > 12:
        score += 18; reasons.append("high host entropy (DGA-like)")
    if f["digit_ratio"] > 0.3:
        score += 10; reasons.append("digit-heavy host")
    if f["url_len"] > 120:
        score += 8; reasons.append("very long URL")
    if f["special_chars"] > 6:
        score += 8; reasons.append("many special chars in URL")
    if f["domain"] in _SHORTENERS:
        score += 12; reasons.append("URL shortener")

    # Brand-impersonation: brand token in subdomain/path but not the registered domain
    low = url.lower()
    for tok in _BRAND_TOKENS:
        if tok in low and tok not in f["domain"]:
            score += 14; reasons.append(f"brand token '{tok}' outside registered domain")
            break

    # Content heuristics (optional) -------------------------------------------
    if body_snippet:
        b = body_snippet.lower()
        if re.search(r"eval\(|atob\(|unescape\(|fromcharcode|document\.write\(", b):
            score += 16; reasons.append("JS obfuscation patterns in body")
        iframe_depth = b.count("<iframe")
        if iframe_depth >= 3:
            score += 10; reasons.append(f"{iframe_depth} iframes (nesting)")
        if "data:text/html" in b or b.count("data:") > 4:
            score += 12; reasons.append("data: URI abuse")
        if re.search(r"type=[\"']password[\"']", b) and "http://" in b:
            score += 14; reasons.append("password field on insecure form")

    score = max(0, min(100, score))
    if score >= 80:
        category = "PHISHING" if any("brand" in r or "password" in r for r in reasons) else "MALWARE"
    elif score >= 50:
        category = "SUSPICIOUS"
    elif score == 0:
        category = "TRUSTED"
    else:
        category = "UNKNOWN"

    return {
        "score": score,
        "category": category,
        "reason": "; ".join(reasons) if reasons else "no risk signals",
        "features": f,
    }
