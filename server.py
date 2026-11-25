"""
Sermon Live Translator — Local Soundbooth Server (Mode 1)
Real-time bidirectional Mandarin Chinese <-> American English speech-to-speech
church sermon interpreter supporting:
  - Alibaba Cloud Model Studio (DashScope): qwen3.8-livetranslate-flash-realtime (Default)
  - Google Gemini Live API: gemini-3.5-live-translate-preview
"""

from __future__ import annotations

import asyncio
import base64
import datetime
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import websockets
from dotenv import load_dotenv
from google import genai
from google.genai import types
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("sermon-live-translator")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
LOGS_DIR = BASE_DIR / "logs"
ENV_FILE = BASE_DIR / ".env"
LOGS_DIR.mkdir(exist_ok=True)

DEFAULT_MODEL_ID = "qwen3.8-livetranslate-flash-realtime"

DEFAULT_SERMON_RULES_ZH_EN = """You are a professional interpreter for a Christian church sermon.

Translate spoken Mandarin Chinese into natural, accurate American English.

Remove non-meaningful filler words, repeated syllables, and false starts.

Preserve theological meaning, scripture references, important repetition, and the speaker's intent.

Use established English Bible terminology.

Do not invent or complete words lost due to noise. If speech is unclear, omit the uncertain fragment rather than guessing.

Keep the interpretation concise and suitable for live listening."""

DEFAULT_SERMON_RULES_EN_ZH = """You are a professional interpreter for a Christian church sermon.

Translate spoken English into natural, accurate Simplified Mandarin Chinese.

Remove non-meaningful filler words, repeated syllables, and false starts.

Preserve theological meaning, scripture references, important repetition, and the speaker's intent.

Use established Chinese Bible terminology (Chinese Union Version / 和合本 conventions).

Do not invent or complete words lost due to noise. If speech is unclear, omit the uncertain fragment rather than guessing.

Keep the interpretation concise and suitable for live listening."""

DEFAULT_SERMON_GLOSSARY_ZH_EN = """称义=justification
成圣=sanctification
救恩=salvation
赎罪=atonement
恩典=grace
圣灵=the Holy Spirit
福音=the Gospel
十字架=the cross
复活=resurrection
门徒=disciple
悔改=repentance
顺服=obedience
信靠=trust
立约=covenant
弟兄姊妹=brothers and sisters
主日=Sunday service
讲道=sermon
经文=scripture
祷告=prayer
赞美=praise
敬拜=worship
阿们=Amen
哈利路亚=Hallelujah
罗马书=Romans
约翰福音=the Gospel of John
马太福音=the Gospel of Matthew
诗篇=Psalms
创世记=Genesis
使徒行传=Acts
保罗=Paul
彼得=Peter
大卫=David
摩西=Moses
亚伯拉罕=Abraham"""

DEFAULT_SERMON_GLOSSARY_EN_ZH = """justification=称义
sanctification=成圣
salvation=救恩
atonement=赎罪
grace=恩典
the Holy Spirit=圣灵
the Gospel=福音
the cross=十字架
resurrection=复活
disciple=门徒
repentance=悔改
obedience=顺服
covenant=立约
brothers and sisters=弟兄姊妹
Sunday service=主日
sermon=讲道
scripture=经文
prayer=祷告
praise=赞美
worship=敬拜
Amen=阿们
Hallelujah=哈利路亚
Romans=罗马书
Gospel of John=约翰福音
Gospel of Matthew=马太福音
Psalms=诗篇
Genesis=创世记
Acts=使徒行传
Paul=保罗
Peter=彼得
David=大卫
Moses=摩西
Abraham=亚伯拉罕"""

# Backwards-compatible alias
DEFAULT_SERMON_RULES = DEFAULT_SERMON_RULES_ZH_EN

DIRECTIONS: dict[str, dict[str, Any]] = {
    "zh-en": {
        "id": "zh-en",
        "label": "中文 → 英文",
        "short_label": "Mandarin → American English",
        "target_language_code": "en",
        "qwen_target_language_code": "en",
        "source_lang_tag": "ZH",
        "target_lang_tag": "EN",
        "target_title": "实时英文同传字幕 · Live American English",
        "source_title": "中文收音转写参考 · Mandarin Input Transcript",
        "fullscreen_title": "Live English Interpretation",
        "context_placeholder": (
            "示例（支持每行写 术语=译文，Qwen3.8 会自动加入热词词典）：\n"
            "主题：在基督里的自由\n"
            "经文：罗马书 8:1-17\n"
            "称义=justification\n"
            "成圣=sanctification\n"
            "圣灵=the Holy Spirit"
        ),
        "default_rules": DEFAULT_SERMON_RULES_ZH_EN,
        "default_glossary": DEFAULT_SERMON_GLOSSARY_ZH_EN,
        "accent_guidance": (
            "The speaker may speak Mandarin Chinese with regional accents or imperfect pronunciation. "
            "Use the sermon context to recognize intended theological terms and scripture references accurately, "
            "but never fabricate words when audio is unintelligible."
        ),
        "live_agent_guardrail": (
            "CRITICAL INTERPRETATION MODE: Every single spoken Mandarin utterance you hear is "
            "addressed directly to you for immediate translation—even when the speaker addresses "
            "'brothers and sisters', a congregation, or another person. NEVER stay silent or "
            "treat sermon speech as background conversation. Immediately speak the American "
            "English translation of everything you hear. Output ONLY the translation; never "
            "answer rhetorical questions, greet, converse with the speaker, or add commentary."
        ),
    },
    "en-zh": {
        "id": "en-zh",
        "label": "英文 → 中文",
        "short_label": "English → Simplified Mandarin",
        "target_language_code": "zh-Hans",
        "qwen_target_language_code": "zh",
        "source_lang_tag": "EN",
        "target_lang_tag": "ZH",
        "target_title": "实时中文同传字幕 · Live Mandarin Chinese",
        "source_title": "英文收音转写参考 · English Input Transcript",
        "fullscreen_title": "实时中文讲道同传",
        "context_placeholder": (
            "示例（支持每行写 Term=中文译名，Qwen3.8 会自动加入热词词典）：\n"
            "Topic: Freedom in Christ\n"
            "Passage: Romans 8:1-17\n"
            "justification=称义\n"
            "sanctification=成圣\n"
            "the Holy Spirit=圣灵"
        ),
        "default_rules": DEFAULT_SERMON_RULES_EN_ZH,
        "default_glossary": DEFAULT_SERMON_GLOSSARY_EN_ZH,
        "accent_guidance": (
            "The speaker may speak English with regional accents, rapid pacing, or imperfect audio clarity. "
            "Use the sermon context to recognize intended theological terms and scripture references accurately, "
            "but never fabricate words when audio is unintelligible."
        ),
        "live_agent_guardrail": (
            "CRITICAL INTERPRETATION MODE: Every single spoken English utterance you hear is "
            "addressed directly to you for immediate translation—even when the speaker addresses "
            "a congregation or another person. NEVER stay silent or treat sermon speech as "
            "background conversation. Immediately speak the Simplified Mandarin Chinese "
            "translation of everything you hear. Output ONLY the translation; never answer "
            "rhetorical questions, greet, converse with the speaker, or add commentary."
        ),
    },
}

DASHSCOPE_REGIONS: dict[str, dict[str, Any]] = {
    "cn-beijing": {
        "id": "cn-beijing",
        "label": "国内站 · 华北2（北京 · 人民币计费）",
        "default_host": "dashscope.aliyuncs.com",
        "currency": "CNY",
        "currency_symbol": "¥",
        "input_per_1m_tokens": 40.0,
        "output_text_per_1m_tokens": 100.0,
        "output_audio_per_1m_tokens": 160.0,
        "base_per_min": 0.165,
    },
    "ap-southeast-1": {
        "id": "ap-southeast-1",
        "label": "国际站 · 新加坡（美元计费）",
        "default_host": "dashscope-intl.aliyuncs.com",
        "currency": "USD",
        "currency_symbol": "$",
        "input_per_1m_tokens": 7.50,
        "output_text_per_1m_tokens": 20.00,
        "output_audio_per_1m_tokens": 30.00,
        "base_per_min": 0.031,
    },
}

QWEN_VOICE_MODES: list[dict[str, str]] = [
    {"id": "clone_once", "label": "实时声音复刻 · 单讲员推荐（默认 · 自动还原讲员男/女声）"},
    {"id": "tina", "label": "系统预设女声 · Tina（官方唯一内置预设音色）"},
    {"id": "clone_always", "label": "实时声音复刻 · 多人模式（自动跟随不同发言人）"},
    {"id": "custom", "label": "自定义预建音色 ID（可填提前复刻的固定男声 ID）"},
]

QWEN_VAD_MODES: list[dict[str, str]] = [
    {"id": "sermon_fast", "label": "讲道极速灵敏（推荐 · server_vad · 0.5秒断句不漏词）"},
    {"id": "speaker_fast", "label": "多讲员分离（speaker_detection · 0.6秒断句）"},
]

QWEN_TRANSPORT_MODES: list[dict[str, str]] = [
    {"id": "webrtc", "label": "WebRTC UDP 直连（推荐 · 同官网低延迟，需填 Workspace ID）"},
    {"id": "websocket", "label": "WebSocket 兼容模式（免填 Workspace ID）"},
]

MODELS: dict[str, dict[str, Any]] = {
    "qwen3.8-livetranslate-flash-realtime": {
        "id": "qwen3.8-livetranslate-flash-realtime",
        "label": "Qwen3.8-LiveTranslate-flash-realtime (默认 · 阿里百炼同传)",
        "provider": "dashscope",
        "mode": "qwen_live_translate",
        "audio_tokens_per_second": 12.5,
        "input_usd_per_1m_tokens": 5.65,
        "output_usd_per_1m_tokens": 22.61,
        "base_usd_per_min": 0.0230,
        "description": "阿里百炼新一代交错流式同传模型，平均延迟约 2.3 秒，12.5 tokens/秒，支持中文口音优化、实时音色复刻与自定义神学术语词典。",
    },
    "gemini-3.5-live-translate-preview": {
        "id": "gemini-3.5-live-translate-preview",
        "label": "Gemini 3.5 Live Translate (Google · 连续同传)",
        "provider": "gemini",
        "mode": "live_translate",
        "audio_tokens_per_second": 25.0,
        "input_usd_per_1m_tokens": 3.50,
        "output_usd_per_1m_tokens": 21.00,
        "base_usd_per_min": 0.0368,
        "description": "Google 专用低延迟连续流式语音翻译模型，支持自定义自由文本口译规则。",
    },
}

INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000
BYTES_PER_SAMPLE = 2  # 16-bit PCM


@dataclass
class SessionMetrics:
    model: str
    region: str = "cn-beijing"
    input_audio_bytes: int = 0
    output_audio_bytes: int = 0
    reported_prompt_tokens: int = 0
    reported_response_tokens: int = 0
    reported_text_output_tokens: int = 0
    reported_audio_output_tokens: int = 0
    reconnect_count: int = 0
    started_at: datetime.datetime = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc)
    )

    @property
    def input_audio_seconds(self) -> float:
        return self.input_audio_bytes / (INPUT_SAMPLE_RATE * BYTES_PER_SAMPLE)

    @property
    def output_audio_seconds(self) -> float:
        return self.output_audio_bytes / (OUTPUT_SAMPLE_RATE * BYTES_PER_SAMPLE)

    def estimate_cost(self) -> dict[str, Any]:
        spec = MODELS.get(self.model, MODELS[DEFAULT_MODEL_ID])
        tok_per_sec = float(spec.get("audio_tokens_per_second", 25.0))

        if spec["provider"] == "dashscope":
            reg = DASHSCOPE_REGIONS.get(self.region, DASHSCOPE_REGIONS["cn-beijing"])
            currency = reg["currency"]
            symbol = reg["currency_symbol"]
            in_rate = reg["input_per_1m_tokens"]
            out_audio_rate = reg["output_audio_per_1m_tokens"]
            out_text_rate = reg["output_text_per_1m_tokens"]

            if self.reported_prompt_tokens > 0 or self.reported_response_tokens > 0:
                in_cost = (self.reported_prompt_tokens / 1_000_000) * in_rate
                if self.reported_audio_output_tokens > 0 or self.reported_text_output_tokens > 0:
                    out_cost = (
                        (self.reported_audio_output_tokens / 1_000_000) * out_audio_rate
                        + (self.reported_text_output_tokens / 1_000_000) * out_text_rate
                    )
                else:
                    out_cost = (self.reported_response_tokens / 1_000_000) * out_audio_rate
                basis = "actual_tokens"
            else:
                est_in_tokens = self.input_audio_seconds * tok_per_sec
                est_out_audio_tokens = self.output_audio_seconds * tok_per_sec
                est_out_text_tokens = (self.output_audio_seconds / 60.0) * 150.0
                in_cost = (est_in_tokens / 1_000_000) * in_rate
                out_cost = (
                    (est_out_audio_tokens / 1_000_000) * out_audio_rate
                    + (est_out_text_tokens / 1_000_000) * out_text_rate
                )
                basis = "audio_duration_estimate"

            total = round(in_cost + out_cost, 5)
            return {
                "basis": basis,
                "currency": currency,
                "currency_symbol": symbol,
                "estimated_cost": total,
                "estimated_usd": total if currency == "USD" else round(total / 7.1, 5),
                "input_audio_seconds": round(self.input_audio_seconds, 1),
                "output_audio_seconds": round(self.output_audio_seconds, 1),
                "reported_prompt_tokens": self.reported_prompt_tokens,
                "reported_response_tokens": self.reported_response_tokens,
                "reconnect_count": self.reconnect_count,
            }

        # Gemini models (USD)
        in_rate = spec["input_usd_per_1m_tokens"]
        out_rate = spec["output_usd_per_1m_tokens"]
        if self.reported_prompt_tokens > 0 or self.reported_response_tokens > 0:
            input_cost = (self.reported_prompt_tokens / 1_000_000) * in_rate
            output_cost = (self.reported_response_tokens / 1_000_000) * out_rate
            basis = "actual_tokens"
        else:
            est_in_tokens = self.input_audio_seconds * tok_per_sec
            est_out_tokens = self.output_audio_seconds * tok_per_sec
            input_cost = (est_in_tokens / 1_000_000) * in_rate
            output_cost = (est_out_tokens / 1_000_000) * out_rate
            basis = "audio_duration_estimate"

        total_usd = round(input_cost + output_cost, 5)
        return {
            "basis": basis,
            "currency": "USD",
            "currency_symbol": "$",
            "estimated_cost": total_usd,
            "estimated_usd": total_usd,
            "input_audio_seconds": round(self.input_audio_seconds, 1),
            "output_audio_seconds": round(self.output_audio_seconds, 1),
            "reported_prompt_tokens": self.reported_prompt_tokens,
            "reported_response_tokens": self.reported_response_tokens,
            "reconnect_count": self.reconnect_count,
        }

    # Backwards-compatible alias for tests
    def estimate_cost_usd(self) -> dict[str, Any]:
        return self.estimate_cost()


def get_direction_spec(direction: str | None) -> dict[str, Any]:
    return DIRECTIONS.get(direction or "zh-en", DIRECTIONS["zh-en"])


def parse_glossary_phrases(*texts: str | None, max_terms: int = 900) -> dict[str, str]:
    """
    Parse term mappings into a dict suitable for Qwen3.8 translation.corpus.phrases.
    Supports formats like:
      - 称义=justification
      - 称义 -> justification
      - 称义: justification  (or Chinese colon, excluding metadata prefixes like 主题/经文/Topic/Passage)
      - 称义 (justification)
    """
    ignored_prefixes = {"主题", "经文", "术语", "topic", "passage", "glossary", "示例"}
    phrases: dict[str, str] = {}

    for raw_block in texts:
        if not raw_block:
            continue
        for line in raw_block.splitlines():
            clean = line.strip().lstrip("-•* ").strip()
            if not clean or clean.startswith("#"):
                continue

            # Split comma/semicolon-separated items if a line lists multiple "A (B), C (D)" pairs
            segments = [clean]
            if ("(" in clean and ")" in clean) or ("," in clean and "=" in clean):
                if not any(clean.lower().startswith(p) for p in ("主题", "经文", "topic", "passage")):
                    segments = re.split(r"[,，;；]+", clean)

            for seg in segments:
                item = seg.strip()
                if not item:
                    continue

                src = ""
                tgt = ""

                if "=" in item:
                    left, right = item.split("=", 1)
                    src, tgt = left.strip(), right.strip()
                elif "->" in item or "→" in item:
                    parts = re.split(r"->|→", item, maxsplit=1)
                    src, tgt = parts[0].strip(), parts[1].strip()
                else:
                    paren_match = re.match(r"^([^()（）:：]+?)\s*[（(]([^()（）]+)[)）]$", item)
                    if paren_match:
                        src = paren_match.group(1).strip()
                        tgt = paren_match.group(2).strip()
                    elif ":" in item or "：" in item:
                        parts = re.split(r"[:：]", item, maxsplit=1)
                        left, right = parts[0].strip(), parts[1].strip()
                        if left.lower() not in ignored_prefixes and right:
                            src, tgt = left, right

                if src and tgt and src.lower() not in ignored_prefixes:
                    phrases[src] = tgt
                    if len(phrases) >= max_terms:
                        return phrases

    return phrases


def build_qwen_ws_url(
    region: str = "cn-beijing",
    workspace_id: str | None = None,
    model_id: str = DEFAULT_MODEL_ID,
) -> str:
    """Build the DashScope / Model Studio WebSocket URL for Qwen3.8-LiveTranslate."""
    reg_key = region if region in DASHSCOPE_REGIONS else "cn-beijing"
    ws_id = (workspace_id or "").strip()
    if ws_id:
        host = f"{ws_id}.{reg_key}.maas.aliyuncs.com"
    else:
        host = DASHSCOPE_REGIONS[reg_key]["default_host"]
    return f"wss://{host}/api-ws/v1/realtime?model={model_id}"


def build_qwen_webrtc_url(
    region: str = "cn-beijing",
    workspace_id: str | None = None,
    model_id: str = DEFAULT_MODEL_ID,
) -> str:
    """Build the Alibaba Cloud Model Studio WebRTC SDP exchange URL."""
    reg_key = region if region in DASHSCOPE_REGIONS else "cn-beijing"
    ws_id = (workspace_id or "").strip()
    if not ws_id:
        raise ValueError(
            "WebRTC 直连需要填写百炼业务空间 ID（Workspace ID，以 llm- 开头）。"
            "请登录百炼控制台 → 业务空间管理 → 复制 Workspace ID 后填入，或切换为 WebSocket 兼容模式。"
        )
    return f"https://{ws_id}.{reg_key}.maas.aliyuncs.com/api/v1/webrtc/realtime?model={model_id}"


def build_qwen_session_update(
    direction: str = "zh-en",
    voice_mode: str = "clone_once",
    phrases: dict[str, str] | None = None,
    vad_mode: str = "sermon_fast",
    custom_voice_id: str | None = None,
) -> dict[str, Any]:
    """Build the verified session.update payload for qwen3.8-livetranslate-flash-realtime."""
    dir_spec = get_direction_spec(direction)
    translation_obj: dict[str, Any] = {
        "language": dir_spec["qwen_target_language_code"],
    }
    if phrases:
        translation_obj["corpus"] = {"phrases": phrases}

    if vad_mode == "speaker_fast":
        turn_detection = {
            "type": "speaker_detection",
            "threshold": 0.25,
            "silence_duration_ms": 600,
            "create_response": True,
            "interrupt_response": False,
        }
    else:
        turn_detection = {
            "type": "server_vad",
            "threshold": 0.2,
            "silence_duration_ms": 500,
            "create_response": True,
            "interrupt_response": False,
        }

    audio_obj: dict[str, Any] = {
        "input": {
            "format": {"type": "pcm", "sample_rate": INPUT_SAMPLE_RATE},
            "turn_detection": turn_detection,
        }
    }

    session_obj: dict[str, Any] = {
        "output_modalities": ["text", "audio"],
        "audio": audio_obj,
        "translation": translation_obj,
    }

    clean_custom_voice = (custom_voice_id or "").strip()
    if voice_mode == "tina":
        session_obj["voice"] = "Tina"
        audio_obj["output"] = {"voice": "Tina"}
    elif voice_mode == "clone_always":
        session_obj["voice"] = "default"
        session_obj["enable_voice_clone"] = True
        session_obj["voice_clone_options"] = {"frequency": "always"}
    elif voice_mode == "custom" and clean_custom_voice:
        session_obj["voice"] = clean_custom_voice
        audio_obj["output"] = {"voice": clean_custom_voice}
        session_obj["enable_voice_clone"] = True
        session_obj["voice_clone_options"] = {"frequency": "never"}
    else:
        # Default: real-time one-time voice cloning (automatically preserves male/female
        # speaker voice at zero extra cloning fee; supported natively by Qwen3.8 LiveTranslate)
        session_obj["voice"] = "default"
        session_obj["enable_voice_clone"] = True
        session_obj["voice_clone_options"] = {"frequency": "once"}

    return {
        "event_id": f"event_{int(time.time() * 1000)}",
        "type": "session.update",
        "session": session_obj,
    }


_NON_SPLIT_ABBREVS = re.compile(
    r"(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Rev|Ps|Gen|Ex|Lev|Num|Deut|Josh|Sam|Kgs|Chr|Prov|Isa|Jer|"
    r"Ezek|Dan|Matt|Rom|Cor|Gal|Eph|Phil|Col|Thess|Tim|Heb|Jas|Pet|vs|vv|v|e\.g|i\.e)\.$",
    re.IGNORECASE,
)


def find_sentence_split_index(text: str, direction: str = "zh-en") -> int | None:
    """
    Find a natural sentence boundary index (exclusive) to segment continuous
    Gemini Live Translate streams into clean, readable 1-2 sentence paragraphs.
    Returns None if the text should continue accumulating.
    """
    if not text:
        return None

    is_zh_target = direction == "en-zh"
    min_sentence_len = 16 if is_zh_target else 45
    max_clause_len = 65 if is_zh_target else 160

    # 1. Prefer terminal sentence punctuation (. ! ? 。 ！ ？) once long enough
    #    ASCII punctuation requires trailing space/EOL; CJK punctuation (。！？) does not.
    for match in re.finditer(
        r'(?:[.!?]+["”’\'\)\]]*(?=\s|$)|[。！？]+["”’\'\)\]]*)',
        text,
    ):
        end_idx = match.end()
        candidate = text[:end_idx].rstrip()
        if len(candidate) < min_sentence_len:
            continue
        # Avoid splitting decimals (e.g. "3.14") or common abbreviations (e.g. "Dr.", "Rom.")
        punct_start = match.start()
        if text[punct_start] == ".":
            if punct_start > 0 and text[punct_start - 1].isdigit() and end_idx < len(text) and text[end_idx].isdigit():
                continue
            if _NON_SPLIT_ABBREVS.search(candidate):
                continue
        return end_idx

    # 2. Fallback: if a continuous run-on exceeds max_clause_len, split at a comma/semicolon
    if len(text.strip()) >= max_clause_len:
        last_clause = None
        for match in re.finditer(r"(?:[,;](?=\s|$)|[，；、])", text):
            if match.end() >= min_sentence_len:
                last_clause = match.end()
        if last_clause is not None:
            return last_clause

    return None


def build_system_instruction(
    model_id: str,
    custom_rules: str | None = None,
    sermon_context: str | None = None,
    direction: str = "zh-en",
) -> str:
    """Compose the full interpreter system instruction for Gemini Live models."""
    dir_spec = get_direction_spec(direction)
    rules = (custom_rules or dir_spec["default_rules"]).strip()
    sections = [rules, dir_spec["accent_guidance"]]

    if MODELS.get(model_id, {}).get("mode") == "live_agent":
        sections.append(dir_spec["live_agent_guardrail"])

    context_clean = (sermon_context or "").strip()
    if context_clean:
        sections.append(
            "Today's sermon context, Bible passages, and preferred terminology:\n"
            f"{context_clean}"
        )

    return "\n\n".join(sections)


def build_live_config(
    model_id: str,
    system_instruction: str,
    echo_target_language: bool = False,
    compression_trigger_tokens: int = 4500,
    compression_target_tokens: int = 2500,
    resumption_handle: str | None = None,
    direction: str = "zh-en",
) -> types.LiveConnectConfig:
    """Build a LiveConnectConfig tailored for Gemini Live Translate or Gemini 3.8 Live."""
    model_spec = MODELS.get(model_id, MODELS["gemini-3.5-live-translate-preview"])
    dir_spec = get_direction_spec(direction)

    kwargs: dict[str, Any] = {
        "response_modalities": [types.Modality.AUDIO],
        "system_instruction": types.Content(
            parts=[types.Part(text=system_instruction)]
        ),
        "input_audio_transcription": types.AudioTranscriptionConfig(),
        "output_audio_transcription": types.AudioTranscriptionConfig(),
        "session_resumption": types.SessionResumptionConfig(
            handle=resumption_handle
        ),
    }

    if compression_trigger_tokens > 0:
        target = min(
            compression_target_tokens, max(1000, compression_trigger_tokens - 500)
        )
        kwargs["context_window_compression"] = types.ContextWindowCompressionConfig(
            trigger_tokens=compression_trigger_tokens,
            sliding_window=types.SlidingWindow(target_tokens=target),
        )

    if model_spec["mode"] == "live_translate":
        kwargs["translation_config"] = types.TranslationConfig(
            target_language_code=dir_spec["target_language_code"],
            echo_target_language=bool(echo_target_language),
        )
    elif model_spec["mode"] == "live_agent":
        # Tune VAD & disable barge-in interruption so continuous sermon speech
        # triggers fast phrase-by-phrase translation instead of getting suppressed.
        kwargs["realtime_input_config"] = types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                disabled=False,
                start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
                prefix_padding_ms=100,
                silence_duration_ms=400,
            ),
            activity_handling=types.ActivityHandling.NO_INTERRUPTION,
        )

    return types.LiveConnectConfig(**kwargs)


class BroadcastHub:
    """
    Lightweight fan-out hub for translated audio and captions.
    Serves the local soundbooth client (Mode 1) and is ready for Mode 2 multi-listener fan-out.
    """

    def __init__(self) -> None:
        self._listeners: set[WebSocket] = set()

    def register(self, ws: WebSocket) -> None:
        self._listeners.add(ws)

    def unregister(self, ws: WebSocket) -> None:
        self._listeners.discard(ws)

    async def broadcast_audio(self, pcm_bytes: bytes) -> None:
        stale: list[WebSocket] = []
        for ws in list(self._listeners):
            try:
                await ws.send_bytes(pcm_bytes)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self._listeners.discard(ws)

    async def broadcast_event(self, payload: dict[str, Any]) -> None:
        text = json.dumps(payload, ensure_ascii=False)
        stale: list[WebSocket] = []
        for ws in list(self._listeners):
            try:
                await ws.send_text(text)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self._listeners.discard(ws)


class TranscriptLogger:
    """Writes live bilingual sermon transcripts to logs/ when enabled."""

    def __init__(
        self,
        enabled: bool = True,
        model_id: str = "",
        direction: str = "zh-en",
    ) -> None:
        self.enabled = enabled
        self.path: Path | None = None
        if enabled:
            stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            self.path = LOGS_DIR / f"sermon_{direction}_{stamp}.txt"
            header = (
                f"# Sermon Live Translation Transcript\n"
                f"# Started: {datetime.datetime.now().isoformat(timespec='seconds')}\n"
                f"# Model: {model_id}\n"
                f"# Direction: {direction}\n\n"
            )
            self.path.write_text(header, encoding="utf-8")

    def log(self, speaker: str, text: str) -> None:
        if not self.enabled or not self.path or not text.strip():
            return
        ts = datetime.datetime.now().strftime("%H:%M:%S")
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(f"[{ts}] {speaker}: {text.strip()}\n")


class QwenLiveTranslationBridge:
    """Manages an Alibaba Cloud Model Studio (DashScope) Qwen3.8-LiveTranslate session."""

    def __init__(
        self,
        hub: BroadcastHub,
        api_key: str,
        model_id: str,
        direction: str,
        region: str,
        workspace_id: str,
        voice_mode: str,
        vad_mode: str,
        phrases: dict[str, str],
        save_transcript: bool,
        custom_voice_id: str = "",
    ) -> None:
        self.hub = hub
        self.api_key = api_key
        self.model_id = model_id
        self.direction = direction
        self.dir_spec = get_direction_spec(direction)
        self.region = region if region in DASHSCOPE_REGIONS else "cn-beijing"
        self.workspace_id = workspace_id.strip()
        self.voice_mode = voice_mode
        self.vad_mode = vad_mode
        self.custom_voice_id = custom_voice_id.strip()
        self.phrases = phrases
        self.metrics = SessionMetrics(model=model_id, region=self.region)
        self.transcript_logger = TranscriptLogger(
            enabled=save_transcript,
            model_id=model_id,
            direction=direction,
        )

        self._audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=200)
        self._stop_event = asyncio.Event()
        self._runner_task: asyncio.Task[None] | None = None
        self._turn_id: int = 1

    def start(self) -> None:
        self._runner_task = asyncio.create_task(self._run_loop())

    async def push_audio(self, pcm_bytes: bytes) -> None:
        if self._stop_event.is_set():
            return
        if self._audio_queue.full():
            try:
                self._audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        await self._audio_queue.put(pcm_bytes)

    async def notify_audio_pause(self) -> None:
        # Qwen3.8 speaker_detection VAD gracefully handles silence without explicit commit
        return

    async def stop(self) -> None:
        self._stop_event.set()
        try:
            self._audio_queue.put_nowait(None)
        except asyncio.QueueFull:
            pass
        if self._runner_task:
            self._runner_task.cancel()
            try:
                await self._runner_task
            except asyncio.CancelledError:
                pass

    async def _run_loop(self) -> None:
        ws_url = build_qwen_ws_url(
            region=self.region,
            workspace_id=self.workspace_id,
            model_id=self.model_id,
        )
        headers: dict[str, str] = {"Authorization": f"Bearer {self.api_key}"}
        if self.workspace_id:
            headers["X-DashScope-WorkSpace"] = self.workspace_id

        consecutive_errors = 0
        while not self._stop_event.is_set():
            try:
                reg_label = DASHSCOPE_REGIONS[self.region]["label"]
                await self.hub.broadcast_event(
                    {
                        "type": "status",
                        "state": "connecting",
                        "message": f"正在连接 {self.model_id}（{self.dir_spec['label']} · {reg_label}）...",
                    }
                )

                async with websockets.connect(
                    ws_url,
                    additional_headers=headers,
                    open_timeout=15,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=16 * 1024 * 1024,
                ) as qwen_ws:
                    # 1. Wait for initial session.created
                    first_raw = await asyncio.wait_for(qwen_ws.recv(), timeout=15)
                    first_ev = json.loads(first_raw)
                    if first_ev.get("type") == "error":
                        err_info = first_ev.get("error", {})
                        raise RuntimeError(
                            err_info.get("message") or str(first_ev)
                        )

                    # 2. Send mandatory session.update before streaming any audio
                    update_payload = build_qwen_session_update(
                        direction=self.direction,
                        voice_mode=self.voice_mode,
                        phrases=self.phrases,
                        vad_mode=self.vad_mode,
                        custom_voice_id=self.custom_voice_id,
                    )
                    await qwen_ws.send(json.dumps(update_payload, ensure_ascii=False))

                    # 3. Wait for session.updated acknowledgment
                    ack_raw = await asyncio.wait_for(qwen_ws.recv(), timeout=15)
                    ack_ev = json.loads(ack_raw)
                    if ack_ev.get("type") == "error":
                        err_info = ack_ev.get("error", {})
                        raise RuntimeError(
                            err_info.get("message") or str(ack_ev)
                        )

                    consecutive_errors = 0
                    phrase_count = len(self.phrases)
                    await self.hub.broadcast_event(
                        {
                            "type": "status",
                            "state": "live",
                            "model": self.model_id,
                            "direction": self.direction,
                            "log_file": str(self.transcript_logger.path.name)
                            if self.transcript_logger.path
                            else None,
                            "message": f"Qwen3.8 实时翻译已连接（{self.dir_spec['label']} · 已加载 {phrase_count} 条术语）",
                        }
                    )

                    sender = asyncio.create_task(self._send_loop(qwen_ws))
                    receiver = asyncio.create_task(self._receive_loop(qwen_ws))
                    stats_reporter = asyncio.create_task(self._stats_loop())

                    done, pending = await asyncio.wait(
                        {sender, receiver, stats_reporter},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)

                    for task in done:
                        exc = task.exception()
                        if exc and not isinstance(exc, asyncio.CancelledError):
                            raise exc

                    if not self._stop_event.is_set():
                        self.metrics.reconnect_count += 1
                        logger.info(
                            "Qwen3.8 WebSocket closed by server; reconnecting (count=%d)",
                            self.metrics.reconnect_count,
                        )
                        await asyncio.sleep(1.0)
                        continue

            except asyncio.CancelledError:
                break
            except Exception as exc:
                consecutive_errors += 1
                err_msg = str(exc)
                logger.exception("Qwen3.8 LiveTranslate error: %s", err_msg)

                lower_err = err_msg.lower()
                is_fatal = any(
                    keyword in lower_err
                    for keyword in (
                        "invalidapikey",
                        "api key",
                        "api_key",
                        "401",
                        "403",
                        "unauthorized",
                        "forbidden",
                        "invalid_value",
                        "workspace",
                    )
                )

                await self.hub.broadcast_event(
                    {
                        "type": "error",
                        "fatal": is_fatal or consecutive_errors >= 3,
                        "message": f"Qwen3.8 实时连接异常：{err_msg}",
                    }
                )

                if is_fatal or consecutive_errors >= 3 or self._stop_event.is_set():
                    break

                await asyncio.sleep(min(2.0 * consecutive_errors, 5.0))

        await self.hub.broadcast_event(
            {
                "type": "status",
                "state": "stopped",
                "stats": self.metrics.estimate_cost(),
                "message": "翻译会话已结束",
            }
        )

    async def _send_loop(self, qwen_ws: Any) -> None:
        while not self._stop_event.is_set():
            try:
                chunk = await asyncio.wait_for(self._audio_queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue

            if chunk is None:
                return

            self.metrics.input_audio_bytes += len(chunk)
            await qwen_ws.send(
                json.dumps(
                    {
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(chunk).decode("ascii"),
                    }
                )
            )

    async def _receive_loop(self, qwen_ws: Any) -> None:
        src_tag = self.dir_spec["source_lang_tag"]
        tgt_tag = self.dir_spec["target_lang_tag"]
        input_buf: list[str] = []
        output_buf: list[str] = []
        last_sent_audio_turn_id: int | None = None
        turn_has_output = False
        turn_saw_audio_transcript = False

        # Qwen3.8 LiveTranslate reports session-cumulative usage per connection;
        # snapshot prior connection totals so reconnects add cleanly without double-counting.
        base_in_tok = self.metrics.reported_prompt_tokens
        base_out_tok = self.metrics.reported_response_tokens
        base_text_out = self.metrics.reported_text_output_tokens
        base_audio_out = self.metrics.reported_audio_output_tokens

        async for raw_msg in qwen_ws:
            if self._stop_event.is_set():
                return
            if not isinstance(raw_msg, str):
                continue

            try:
                ev = json.loads(raw_msg)
            except json.JSONDecodeError:
                continue

            ev_type = ev.get("type", "")

            if ev_type == "error":
                err_info = ev.get("error", {})
                err_text = err_info.get("message") or str(ev)
                await self.hub.broadcast_event(
                    {
                        "type": "error",
                        "fatal": False,
                        "message": f"Qwen3.8 服务端提示：{err_text}",
                    }
                )
                continue

            # 1. Translated PCM audio stream (24kHz 16-bit mono)
            if ev_type == "response.audio.delta":
                b64_delta = ev.get("delta", "")
                if b64_delta:
                    audio_bytes = base64.b64decode(b64_delta)
                    if last_sent_audio_turn_id != self._turn_id:
                        await self.hub.broadcast_event(
                            {"type": "audio_turn", "turn_id": self._turn_id}
                        )
                        last_sent_audio_turn_id = self._turn_id
                    turn_has_output = True
                    self.metrics.output_audio_bytes += len(audio_bytes)
                    await self.hub.broadcast_audio(audio_bytes)
                continue

            # 2. Translated target subtitle stream (supports both text+stash and delta)
            if ev_type in ("response.audio_transcript.text", "response.text.text"):
                confirmed = ev.get("text") or ""
                stash = ev.get("stash") or ""
                if confirmed or stash:
                    turn_saw_audio_transcript = True
                    turn_has_output = True
                    output_buf.clear()
                    output_buf.append(confirmed + stash)
                    await self.hub.broadcast_event(
                        {
                            "type": "output_transcript_replace",
                            "turn_id": self._turn_id,
                            "text": confirmed,
                            "stash": stash,
                        }
                    )
                continue

            if ev_type == "response.audio_transcript.delta":
                delta = ev.get("delta", "")
                if delta:
                    turn_saw_audio_transcript = True
                    turn_has_output = True
                    output_buf.append(delta)
                    await self.hub.broadcast_event(
                        {
                            "type": "output_transcript",
                            "turn_id": self._turn_id,
                            "text": delta,
                        }
                    )
                continue

            if ev_type == "response.text.delta" and not turn_saw_audio_transcript:
                delta = ev.get("delta", "")
                if delta:
                    turn_has_output = True
                    output_buf.append(delta)
                    await self.hub.broadcast_event(
                        {
                            "type": "output_transcript",
                            "turn_id": self._turn_id,
                            "text": delta,
                        }
                    )
                continue

            # 3. Source speech ASR transcript events (supports text+stash, delta, completed)
            if ev_type == "conversation.item.input_audio_transcription.text":
                confirmed = ev.get("text") or ""
                stash = ev.get("stash") or ""
                if confirmed or stash:
                    input_buf.clear()
                    input_buf.append(confirmed + stash)
                    await self.hub.broadcast_event(
                        {
                            "type": "input_transcript_replace",
                            "turn_id": self._turn_id,
                            "text": confirmed,
                            "stash": stash,
                        }
                    )
                continue

            if ev_type in (
                "conversation.item.input_audio_transcription.delta",
                "input_audio_transcription.delta",
            ):
                delta = ev.get("delta") or ev.get("text") or ""
                if delta:
                    input_buf.append(delta)
                    await self.hub.broadcast_event(
                        {
                            "type": "input_transcript",
                            "turn_id": self._turn_id,
                            "text": delta,
                        }
                    )
                continue

            if ev_type == "conversation.item.input_audio_transcription.completed":
                completed = ev.get("transcript") or ev.get("text") or ""
                if completed:
                    input_buf.clear()
                    input_buf.append(completed)
                    await self.hub.broadcast_event(
                        {
                            "type": "input_transcript_replace",
                            "turn_id": self._turn_id,
                            "text": completed,
                            "stash": "",
                        }
                    )
                continue

            # 4. Turn completion & usage reporting
            if ev_type == "response.done":
                resp_obj = ev.get("response") or {}
                usage = resp_obj.get("usage") or ev.get("usage") or {}
                if usage:
                    in_details = (
                        usage.get("input_tokens_details")
                        or usage.get("input_token_details")
                        or {}
                    )
                    out_details = (
                        usage.get("output_tokens_details")
                        or usage.get("output_token_details")
                        or {}
                    )
                    in_audio = int(in_details.get("audio_tokens") or 0)
                    in_tok = in_audio or int(usage.get("input_tokens") or 0)
                    out_tok = int(usage.get("output_tokens") or 0)
                    text_out = int(out_details.get("text_tokens") or 0)
                    audio_out = int(out_details.get("audio_tokens") or 0)
                    if in_tok:
                        self.metrics.reported_prompt_tokens = max(
                            self.metrics.reported_prompt_tokens, base_in_tok + in_tok
                        )
                    if out_tok:
                        self.metrics.reported_response_tokens = max(
                            self.metrics.reported_response_tokens, base_out_tok + out_tok
                        )
                    if text_out:
                        self.metrics.reported_text_output_tokens = max(
                            self.metrics.reported_text_output_tokens, base_text_out + text_out
                        )
                    if audio_out:
                        self.metrics.reported_audio_output_tokens = max(
                            self.metrics.reported_audio_output_tokens, base_audio_out + audio_out
                        )

                if input_buf:
                    self.transcript_logger.log(src_tag, "".join(input_buf))
                    input_buf.clear()
                if output_buf:
                    self.transcript_logger.log(tgt_tag, "".join(output_buf))
                    output_buf.clear()

                await self.hub.broadcast_event(
                    {"type": "turn_complete", "turn_id": self._turn_id}
                )
                if turn_has_output:
                    self._turn_id += 1
                    turn_has_output = False
                    turn_saw_audio_transcript = False
                    last_sent_audio_turn_id = None

    async def _stats_loop(self) -> None:
        while not self._stop_event.is_set():
            await asyncio.sleep(2.0)
            await self.hub.broadcast_event(
                {
                    "type": "stats",
                    "stats": self.metrics.estimate_cost(),
                }
            )


class LiveTranslationBridge:
    """Manages a resilient Google Gemini Live API session with automatic resumption."""

    def __init__(
        self,
        hub: BroadcastHub,
        api_key: str,
        model_id: str,
        direction: str,
        system_instruction: str,
        echo_target_language: bool,
        compression_trigger_tokens: int,
        compression_target_tokens: int,
        save_transcript: bool,
    ) -> None:
        self.hub = hub
        self.api_key = api_key
        self.model_id = model_id
        self.direction = direction
        self.dir_spec = get_direction_spec(direction)
        self.system_instruction = system_instruction
        self.echo_target_language = echo_target_language
        self.compression_trigger_tokens = compression_trigger_tokens
        self.compression_target_tokens = compression_target_tokens
        self.metrics = SessionMetrics(model=model_id)
        self.transcript_logger = TranscriptLogger(
            enabled=save_transcript,
            model_id=model_id,
            direction=direction,
        )

        self._audio_queue: asyncio.Queue[bytes | str | None] = asyncio.Queue(maxsize=200)
        self._stop_event = asyncio.Event()
        self._resumption_handle: str | None = None
        self._runner_task: asyncio.Task[None] | None = None
        self._turn_id: int = 1

    def start(self) -> None:
        self._runner_task = asyncio.create_task(self._run_loop())

    async def push_audio(self, pcm_bytes: bytes) -> None:
        if self._stop_event.is_set():
            return
        if self._audio_queue.full():
            try:
                self._audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        await self._audio_queue.put(pcm_bytes)

    async def notify_audio_pause(self) -> None:
        if not self._stop_event.is_set():
            await self._audio_queue.put("AUDIO_STREAM_END")

    async def stop(self) -> None:
        self._stop_event.set()
        try:
            self._audio_queue.put_nowait(None)
        except asyncio.QueueFull:
            pass
        if self._runner_task:
            self._runner_task.cancel()
            try:
                await self._runner_task
            except asyncio.CancelledError:
                pass

    async def _run_loop(self) -> None:
        client = genai.Client(
            api_key=self.api_key,
            http_options={"api_version": "v1beta"},
        )

        consecutive_errors = 0
        while not self._stop_event.is_set():
            config = build_live_config(
                model_id=self.model_id,
                system_instruction=self.system_instruction,
                echo_target_language=self.echo_target_language,
                compression_trigger_tokens=self.compression_trigger_tokens,
                compression_target_tokens=self.compression_target_tokens,
                resumption_handle=self._resumption_handle,
                direction=self.direction,
            )

            try:
                await self.hub.broadcast_event(
                    {
                        "type": "status",
                        "state": "connecting",
                        "message": (
                            "正在无缝重连 Gemini Live 会话..."
                            if self._resumption_handle
                            else f"正在连接 {self.model_id}（{self.dir_spec['label']}）..."
                        ),
                    }
                )

                async with client.aio.live.connect(
                    model=self.model_id,
                    config=config,
                ) as session:
                    consecutive_errors = 0
                    await self.hub.broadcast_event(
                        {
                            "type": "status",
                            "state": "live",
                            "model": self.model_id,
                            "direction": self.direction,
                            "log_file": str(self.transcript_logger.path.name)
                            if self.transcript_logger.path
                            else None,
                            "message": f"实时翻译已连接（{self.dir_spec['label']}）",
                        }
                    )

                    reconnect_requested = asyncio.Event()
                    sender = asyncio.create_task(
                        self._send_loop(session, reconnect_requested)
                    )
                    receiver = asyncio.create_task(
                        self._receive_loop(session, reconnect_requested)
                    )
                    stats_reporter = asyncio.create_task(
                        self._stats_loop(reconnect_requested)
                    )

                    done, pending = await asyncio.wait(
                        {sender, receiver, stats_reporter},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)

                    for task in done:
                        exc = task.exception()
                        if exc and not isinstance(exc, asyncio.CancelledError):
                            raise exc

                    if reconnect_requested.is_set() and not self._stop_event.is_set():
                        self.metrics.reconnect_count += 1
                        logger.info(
                            "Reconnecting Live API session cleanly (count=%d)",
                            self.metrics.reconnect_count,
                        )
                        continue

            except asyncio.CancelledError:
                break
            except Exception as exc:
                consecutive_errors += 1
                err_msg = str(exc)
                logger.exception("Gemini Live session error: %s", err_msg)

                lower_err = err_msg.lower()
                is_fatal = any(
                    keyword in lower_err
                    for keyword in (
                        "api key",
                        "api_key",
                        "permission",
                        "unauthorized",
                        "401",
                        "403",
                        "invalid argument",
                        "not found",
                    )
                )

                await self.hub.broadcast_event(
                    {
                        "type": "error",
                        "fatal": is_fatal or consecutive_errors >= 3,
                        "message": f"Gemini Live 连接异常：{err_msg}",
                    }
                )

                if is_fatal or consecutive_errors >= 3 or self._stop_event.is_set():
                    break

                if consecutive_errors >= 2:
                    self._resumption_handle = None

                await asyncio.sleep(min(2.0 * consecutive_errors, 5.0))

        await self.hub.broadcast_event(
            {
                "type": "status",
                "state": "stopped",
                "stats": self.metrics.estimate_cost(),
                "message": "翻译会话已结束",
            }
        )

    async def _send_loop(
        self,
        session: Any,
        reconnect_requested: asyncio.Event,
    ) -> None:
        while not self._stop_event.is_set() and not reconnect_requested.is_set():
            try:
                item = await asyncio.wait_for(self._audio_queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue

            if item is None:
                return

            if item == "AUDIO_STREAM_END":
                await session.send_realtime_input(audio_stream_end=True)
                continue

            self.metrics.input_audio_bytes += len(item)
            await session.send_realtime_input(
                audio=types.Blob(data=item, mime_type="audio/pcm;rate=16000")
            )

    async def _receive_loop(
        self,
        session: Any,
        reconnect_requested: asyncio.Event,
    ) -> None:
        input_buf: list[str] = []
        output_buf: list[str] = []
        last_sent_audio_turn_id: int | None = None
        turn_has_output = False
        last_output_text_at: float = 0.0
        src_tag = self.dir_spec["source_lang_tag"]
        tgt_tag = self.dir_spec["target_lang_tag"]

        def flush_logs() -> None:
            if input_buf:
                self.transcript_logger.log(src_tag, "".join(input_buf))
                input_buf.clear()
            if output_buf:
                self.transcript_logger.log(tgt_tag, "".join(output_buf))
                output_buf.clear()

        async def advance_segment() -> None:
            nonlocal turn_has_output, last_sent_audio_turn_id
            flush_logs()
            await self.hub.broadcast_event(
                {"type": "turn_complete", "turn_id": self._turn_id}
            )
            if turn_has_output:
                self._turn_id += 1
                turn_has_output = False
                last_sent_audio_turn_id = None

        try:
            # IMPORTANT: google-genai's AsyncSession.receive() breaks after each
            # turn_complete / interaction_complete, so we MUST loop across turns!
            while not self._stop_event.is_set() and not reconnect_requested.is_set():
                got_any = False
                async for response in session.receive():
                    got_any = True
                    if self._stop_event.is_set():
                        return

                    resumption = getattr(response, "session_resumption_update", None)
                    if resumption and getattr(resumption, "resumable", False) and getattr(
                        resumption, "new_handle", None
                    ):
                        self._resumption_handle = resumption.new_handle

                    go_away = getattr(response, "go_away", None)
                    if go_away:
                        time_left = getattr(go_away, "time_left", None)
                        await self.hub.broadcast_event(
                            {
                                "type": "go_away",
                                "time_left": str(time_left) if time_left is not None else "",
                                "message": "服务端即将轮换连接，正在准备无缝恢复会话...",
                            }
                        )
                        reconnect_requested.set()
                        return

                    usage = getattr(response, "usage_metadata", None)
                    if usage:
                        prompt_tokens = getattr(usage, "prompt_token_count", None) or 0
                        response_tokens = getattr(usage, "response_token_count", None) or 0
                        if prompt_tokens:
                            self.metrics.reported_prompt_tokens += int(prompt_tokens)
                        if response_tokens:
                            self.metrics.reported_response_tokens += int(response_tokens)

                    content = getattr(response, "server_content", None)
                    if not content:
                        continue

                    model_turn = getattr(content, "model_turn", None)
                    if model_turn and getattr(model_turn, "parts", None):
                        for part in model_turn.parts:
                            inline_data = getattr(part, "inline_data", None)
                            if inline_data and getattr(inline_data, "data", None):
                                if last_sent_audio_turn_id != self._turn_id:
                                    await self.hub.broadcast_event(
                                        {
                                            "type": "audio_turn",
                                            "turn_id": self._turn_id,
                                        }
                                    )
                                    last_sent_audio_turn_id = self._turn_id
                                turn_has_output = True
                                audio_bytes = inline_data.data
                                self.metrics.output_audio_bytes += len(audio_bytes)
                                await self.hub.broadcast_audio(audio_bytes)

                    in_tr = getattr(content, "input_transcription", None)
                    if in_tr and getattr(in_tr, "text", None):
                        text = in_tr.text
                        input_buf.append(text)
                        await self.hub.broadcast_event(
                            {
                                "type": "input_transcript",
                                "turn_id": self._turn_id,
                                "text": text,
                            }
                        )

                    out_tr = getattr(content, "output_transcription", None)
                    if out_tr and getattr(out_tr, "text", None):
                        now_mono = time.monotonic()
                        # Natural speech pause (>= 2.2s gap) starts a fresh paragraph cleanly
                        if (
                            output_buf
                            and last_output_text_at > 0
                            and (now_mono - last_output_text_at) >= 2.2
                        ):
                            await advance_segment()

                        last_output_text_at = now_mono
                        incoming = out_tr.text
                        combined = "".join(output_buf) + incoming
                        split_idx = find_sentence_split_index(combined, self.direction)

                        if split_idx is not None:
                            prev_len = len("".join(output_buf))
                            # Part of incoming that finishes the current paragraph
                            cut_in_incoming = max(0, split_idx - prev_len)
                            head = incoming[:cut_in_incoming]
                            tail = incoming[cut_in_incoming:].lstrip()

                            if head:
                                output_buf.append(head)
                                turn_has_output = True
                                await self.hub.broadcast_event(
                                    {
                                        "type": "output_transcript",
                                        "turn_id": self._turn_id,
                                        "text": head,
                                    }
                                )

                            await advance_segment()

                            if tail:
                                output_buf.append(tail)
                                turn_has_output = True
                                await self.hub.broadcast_event(
                                    {
                                        "type": "output_transcript",
                                        "turn_id": self._turn_id,
                                        "text": tail,
                                    }
                                )
                        else:
                            output_buf.append(incoming)
                            turn_has_output = True
                            await self.hub.broadcast_event(
                                {
                                    "type": "output_transcript",
                                    "turn_id": self._turn_id,
                                    "text": incoming,
                                }
                            )

                    if getattr(content, "interrupted", False):
                        flush_logs()
                        await self.hub.broadcast_event(
                            {"type": "interrupted", "turn_id": self._turn_id}
                        )
                        if turn_has_output:
                            self._turn_id += 1
                            turn_has_output = False
                            last_sent_audio_turn_id = None

                    if getattr(content, "turn_complete", False) or getattr(
                        content, "generation_complete", False
                    ):
                        await advance_segment()

                if not got_any:
                    # Underlying WebSocket closed cleanly
                    return
        finally:
            flush_logs()

    async def _stats_loop(self, reconnect_requested: asyncio.Event) -> None:
        while not self._stop_event.is_set() and not reconnect_requested.is_set():
            await asyncio.sleep(2.0)
            await self.hub.broadcast_event(
                {
                    "type": "stats",
                    "stats": self.metrics.estimate_cost(),
                }
            )


async def homepage(_request: Request) -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


async def api_health(_request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})


async def api_config(_request: Request) -> JSONResponse:
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    has_gemini_key = bool(
        gemini_key and gemini_key != "your_google_ai_studio_api_key_here"
    )
    dashscope_key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    has_dashscope_key = bool(
        dashscope_key and dashscope_key != "your_dashscope_api_key_here"
    )
    default_region = os.getenv("DASHSCOPE_REGION", "cn-beijing").strip() or "cn-beijing"
    if default_region not in DASHSCOPE_REGIONS:
        default_region = "cn-beijing"

    return JSONResponse(
        {
            "has_env_api_key": has_gemini_key,
            "has_env_gemini_key": has_gemini_key,
            "has_env_dashscope_key": has_dashscope_key,
            "has_env_workspace_id": bool(os.getenv("DASHSCOPE_WORKSPACE_ID", "").strip()),
            "default_model": DEFAULT_MODEL_ID,
            "default_direction": "zh-en",
            "default_dashscope_region": default_region,
            "models": list(MODELS.values()),
            "directions": list(DIRECTIONS.values()),
            "dashscope_regions": list(DASHSCOPE_REGIONS.values()),
            "qwen_voice_modes": QWEN_VOICE_MODES,
            "qwen_vad_modes": QWEN_VAD_MODES,
            "qwen_transport_modes": QWEN_TRANSPORT_MODES,
            "default_rules": DEFAULT_SERMON_RULES_ZH_EN,
            "defaults": {
                "echo_target_language": False,
                "compression_trigger_tokens": 4500,
                "compression_target_tokens": 2500,
                "save_transcript": True,
                "qwen_voice_mode": "clone_once",
                "qwen_vad_mode": "sermon_fast",
                "qwen_transport_mode": "webrtc",
            },
        }
    )


async def ws_translate(websocket: WebSocket) -> None:
    await websocket.accept()
    hub = BroadcastHub()
    hub.register(websocket)
    bridge: LiveTranslationBridge | QwenLiveTranslationBridge | None = None

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break

            if message.get("bytes") is not None:
                if bridge:
                    await bridge.push_audio(message["bytes"])
                continue

            raw_text = message.get("text")
            if not raw_text:
                continue

            try:
                payload = json.loads(raw_text)
            except json.JSONDecodeError:
                await websocket.send_text(
                    json.dumps(
                        {"type": "error", "fatal": False, "message": "无效的 JSON 消息"}
                    )
                )
                continue

            msg_type = payload.get("type")

            if msg_type == "start":
                if bridge:
                    await bridge.stop()
                    bridge = None

                model_id = payload.get("model") or DEFAULT_MODEL_ID
                if model_id not in MODELS:
                    model_id = DEFAULT_MODEL_ID
                model_spec = MODELS[model_id]

                direction = payload.get("direction") or "zh-en"
                if direction not in DIRECTIONS:
                    direction = "zh-en"

                save_transcript = bool(payload.get("save_transcript", True))

                if model_spec["provider"] == "dashscope":
                    dashscope_key = (
                        (payload.get("dashscope_api_key") or "").strip()
                        or os.getenv("DASHSCOPE_API_KEY", "").strip()
                    )
                    if not dashscope_key or dashscope_key == "your_dashscope_api_key_here":
                        await websocket.send_text(
                            json.dumps(
                                {
                                    "type": "error",
                                    "fatal": True,
                                    "message": "未检测到 DASHSCOPE_API_KEY。请在页面设置中填入，或在项目根目录 .env 文件中配置。",
                                },
                                ensure_ascii=False,
                            )
                        )
                        continue

                    region = (
                        (payload.get("dashscope_region") or "").strip()
                        or os.getenv("DASHSCOPE_REGION", "cn-beijing").strip()
                        or "cn-beijing"
                    )
                    workspace_id = (
                        (payload.get("dashscope_workspace_id") or "").strip()
                        or os.getenv("DASHSCOPE_WORKSPACE_ID", "").strip()
                    )
                    voice_mode = payload.get("qwen_voice_mode") or "clone_once"
                    vad_mode = payload.get("qwen_vad_mode") or "sermon_fast"
                    custom_voice_id = (payload.get("qwen_custom_voice_id") or "").strip()
                    phrases = parse_glossary_phrases(
                        payload.get("glossary"),
                        payload.get("sermon_context"),
                    )

                    bridge = QwenLiveTranslationBridge(
                        hub=hub,
                        api_key=dashscope_key,
                        model_id=model_id,
                        direction=direction,
                        region=region,
                        workspace_id=workspace_id,
                        voice_mode=voice_mode,
                        vad_mode=vad_mode,
                        phrases=phrases,
                        save_transcript=save_transcript,
                        custom_voice_id=custom_voice_id,
                    )
                    bridge.start()
                else:
                    gemini_key = (
                        (payload.get("api_key") or "").strip()
                        or os.getenv("GEMINI_API_KEY", "").strip()
                    )
                    if not gemini_key or gemini_key == "your_google_ai_studio_api_key_here":
                        await websocket.send_text(
                            json.dumps(
                                {
                                    "type": "error",
                                    "fatal": True,
                                    "message": "未检测到 GEMINI_API_KEY。请在页面设置中填入，或在项目根目录 .env 文件中配置。",
                                },
                                ensure_ascii=False,
                            )
                        )
                        continue

                    system_instruction = build_system_instruction(
                        model_id=model_id,
                        custom_rules=payload.get("rules"),
                        sermon_context=payload.get("sermon_context"),
                        direction=direction,
                    )

                    bridge = LiveTranslationBridge(
                        hub=hub,
                        api_key=gemini_key,
                        model_id=model_id,
                        direction=direction,
                        system_instruction=system_instruction,
                        echo_target_language=bool(payload.get("echo_target_language", False)),
                        compression_trigger_tokens=int(
                            payload.get("compression_trigger_tokens", 4500)
                        ),
                        compression_target_tokens=int(
                            payload.get("compression_target_tokens", 2500)
                        ),
                        save_transcript=save_transcript,
                    )
                    bridge.start()

            elif msg_type == "pause":
                if bridge:
                    await bridge.notify_audio_pause()
                    await websocket.send_text(
                        json.dumps(
                            {
                                "type": "status",
                                "state": "paused",
                                "message": "已暂停收音（唱诗/祷告静音中，不发送音频）",
                            },
                            ensure_ascii=False,
                        )
                    )

            elif msg_type == "resume":
                if bridge:
                    await websocket.send_text(
                        json.dumps(
                            {
                                "type": "status",
                                "state": "live",
                                "message": "已恢复实时收音翻译",
                            },
                            ensure_ascii=False,
                        )
                    )

            elif msg_type == "stop":
                if bridge:
                    await bridge.stop()
                    bridge = None

    except WebSocketDisconnect:
        logger.info("Soundbooth client disconnected")
    finally:
        if bridge:
            await bridge.stop()
        hub.unregister(websocket)


async def api_qwen_webrtc_sdp(request: Request) -> JSONResponse:
    """Proxy WebRTC Offer/Answer SDP exchange to Alibaba Cloud Model Studio."""
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "无效的请求体（需要 JSON）"}, status_code=400)

    offer_sdp = (payload.get("sdp") or "").strip()
    if not offer_sdp:
        return JSONResponse({"error": "缺少 WebRTC Offer SDP"}, status_code=400)

    model_id = payload.get("model") or DEFAULT_MODEL_ID
    if model_id not in MODELS or MODELS[model_id]["provider"] != "dashscope":
        model_id = DEFAULT_MODEL_ID

    direction = payload.get("direction") or "zh-en"
    if direction not in DIRECTIONS:
        direction = "zh-en"
    dir_spec = get_direction_spec(direction)

    api_key = (
        (payload.get("dashscope_api_key") or "").strip()
        or os.getenv("DASHSCOPE_API_KEY", "").strip()
    )
    if not api_key or api_key == "your_dashscope_api_key_here":
        return JSONResponse(
            {"error": "未检测到 DASHSCOPE_API_KEY，请在页面设置或 .env 中配置。"},
            status_code=400,
        )

    region = (
        (payload.get("dashscope_region") or "").strip()
        or os.getenv("DASHSCOPE_REGION", "cn-beijing").strip()
        or "cn-beijing"
    )
    workspace_id = (
        (payload.get("dashscope_workspace_id") or "").strip()
        or os.getenv("DASHSCOPE_WORKSPACE_ID", "").strip()
    )

    try:
        webrtc_url = build_qwen_webrtc_url(
            region=region,
            workspace_id=workspace_id,
            model_id=model_id,
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    voice_mode = payload.get("qwen_voice_mode") or "clone_once"
    vad_mode = payload.get("qwen_vad_mode") or "sermon_fast"
    custom_voice_id = (payload.get("qwen_custom_voice_id") or "").strip()
    phrases = parse_glossary_phrases(
        payload.get("glossary"),
        payload.get("sermon_context"),
    )
    session_update = build_qwen_session_update(
        direction=direction,
        voice_mode=voice_mode,
        phrases=phrases,
        vad_mode=vad_mode,
        custom_voice_id=custom_voice_id,
    )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/sdp",
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                webrtc_url,
                headers=headers,
                content=offer_sdp.encode("utf-8"),
            )
    except httpx.HTTPError as exc:
        return JSONResponse(
            {"error": f"连接阿里云 WebRTC 网关失败（请检查 Workspace ID 是否正确）：{exc}"},
            status_code=502,
        )

    if resp.status_code >= 400:
        detail = resp.text.strip()[:400] or f"HTTP {resp.status_code}"
        return JSONResponse(
            {"error": f"阿里云 WebRTC SDP 交换被拒绝 ({resp.status_code})：{detail}"},
            status_code=resp.status_code,
        )

    answer_sdp = resp.text
    log_file: str | None = None
    if bool(payload.get("save_transcript", True)):
        tl = TranscriptLogger(enabled=True, model_id=f"{model_id} (WebRTC)", direction=direction)
        log_file = tl.path.name if tl.path else None

    return JSONResponse(
        {
            "answer_sdp": answer_sdp,
            "session_update": session_update,
            "phrase_count": len(phrases),
            "direction_label": dir_spec["label"],
            "log_file": log_file,
        }
    )


def update_env_var(key_name: str, value: str, env_path: Path | None = None) -> None:
    """Persist or clear a single environment variable in local .env and os.environ."""
    target = env_path or ENV_FILE
    clean_val = value.strip()

    if clean_val:
        os.environ[key_name] = clean_val
    else:
        os.environ.pop(key_name, None)

    lines: list[str] = []
    if target.exists():
        lines = target.read_text(encoding="utf-8").splitlines()

    prefix = f"{key_name}="
    replaced = False
    new_lines: list[str] = []
    for line in lines:
        if line.startswith(prefix):
            new_lines.append(f"{prefix}{clean_val}")
            replaced = True
        else:
            new_lines.append(line)

    if not replaced:
        new_lines.append(f"{prefix}{clean_val}")

    target.write_text("\n".join(new_lines) + "\n", encoding="utf-8")


async def api_keys(request: Request) -> JSONResponse:
    """Save or clear GEMINI_API_KEY / DASHSCOPE_API_KEY locally in .env."""
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "无效的 JSON 请求"}, status_code=400)

    provider = (payload.get("provider") or "").strip().lower()
    action = (payload.get("action") or "").strip().lower()
    key_map = {
        "gemini": "GEMINI_API_KEY",
        "dashscope": "DASHSCOPE_API_KEY",
    }
    if provider not in key_map:
        return JSONResponse({"error": "不支持的 provider"}, status_code=400)
    if action not in ("save", "clear"):
        return JSONResponse({"error": "不支持的 action"}, status_code=400)

    env_key_name = key_map[provider]
    if action == "clear":
        update_env_var(env_key_name, "")
    else:
        api_key = (payload.get("api_key") or "").strip()
        if not api_key:
            return JSONResponse({"error": "API Key 不能为空"}, status_code=400)
        update_env_var(env_key_name, api_key)

    gemini_val = os.getenv("GEMINI_API_KEY", "").strip()
    dashscope_val = os.getenv("DASHSCOPE_API_KEY", "").strip()
    return JSONResponse(
        {
            "status": "ok",
            "provider": provider,
            "action": action,
            "has_env_gemini_key": bool(
                gemini_val and gemini_val != "your_google_ai_studio_api_key_here"
            ),
            "has_env_dashscope_key": bool(
                dashscope_val and dashscope_val != "your_dashscope_api_key_here"
            ),
        }
    )


async def api_transcript_log(request: Request) -> JSONResponse:
    """Append a finalized bilingual line from a WebRTC session to its logs/ file."""
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    log_file = os.path.basename((payload.get("log_file") or "").strip())
    speaker = (payload.get("speaker") or "").strip()
    text = (payload.get("text") or "").strip()
    if not log_file or not log_file.startswith("sermon_") or not log_file.endswith(".txt"):
        return JSONResponse({"error": "invalid log_file"}, status_code=400)
    if not speaker or not text:
        return JSONResponse({"status": "skipped"})

    target_path = (LOGS_DIR / log_file).resolve()
    if target_path.parent != LOGS_DIR.resolve():
        return JSONResponse({"error": "invalid path"}, status_code=400)

    ts = datetime.datetime.now().strftime("%H:%M:%S")
    with target_path.open("a", encoding="utf-8") as fh:
        fh.write(f"[{ts}] {speaker}: {text}\n")
    return JSONResponse({"status": "ok"})


routes = [
    Route("/", homepage),
    Route("/api/health", api_health),
    Route("/api/config", api_config),
    Route("/api/keys", api_keys, methods=["POST"]),
    Route("/api/qwen/webrtc-sdp", api_qwen_webrtc_sdp, methods=["POST"]),
    Route("/api/transcript/log", api_transcript_log, methods=["POST"]),
    WebSocketRoute("/ws/translate", ws_translate),
    Mount("/static", app=StaticFiles(directory=STATIC_DIR), name="static"),
]

app = Starlette(routes=routes)

if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8765"))
    uvicorn.run("server:app", host=host, port=port, reload=False)
