from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class AppConfig:
    settings_path: str


def get_config() -> AppConfig:
    return AppConfig(
        settings_path=os.getenv("SETTINGS_PATH", "/app/data/settings.json"),
    )
