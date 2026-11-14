import socket
import subprocess
import sys
import threading
import traceback

import httpx
import uvicorn
import webview

from agent import config, dev_server
from agent.server import app as fastapi_app

HOST = "127.0.0.1"
PORT = 8009
ICON_PATH = str(config.BUNDLE_DIR / "web" / "icon.ico")

CREATE_NO_WINDOW = 0x08000000  # só existe no Windows; app é Windows-only.


def _already_running() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((HOST, PORT)) == 0


def _ensure_ollama_running() -> None:
    try:
        httpx.get(f"{config.OLLAMA_HOST}/api/tags", timeout=2.0)
        return
    except httpx.HTTPError:
        pass
    try:
        subprocess.Popen(
            ["ollama", "serve"],
            creationflags=CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        pass


def _run_server():
    uvicorn.run(fastapi_app, host=HOST, port=PORT, log_level="warning")


def main():
    if _already_running():
        return

    _ensure_ollama_running()

    thread = threading.Thread(target=_run_server, daemon=True)
    thread.start()
    webview.create_window("Ambar", f"http://{HOST}:{PORT}", width=1100, height=750, text_select=True)
    webview.start(icon=ICON_PATH)
    dev_server.stop()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        config.DATA_DIR.joinpath("crash.log").write_text(traceback.format_exc(), encoding="utf-8")
        sys.exit(1)