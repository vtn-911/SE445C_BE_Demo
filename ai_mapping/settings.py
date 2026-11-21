import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


MAPPING_DIR = Path(__file__).resolve().parent
load_dotenv(MAPPING_DIR / ".env", override=False)


@dataclass(frozen=True)
class MappingSettings:
    gemini_api_key: str
    gemini_model: str
    gemini_timeout_ms: int

    @classmethod
    def from_environment(cls):
        timeout_value = os.getenv("GEMINI_TIMEOUT_MS", "30000")
        try:
            timeout_ms = int(timeout_value)
        except (TypeError, ValueError) as error:
            raise ValueError("GEMINI_TIMEOUT_MS must be a positive integer") from error
        if timeout_ms <= 0:
            raise ValueError("GEMINI_TIMEOUT_MS must be a positive integer")

        return cls(
            gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
            gemini_model=os.getenv("GEMINI_MODEL", "").strip(),
            gemini_timeout_ms=timeout_ms,
        )
