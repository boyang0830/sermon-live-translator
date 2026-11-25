"""Tests for Sermon Live Translator backend (Qwen3.8 default + Gemini Live)."""

from starlette.testclient import TestClient

import server


def test_health_and_config_endpoints():
    client = TestClient(server.app)

    res_health = client.get("/api/health")
    assert res_health.status_code == 200
    assert res_health.json() == {"status": "ok"}

    res_cfg = client.get("/api/config")
    assert res_cfg.status_code == 200
    data = res_cfg.json()
    assert data["default_model"] == "qwen3.8-livetranslate-flash-realtime"
    assert data["default_direction"] == "zh-en"
    assert data["default_dashscope_region"] == "cn-beijing"
    assert "Christian church sermon" in data["default_rules"]

    model_ids = [m["id"] for m in data["models"]]
    assert model_ids == [
        "qwen3.8-livetranslate-flash-realtime",
        "gemini-3.5-live-translate-preview",
    ]
    assert data["defaults"]["qwen_voice_mode"] == "clone_once"
    voice_ids = [v["id"] for v in data["qwen_voice_modes"]]
    assert voice_ids[0] == "clone_once"
    assert "tina" in voice_ids
    assert "custom" in voice_ids

    directions = {d["id"]: d for d in data["directions"]}
    assert directions["zh-en"]["target_language_code"] == "en"
    assert directions["zh-en"]["qwen_target_language_code"] == "en"
    assert directions["en-zh"]["target_language_code"] == "zh-Hans"
    assert directions["en-zh"]["qwen_target_language_code"] == "zh"
    assert "称义=justification" in directions["zh-en"]["default_glossary"]
    assert "justification=称义" in directions["en-zh"]["default_glossary"]


def test_homepage_and_static_assets_served():
    client = TestClient(server.app)

    res_home = client.get("/")
    assert res_home.status_code == 200
    assert "教会主日同声传译台" in res_home.text
    assert 'id="paneSplitter"' in res_home.text
    assert 'id="dashscopeRegionSelect"' in res_home.text
    assert 'id="glossaryInput"' in res_home.text

    for path in (
        "/static/styles.css",
        "/static/app.js",
        "/static/audio-player.js",
        "/static/audio-capture-worklet.js",
        "/static/qwen-webrtc.js",
    ):
        res = client.get(path)
        assert res.status_code == 200, f"Expected 200 for {path}"


def test_qwen_ws_url_and_session_update_and_glossary():
    # Default workspace Beijing & Singapore URLs
    assert (
        server.build_qwen_ws_url("cn-beijing")
        == "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime"
    )
    assert (
        server.build_qwen_ws_url("ap-southeast-1")
        == "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime"
    )
    # Dedicated sub-workspace URL
    assert (
        server.build_qwen_ws_url("cn-beijing", workspace_id="llm-abc123")
        == "wss://llm-abc123.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime"
    )

    # Glossary parsing supports multiple user-friendly formats
    phrases = server.parse_glossary_phrases(
        "称义=justification\n成圣 -> sanctification\n主题：罗马书第八章\n圣灵 (the Holy Spirit), 恩典 (grace)",
        "阿们: Amen",
    )
    assert phrases["称义"] == "justification"
    assert phrases["成圣"] == "sanctification"
    assert phrases["圣灵"] == "the Holy Spirit"
    assert phrases["恩典"] == "grace"
    assert phrases["阿们"] == "Amen"
    assert "主题" not in phrases

    # session.update default voice must be real-time one-time voice cloning (clone_once)
    upd_default = server.build_qwen_session_update(
        direction="zh-en", phrases={"称义": "justification"}
    )
    assert upd_default["type"] == "session.update"
    assert upd_default["session"]["voice"] == "default"
    assert upd_default["session"]["enable_voice_clone"] is True
    assert upd_default["session"]["voice_clone_options"] == {"frequency": "once"}
    assert upd_default["session"]["translation"]["language"] == "en"
    assert upd_default["session"]["translation"]["corpus"]["phrases"] == {"称义": "justification"}
    td = upd_default["session"]["audio"]["input"]["turn_detection"]
    assert td["type"] == "server_vad"
    assert td["threshold"] == 0.2
    assert td["silence_duration_ms"] == 500
    assert td["interrupt_response"] is False

    # session.update payload for built-in preset voice Tina
    upd_tina = server.build_qwen_session_update(
        direction="zh-en", voice_mode="tina", phrases={"称义": "justification"}
    )
    assert upd_tina["session"]["voice"] == "Tina"
    assert upd_tina["session"]["audio"]["output"]["voice"] == "Tina"

    # session.update payload for custom pre-enrolled voice ID
    upd_custom = server.build_qwen_session_update(
        direction="zh-en", voice_mode="custom", custom_voice_id="qwen-vc-male-01"
    )
    assert upd_custom["session"]["voice"] == "qwen-vc-male-01"
    assert upd_custom["session"]["enable_voice_clone"] is True
    assert upd_custom["session"]["voice_clone_options"] == {"frequency": "never"}

    # session.update payload for real-time voice clone (once) + en-zh + speaker_fast
    upd_clone = server.build_qwen_session_update(
        direction="en-zh",
        voice_mode="clone_once",
        phrases={"justification": "称义"},
        vad_mode="speaker_fast",
    )
    assert upd_clone["session"]["voice"] == "default"
    assert upd_clone["session"]["enable_voice_clone"] is True
    assert upd_clone["session"]["voice_clone_options"] == {"frequency": "once"}
    assert upd_clone["session"]["translation"]["language"] == "zh"
    assert upd_clone["session"]["audio"]["input"]["turn_detection"]["type"] == "speaker_detection"
    assert upd_clone["session"]["audio"]["input"]["turn_detection"]["interrupt_response"] is False


def test_build_system_instruction_and_live_config_bidirectional():
    si_zh_en = server.build_system_instruction(
        "gemini-3.5-live-translate-preview",
        sermon_context="Passage: Romans 8",
        direction="zh-en",
    )
    assert "American English" in si_zh_en
    assert "Passage: Romans 8" in si_zh_en

    cfg_zh_en = server.build_live_config(
        model_id="gemini-3.5-live-translate-preview",
        system_instruction=si_zh_en,
        direction="zh-en",
    )
    assert cfg_zh_en.translation_config.target_language_code == "en"

    si_en_zh = server.build_system_instruction(
        "gemini-3.5-live-translate-preview",
        direction="en-zh",
    )
    cfg_en_zh = server.build_live_config(
        model_id="gemini-3.5-live-translate-preview",
        system_instruction=si_en_zh,
        direction="en-zh",
    )
    assert cfg_en_zh.translation_config.target_language_code == "zh-Hans"


def test_session_metrics_cost_estimation_qwen_and_gemini():
    # Qwen3.8 Beijing: 60s input (750 tok * ¥40/1M = ¥0.03) + 60s output (750 tok * ¥160/1M = ¥0.12) + 150 text tok * ¥100/1M = ¥0.015 => ¥0.165
    m_qwen = server.SessionMetrics(
        model="qwen3.8-livetranslate-flash-realtime",
        region="cn-beijing",
        input_audio_bytes=16000 * 2 * 60,
        output_audio_bytes=24000 * 2 * 60,
    )
    est_q = m_qwen.estimate_cost()
    assert est_q["currency"] == "CNY"
    assert est_q["currency_symbol"] == "¥"
    assert abs(est_q["estimated_cost"] - 0.165) < 0.0005

    # Gemini 3.5 Live Translate: 60s input + 60s output => $0.03675
    m_gem = server.SessionMetrics(
        model="gemini-3.5-live-translate-preview",
        input_audio_bytes=16000 * 2 * 60,
        output_audio_bytes=24000 * 2 * 60,
    )
    est_g = m_gem.estimate_cost()
    assert est_g["currency"] == "USD"
    assert abs(est_g["estimated_usd"] - 0.03675) < 0.0001


def test_qwen_webrtc_url_and_sdp_validation(monkeypatch):
    import pytest

    assert (
        server.build_qwen_webrtc_url("cn-beijing", "llm-abc123")
        == "https://llm-abc123.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-livetranslate-flash-realtime"
    )
    assert (
        server.build_qwen_webrtc_url("ap-southeast-1", "llm-sg999")
        == "https://llm-sg999.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-livetranslate-flash-realtime"
    )
    with pytest.raises(ValueError, match="Workspace ID"):
        server.build_qwen_webrtc_url("cn-beijing", "")

    monkeypatch.delenv("DASHSCOPE_WORKSPACE_ID", raising=False)
    client = TestClient(server.app)
    res = client.post(
        "/api/qwen/webrtc-sdp",
        json={
            "sdp": "v=0\r\n",
            "dashscope_api_key": "sk-test",
            "dashscope_region": "cn-beijing",
            "dashscope_workspace_id": "",
        },
    )
    assert res.status_code == 400
    assert "Workspace ID" in res.json()["error"]


def test_find_sentence_split_index_for_gemini():
    # Too short -> should NOT split yet
    assert server.find_sentence_split_index("Amen.", "zh-en") is None
    assert server.find_sentence_split_index("Peace to you.", "zh-en") is None

    # Abbreviations & numbers should NOT trigger premature splits
    abbr = "Today we are reading from Rom. 8 and listening to Dr. Lin speak about grace"
    assert server.find_sentence_split_index(abbr, "zh-en") is None

    # Normal completed English sentence (>= 45 chars) -> splits cleanly after period
    en_text = "Brothers and sisters, peace to you in the name of the Lord. Let us open Romans 8."
    idx = server.find_sentence_split_index(en_text, "zh-en")
    assert idx is not None
    assert en_text[:idx] == "Brothers and sisters, peace to you in the name of the Lord."
    assert en_text[idx:].lstrip() == "Let us open Romans 8."

    # Chinese target (en-zh) splits cleanly after Chinese period once >= 16 chars
    zh_text = "弟兄姊妹们平安，今天我们一起来读罗马书第八章。接下来我们看第一节。"
    idx_zh = server.find_sentence_split_index(zh_text, "en-zh")
    assert idx_zh is not None
    assert zh_text[:idx_zh] == "弟兄姊妹们平安，今天我们一起来读罗马书第八章。"
    assert zh_text[idx_zh:] == "接下来我们看第一节。"

    # Long run-on without period splits at comma once >= 160 chars
    long_runon = (
        "Because we have been justified through faith in Jesus Christ our Lord and Savior "
        "who gave himself for us on the cross, we now have peace with God and rejoice in the hope of his glory"
    )
    idx_comma = server.find_sentence_split_index(long_runon, "zh-en")
    assert idx_comma is not None
    assert long_runon[:idx_comma].endswith(",")


def test_api_keys_save_and_clear(tmp_path, monkeypatch):
    fake_env = tmp_path / ".env"
    fake_env.write_text("DASHSCOPE_API_KEY=sk-existing\nHOST=127.0.0.1\n", encoding="utf-8")
    monkeypatch.setattr(server, "ENV_FILE", fake_env)
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-existing")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    client = TestClient(server.app)

    # Save GEMINI_API_KEY without touching DASHSCOPE_API_KEY
    r_save = client.post(
        "/api/keys",
        json={"provider": "gemini", "action": "save", "api_key": "AIza-test-key"},
    )
    assert r_save.status_code == 200
    assert r_save.json()["has_env_gemini_key"] is True
    assert r_save.json()["has_env_dashscope_key"] is True
    content = fake_env.read_text(encoding="utf-8")
    assert "GEMINI_API_KEY=AIza-test-key" in content
    assert "DASHSCOPE_API_KEY=sk-existing" in content

    # Clear GEMINI_API_KEY only
    r_clear = client.post(
        "/api/keys",
        json={"provider": "gemini", "action": "clear"},
    )
    assert r_clear.status_code == 200
    assert r_clear.json()["has_env_gemini_key"] is False
    assert r_clear.json()["has_env_dashscope_key"] is True
    content2 = fake_env.read_text(encoding="utf-8")
    assert "GEMINI_API_KEY=\n" in content2
    assert "DASHSCOPE_API_KEY=sk-existing" in content2


def test_websocket_missing_keys_return_clear_errors(monkeypatch):
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    client = TestClient(server.app)

    with client.websocket_connect("/ws/translate") as ws:
        ws.send_json(
            {
                "type": "start",
                "model": "qwen3.8-livetranslate-flash-realtime",
                "direction": "zh-en",
            }
        )
        msg = ws.receive_json()
        assert msg["type"] == "error"
        assert msg["fatal"] is True
        assert "DASHSCOPE_API_KEY" in msg["message"]

        ws.send_json(
            {
                "type": "start",
                "model": "gemini-3.5-live-translate-preview",
                "direction": "en-zh",
            }
        )
        msg2 = ws.receive_json()
        assert msg2["type"] == "error"
        assert msg2["fatal"] is True
        assert "GEMINI_API_KEY" in msg2["message"]
