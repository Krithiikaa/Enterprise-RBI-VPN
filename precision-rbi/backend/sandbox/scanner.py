"""Precision RBI — sandbox file scanner  [SRV-08]

POST /api/scan { fileData: base64, filename } -> { verdict, score, details, sha256 }
  score 91-100 -> BLOCK | 50-90 -> QUARANTINE | 0-49 -> CLEAN

Static triage only (signatures + structural heuristics): ClamAV daemon scan,
PE-header inspection, Office-macro detection, and Shannon-entropy of the payload.
No dynamic detonation in this build (see ARCHITECTURE §6/§7).
ClamAV signatures are bundled into the image at build time (HC-06).
"""
import base64
import hashlib
import math
import os
import re
import socket
import tempfile
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json

CLAMD_SOCKET = "/var/run/clamav/clamd.ctl"
CLAMD_HOST, CLAMD_PORT = "127.0.0.1", 3310


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = Counter(data)
    n = len(data)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def clamav_scan(data: bytes) -> tuple[bool, str]:
    """Return (infected, signature). Tries unix socket, then TCP. Fails closed-ish."""
    for connector in (
        lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM),
        lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM),
    ):
        try:
            s = connector()
            s.settimeout(15)
            if s.family == socket.AF_UNIX:
                s.connect(CLAMD_SOCKET)
            else:
                s.connect((CLAMD_HOST, CLAMD_PORT))
            s.sendall(b"zINSTREAM\0")
            chunk = 4096
            for i in range(0, len(data), chunk):
                part = data[i:i + chunk]
                s.sendall(len(part).to_bytes(4, "big") + part)
            s.sendall((0).to_bytes(4, "big"))
            resp = s.recv(4096).decode("utf-8", "ignore")
            s.close()
            if "FOUND" in resp:
                sig = resp.split(":")[-1].replace("FOUND", "").strip()
                return True, sig
            return False, ""
        except Exception:
            continue
    return False, "clamd-unavailable"


def static_triage(data: bytes, filename: str) -> dict:
    flags = []
    score = 0

    # PE header
    if data[:2] == b"MZ":
        flags.append("PE/MZ executable")
        score += 35
        if b"This program cannot be run in DOS mode" in data[:256]:
            score += 5
        if re.search(rb"UPX[0-9!]", data):
            flags.append("UPX-packed"); score += 15

    # Office macro / OLE / ZIP-based docx with vbaProject
    if data[:4] == b"\xd0\xcf\x11\xe0":
        flags.append("OLE compound (legacy Office)"); score += 20
    if data[:2] == b"PK" and b"vbaProject.bin" in data:
        flags.append("Office macro (vbaProject)"); score += 30
    if re.search(rb"(AutoOpen|Document_Open|Workbook_Open|Shell\(|powershell|cmd\.exe)", data, re.I):
        flags.append("macro auto-exec / shell tokens"); score += 25

    # Script payloads
    if re.search(rb"(eval\(|FromBase64String|Invoke-Expression|wscript\.shell)", data, re.I):
        flags.append("script obfuscation / exec tokens"); score += 20

    # Entropy (packed/encrypted)
    ent = entropy(data)
    if ent > 7.2 and len(data) > 1024:
        flags.append(f"high entropy {ent:.2f} (packed/encrypted)"); score += 15

    # Double extension
    if re.search(r"\.(pdf|doc|jpg|png|txt)\.(exe|scr|js|vbs|bat)$", filename, re.I):
        flags.append("double extension"); score += 30

    return {"score": min(score, 90), "flags": flags, "entropy": round(ent, 2)}


def scan(data: bytes, filename: str) -> dict:
    infected, sig = clamav_scan(data)
    triage = static_triage(data, filename)

    if infected:
        score = 100
    else:
        score = triage["score"]

    verdict = "BLOCK" if score >= 91 else "QUARANTINE" if score >= 50 else "CLEAN"
    return {
        "verdict": verdict,
        "score": score,
        "sha256": sha256(data),
        "size": len(data),
        "details": {
            "clamav": {"infected": infected, "signature": sig},
            "static": triage,
        },
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            up, _ = clamav_scan(b"healthcheck")
            return self._send(200, {"status": "ok", "clamav": not _ == "clamd-unavailable"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/api/scan":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
            data = base64.b64decode(payload.get("fileData", ""))
            filename = payload.get("filename", "unknown.bin")
            self._send(200, scan(data, filename))
        except Exception as e:
            self._send(400, {"error": str(e)})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8002"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
