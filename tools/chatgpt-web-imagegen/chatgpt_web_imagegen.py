#!/usr/bin/env python3
"""Generate an image through a logged-in ChatGPT web page via browser-control."""

from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_PROXY_CANDIDATES = (
    "http://127.0.0.1:3456",
    "http://localhost:3456",
)


class WebImageGenError(RuntimeError):
    pass


def request_json(method: str, url: str, data: str | None = None, timeout: int = 20) -> Any:
    body = data.encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", "text/plain; charset=utf-8")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read().decode("utf-8", errors="replace")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def first_scalar(value: Any) -> Any:
    if isinstance(value, dict):
        for key in ("value", "result", "data"):
            if key in value:
                found = value[key]
                if isinstance(found, (dict, list)):
                    return found
                return first_scalar(found)
        return value
    if isinstance(value, list):
        return value
    return value


def eval_js(proxy_url: str, target_id: str, js: str, timeout: int = 20) -> Any:
    target = urllib.parse.quote(target_id, safe="")
    response = request_json("POST", f"{proxy_url}/eval?target={target}", js, timeout=timeout)
    return first_scalar(response)


def click_at(proxy_url: str, target_id: str, selector: str) -> None:
    query = urllib.parse.urlencode({"target": target_id})
    try:
        request_json("POST", f"{proxy_url}/clickAt?{query}", selector, timeout=20)
    except urllib.error.HTTPError as exc:
        raise WebImageGenError(f"failed to click send button with selector {selector}: {exc}") from exc


def resolve_proxy_url(explicit: str | None) -> str:
    candidates: list[str] = []
    if explicit:
        candidates.append(explicit.rstrip("/"))
    env_proxy = os.environ.get("BROWSER_CONTROL_PROXY_URL")
    if env_proxy:
        candidates.append(env_proxy.rstrip("/"))
    candidates.extend(DEFAULT_PROXY_CANDIDATES)

    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            request_json("GET", f"{candidate}/health", timeout=3)
            return candidate
        except Exception:
            try:
                request_json("GET", f"{candidate}/targets", timeout=3)
                return candidate
            except Exception:
                continue
    raise WebImageGenError(
        "no browser-control proxy reachable; start $browse/browser-control or pass --proxy-url"
    )


def list_targets(proxy_url: str) -> list[dict[str, Any]]:
    targets = request_json("GET", f"{proxy_url}/targets", timeout=10)
    if isinstance(targets, dict):
        for key in ("targets", "data", "result", "value"):
            if isinstance(targets.get(key), list):
                return targets[key]
    if isinstance(targets, list):
        return targets
    raise WebImageGenError("browser-control /targets returned an unexpected response")


def target_id(target: dict[str, Any]) -> str | None:
    value = target.get("id") or target.get("targetId") or target.get("target_id")
    return str(value) if value else None


def find_or_open_chatgpt(proxy_url: str) -> str:
    # Keep bot requests out of the user's existing conversations. web-access
    # 2.5.3+ takes the destination URL in a POST body.
    created = first_scalar(request_json(
        "POST", f"{proxy_url}/new", "https://chatgpt.com/", timeout=30
    ))
    if isinstance(created, dict):
        tid = target_id(created)
    else:
        tid = first_scalar(created)
    if not isinstance(tid, str) or not tid:
        raise WebImageGenError("opened ChatGPT but could not resolve the target id")
    time.sleep(3)
    return tid


def ensure_logged_in(proxy_url: str, target: str) -> None:
    js = """
(() => {
  const text = document.body ? document.body.innerText : "";
  const hasComposer = !!document.querySelector('[contenteditable="true"], textarea[aria-label*="ChatGPT"], textarea[aria-label*="聊天"], [role="textbox"]');
  return {title: document.title, url: location.href, hasComposer, text: text.slice(0, 2000)};
})()
"""
    state = None
    for _ in range(30):
        state = eval_js(proxy_url, target, js, timeout=20)
        if isinstance(state, dict) and state.get("hasComposer") and state.get("url", "").startswith("https://chatgpt.com/"):
            break
        time.sleep(1)
    if isinstance(state, str):
        try:
            state = json.loads(state)
        except json.JSONDecodeError:
            state = {"text": state}
    text = str((state or {}).get("text") or "")
    has_composer = bool((state or {}).get("hasComposer"))
    if ("登录" in text and "免费注册" in text) or ("Log in" in text and "Sign up" in text):
        raise WebImageGenError("ChatGPT page is not logged in; log in through Chrome, then retry")
    if not has_composer:
        raise WebImageGenError("ChatGPT composer not found; open a normal ChatGPT chat and retry")


def upload_reference(proxy_url: str, target: str, file: str) -> None:
    path = Path(file).expanduser().resolve()
    if not path.is_file() or path.stat().st_size > 20 * 1024 * 1024:
        raise WebImageGenError("reference image missing or larger than 20 MiB")
    ready_js = """(() => ({ready: !!document.querySelector('input[type="file"][accept="image/*"]')}))()"""
    for _ in range(30):
        ready = eval_js(proxy_url, target, ready_js)
        if isinstance(ready, dict) and ready.get("ready"):
            break
        time.sleep(1)
    else:
        raise WebImageGenError("reference image upload control not available")
    query = urllib.parse.urlencode({"target": target})
    result = request_json("POST", f"{proxy_url}/setFiles?{query}", json.dumps({
        "selector": 'input[type="file"][accept="image/*"]', "files": [str(path)]
    }), timeout=30)
    if not isinstance(result, dict) or not result.get("success"):
        raise WebImageGenError("reference image upload failed")
    time.sleep(2)


def current_image_sources(proxy_url: str, target: str) -> set[str]:
    js = """
(() => Array.from(document.querySelectorAll('main img'))
    .filter(img => /^(?:已生成图像|生成的图片|Generated image|Image created|Created image)/i.test(img.alt || '') || !!img.closest('[data-message-author-role="assistant"]'))
    .filter(img => img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256)
    .map(img => img.currentSrc || img.src || "")
  .filter(src => /estuary\\/content|files\\/download|oaiusercontent|blob:/.test(src)))()
"""
    sources = eval_js(proxy_url, target, js, timeout=20)
    if isinstance(sources, str):
        try:
            sources = json.loads(sources)
        except json.JSONDecodeError:
            sources = []
    return {str(src) for src in sources or [] if src}


def select_thinking_level(proxy_url: str, target: str, level: str) -> None:
    labels = {
        "fast": "极速",
        "balanced": "均衡",
        "advanced": "高级",
        "ultra": "超高",
        "pro": "Pro 扩展",
        "gpt-5.5": "GPT-5.5",
    }
    label = labels[level]
    label_json = json.dumps(label)
    js = f"""
(() => {{
  const label = {label_json};
  const pill = document.querySelector('button.__composer-pill');
  if (!pill) return {{ok:false, error:'thinking level button not found'}};
  if ((pill.innerText || '').trim() === label) return {{ok:true, changed:false, label}};
  pill.click();
  return new Promise(resolve => {{
    let attempts = 0;
    const timer = setInterval(() => {{
      attempts += 1;
      const items = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'));
      const item = items.find(el => (el.innerText || '').trim() === label);
      if (item) {{
        clearInterval(timer);
        item.click();
        setTimeout(() => {{
          const current = (document.querySelector('button.__composer-pill')?.innerText || '').trim();
          resolve(current === label ? {{ok:true, changed:true, label}} : {{ok:false, error:`selected ${{label}} but current is ${{current}}`}});
        }}, 300);
      }} else if (attempts >= 20) {{
        clearInterval(timer);
        resolve({{ok:false, error:`thinking level option not found: ${{label}}`}});
      }}
    }}, 100);
  }});
}})()
"""
    result = eval_js(proxy_url, target, js, timeout=20)
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            result = {"ok": False, "error": result}
    if not isinstance(result, dict) or not result.get("ok"):
        raise WebImageGenError(f"failed to select ChatGPT thinking level: {result}")


def submit_prompt(proxy_url: str, target: str, prompt: str) -> None:
    prompt_json = json.dumps(prompt)
    fill_js = f"""
(() => {{
  const prompt = {prompt_json};
  const editor = document.querySelector('div#prompt-textarea[contenteditable="true"], [contenteditable="true"][role="textbox"]');
  if (editor) {{
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, prompt);
    editor.dispatchEvent(new InputEvent('input', {{bubbles:true, inputType:'insertText', data:prompt}}));
    editor.dispatchEvent(new Event('change', {{bubbles:true}}));
    return {{ok:true, mode:'prosemirror', text:(editor.innerText || '').slice(0, 80)}};
  }}
  const boxes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'));
  const box = boxes.find(el => {{
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    const text = (el.innerText || el.value || '').trim();
    return !el.disabled && (label.includes('chatgpt') || label.includes('聊天') || label.includes('message') || text.length === 0);
  }}) || boxes[0];
  if (!box) return {{ok:false, error:'composer not found'}};
  box.focus();
  if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {{
    box.value = prompt;
  }} else {{
    box.textContent = prompt;
  }}
  box.dispatchEvent(new InputEvent('input', {{bubbles:true, inputType:'insertText', data:prompt}}));
  box.dispatchEvent(new Event('change', {{bubbles:true}}));
  return {{ok:true, mode:'fallback'}};
}})()
"""
    result = eval_js(proxy_url, target, fill_js, timeout=20)
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            result = {"ok": False, "error": result}
    if not isinstance(result, dict) or not result.get("ok"):
        raise WebImageGenError(f"failed to fill ChatGPT prompt: {result}")

    mark_send_js = """
(() => {
  const button = document.querySelector('button.composer-submit-btn:not(:disabled)') ||
    Array.from(document.querySelectorAll('button')).find(btn => {
    const label = (btn.getAttribute('aria-label') || btn.innerText || '').toLowerCase();
    return !btn.disabled && (
      label.includes('send') ||
      label.includes('发送') ||
      label.includes('submit')
    );
  });
  if (!button) return {ok:false};
  button.setAttribute('data-codex-web-imagegen-send', '1');
  return {ok:true};
})()
"""
    marked = None
    for _ in range(20):
        marked = eval_js(proxy_url, target, mark_send_js, timeout=20)
        if isinstance(marked, str):
            try:
                marked = json.loads(marked)
            except json.JSONDecodeError:
                marked = None
        if isinstance(marked, dict) and marked.get("ok"):
            break
        time.sleep(0.25)
    if isinstance(marked, str):
        try:
            marked = json.loads(marked)
        except json.JSONDecodeError:
            marked = None
    if not isinstance(marked, dict) or not marked.get("ok"):
        raise WebImageGenError("send button not found or still disabled")
    click_at(proxy_url, target, '[data-codex-web-imagegen-send="1"]')


def wait_for_new_image(proxy_url: str, target: str, old_sources: set[str], timeout: int) -> str:
    deadline = time.time() + timeout
    last_src = ""
    stable_seen_at = 0.0
    while time.time() < deadline:
        sources = current_image_sources(proxy_url, target)
        new_sources = [src for src in sources if src not in old_sources]
        if new_sources:
            src = new_sources[-1]
            if src == last_src:
                if stable_seen_at and time.time() - stable_seen_at >= 3:
                    return src
            else:
                last_src = src
                stable_seen_at = time.time()
        time.sleep(3)
    raise WebImageGenError(f"timed out after {timeout}s waiting for a new ChatGPT image")


def fetch_image_base64(proxy_url: str, target: str, src: str) -> bytes:
    src_json = json.dumps(src)
    js = f"""
async () => {{
  const src = {src_json};
  const response = await fetch(src, {{credentials: 'include'}});
  if (!response.ok) return {{ok:false, status:response.status, text:await response.text()}};
  const blob = await response.blob();
  const dataUrl = await new Promise((resolve, reject) => {{
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  }});
  return {{ok:true, type:blob.type, size:blob.size, dataUrl}};
}}
"""
    result = eval_js(proxy_url, target, f"({js})()", timeout=120)
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError as exc:
            raise WebImageGenError("browser image fetch returned non-JSON data") from exc
    if not isinstance(result, dict) or not result.get("ok"):
        raise WebImageGenError(f"browser image fetch failed: {result}")
    data_url = str(result.get("dataUrl") or "")
    if "," not in data_url:
        raise WebImageGenError("browser image fetch returned an invalid data URL")
    return base64.b64decode(data_url.split(",", 1)[1])


def image_dimensions(data: bytes) -> tuple[int | None, int | None]:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8X" and len(data) >= 30:
            width = int.from_bytes(data[24:27], "little") + 1
            height = int.from_bytes(data[27:30], "little") + 1
            return width, height
    if data.startswith(b"\xff\xd8"):
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            i += 2
            if marker in (0xD8, 0xD9):
                continue
            if i + 2 > len(data):
                break
            length = int.from_bytes(data[i : i + 2], "big")
            if marker in range(0xC0, 0xC4) and i + 7 < len(data):
                height = int.from_bytes(data[i + 3 : i + 5], "big")
                width = int.from_bytes(data[i + 5 : i + 7], "big")
                return width, height
            i += length
    return None, None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate an image through the user's logged-in ChatGPT web page."
    )
    prompt_group = parser.add_mutually_exclusive_group(required=True)
    prompt_group.add_argument("--prompt", help="Image prompt to submit to ChatGPT.")
    prompt_group.add_argument("--prompt-stdin", action="store_true", help="Read the prompt from stdin.")
    parser.add_argument("--reference", action="append", default=[], help="Local reference image, at most two.")
    parser.add_argument("--out", required=True, help="Workspace path for the saved image.")
    parser.add_argument("--proxy-url", help="Browser-control proxy URL. Overrides env/defaults.")
    parser.add_argument("--timeout", type=int, default=300, help="Seconds to wait for a new image.")
    parser.add_argument(
        "--thinking-level",
        choices=("fast", "balanced", "advanced", "ultra", "pro", "gpt-5.5"),
        help="Optional ChatGPT web thinking level to select before submitting. Omit to keep the page's current selection.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    prompt = sys.stdin.read(6000).strip() if args.prompt_stdin else args.prompt
    if not prompt or len(prompt) > 5000 or len(args.reference) > 2:
        raise WebImageGenError("prompt must contain 1-5000 characters and at most two references")
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        proxy_url = resolve_proxy_url(args.proxy_url)
        target = find_or_open_chatgpt(proxy_url)
        ensure_logged_in(proxy_url, target)
        for file in args.reference:
            upload_reference(proxy_url, target, file)
        if args.thinking_level:
            select_thinking_level(proxy_url, target, args.thinking_level)
        old_sources = current_image_sources(proxy_url, target)
        submit_prompt(proxy_url, target, prompt)
        src = wait_for_new_image(proxy_url, target, old_sources, args.timeout)
        data = fetch_image_base64(proxy_url, target, src)
        out_path.write_bytes(data)
        width, height = image_dimensions(data)
    except WebImageGenError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    metadata = {
        "path": str(out_path),
        "width": width,
        "height": height,
        "bytes": len(data),
        "proxy_url": proxy_url,
        "target": target,
    }
    print(json.dumps(metadata, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
