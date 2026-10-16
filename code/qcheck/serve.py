"""論文 007：問題集の人による確かめ。index.html と sample.json を配り、POST /save で checks.json に保存する
使い方: python3 bench/rag-bench/qcheck/serve.py  → http://localhost:3122/
"""
import http.server, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'checks.json')

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=HERE, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == '/checks':
            body = open(OUT, 'rb').read() if os.path.exists(OUT) else b'{}'
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body); return
        if self.path.startswith('/checks.json') or self.path.endswith('.py'): self.send_error(404); return
        super().do_GET()
    def do_POST(self):
        if self.path != '/save': self.send_error(404); return
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with open(OUT, 'w') as f: json.dump(data, f, ensure_ascii=False, indent=1)
        self.send_response(204); self.end_headers()

http.server.ThreadingHTTPServer(('127.0.0.1', 3122), H).serve_forever()
