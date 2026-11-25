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
        initial = ws.receive_json()
        assert initial["type"] == "listener_count"

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


def test_mode2_listener_page_qrcode_and_tunnel_admin_protection():
    client = TestClient(server.app)

    # /listen and its static assets load cleanly
    r_listen = client.get("/listen")
    assert r_listen.status_code == 200
    assert "实时同声传译" in r_listen.text
    for asset in ("/static/listen.css", "/static/listen.js"):
        r_asset = client.get(asset)
        assert r_asset.status_code == 200

    # Offline SVG QR code generator
    r_qr = client.get("/api/qrcode", params={"url": "http://192.168.1.50:8765/listen"})
    assert r_qr.status_code == 200
    assert "image/svg+xml" in r_qr.headers["content-type"]
    assert "<svg" in r_qr.text

    # Requests arriving through Cloudflare Tunnel / reverse proxy must NEVER reach admin routes
    tunnel_headers = {"CF-Connecting-IP": "203.0.113.10", "X-Forwarded-For": "203.0.113.10"}

    r_root = client.get("/", headers=tunnel_headers, follow_redirects=False)
    assert r_root.status_code == 302
    assert r_root.headers["location"] == "/listen"

    assert client.get("/api/config", headers=tunnel_headers).status_code == 403
    assert (
        client.post(
            "/api/keys",
            headers=tunnel_headers,
            json={"provider": "gemini", "action": "clear"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/broadcast/settings",
            headers=tunnel_headers,
            json={"room_pin": "9999"},
        ).status_code
        == 403
    )
    assert client.post("/api/broadcast/tunnel/start", headers=tunnel_headers).status_code == 403
    assert client.post("/api/broadcast/tunnel/stop", headers=tunnel_headers).status_code == 403

    # Public broadcast status omits admin-only fields for proxied requests
    r_pub_status = client.get("/api/broadcast/status", headers=tunnel_headers)
    assert r_pub_status.status_code == 200
    pub_data = r_pub_status.json()
    assert "live" in pub_data
    assert "listener_count" in pub_data
    assert "room_pin" not in pub_data
    assert "lan_ip" not in pub_data


def test_mode2_1_to_n_fanout_ulaw_audio_late_join_and_pin(tmp_path, monkeypatch):
    import struct

    fake_env = tmp_path / ".env"
    fake_env.write_text("HOST=0.0.0.0\n", encoding="utf-8")
    monkeypatch.setattr(server, "ENV_FILE", fake_env)

    # Reset hub state cleanly for test isolation
    server.broadcast_hub.room_pin = ""
    server.broadcast_hub.public_url = ""
    client = TestClient(server.app)

    # 1. Soundbooth connects WebRTC broadcast uplink + starts session
    with client.websocket_connect("/ws/broadcast") as sb_ws:
        assert sb_ws.receive_json()["type"] == "listener_count"
        sb_ws.send_json(
            {
                "type": "broadcast_start",
                "model": "qwen3.8-livetranslate-flash-realtime",
                "direction": "zh-en",
                "transport": "webrtc",
            }
        )

        # 2. Two congregation phones connect simultaneously
        with client.websocket_connect("/ws/listen") as phone1, client.websocket_connect(
            "/ws/listen"
        ) as phone2:
            w1 = phone1.receive_json()
            w2 = phone2.receive_json()
            assert w1["type"] == "welcome"
            assert w1["live"] is True
            assert w2["type"] == "welcome"
            assert w2["listener_count"] == 2

            # Soundbooth receives live listener count updates (1 then 2)
            counts = []
            while len(counts) < 2:
                ev = sb_ws.receive_json()
                if ev["type"] == "listener_count":
                    counts.append(ev["count"])
            assert counts[-1] == 2

            # 3. Soundbooth broadcasts a translated caption + 24kHz PCM audio chunk (turn 7)
            sb_ws.send_json(
                {
                    "type": "output_transcript_replace",
                    "turn_id": 7,
                    "text": "Grace and peace to you in Christ.",
                    "stash": "",
                }
            )
            pcm_samples = b"\x00\x10\x00\xf0" * 100  # 400 bytes -> 200 samples -> 200 ulaw bytes
            sb_ws.send_bytes(struct.pack("<I", 7) + pcm_samples)

            # Helper to drain listener_count notifications until target event
            def next_non_count_json(ws):
                for _ in range(5):
                    m = ws.receive_json()
                    if m.get("type") != "listener_count":
                        return m
                raise AssertionError("Expected non-count JSON message")

            c1 = next_non_count_json(phone1)
            c2 = next_non_count_json(phone2)
            assert c1["type"] == "output_transcript_replace"
            assert c1["text"] == "Grace and peace to you in Christ."
            assert c2["text"] == "Grace and peace to you in Christ."

            b1 = phone1.receive_bytes()
            b2 = phone2.receive_bytes()
            assert b1 == b2
            codec, turn_id = struct.unpack("<BI", b1[:5])
            assert codec == 1  # Lossless 24kHz Int16 PCM for <= 25 listeners
            assert turn_id == 7
            assert b1[5:] == pcm_samples

            # Also verify adaptive μ-law codec (codec=2) activates when > PCM_LOSSLESS_MAX_LISTENERS
            orig_limit = server.broadcast_hub.PCM_LOSSLESS_MAX_LISTENERS
            try:
                server.broadcast_hub.PCM_LOSSLESS_MAX_LISTENERS = 1
                sb_ws.send_bytes(struct.pack("<I", 8) + pcm_samples)
                b1_ulaw = phone1.receive_bytes()
                b2_ulaw = phone2.receive_bytes()
                assert b1_ulaw == b2_ulaw
                codec_u, turn_u = struct.unpack("<BI", b1_ulaw[:5])
                assert codec_u == 2  # G.711 μ-law 24kHz
                assert turn_u == 8
                assert len(b1_ulaw) == 5 + len(pcm_samples) // 2
            finally:
                server.broadcast_hub.PCM_LOSSLESS_MAX_LISTENERS = orig_limit

            # 4. A 3rd late-joining phone immediately receives recent caption history
            with client.websocket_connect("/ws/listen") as phone3:
                w3 = phone3.receive_json()
                assert w3["type"] == "welcome"
                assert any(
                    item["turn_id"] == 7 and "Grace and peace" in item["target_text"]
                    for item in w3["history"]
                )

    # 5. Optional Room PIN gate & public URL normalization
    r_pin = client.post(
        "/api/broadcast/settings",
        json={"room_pin": "2026", "public_url": "sermon.example.com"},
    )
    assert r_pin.status_code == 200
    snap = r_pin.json()
    assert snap["requires_pin"] is True
    assert snap["effective_listen_url"] == "https://sermon.example.com/listen"

    with client.websocket_connect("/ws/listen") as bad_phone:
        auth_msg = bad_phone.receive_json()
        assert auth_msg["type"] == "auth_required"

    with client.websocket_connect("/ws/listen?pin=2026") as ok_phone:
        ok_welcome = ok_phone.receive_json()
        assert ok_welcome["type"] == "welcome"

    # Reset PIN & public_url cleanly
    r_reset = client.post("/api/broadcast/settings", json={"room_pin": "", "public_url": ""})
    assert r_reset.status_code == 200
    assert r_reset.json()["requires_pin"] is False
