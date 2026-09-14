#!/usr/bin/env python3
"""本机「导入订阅链接」页。metacubexd 只能更新已有 Provider，不能粘贴新 URL。

鉴权：首次启动自动生成口令写入 $CLASH_DIR/admin.key（打印一次），
浏览器用 http://<Pi>:9091/?key=<口令> 打开后发 HttpOnly cookie；也接受 Bearer 头。
口令可用 SUB_ADMIN_KEY env 覆盖。
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
from http import cookies as http_cookies
from urllib.parse import parse_qs, urlparse
import hmac
import os
import re
import secrets
import subprocess

CLASH = os.environ.get("CLASH_DIR", "/vol1/1000/valimart-clash")
SUBF = os.path.join(CLASH, "subscriptions.yaml")
APPLY = os.environ.get("APPLY_SH", os.path.join(CLASH, "apply-subscriptions.sh"))
PORT = int(os.environ.get("SUB_ADMIN_PORT", "9091"))
COOKIE = "subadmin_key"


def load_admin_key():
    env = os.environ.get("SUB_ADMIN_KEY")
    if env:
        return env.strip()
    keyfile = os.path.join(CLASH, "admin.key")
    if os.path.isfile(keyfile):
        with open(keyfile, encoding="utf-8") as f:
            v = f.read().strip()
        if v:
            return v
    os.makedirs(CLASH, exist_ok=True)
    v = secrets.token_urlsafe(16)
    with open(keyfile, "w", encoding="utf-8") as f:
        f.write(v + "\n")
    try:
        os.chmod(keyfile, 0o600)
    except OSError:
        pass
    print(f"[sub-admin] 口令已生成：{keyfile} → {v}（浏览器打开 http://<Pi>:{PORT}/?key={v}）")
    return v


ADMIN_KEY = load_admin_key()


def load_items():
    items, cur = [], None
    if not os.path.isfile(SUBF):
        return []
    with open(SUBF, encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            m = re.match(r"^-\s+id:\s*(\S+)", t)
            if m:
                if cur:
                    items.append(cur)
                cur = {"id": m.group(1).strip("\"'"), "name": "", "url": "", "interval": "86400", "prefix": ""}
                continue
            if not cur:
                continue
            kv = re.match(r"^(\w+):\s*(.*)$", t)
            if not kv:
                continue
            k, v = kv.group(1), kv.group(2).strip().strip("\"'")
            if k in cur:
                cur[k] = v
    if cur:
        items.append(cur)
    return items


def yq(s):
    """YQL 双引号标量：转义反斜杠和双引号，杜绝值里带 :/# 破坏结构。"""
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def save_items(items):
    os.makedirs(CLASH, exist_ok=True)
    lines = ["# 树莓派 mihomo 订阅清单", "items:"]
    for it in items:
        iid = re.sub(r"[^a-zA-Z0-9_-]", "", it.get("id") or "") or "sub"
        name = it.get("name") or iid
        url = it.get("url") or ""
        prefix = it.get("prefix") or (name + "/")
        interval = re.sub(r"\D", "", str(it.get("interval") or "")) or "86400"
        lines += [
            f"  - id: {yq(iid)}",
            f"    name: {yq(name)}",
            f"    url: {yq(url)}",
            f"    interval: {interval}",
            f"    prefix: {yq(prefix)}",
        ]
    with open(SUBF, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def apply():
    if not os.path.isfile(APPLY):
        return 1, "找不到 apply-subscriptions.sh"
    r = subprocess.run(["sh", APPLY], capture_output=True, text=True, timeout=120)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


STYLE = """
body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;background:#0f1115;color:#e8e8e8}
a{color:#7cbcff} h1{font-size:20px} .msg{background:#1e3a2f;padding:10px 12px;border-radius:8px;margin:12px 0;white-space:pre-wrap}
.card{background:#1a1d24;border:1px solid #2c313a;border-radius:10px;padding:14px;margin:12px 0}
label{display:block;margin:8px 0 4px;font-size:12px;color:#9aa}
input{width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid #333;background:#111;color:#eee}
.url{font-family:ui-monospace,monospace;font-size:12px}
.row{display:flex;gap:8px;margin-top:12px} button{padding:8px 14px;border:0;border-radius:6px;background:#3b82f6;color:#fff;cursor:pointer}
.danger{background:#7f1d1d} .hint{color:#888;font-size:13px}
"""


def page(msg=""):
    rows = ""
    for it in load_items():
        rows += f"""
        <form method="post" class="card">
          <input type="hidden" name="action" value="save">
          <input type="hidden" name="old_id" value="{esc(it['id'])}">
          <label>ID <input name="id" value="{esc(it['id'])}" required></label>
          <label>名称 <input name="name" value="{esc(it['name'])}"></label>
          <label>订阅链接 <input name="url" value="{esc(it['url'])}" class="url" required></label>
          <label>节点前缀 <input name="prefix" value="{esc(it['prefix'])}"></label>
          <label>刷新秒数 <input name="interval" value="{esc(it['interval'])}"></label>
          <div class="row">
            <button type="submit">保存并重启</button>
            <button type="submit" name="action" value="delete" class="danger">删除</button>
          </div>
        </form>"""
    return f"""<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>导入订阅 · 树莓派 Clash</title>
<style>{STYLE}</style></head><body>
<h1>导入订阅链接</h1>
<p class="hint">metacubexd 面板只能更新已有订阅，不能粘贴新链接。在这里改 URL，保存后会重生配置并重启 mihomo。切节点仍用
<a href="http://10.56.41.60:9090/ui/" target="_blank">节点面板 :9090/ui/</a>（secret 见 mihomo 配置 external-controller）。</p>
{f'<div class="msg">{esc(msg)}</div>' if msg else ''}
{rows}
<form method="post" class="card">
  <h2 style="margin:0 0 8px;font-size:16px">新增订阅</h2>
  <input type="hidden" name="action" value="add">
  <label>ID（英文，如 ikuuu） <input name="id" required></label>
  <label>名称 <input name="name" placeholder="显示名"></label>
  <label>订阅链接 <input name="url" class="url" required placeholder="https://..."></label>
  <label>节点前缀 <input name="prefix" placeholder="iKuuu/"></label>
  <div class="row"><button type="submit">添加并重启</button></div>
</form>
</body></html>"""


def denied():
    body = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>401</title>
<style>{STYLE}</style></head><body><h1>需要口令</h1>
<p class="hint">在树莓派上查看 <code>{os.path.join(CLASH, 'admin.key')}</code>，然后访问
<code>http://&lt;Pi&gt;:{PORT}/?key=口令</code>。也可用请求头 <code>Authorization: Bearer 口令</code>。</p></body></html>"""
    return body.encode("utf-8")


class H(BaseHTTPRequestHandler):
    def _authorized(self, query):
        key = (query.get("key") or [""])[0]
        if key and hmac.compare_digest(key, ADMIN_KEY):
            return "query"
        auth = self.headers.get("Authorization") or ""
        if auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip(), ADMIN_KEY):
            return "bearer"
        try:
            jar = http_cookies.SimpleCookie(self.headers.get("Cookie", ""))
            if COOKIE in jar and hmac.compare_digest(jar[COOKIE].value, ADMIN_KEY):
                return "cookie"
        except http_cookies.CookieError:
            pass
        return None

    def _check(self):
        query = parse_qs(urlparse(self.path).query)
        how = self._authorized(query)
        if how:
            return True, query, how
        self.send_response(401)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        b = denied()
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
        return False, query, None

    def _html(self, body, set_cookie=False):
        b = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        if set_cookie:
            # 口令换会话 cookie：表单 POST 不必每次带 ?key=
            self.send_header("Set-Cookie", f"{COOKIE}={ADMIN_KEY}; HttpOnly; SameSite=Strict; Path=/")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        ok, _q, how = self._check()
        if ok:
            self._html(page(), set_cookie=(how == "query"))

    def do_POST(self):
        ok, _q, _how = self._check()
        if not ok:
            return
        n = int(self.headers.get("Content-Length") or 0)
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode("utf-8")).items()}
        action = form.get("action", "save")
        items = load_items()
        if action == "delete":
            oid = form.get("old_id") or form.get("id")
            items = [x for x in items if x["id"] != oid]
            save_items(items)
            code, out = apply()
            self._html(page(f"已删除 {oid}\n{out[-2000:]}"))
            return
        it = {
            "id": form.get("id", "").strip(),
            "name": form.get("name", "").strip() or form.get("id", "").strip(),
            "url": form.get("url", "").strip(),
            "interval": form.get("interval", "86400").strip() or "86400",
            "prefix": form.get("prefix", "").strip() or (form.get("name") or form.get("id") or "") + "/",
        }
        if not it["id"] or not it["url"]:
            self._html(page("ID 和订阅链接不能为空"))
            return
        oid = form.get("old_id") or it["id"]
        rest = [x for x in items if x["id"] != oid]
        rest.append(it)
        save_items(rest)
        code, out = apply()
        self._html(page(f"已保存 {it['id']}（退出码 {code}）\n{out[-2000:]}"))

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"[sub-admin] 监听 0.0.0.0:{PORT}（口令鉴权；忘记口令看 {os.path.join(CLASH, 'admin.key')} 或设 SUB_ADMIN_KEY）")
    HTTPServer(("0.0.0.0", PORT), H).serve_forever()
