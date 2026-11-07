#!/usr/bin/env python3
"""정적 파일 + 관리자 API 서버 (표준 라이브러리만 사용).

  ADMIN_ID=admin ADMIN_PASSWORD=비밀번호 python server.py        # http://localhost:8000
  관리자 화면: /admin  → 로그인 후 '최신 데이터로 갱신' = python run.py all 실행

환경변수: PORT(기본 8000), ADMIN_ID, ADMIN_PASSWORD, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, GEMINI_API_KEY(선택)
"""
import hmac
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ADMIN_ID = os.environ.get("ADMIN_ID", "")
ADMIN_PW = os.environ.get("ADMIN_PASSWORD", "")
SESSIONS = {}          # token -> 만료 시각
SESSION_TTL = 8 * 3600
JOB = {"state": "idle", "message": "", "started": None}
LOCK = threading.Lock()
PUBLIC = {"/", "/index.html", "/report.html", "/data.js", "/admin"}


def run_job():
    with LOCK:
        JOB.update(state="running", message="수집 시작", started=time.time())
    try:
        for step in ("collect", "build", "report"):
            JOB["message"] = f"({step})"
            r = subprocess.run([sys.executable, str(ROOT / "run.py"), step], cwd=ROOT, capture_output=True, text=True, timeout=3600)
            if r.returncode:
                raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else f"{step} 실패")
        JOB.update(state="done", message="완료")
    except Exception as e:
        JOB.update(state="failed", message=f"수집 실패: {e}")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # ── 도우미 ──
    def send_json(self, code, body, extra_headers=()):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        for k, v in extra_headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def is_admin(self):
        c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        tok = c["sid"].value if "sid" in c else None
        exp = SESSIONS.get(tok)
        return bool(exp and exp > time.time())

    # ── 라우팅 ──
    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/admin", "/admin/"):
            self.path = "/index.html"
            return super().do_GET()
        if path == "/api/admin/me":
            return self.send_json(200, {"admin": self.is_admin()})
        if path == "/api/refresh-status":
            if not self.is_admin():
                return self.send_json(401, {"message": "로그인이 필요합니다."})
            enabled = bool(os.environ.get("NAVER_CLIENT_ID") and os.environ.get("NAVER_CLIENT_SECRET"))
            return self.send_json(200, {"enabled": enabled, **JOB,
                                        "message": JOB["message"] if enabled else "서버에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 설정되지 않았습니다."})
        # 원본 저장소·설정·코드 파일은 공개하지 않음
        if not (path in PUBLIC or path.startswith("/assets/")):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/admin/login":
            n = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(min(n, 10_000)) or b"{}")
            except ValueError:
                body = {}
            if not ADMIN_ID or not ADMIN_PW:
                return self.send_json(503, {"message": "서버에 ADMIN_ID / ADMIN_PASSWORD 가 설정되지 않았습니다."})
            ok = hmac.compare_digest(str(body.get("id", "")), ADMIN_ID) & hmac.compare_digest(str(body.get("password", "")), ADMIN_PW)
            if not ok:
                time.sleep(1)
                return self.send_json(401, {"message": "아이디 또는 비밀번호가 올바르지 않습니다."})
            tok = secrets.token_urlsafe(32)
            SESSIONS[tok] = time.time() + SESSION_TTL
            return self.send_json(200, {"ok": True}, [("Set-Cookie", f"sid={tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}")])
        if path == "/api/admin/logout":
            c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
            if "sid" in c:
                SESSIONS.pop(c["sid"].value, None)
            return self.send_json(200, {"ok": True}, [("Set-Cookie", "sid=; Path=/; Max-Age=0")])
        if path == "/api/refresh":
            if not self.is_admin():
                return self.send_json(401, {"message": "로그인이 필요합니다."})
            if not (os.environ.get("NAVER_CLIENT_ID") and os.environ.get("NAVER_CLIENT_SECRET")):
                return self.send_json(400, {"message": "서버에 네이버 API 키가 설정되지 않았습니다."})
            if JOB["state"] == "running":
                return self.send_json(202, {"message": "이미 수집이 진행 중입니다."})
            threading.Thread(target=run_job, daemon=True).start()
            return self.send_json(202, {"message": "수집을 시작했습니다."})
        self.send_error(404)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"http://localhost:{port}  (관리자: /admin)")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
