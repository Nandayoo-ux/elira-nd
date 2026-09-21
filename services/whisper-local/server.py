import hmac
import json
import os
import sys
import tempfile
import threading
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(os.environ.get("ELARA_ROOT", Path(__file__).resolve().parents[2]))
HOST = "127.0.0.1"
PORT = int(os.environ.get("ELARA_WHISPER_PORT", "31339"))
TOKEN = os.environ.get("ELARA_WHISPER_TOKEN", "")
MODEL_NAME = os.environ.get("ELARA_WHISPER_MODEL", "small")
MODEL_ROOT = Path(os.environ.get("ELARA_WHISPER_MODEL_ROOT", ROOT / ".runtime" / "whisper" / "models"))
REQUEST_LIMIT = 25 * 1024 * 1024


def add_packaged_nvidia_libraries() -> None:
    site_packages = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    for relative in ("cublas/bin", "cudnn/bin"):
        candidate = site_packages / relative
        if candidate.is_dir() and hasattr(os, "add_dll_directory"):
            os.add_dll_directory(str(candidate))


add_packaged_nvidia_libraries()

import ctranslate2  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402


class ModelRuntime:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.device = "cpu"
        self.compute_type = "int8"
        requested = os.environ.get("ELARA_WHISPER_DEVICE", "auto").lower()
        if requested == "cuda" or (requested == "auto" and ctranslate2.get_cuda_device_count() > 0):
            self.device = "cuda"
            self.compute_type = "float16"
        elif requested not in ("auto", "cpu"):
            raise ValueError("ELARA_WHISPER_DEVICE must be auto, cpu, or cuda")
        self.model = self._load(self.device, self.compute_type)

    def _load(self, device: str, compute_type: str) -> WhisperModel:
        MODEL_ROOT.mkdir(parents=True, exist_ok=True)
        try:
            model = WhisperModel(
                MODEL_NAME,
                device=device,
                compute_type=compute_type,
                download_root=str(MODEL_ROOT),
            )
            print(f"[ELARA-WHISPER] model={MODEL_NAME} device={device} compute={compute_type}", flush=True)
            return model
        except Exception as error:
            if device != "cuda":
                raise
            print(f"[ELARA-WHISPER] CUDA unavailable during model load, using CPU ({type(error).__name__})", flush=True)
            self.device = "cpu"
            self.compute_type = "int8"
            return WhisperModel(
                MODEL_NAME,
                device="cpu",
                compute_type="int8",
                download_root=str(MODEL_ROOT),
            )

    def _run(self, audio_path: str, language: str | None) -> str:
        segments, _info = self.model.transcribe(
            audio_path,
            language=language or None,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        return " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()

    def transcribe(self, audio_path: str, language: str | None) -> str:
        with self.lock:
            try:
                return self._run(audio_path, language)
            except Exception as error:
                if self.device != "cuda":
                    raise
                print(f"[ELARA-WHISPER] CUDA inference failed, retrying on CPU ({type(error).__name__})", flush=True)
                self.device = "cpu"
                self.compute_type = "int8"
                self.model = self._load("cpu", "int8")
                return self._run(audio_path, language)


RUNTIME = ModelRuntime()


def parse_multipart(content_type: str, body: bytes) -> tuple[bytes, str, str | None]:
    envelope = (
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
    )
    message = BytesParser(policy=policy.default).parsebytes(envelope)
    if not message.is_multipart():
        raise ValueError("multipart form data is required")

    audio: bytes | None = None
    filename = "voice.ogg"
    language: str | None = None
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        payload = part.get_payload(decode=True) or b""
        if name == "file":
            audio = payload
            supplied = part.get_filename()
            if supplied:
                filename = Path(supplied).name
        elif name == "language":
            language = payload.decode("utf-8", errors="ignore").strip() or None
    if not audio:
        raise ValueError("audio file is required")
    return audio, filename, language


class Handler(BaseHTTPRequestHandler):
    server_version = "ELARAWhisper/1"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[ELARA-WHISPER] {self.address_string()} {format % args}", flush=True)

    def authorized(self) -> bool:
        if not TOKEN:
            return True
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {TOKEN}"
        return hmac.compare_digest(supplied, expected)

    def send_json(self, status: int, value: dict[str, Any]) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_json(404, {"error": "not found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        self.send_json(200, {
            "status": "ready",
            "model": MODEL_NAME,
            "device": RUNTIME.device,
            "compute_type": RUNTIME.compute_type,
        })

    def do_POST(self) -> None:
        if self.path != "/v1/audio/transcriptions":
            self.send_json(404, {"error": "not found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > REQUEST_LIMIT:
                self.send_json(413, {"error": "audio payload is empty or too large"})
                return
            content_type = self.headers.get("Content-Type", "")
            audio, filename, language = parse_multipart(content_type, self.rfile.read(length))
            suffix = Path(filename).suffix[:12] or ".bin"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
                temporary.write(audio)
                temporary_path = temporary.name
            try:
                text = RUNTIME.transcribe(temporary_path, language)
            finally:
                Path(temporary_path).unlink(missing_ok=True)
            if not text:
                self.send_json(422, {"error": "no speech detected"})
                return
            self.send_json(200, {"text": text[:64_000]})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            print(f"[ELARA-WHISPER] transcription failed ({type(error).__name__})", flush=True)
            self.send_json(500, {"error": "transcription failed"})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[ELARA-WHISPER] listening on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
