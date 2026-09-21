import os
from pathlib import Path

from faster_whisper import WhisperModel


root = Path(os.environ.get("ELARA_ROOT", Path(__file__).resolve().parents[2]))
model_name = os.environ.get("ELARA_WHISPER_MODEL", "small")
model_root = root / ".runtime" / "whisper" / "models"
model_root.mkdir(parents=True, exist_ok=True)

print(f"[ELARA-WHISPER] Downloading or verifying model {model_name}")
WhisperModel(model_name, device="cpu", compute_type="int8", download_root=str(model_root))
print(f"[ELARA-WHISPER] Model {model_name} is ready")
