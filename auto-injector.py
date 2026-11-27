import asyncio
import json
import signal
import sys
import threading
import urllib.request
from pathlib import Path
import websockets
import datetime
import time

# When stdout is redirected to a file (tray runner) Windows defaults to cp1252, and printing
# a console message with e.g. "≈" or emoji raised UnicodeEncodeError, which dropped the CDP
# connection. Always write UTF-8 and never fail on an unencodable character.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

DEBUG_PORT = 9222
# The Designer can start more than one embedded Chromium engine, each asking for the same
# debug port. The first to bind gets 127.0.0.1, the next falls back to [::1], and which
# engine holds the Perspective pages varies per launch. "localhost" resolves to ::1 first
# on Windows, so watch both addresses explicitly instead.
DEBUG_HOSTS = ("127.0.0.1", "[::1]")

# Never route local debug traffic through a system proxy
_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# Runtime.enable replays the page's whole console history; ignore anything logged
# before we attached (keyed by session id, value = epoch ms at attach time)
attach_times: dict[str, float] = {}
SCRIPTS_DIR = Path(__file__).parent / "scripts"
IGNORED_TITLES = {"DrawingEditor"}

# JS snippet to strip all injected UI, listeners, observers, and globals from a live tab
CLEANUP_JS = r"""
(() => {
  let removedAny = false;
  if (document.getElementById('__ignition-custom-toolbar-host')) {
    document.getElementById('__ignition-custom-toolbar-host').remove();
    removedAny = true;
  }
  if (document.getElementById('__ignition-custom-toolbar-menu')) {
    document.getElementById('__ignition-custom-toolbar-menu').remove();
    removedAny = true;
  }
  if (document.getElementById('__ignition-custom-toolbar-restore')) {
    document.getElementById('__ignition-custom-toolbar-restore').remove();
    removedAny = true;
  }
  if (window.__toolbarDockObserver) {
    window.__toolbarDockObserver.disconnect();
    delete window.__toolbarDockObserver;
    removedAny = true;
  }
  if (window.__toolbarMenuCloser) {
    window.removeEventListener('pointerdown', window.__toolbarMenuCloser, true);
    delete window.__toolbarMenuCloser;
    removedAny = true;
  }
  if (window.__toolbarZoomHandler) {
    window.removeEventListener('resize', window.__toolbarZoomHandler);
    window.visualViewport?.removeEventListener('resize', window.__toolbarZoomHandler);
    delete window.__toolbarZoomHandler;
    removedAny = true;
  }
  if (window.__toolbarKeyHandler) {
    window.removeEventListener('keydown', window.__toolbarKeyHandler, true);
    delete window.__toolbarKeyHandler;
    removedAny = true;
  }
  if (window.__centerSelectionHandler) {
    window.removeEventListener('keydown', window.__centerSelectionHandler, true);
    delete window.__centerSelectionHandler;
    removedAny = true;
  }
  if (window.__centerSelectionObserver) {
    window.__centerSelectionObserver.disconnect();
    delete window.__centerSelectionObserver;
    removedAny = true;
  }
  if (window.__selectionObserver) {
    window.__selectionObserver.disconnect();
    delete window.__selectionObserver;
    removedAny = true;
  }
  if (window.__centerSelectionInteractionHandler) {
    window.removeEventListener('mousedown', window.__centerSelectionInteractionHandler, true);
    window.removeEventListener('pointerdown', window.__centerSelectionInteractionHandler, true);
    window.removeEventListener('wheel', window.__centerSelectionInteractionHandler, true);
    delete window.__centerSelectionInteractionHandler;
    removedAny = true;
  }
  if (window.__centerSelectionScrollHandler) {
    window.removeEventListener('scroll', window.__centerSelectionScrollHandler, true);
    delete window.__centerSelectionScrollHandler;
    removedAny = true;
  }
  if (window.__toolbarHiddenSync) {
    window.removeEventListener('storage', window.__toolbarHiddenSync);
    window.removeEventListener('focus', window.__toolbarHiddenSync);
    delete window.__toolbarHiddenSync;
    removedAny = true;
  }
  if (window.__zoomKeyHandler) {
    window.removeEventListener('keydown', window.__zoomKeyHandler, true);
    delete window.__zoomKeyHandler;
    removedAny = true;
  }
  if (document.body && document.body.style.zoom) {
    document.body.style.zoom = '';
    removedAny = true;
  }
  for (const key of ['__toolbarQueue', 'DesignerToolbar', 'DesignerFind', 'DesignerZoom', '__designerZoomLevel']) {
    if (key in window) {
      delete window[key];
      removedAny = true;
    }
  }
  if (removedAny) {
    console.log('[Cleanup] All injected scripts and UI removed.');
  }
})();
"""


def is_ignored_target(target_info: dict) -> bool:
    title = target_info.get("title", "")
    url = target_info.get("url", "")
    return any(ignored in title for ignored in IGNORED_TITLES) or "drawing-editor" in url.lower()


def is_replayed(session_id: str | None, params: dict) -> bool:
    """True for console/exception events that happened before we attached to the session."""
    attached = attach_times.get(session_id)
    ts = params.get("timestamp")
    # Small slack so messages from our own injected scripts are never dropped
    return attached is not None and isinstance(ts, (int, float)) and ts < attached - 250


def load_scripts(directory: Path) -> list[tuple[str, str]]:
    directory.mkdir(parents=True, exist_ok=True)
    scripts = []
    for js_file in sorted(directory.glob("*.js")):
        try:
            scripts.append((js_file.name, js_file.read_text(encoding="utf-8")))
        except Exception as e:
            print(f"[Error] Failed to read {js_file.name}: {e}")
    return scripts


def format_console_args(args: list[dict]) -> str:
    parts = []
    for arg in args:
        if "value" in arg:
            val = arg["value"]
            parts.append(json.dumps(val) if isinstance(val, (dict, list)) else str(val))
        elif "unserializableValue" in arg:
            parts.append(arg["unserializableValue"])
        elif "description" in arg:
            parts.append(arg["description"])
        else:
            parts.append(f"[{arg.get('type', 'unknown')}]")
    return " ".join(parts)


def get_browser_ws_url(host: str, port: int) -> str:
    with _http.open(f"http://{host}:{port}/json/version", timeout=2) as resp:
        ws_url = json.loads(resp.read().decode())["webSocketDebuggerUrl"]
    # Chromium reports ws://localhost:..., which may resolve to the *other* engine; pin the host
    return f"ws://{host}:{port}/devtools/{ws_url.split('/devtools/', 1)[1]}"


async def send_cdp(ws, method: str, msg_id: int, session_id: str | None = None, params: dict | None = None) -> int:
    payload = {"id": msg_id, "method": method}
    if session_id:
        payload["sessionId"] = session_id
    if params is not None:
        payload["params"] = params
    await ws.send(json.dumps(payload))
    return msg_id + 1


async def inject_into_session(
    ws,
    session_id: str,
    target_info: dict,
    msg_id: int,
    injected_sessions: set[str],
) -> int:
    if session_id in injected_sessions:
        return msg_id

    url = target_info.get("url", "")
    label = target_info.get("title") or url or session_id[:8]

    attach_times[session_id] = time.time() * 1000
    msg_id = await send_cdp(ws, "Page.enable", msg_id, session_id=session_id)
    msg_id = await send_cdp(ws, "Runtime.enable", msg_id, session_id=session_id)

    # Always run cleanup first so re-attaching starts from a clean slate
    msg_id = await send_cdp(
        ws,
        "Runtime.evaluate",
        msg_id,
        session_id=session_id,
        params={"expression": CLEANUP_JS},
    )

    scripts = load_scripts(SCRIPTS_DIR)
    if not scripts:
        print(f"[Warning] No .js files found in {SCRIPTS_DIR.resolve()}")
        injected_sessions.add(session_id)
        return msg_id

    for filename, source in scripts:
        tagged_source = f"{source}\n//# sourceURL=injected/{filename}"
        msg_id = await send_cdp(
            ws,
            "Page.addScriptToEvaluateOnNewDocument",
            msg_id,
            session_id=session_id,
            params={"source": tagged_source},
        )

        if url and url != "about:blank":
            msg_id = await send_cdp(
                ws,
                "Runtime.evaluate",
                msg_id,
                session_id=session_id,
                params={"expression": tagged_source},
            )

    injected_sessions.add(session_id)
    print(f"[Injected {len(scripts)} script(s)] -> {label} #{session_id[:6]}")
    return msg_id


async def cleanup_all_sessions(
    ws,
    sessions: dict[str, str],
    injected_sessions: set[str],
    msg_id: int,
) -> int:
    """Runs CLEANUP_JS across all active sessions, waits for execution to finish, and detaches."""
    eval_ids: set[int] = set()

    for sid, label in list(sessions.items()):
        eval_id = msg_id
        eval_ids.add(eval_id)
        msg_id = await send_cdp(
            ws,
            "Runtime.evaluate",
            msg_id,
            session_id=sid,
            params={"expression": CLEANUP_JS},
        )
        print(f"[Cleaning] -> {label} #{sid[:6]}")

    # Drain incoming frames until every CLEANUP_JS Runtime.evaluate reply returns (or timeout)
    if eval_ids:
        deadline = asyncio.get_running_loop().time() + 3.0
        while eval_ids and asyncio.get_running_loop().time() < deadline:
            remaining = max(0.05, deadline - asyncio.get_running_loop().time())
            try:
                raw_msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            try:
                msg = json.loads(raw_msg)
            except Exception:
                continue

            if "id" in msg and msg["id"] in eval_ids:
                eval_ids.discard(msg["id"])
            elif msg.get("method") == "Runtime.consoleAPICalled":
                sid = msg.get("sessionId")
                if sid in sessions:
                    params = msg.get("params", {})
                    level = params.get("type", "log").upper()
                    text = format_console_args(params.get("args", []))
                    # print(f"[{sessions[sid]} #{sid[:6]}] [Console:{level}] {text}")
                    ts = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
                    print(f"[{ts}] [{sessions[sid]} #{sid[:6]}] [Console:{level}] {text}")

    for sid, label in list(sessions.items()):
        msg_id = await send_cdp(
            ws,
            "Target.detachFromTarget",
            msg_id,
            params={"sessionId": sid},
        )
        print(f"[Detached] -> {label} #{sid[:6]}")

    sessions.clear()
    injected_sessions.clear()
    return msg_id


async def watch_designer(clean_only: bool = False):
    SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()

    # Signals (SIGINT, SIGTERM, SIGBREAK)
    signals = [signal.SIGINT, signal.SIGTERM]
    if hasattr(signal, "SIGBREAK"):
        signals.append(signal.SIGBREAK)
    for sig in signals:
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except (NotImplementedError, AttributeError):
            try:
                signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop_event.set))
            except Exception:
                pass

    # Listen on stdin for quit command from parent runner
    def stdin_listener():
        try:
            for line in sys.stdin:
                if line.strip().lower() == "quit":
                    break
        except Exception:
            pass
        loop.call_soon_threadsafe(stop_event.set)

    if sys.stdin and not sys.stdin.closed:
        threading.Thread(target=stdin_listener, daemon=True).start()

    # One independent watcher per debug address (see DEBUG_HOSTS)
    await asyncio.gather(*(watch_engine(host, stop_event, clean_only) for host in DEBUG_HOSTS))


async def watch_engine(host: str, stop_event: asyncio.Event, clean_only: bool):
    msg_id = 1
    sessions: dict[str, str] = {}
    target_to_sid: dict[str, str] = {}
    injected_sessions: set[str] = set()
    last_error: str | None = None

    while not stop_event.is_set():
        try:
            ws_url = await asyncio.to_thread(get_browser_ws_url, host, DEBUG_PORT)
            async with websockets.connect(ws_url, max_size=None, proxy=None) as ws:
                last_error = None
                print(f"[Connected] Ignition Designer engine at {host}:{DEBUG_PORT}...")
                msg_id = await send_cdp(
                    ws,
                    "Target.setAutoAttach",
                    msg_id,
                    params={
                        "autoAttach": True,
                        "waitForDebuggerOnStart": False,
                        "flatten": True,
                    },
                )

                # If launched with --clean, attach briefly, scrub all open tabs, and exit
                if clean_only:
                    await asyncio.sleep(0.5)
                    while True:
                        try:
                            raw_msg = await asyncio.wait_for(ws.recv(), timeout=0.3)
                            msg = json.loads(raw_msg)
                            if msg.get("method") == "Target.attachedToTarget":
                                info = msg["params"].get("targetInfo", {})
                                if info.get("type") == "page" and not is_ignored_target(info):
                                    sid = msg["params"]["sessionId"]
                                    sessions[sid] = info.get("title") or sid[:8]
                        except asyncio.TimeoutError:
                            break
                    msg_id = await cleanup_all_sessions(ws, sessions, injected_sessions, msg_id)
                    print(f"[Fresh State] {host}: all sessions cleaned and detached.")
                    return

                while not stop_event.is_set():
                    try:
                        raw_msg = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    except asyncio.TimeoutError:
                        continue

                    msg = json.loads(raw_msg)
                    method = msg.get("method")
                    params = msg.get("params", {})
                    session_id = msg.get("sessionId")

                    if method == "Target.attachedToTarget":
                        target_info = params.get("targetInfo", {})
                        if target_info.get("type") == "page":
                            sid = params["sessionId"]
                            tid = target_info.get("targetId", "")
                            label = target_info.get("title") or target_info.get("url") or sid[:8]

                            if is_ignored_target(target_info):
                                msg_id = await send_cdp(
                                    ws,
                                    "Target.detachFromTarget",
                                    msg_id,
                                    params={"sessionId": sid},
                                )
                                continue

                            sessions[sid] = label
                            if tid:
                                target_to_sid[tid] = sid
                            msg_id = await inject_into_session(
                                ws, sid, target_info, msg_id, injected_sessions
                            )

                    elif method == "Target.targetInfoChanged":
                        target_info = params.get("targetInfo", {})
                        tid = target_info.get("targetId", "")
                        sid = target_to_sid.get(tid)
                        if sid and sid in sessions:
                            title = target_info.get("title", "")
                            if is_ignored_target(target_info):
                                sessions.pop(sid, None)
                                injected_sessions.discard(sid)
                                target_to_sid.pop(tid, None)
                                msg_id = await send_cdp(
                                    ws,
                                    "Target.detachFromTarget",
                                    msg_id,
                                    params={"sessionId": sid},
                                )
                            elif title:
                                sessions[sid] = title

                    elif method == "Target.detachedFromTarget":
                        sid = params.get("sessionId")
                        sessions.pop(sid, None)
                        injected_sessions.discard(sid)
                        attach_times.pop(sid, None)

                    elif method in ("Runtime.consoleAPICalled", "Runtime.exceptionThrown") and is_replayed(session_id, params):
                        continue  # console history replayed by Runtime.enable

                    elif method == "Runtime.consoleAPICalled" and session_id in sessions:
                        ts = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
                        level = params.get("type", "log").upper()
                        text = format_console_args(params.get("args", []))
                        # print(f"[{sessions[session_id]} #{session_id[:6]}] [Console:{level}] {text}")
                        print(f"[{ts}] [{sessions[session_id]} #{session_id[:6]}] [Console:{level}] {text}")

                    elif method == "Runtime.exceptionThrown" and session_id in sessions:
                        details = params.get("exceptionDetails", {})
                        exc_text = details.get("exception", {}).get("description") or details.get("text", "Unknown error")
                        print(f"[{sessions[session_id]} #{session_id[:6]}] [Console:EXCEPTION] {exc_text}")

                # Graceful shutdown on quit / Ctrl+C: clean all tabs before closing socket
                if sessions:
                    print("\n[Stopping] Cleaning up injected scripts across all open tabs...")
                    msg_id = await cleanup_all_sessions(ws, sessions, injected_sessions, msg_id)

        except Exception as exc:
            err = f"{type(exc).__name__}: {exc}"
            # Usually only one engine is running, so the other address just refuses
            # connections; log each distinct error once instead of every 2 seconds
            if err != last_error:
                print(f"[Disconnected / Error] {host}: {err}")
                last_error = err
            sessions.clear()
            target_to_sid.clear()
            injected_sessions.clear()
            if clean_only:
                return  # nothing to clean on an address with no engine
            if not stop_event.is_set():
                try:
                    await asyncio.sleep(2)
                except asyncio.CancelledError:
                    break

        # except (Exception, KeyboardInterrupt):
        #     sessions.clear()
        #     target_to_sid.clear()
        #     injected_sessions.clear()
        #     if not stop_event.is_set():
        #         try:
        #             await asyncio.sleep(2)
        #         except (asyncio.CancelledError, KeyboardInterrupt):
        #             break


if __name__ == "__main__":
    clean_mode = "--clean" in sys.argv
    try:
        asyncio.run(watch_designer(clean_only=clean_mode))
    except KeyboardInterrupt:
        pass