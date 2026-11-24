import os
import signal
import subprocess
import sys
import threading
import time
from PIL import Image, ImageDraw
import pystray

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TARGET_SCRIPT = os.path.join(BASE_DIR, "auto-injector.py")
LOG_FILE = os.path.join(BASE_DIR, "background_script.log")
stop_event = threading.Event()
restart_event = threading.Event()
reload_lock = threading.Lock()
proc_lock = threading.Lock()
current_proc = None


def create_icon_image():
    for icon_name in ("icon.png", "icon.jpg", "icon.ico"):
        icon_path = os.path.join(BASE_DIR, icon_name)
        if os.path.exists(icon_path):
            # Image.open is lazy and keeps the file handle open for the life of the
            # image, which locks icon.ico while the tray runs (breaking git checkouts).
            # Copy it into memory and let the with-block close the file.
            with Image.open(icon_path) as img:
                return img.copy()
    img = Image.new("RGB", (64, 64), color=(30, 144, 255))
    draw = ImageDraw.Draw(img)
    draw.rectangle([16, 16, 48, 48], fill=(255, 255, 255))
    return img


def run_existing_script():
    global current_proc

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8:replace"  # log file is UTF-8; never crash on odd characters

    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        creationflags = 0

    while not stop_event.is_set():
        with open(LOG_FILE, "a", encoding="utf-8") as log_f:
            log_f.write(f"\n[{time.strftime('%H:%M:%S')}] Launching {TARGET_SCRIPT}\n")
            log_f.flush()

            with proc_lock:
                current_proc = subprocess.Popen(
                    [sys.executable, TARGET_SCRIPT],
                    stdin=subprocess.PIPE,
                    stdout=log_f,
                    stderr=subprocess.STDOUT,
                    env=env,
                    creationflags=creationflags,
                )

            while current_proc.poll() is None:
                if stop_event.wait(0.5):
                    break

            if stop_event.is_set():
                try:
                    current_proc.wait(timeout=11.0)
                except Exception:
                    pass

            exit_code = current_proc.poll()
            log_f.write(f"[{time.strftime('%H:%M:%S')}] Script exited (code {exit_code}).\n")
            log_f.flush()

        # Reload requested: relaunch immediately instead of waiting
        if restart_event.is_set():
            restart_event.clear()
            continue

        if stop_event.wait(5):
            break


def stop_child_process(proc, timeout=10.0):
    if proc is None or proc.poll() is not None:
        return

    # 1. Send "quit" via stdin pipe so the child wakes up immediately
    try:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.write(b"quit\n")
            proc.stdin.flush()
            proc.stdin.close()
    except Exception:
        pass

    # 2. Send OS signal as fallback
    try:
        if sys.platform == "win32":
            os.kill(proc.pid, signal.CTRL_BREAK_EVENT)
        else:
            os.kill(proc.pid, signal.SIGINT)
    except ProcessLookupError:
        return
    except Exception:
        pass

    # Give the child script time to run CLEANUP_JS and detach CDP
    try:
        proc.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass

    # Force-kill only if still running after grace period
    try:
        proc.terminate()
        proc.wait(timeout=2)
    except (subprocess.TimeoutExpired, Exception):
        try:
            proc.kill()
        except Exception:
            pass


def open_terminal(icon, item):
    if sys.platform == "win32":
        ps_cmd = f"Get-Content -Path '{LOG_FILE}' -Tail 100 -Wait"
        cmd = f'start "Python Script Output" powershell -NoExit -Command "{ps_cmd}"'
        subprocess.Popen(cmd, shell=True)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-a", "Terminal", LOG_FILE])
    else:
        subprocess.Popen(["x-terminal-emulator", "-e", f"tail -n 100 -f '{LOG_FILE}'"])


def _reload_worker():
    # Non-blocking guard so repeated clicks don't stack up reloads
    if not reload_lock.acquire(blocking=False):
        return
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as log_f:
            log_f.write(f"\n[{time.strftime('%H:%M:%S')}] Reload requested: cleaning sessions and reloading scripts...\n")
        restart_event.set()
        # Graceful stop runs CLEANUP_JS in every tab and detaches (which also drops
        # the on-new-document scripts); the runner loop then relaunches the injector,
        # which re-reads the scripts folder.
        with proc_lock:
            stop_child_process(current_proc, timeout=10.0)
    finally:
        reload_lock.release()


def reload_scripts(icon, item):
    if stop_event.is_set():
        return
    # Run off the tray thread so the menu stays responsive during cleanup
    threading.Thread(target=_reload_worker, daemon=True).start()


def quit_app(icon, item):
    stop_event.set()
    with proc_lock:
        stop_child_process(current_proc, timeout=10.0)
    icon.stop()


def main():
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] Tray runner started.\n")

    t = threading.Thread(target=run_existing_script, daemon=True)
    t.start()

    menu = pystray.Menu(
        pystray.MenuItem("Show Terminal", open_terminal, default=True),
        pystray.MenuItem("Reload Scripts", reload_scripts),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", quit_app),
    )

    icon = pystray.Icon("designer-tools", create_icon_image(), "Designer Tools", menu)
    icon.run()


if __name__ == "__main__":
    main()