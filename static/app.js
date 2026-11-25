import { Pcm24kPlayer } from "/static/audio-player.js";
import { QwenWebRtcClient } from "/static/qwen-webrtc.js";

const STORAGE_KEY = "sermon_live_translator_prefs_v6";
const PREV_STORAGE_KEY = "sermon_live_translator_prefs_v5";
const DEFAULT_SPLIT_PCT = 68;
const MIN_SPLIT_PCT = 25;
const MAX_SPLIT_PCT = 85;

const el = {
  liveDot: document.getElementById("liveDot"),
  fsDot: document.getElementById("fsDot"),
  headerSubtitle: document.getElementById("headerSubtitle"),
  statusPill: document.getElementById("statusPill"),
  connectionHint: document.getElementById("connectionHint"),
  timerDisplay: document.getElementById("timerDisplay"),
  costDisplay: document.getElementById("costDisplay"),
  alertBanner: document.getElementById("alertBanner"),

  dirZhEnBtn: document.getElementById("dirZhEnBtn"),
  dirEnZhBtn: document.getElementById("dirEnZhBtn"),

  startBtn: document.getElementById("startBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  stopBtn: document.getElementById("stopBtn"),

  vuFill: document.getElementById("vuFill"),
  vuText: document.getElementById("vuText"),

  inputDeviceSelect: document.getElementById("inputDeviceSelect"),
  outputDeviceSelect: document.getElementById("outputDeviceSelect"),
  outputDeviceHelp: document.getElementById("outputDeviceHelp"),
  refreshDevicesBtn: document.getElementById("refreshDevicesBtn"),
  mixerCleanMode: document.getElementById("mixerCleanMode"),
  volumeSlider: document.getElementById("volumeSlider"),
  volumeValue: document.getElementById("volumeValue"),
  muteOutputBtn: document.getElementById("muteOutputBtn"),

  sermonContextInput: document.getElementById("sermonContextInput"),
  modelSelect: document.getElementById("modelSelect"),
  modelDescription: document.getElementById("modelDescription"),

  qwenSettingsGroup: document.getElementById("qwenSettingsGroup"),
  qwenTransportSelect: document.getElementById("qwenTransportSelect"),
  dashscopeRegionSelect: document.getElementById("dashscopeRegionSelect"),
  qwenVoiceModeSelect: document.getElementById("qwenVoiceModeSelect"),
  qwenCustomVoiceField: document.getElementById("qwenCustomVoiceField"),
  qwenCustomVoiceInput: document.getElementById("qwenCustomVoiceInput"),
  qwenVadModeSelect: document.getElementById("qwenVadModeSelect"),
  dashscopeApiKeyInput: document.getElementById("dashscopeApiKeyInput"),
  clearDashscopeKeyBtn: document.getElementById("clearDashscopeKeyBtn"),
  dashscopeKeyHelp: document.getElementById("dashscopeKeyHelp"),
  dashscopeWorkspaceInput: document.getElementById("dashscopeWorkspaceInput"),
  workspaceHelp: document.getElementById("workspaceHelp"),
  glossaryLabel: document.getElementById("glossaryLabel"),
  glossaryInput: document.getElementById("glossaryInput"),
  resetGlossaryBtn: document.getElementById("resetGlossaryBtn"),

  geminiSettingsGroup: document.getElementById("geminiSettingsGroup"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  clearGeminiKeyBtn: document.getElementById("clearGeminiKeyBtn"),
  apiKeyHelp: document.getElementById("apiKeyHelp"),
  compressionTriggerInput: document.getElementById("compressionTriggerInput"),
  compressionTargetInput: document.getElementById("compressionTargetInput"),
  echoTargetCheckbox: document.getElementById("echoTargetCheckbox"),
  saveTranscriptCheckbox: document.getElementById("saveTranscriptCheckbox"),
  rulesLabel: document.getElementById("rulesLabel"),
  rulesInput: document.getElementById("rulesInput"),
  resetRulesBtn: document.getElementById("resetRulesBtn"),

  splitContainer: document.getElementById("splitContainer"),
  paneSplitter: document.getElementById("paneSplitter"),
  toggleSourceBtn: document.getElementById("toggleSourceBtn"),

  targetPaneTitle: document.getElementById("targetPaneTitle"),
  sourcePaneTitle: document.getElementById("sourcePaneTitle"),
  targetStream: document.getElementById("targetStream"),
  targetEmptyState: document.getElementById("targetEmptyState"),
  sourceStream: document.getElementById("sourceStream"),
  sourceEmptyState: document.getElementById("sourceEmptyState"),
  logFileHint: document.getElementById("logFileHint"),

  fontSmallerBtn: document.getElementById("fontSmallerBtn"),
  fontLargerBtn: document.getElementById("fontLargerBtn"),
  exportBtn: document.getElementById("exportBtn"),
  clearCaptionsBtn: document.getElementById("clearCaptionsBtn"),

  themeToggleBtn: document.getElementById("themeToggleBtn"),
  fullscreenBtn: document.getElementById("fullscreenBtn"),
  fullscreenOverlay: document.getElementById("fullscreenOverlay"),
  fullscreenCaptions: document.getElementById("fullscreenCaptions"),
  fsTitle: document.getElementById("fsTitle"),
  fsFontSmallerBtn: document.getElementById("fsFontSmallerBtn"),
  fsFontLargerBtn: document.getElementById("fsFontLargerBtn"),
  exitFullscreenBtn: document.getElementById("exitFullscreenBtn"),
};

const state = {
  serverConfig: null,
  direction: "zh-en",
  rulesByDirection: {},
  glossaryByDirection: {},

  ws: null,
  webrtcClient: null,
  activeTransport: "websocket", // "webrtc" | "websocket"
  captureCtx: null,
  mediaStream: null,
  workletNode: null,
  player: null,

  running: false,
  paused: false,
  outputMuted: false,
  startedAtMs: null,
  timerHandle: null,

  captionSizeRem: 1.45,
  fsCaptionSizeRem: 3.0,
  splitPct: DEFAULT_SPLIT_PCT,
  sourceCollapsed: false,

  activeAudioTurnId: null,
  speakingTurnId: null,
  targetEntriesByTurn: new Map(),
  targetTurnOrder: [],
  sourceEntriesByTurn: new Map(),
  transcriptHistory: [],
  fallbackTurnCounter: 1,
};

state.player = new Pcm24kPlayer({
  onActiveTurnChange: (turnId) => {
    setSpeakingTurn(turnId);
  },
});

function getDirectionSpec(dirId = state.direction) {
  if (!state.serverConfig?.directions) return null;
  return (
    state.serverConfig.directions.find((d) => d.id === dirId) ||
    state.serverConfig.directions[0]
  );
}

function getSelectedModelSpec() {
  if (!state.serverConfig?.models) return null;
  return (
    state.serverConfig.models.find((m) => m.id === el.modelSelect.value) ||
    state.serverConfig.models[0]
  );
}

function getSelectedDashScopeRegionSpec() {
  if (!state.serverConfig?.dashscope_regions) return null;
  return (
    state.serverConfig.dashscope_regions.find(
      (r) => r.id === el.dashscopeRegionSelect.value
    ) || state.serverConfig.dashscope_regions[0]
  );
}

function formatClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function nowTimeLabel() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function showBanner(message, type = "error") {
  el.alertBanner.textContent = message;
  el.alertBanner.classList.remove("hidden", "info");
  if (type === "info") {
    el.alertBanner.classList.add("info");
  }
}

function hideBanner() {
  el.alertBanner.classList.add("hidden");
}

function updateHeaderSubtitle() {
  const dirSpec = getDirectionSpec();
  const modelSpec = getSelectedModelSpec();
  if (!dirSpec || !modelSpec) return;
  const shortModel =
    modelSpec.provider === "dashscope" ? "Qwen3.8-LiveTranslate" : modelSpec.id;
  el.headerSubtitle.textContent = `${dirSpec.short_label} · ${shortModel} (单机音控版)`;
}

function setUiState(mode, message) {
  el.liveDot.className = "brand-dot";
  el.fsDot.className = "brand-dot";
  el.statusPill.className = "status-pill";

  if (mode === "connecting") {
    el.liveDot.classList.add("connecting");
    el.fsDot.classList.add("connecting");
    el.statusPill.textContent = "连接中...";
  } else if (mode === "live") {
    el.liveDot.classList.add("live");
    el.fsDot.classList.add("live");
    el.statusPill.classList.add("live");
    el.statusPill.textContent = "实时翻译中";
  } else if (mode === "paused") {
    el.liveDot.classList.add("paused");
    el.fsDot.classList.add("paused");
    el.statusPill.classList.add("paused");
    el.statusPill.textContent = "已静音暂停";
  } else {
    el.statusPill.textContent = "待机";
  }

  if (message) {
    el.connectionHint.textContent = message;
  }

  el.startBtn.disabled = state.running;
  el.pauseBtn.disabled = !state.running;
  el.stopBtn.disabled = !state.running;
  el.dirZhEnBtn.disabled = state.running;
  el.dirEnZhBtn.disabled = state.running;
  el.modelSelect.disabled = state.running;
  el.pauseBtn.classList.toggle("active", state.paused);
  el.pauseBtn.textContent = state.paused ? "恢复收音翻译" : "静音暂停（唱诗/祷告）";
}

function savePrefs() {
  state.rulesByDirection[state.direction] = el.rulesInput.value;
  state.glossaryByDirection[state.direction] = el.glossaryInput.value;
  const prefs = {
    direction: state.direction,
    model: el.modelSelect.value,
    qwenTransport: el.qwenTransportSelect.value,
    dashscopeRegion: el.dashscopeRegionSelect.value,
    dashscopeWorkspace: el.dashscopeWorkspaceInput.value.trim(),
    dashscopeApiKey: el.dashscopeApiKeyInput.value.trim(),
    geminiApiKey: el.apiKeyInput.value.trim(),
    qwenVoiceMode: el.qwenVoiceModeSelect.value,
    qwenCustomVoiceId: el.qwenCustomVoiceInput.value.trim(),
    qwenVadMode: el.qwenVadModeSelect.value,
    sermonContext: el.sermonContextInput.value,
    rulesByDirection: state.rulesByDirection,
    glossaryByDirection: state.glossaryByDirection,
    mixerCleanMode: el.mixerCleanMode.checked,
    echoTarget: el.echoTargetCheckbox.checked,
    saveTranscript: el.saveTranscriptCheckbox.checked,
    compressionTrigger: Number(el.compressionTriggerInput.value),
    compressionTarget: Number(el.compressionTargetInput.value),
    inputDeviceId: el.inputDeviceSelect.value,
    outputDeviceId: el.outputDeviceSelect.value,
    theme: document.documentElement.dataset.theme || "dark",
    splitPct: state.splitPct,
    sourceCollapsed: state.sourceCollapsed,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota errors
  }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    // Migrate previous prefs while letting new default real-time voice cloning take effect
    const prevRaw = localStorage.getItem(PREV_STORAGE_KEY);
    if (prevRaw) {
      const prev = JSON.parse(prevRaw);
      delete prev.qwenVoiceMode;
      return prev;
    }
    return {};
  } catch {
    return {};
  }
}

function applyDirection(directionId, persist = true) {
  const spec = getDirectionSpec(directionId);
  if (!spec) return;

  if (state.direction && el.rulesInput.value) {
    state.rulesByDirection[state.direction] = el.rulesInput.value;
  }
  if (state.direction && el.glossaryInput.value) {
    state.glossaryByDirection[state.direction] = el.glossaryInput.value;
  }

  state.direction = spec.id;

  const isZhEn = spec.id === "zh-en";
  el.dirZhEnBtn.classList.toggle("active", isZhEn);
  el.dirZhEnBtn.setAttribute("aria-checked", String(isZhEn));
  el.dirEnZhBtn.classList.toggle("active", !isZhEn);
  el.dirEnZhBtn.setAttribute("aria-checked", String(!isZhEn));

  updateHeaderSubtitle();
  el.targetPaneTitle.textContent = spec.target_title;
  el.sourcePaneTitle.textContent = spec.source_title;
  el.fsTitle.textContent = spec.fullscreen_title;
  el.sermonContextInput.placeholder = spec.context_placeholder;
  el.rulesLabel.textContent = `口译规则（System Instruction · ${spec.label}）`;
  el.glossaryLabel.textContent = `神学术语词典（corpus.phrases · ${spec.label}）`;
  el.rulesInput.value = state.rulesByDirection[spec.id] || spec.default_rules;
  el.glossaryInput.value = state.glossaryByDirection[spec.id] || spec.default_glossary;

  if (persist) {
    savePrefs();
  }
}

function refreshApiKeyHints() {
  const cfg = state.serverConfig || {};
  const hasLocalDash = Boolean(el.dashscopeApiKeyInput.value.trim());
  const hasLocalGemini = Boolean(el.apiKeyInput.value.trim());

  if (cfg.has_env_dashscope_key || hasLocalDash) {
    el.dashscopeKeyHelp.textContent = cfg.has_env_dashscope_key
      ? "已记住 DASHSCOPE_API_KEY（已同步至本地 .env，切换模型或刷新不会丢失）。"
      : "已在本机浏览器记住 DASHSCOPE_API_KEY。";
  } else {
    el.dashscopeKeyHelp.textContent =
      "尚未配置 DASHSCOPE_API_KEY，填入后会自动记住，也可点击右侧「清空 Key」清除。";
  }

  if (cfg.has_env_gemini_key || hasLocalGemini) {
    el.apiKeyHelp.textContent = cfg.has_env_gemini_key
      ? "已记住 GEMINI_API_KEY（已同步至本地 .env，切换模型或刷新不会丢失）。"
      : "已在本机浏览器记住 GEMINI_API_KEY。";
  } else {
    el.apiKeyHelp.textContent =
      "尚未配置 GEMINI_API_KEY（切换为 Gemini 模型时需要），填入后会自动记住。";
  }
}

async function syncApiKeyWithServer(provider, action, apiKey = "") {
  try {
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, action, api_key: apiKey }),
    });
    if (res.ok) {
      const data = await res.json();
      if (state.serverConfig) {
        state.serverConfig.has_env_gemini_key = data.has_env_gemini_key;
        state.serverConfig.has_env_dashscope_key = data.has_env_dashscope_key;
      }
    }
  } catch (err) {
    console.warn("Failed to sync API key with local server:", err);
  }
  refreshApiKeyHints();
}

function updateModelUI() {
  const modelSpec = getSelectedModelSpec();
  if (!modelSpec) return;

  const isQwen = modelSpec.provider === "dashscope";
  el.qwenSettingsGroup.classList.toggle("hidden", !isQwen);
  el.geminiSettingsGroup.classList.toggle("hidden", isQwen);

  if (isQwen) {
    const reg = getSelectedDashScopeRegionSpec();
    const sym = reg ? reg.currency_symbol : "¥";
    const rate = reg ? reg.base_per_min.toFixed(3) : "0.165";
    el.modelDescription.textContent = `${modelSpec.description}（基础流式估算约 ${sym}${rate}/分钟）`;
    if (!state.running) {
      el.costDisplay.textContent = `${sym}0.000`;
    }
  } else {
    el.modelDescription.textContent = `${modelSpec.description}（基础流式单价约 $${modelSpec.base_usd_per_min.toFixed(4)}/分钟）`;
    if (!state.running) {
      el.costDisplay.textContent = "$0.000";
    }
  }

  updateHeaderSubtitle();
}

function applySplitPct(pct, persist = false) {
  const clamped = Math.max(MIN_SPLIT_PCT, Math.min(MAX_SPLIT_PCT, Math.round(pct)));
  state.splitPct = clamped;
  document.documentElement.style.setProperty("--top-pane-pct", `${clamped}%`);
  el.paneSplitter.setAttribute("aria-valuenow", String(clamped));
  if (persist) {
    savePrefs();
  }
}

function applySourceCollapsed(collapsed, persist = false) {
  state.sourceCollapsed = Boolean(collapsed);
  el.splitContainer.classList.toggle("source-collapsed", state.sourceCollapsed);
  el.toggleSourceBtn.textContent = state.sourceCollapsed ? "展开" : "收起";
  el.toggleSourceBtn.setAttribute("aria-expanded", String(!state.sourceCollapsed));
  if (persist) {
    savePrefs();
  }
}

function setupSplitter() {
  let dragging = false;

  const updateFromClientY = (clientY) => {
    const rect = el.splitContainer.getBoundingClientRect();
    if (rect.height <= 0) return;
    const relY = clientY - rect.top;
    const pct = (relY / rect.height) * 100;
    applySplitPct(pct, false);
  };

  el.paneSplitter.addEventListener("pointerdown", (e) => {
    if (state.sourceCollapsed) return;
    dragging = true;
    el.paneSplitter.classList.add("dragging");
    document.body.classList.add("is-resizing");
    el.paneSplitter.setPointerCapture(e.pointerId);
    updateFromClientY(e.clientY);
  });

  el.paneSplitter.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    updateFromClientY(e.clientY);
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    el.paneSplitter.classList.remove("dragging");
    document.body.classList.remove("is-resizing");
    try {
      el.paneSplitter.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    savePrefs();
  };

  el.paneSplitter.addEventListener("pointerup", endDrag);
  el.paneSplitter.addEventListener("pointercancel", endDrag);

  el.paneSplitter.addEventListener("dblclick", () => {
    applySplitPct(DEFAULT_SPLIT_PCT, true);
  });

  el.paneSplitter.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      applySplitPct(state.splitPct - 4, true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      applySplitPct(state.splitPct + 4, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      applySplitPct(DEFAULT_SPLIT_PCT, true);
    }
  });
}

async function refreshAudioDevices(requestPermission = false) {
  if (!navigator.mediaDevices?.enumerateDevices) return;

  if (requestPermission) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
    } catch (err) {
      showBanner(`无法获取麦克风权限：${err.message}`);
      return;
    }
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const prevIn = el.inputDeviceSelect.value;
  const prevOut = el.outputDeviceSelect.value;

  el.inputDeviceSelect.innerHTML = '<option value="">默认麦克风 / 音频输入</option>';
  el.outputDeviceSelect.innerHTML = '<option value="">系统默认输出</option>';

  let inIndex = 1;
  let outIndex = 1;
  for (const d of devices) {
    if (d.kind === "audioinput") {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `音频输入设备 ${inIndex++}`;
      el.inputDeviceSelect.appendChild(opt);
    } else if (d.kind === "audiooutput") {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `音频输出设备 ${outIndex++}`;
      el.outputDeviceSelect.appendChild(opt);
    }
  }

  if (prevIn) el.inputDeviceSelect.value = prevIn;
  if (prevOut) el.outputDeviceSelect.value = prevOut;

  const supportsSink =
    typeof AudioContext !== "undefined" &&
    typeof AudioContext.prototype.setSinkId === "function";
  if (!supportsSink) {
    el.outputDeviceSelect.disabled = true;
    el.outputDeviceHelp.textContent =
      "当前浏览器不支持独立切换输出设备，将走系统默认音频输出（建议使用 Chrome 或 Edge 以单独指定同传发射机）。";
  }
}

function setSpeakingTurn(turnId) {
  if (state.speakingTurnId === turnId) return;
  const prevTurnId = state.speakingTurnId;
  state.speakingTurnId = turnId;

  if (prevTurnId !== null) {
    const prevEntry = state.targetEntriesByTurn.get(prevTurnId);
    if (prevEntry) {
      prevEntry.div.classList.remove("speaking");
    }
  }

  if (turnId === null) {
    for (const entry of state.targetEntriesByTurn.values()) {
      entry.div.classList.remove("speaking");
    }
    renderFullscreenCaptions();
    return;
  }

  const activeEntry = state.targetEntriesByTurn.get(turnId);
  if (activeEntry) {
    activeEntry.div.classList.add("speaking");
    activeEntry.div.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  renderFullscreenCaptions();
}

function ensureTargetEntry(tid) {
  const spec = getDirectionSpec();
  const langTag = spec ? spec.target_lang_tag : "EN";

  el.targetEmptyState.classList.add("hidden");

  let entry = state.targetEntriesByTurn.get(tid);
  if (!entry) {
    const time = nowTimeLabel();
    const div = document.createElement("div");
    div.className = "caption-entry receiving";
    div.dataset.turnId = String(tid);

    const meta = document.createElement("div");
    meta.className = "caption-meta";

    const timeSpan = document.createElement("span");
    timeSpan.className = "caption-time";
    timeSpan.textContent = time;

    const badge = document.createElement("span");
    badge.className = "speaking-badge";
    badge.innerHTML =
      '<span class="eq-bars" aria-hidden="true"><span></span><span></span><span></span></span><span>播报中</span>';

    meta.appendChild(timeSpan);
    meta.appendChild(badge);

    const textWrap = document.createElement("div");
    textWrap.className = "caption-text";
    const confirmedSpan = document.createElement("span");
    const stashSpan = document.createElement("span");
    stashSpan.className = "caption-stash";
    textWrap.appendChild(confirmedSpan);
    textWrap.appendChild(stashSpan);

    div.appendChild(meta);
    div.appendChild(textWrap);
    el.targetStream.appendChild(div);

    entry = {
      turnId: tid,
      div,
      confirmedSpan,
      stashSpan,
      time,
      text: "",
      stash: "",
      langTag,
      finalized: false,
    };
    state.targetEntriesByTurn.set(tid, entry);
    state.targetTurnOrder.push(tid);

    if (state.speakingTurnId === tid) {
      div.classList.add("speaking");
    }
  }
  return entry;
}

function appendTargetTranscript(turnId, deltaText) {
  if (!deltaText) return;
  const tid = turnId ?? state.fallbackTurnCounter;
  const entry = ensureTargetEntry(tid);
  entry.text += deltaText;
  entry.stash = "";
  entry.confirmedSpan.textContent = entry.text;
  entry.stashSpan.textContent = "";
  el.targetStream.scrollTop = el.targetStream.scrollHeight;
  renderFullscreenCaptions();
}

function replaceTargetTranscript(turnId, confirmedText, stashText = "") {
  if (!confirmedText && !stashText) return;
  const tid = turnId ?? state.fallbackTurnCounter;
  const entry = ensureTargetEntry(tid);
  entry.text = confirmedText || "";
  entry.stash = stashText || "";
  entry.confirmedSpan.textContent = entry.text;
  entry.stashSpan.textContent = entry.stash;
  el.targetStream.scrollTop = el.targetStream.scrollHeight;
  renderFullscreenCaptions();
}

function ensureSourceEntry(tid) {
  const spec = getDirectionSpec();
  const langTag = spec ? spec.source_lang_tag : "ZH";

  el.sourceEmptyState.classList.add("hidden");

  let entry = state.sourceEntriesByTurn.get(tid);
  if (!entry) {
    const time = nowTimeLabel();
    const div = document.createElement("div");
    div.className = "source-entry";
    const timeSpan = document.createElement("span");
    timeSpan.className = "caption-time";
    timeSpan.textContent = time;
    const textWrap = document.createElement("span");
    const confirmedSpan = document.createElement("span");
    const stashSpan = document.createElement("span");
    stashSpan.className = "caption-stash";
    textWrap.appendChild(confirmedSpan);
    textWrap.appendChild(stashSpan);
    div.appendChild(timeSpan);
    div.appendChild(textWrap);
    el.sourceStream.appendChild(div);

    entry = {
      turnId: tid,
      div,
      confirmedSpan,
      stashSpan,
      time,
      text: "",
      stash: "",
      langTag,
      finalized: false,
    };
    state.sourceEntriesByTurn.set(tid, entry);
  }
  return entry;
}

function appendSourceTranscript(turnId, deltaText) {
  if (!deltaText) return;
  const tid = turnId ?? state.fallbackTurnCounter;
  const entry = ensureSourceEntry(tid);
  entry.text += deltaText;
  entry.stash = "";
  entry.confirmedSpan.textContent = entry.text;
  entry.stashSpan.textContent = "";
  el.sourceStream.scrollTop = el.sourceStream.scrollHeight;
}

function replaceSourceTranscript(turnId, confirmedText, stashText = "") {
  if (!confirmedText && !stashText) return;
  const tid = turnId ?? state.fallbackTurnCounter;
  const entry = ensureSourceEntry(tid);
  entry.text = confirmedText || "";
  entry.stash = stashText || "";
  entry.confirmedSpan.textContent = entry.text;
  entry.stashSpan.textContent = entry.stash;
  el.sourceStream.scrollTop = el.sourceStream.scrollHeight;
}

function persistWebRtcLogLine(logFile, speaker, text) {
  if (!logFile || !text) return;
  fetch("/api/transcript/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ log_file: logFile, speaker, text }),
  }).catch(() => {});
}

function finalizeTurn(turnId, webrtcLogFile = null) {
  const tids =
    turnId !== undefined && turnId !== null
      ? [turnId]
      : [...new Set([...state.sourceEntriesByTurn.keys(), ...state.targetEntriesByTurn.keys()])];

  for (const tid of tids) {
    const src = state.sourceEntriesByTurn.get(tid);
    if (src && !src.finalized) {
      const fullSrc = `${src.text}${src.stash}`.trim();
      src.finalized = true;
      src.text = fullSrc;
      src.stash = "";
      src.confirmedSpan.textContent = fullSrc;
      src.stashSpan.textContent = "";
      if (fullSrc) {
        state.transcriptHistory.push({
          time: src.time,
          lang: src.langTag,
          text: fullSrc,
        });
        if (webrtcLogFile) persistWebRtcLogLine(webrtcLogFile, src.langTag, fullSrc);
      }
    }

    const tgt = state.targetEntriesByTurn.get(tid);
    if (tgt && !tgt.finalized) {
      const fullTgt = `${tgt.text}${tgt.stash}`.trim();
      tgt.finalized = true;
      tgt.text = fullTgt;
      tgt.stash = "";
      tgt.confirmedSpan.textContent = fullTgt;
      tgt.stashSpan.textContent = "";
      tgt.div.classList.remove("receiving");
      if (fullTgt) {
        state.transcriptHistory.push({
          time: tgt.time,
          lang: tgt.langTag,
          text: fullTgt,
        });
        if (webrtcLogFile) persistWebRtcLogLine(webrtcLogFile, tgt.langTag, fullTgt);
      }
    }
  }

  if (turnId === undefined || turnId === null) {
    state.fallbackTurnCounter += 1;
  }
  renderFullscreenCaptions();
}

function renderFullscreenCaptions() {
  const recentIds = state.targetTurnOrder.slice(-6);
  el.fullscreenCaptions.innerHTML = "";

  const visibleEntries = recentIds
    .map((id) => state.targetEntriesByTurn.get(id))
    .filter((entry) => entry && `${entry.text}${entry.stash}`.trim());

  if (visibleEntries.length === 0) {
    const p = document.createElement("p");
    p.className = "fs-placeholder";
    p.textContent =
      state.direction === "en-zh"
        ? "等待实时中文同传字幕..."
        : "Waiting for live interpretation...";
    el.fullscreenCaptions.appendChild(p);
    return;
  }

  visibleEntries.forEach((entry, idx) => {
    const p = document.createElement("p");
    const isSpeakingLine =
      state.speakingTurnId !== null && entry.turnId === state.speakingTurnId;
    const classes = ["fs-line"];
    if (idx === visibleEntries.length - 1) classes.push("latest");
    if (isSpeakingLine) classes.push("speaking");
    p.className = classes.join(" ");
    p.textContent = `${entry.text}${entry.stash}`.trim();
    el.fullscreenCaptions.appendChild(p);
  });
  el.fullscreenCaptions.scrollTop = el.fullscreenCaptions.scrollHeight;
}

function updateStats(stats) {
  if (!stats) return;
  const sym = stats.currency_symbol || "$";
  const amount = Number(
    stats.estimated_cost !== undefined ? stats.estimated_cost : stats.estimated_usd || 0
  );
  el.costDisplay.textContent = `${sym}${amount.toFixed(4)}`;
  const basisLabel =
    stats.basis === "actual_tokens" ? "服务端回报 Token 估算" : "按音频流时长估算";
  const detailParts = [
    basisLabel,
    `输入音频 ${stats.input_audio_seconds}s · 输出音频 ${stats.output_audio_seconds}s`,
  ];
  if (stats.reported_prompt_tokens || stats.reported_response_tokens) {
    detailParts.push(
      `输入 ${stats.reported_prompt_tokens || 0} tok (音频 ${stats.reported_input_audio_tokens || 0} / 文本 ${stats.reported_input_text_tokens || 0} / 缓存 ${stats.reported_cached_tokens || 0})`
    );
    detailParts.push(
      `输出 ${stats.reported_response_tokens || 0} tok (音频 ${stats.reported_audio_output_tokens || 0} / 文本 ${stats.reported_text_output_tokens || 0})`
    );
  }
  el.costDisplay.title = detailParts.join(" | ");
}

async function startAudioCapture() {
  const cleanMixer = el.mixerCleanMode.checked;
  const audioConstraints = {
    channelCount: 1,
    echoCancellation: !cleanMixer,
    noiseSuppression: !cleanMixer,
    autoGainControl: !cleanMixer,
  };
  if (el.inputDeviceSelect.value) {
    audioConstraints.deviceId = { exact: el.inputDeviceSelect.value };
  }

  state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  await refreshAudioDevices(false);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  state.captureCtx = new AudioCtx();
  await state.captureCtx.audioWorklet.addModule("/static/audio-capture-worklet.js");

  const source = state.captureCtx.createMediaStreamSource(state.mediaStream);
  state.workletNode = new AudioWorkletNode(state.captureCtx, "pcm-16k-capture");

  state.workletNode.port.onmessage = (event) => {
    const { pcm, rms } = event.data;
    const pct = Math.min(100, Math.round(rms * 280));
    el.vuFill.style.width = `${pct}%`;
    el.vuText.textContent = `${pct}%`;

    if (
      state.running &&
      !state.paused &&
      state.ws &&
      state.ws.readyState === WebSocket.OPEN
    ) {
      state.ws.send(pcm);
    }
  };

  source.connect(state.workletNode);
}

async function stopAudioCapture() {
  if (state.workletNode) {
    state.workletNode.port.onmessage = null;
    state.workletNode.disconnect();
    state.workletNode = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;
  }
  if (state.captureCtx) {
    await state.captureCtx.close();
    state.captureCtx = null;
  }
  el.vuFill.style.width = "0%";
  el.vuText.textContent = "0%";
}

function startTimer() {
  state.startedAtMs = Date.now();
  el.timerDisplay.textContent = "00:00";
  clearInterval(state.timerHandle);
  state.timerHandle = setInterval(() => {
    if (state.startedAtMs) {
      el.timerDisplay.textContent = formatClock(Date.now() - state.startedAtMs);
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(state.timerHandle);
  state.timerHandle = null;
}

async function startQwenWebRtcSession() {
  const client = new QwenWebRtcClient({
    onStatus: (mode, message, logFile) => {
      if (logFile) {
        el.logFileHint.textContent = `双语字幕已自动记录至 logs/${logFile}（WebRTC 语音播报同步高亮）`;
      }
      if (mode === "live") {
        hideBanner();
        setUiState("live", message);
      } else if (mode === "connecting") {
        setUiState("connecting", message);
      }
    },
    onError: (message, fatal) => {
      showBanner(message);
      if (fatal) {
        stopSession(false);
      }
    },
    onInputLevel: (rms) => {
      const pct = Math.min(100, Math.round(rms * 280));
      el.vuFill.style.width = `${pct}%`;
      el.vuText.textContent = `${pct}%`;
    },
    onActiveTurnChange: (turnId) => {
      setSpeakingTurn(turnId);
    },
    onTargetDelta: (turnId, delta) => {
      appendTargetTranscript(turnId, delta);
    },
    onTargetReplace: (turnId, confirmed, stash) => {
      replaceTargetTranscript(turnId, confirmed, stash);
    },
    onSourceDelta: (turnId, delta) => {
      appendSourceTranscript(turnId, delta);
    },
    onSourceReplace: (turnId, confirmed, stash) => {
      replaceSourceTranscript(turnId, confirmed, stash);
    },
    onTurnComplete: (turnId, logFile) => {
      finalizeTurn(turnId, logFile);
    },
    onStats: (stats) => {
      updateStats(stats);
    },
  });

  client.setVolume(Number(el.volumeSlider.value));
  client.setMuted(state.outputMuted);
  if (el.outputDeviceSelect.value) {
    client.sinkId = el.outputDeviceSelect.value;
  }

  state.webrtcClient = client;
  state.activeTransport = "webrtc";
  state.running = true;
  state.paused = false;
  setUiState("connecting", "正在建立 Qwen3.8 WebRTC (UDP) 直连...");
  startTimer();

  try {
    await client.start({
      model: el.modelSelect.value,
      direction: state.direction,
      inputDeviceId: el.inputDeviceSelect.value,
      mixerCleanMode: el.mixerCleanMode.checked,
      dashscopeApiKey: el.dashscopeApiKeyInput.value.trim(),
      dashscopeRegion: el.dashscopeRegionSelect.value,
      dashscopeWorkspaceId: el.dashscopeWorkspaceInput.value.trim(),
      qwenVoiceMode: el.qwenVoiceModeSelect.value,
      qwenCustomVoiceId: el.qwenCustomVoiceInput.value.trim(),
      qwenVadMode: el.qwenVadModeSelect.value,
      glossary: el.glossaryInput.value,
      sermonContext: el.sermonContextInput.value,
      saveTranscript: el.saveTranscriptCheckbox.checked,
      regionSpec: getSelectedDashScopeRegionSpec(),
    });
    await refreshAudioDevices(false);
  } catch (err) {
    showBanner(err.message || "Qwen3.8 WebRTC 启动失败");
    if ((err.message || "").includes("Workspace ID") || (err.message || "").includes("业务空间")) {
      document.getElementById("advancedDetails").open = true;
      el.dashscopeWorkspaceInput.focus();
    }
    await stopSession(false);
  }
}

async function startSession() {
  hideBanner();
  savePrefs();
  if (el.apiKeyInput.value.trim()) {
    syncApiKeyWithServer("gemini", "save", el.apiKeyInput.value.trim());
  }
  if (el.dashscopeApiKeyInput.value.trim()) {
    syncApiKeyWithServer("dashscope", "save", el.dashscopeApiKeyInput.value.trim());
  }

  const modelSpec = getSelectedModelSpec();
  if (
    modelSpec?.provider === "dashscope" &&
    el.qwenTransportSelect.value === "webrtc"
  ) {
    await startQwenWebRtcSession();
    return;
  }

  state.activeTransport = "websocket";

  try {
    await state.player.ensureReady();
    if (el.outputDeviceSelect.value) {
      try {
        await state.player.setOutputDevice(el.outputDeviceSelect.value);
      } catch (err) {
        console.warn("Output device routing fallback:", err);
      }
    }
    await startAudioCapture();
  } catch (err) {
    showBanner(`启动麦克风/音频设备失败：${err.message}`);
    await stopAudioCapture();
    return;
  }

  state.running = true;
  state.paused = false;
  state.activeAudioTurnId = null;
  setUiState("connecting", "正在连接实时同传服务...");
  startTimer();

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${proto}://${window.location.host}/ws/translate`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "start",
        model: el.modelSelect.value,
        direction: state.direction,
        api_key: el.apiKeyInput.value.trim(),
        dashscope_api_key: el.dashscopeApiKeyInput.value.trim(),
        dashscope_region: el.dashscopeRegionSelect.value,
        dashscope_workspace_id: el.dashscopeWorkspaceInput.value.trim(),
        qwen_voice_mode: el.qwenVoiceModeSelect.value,
        qwen_custom_voice_id: el.qwenCustomVoiceInput.value.trim(),
        qwen_vad_mode: el.qwenVadModeSelect.value,
        glossary: el.glossaryInput.value,
        rules: el.rulesInput.value,
        sermon_context: el.sermonContextInput.value,
        echo_target_language: el.echoTargetCheckbox.checked,
        compression_trigger_tokens: Number(el.compressionTriggerInput.value || 4500),
        compression_target_tokens: Number(el.compressionTargetInput.value || 2500),
        save_transcript: el.saveTranscriptCheckbox.checked,
      })
    );
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      state.player.enqueuePcm16(event.data, state.activeAudioTurnId);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "audio_turn") {
      state.activeAudioTurnId = msg.turn_id;
    } else if (msg.type === "status") {
      if (msg.log_file) {
        el.logFileHint.textContent = `双语字幕已自动记录至 logs/${msg.log_file}（语音播报时自动高亮）`;
      }
      if (msg.stats) {
        updateStats(msg.stats);
      }
      if (msg.state === "live") {
        hideBanner();
        setUiState("live", msg.message);
      } else if (msg.state === "connecting") {
        setUiState("connecting", msg.message);
      } else if (msg.state === "paused") {
        setUiState("paused", msg.message);
      } else if (msg.state === "stopped") {
        stopSession(false);
      }
    } else if (msg.type === "output_transcript") {
      appendTargetTranscript(msg.turn_id, msg.text);
    } else if (msg.type === "output_transcript_replace") {
      replaceTargetTranscript(msg.turn_id, msg.text, msg.stash);
    } else if (msg.type === "input_transcript") {
      appendSourceTranscript(msg.turn_id, msg.text);
    } else if (msg.type === "input_transcript_replace") {
      replaceSourceTranscript(msg.turn_id, msg.text, msg.stash);
    } else if (msg.type === "turn_complete") {
      finalizeTurn(msg.turn_id);
    } else if (msg.type === "interrupted") {
      state.player.clearQueue();
      finalizeTurn(msg.turn_id);
    } else if (msg.type === "go_away") {
      showBanner(msg.message || "正在无缝轮换会话连接...", "info");
    } else if (msg.type === "stats") {
      updateStats(msg.stats);
    } else if (msg.type === "error") {
      showBanner(msg.message || "发生未知错误");
      if (msg.fatal) {
        stopSession(false);
      }
    }
  };

  ws.onerror = () => {
    showBanner("与本地服务器的 WebSocket 连接出现异常，请确认后端服务正在运行。");
  };

  ws.onclose = () => {
    if (state.running) {
      stopSession(false);
    }
  };
}

function togglePause() {
  if (!state.running) return;
  if (state.activeTransport === "webrtc" && state.webrtcClient) {
    state.paused = !state.paused;
    state.webrtcClient.setPaused(state.paused);
    if (state.paused) {
      setUiState("paused", "已暂停收音（唱诗/祷告期间关闭上行音轨）");
    } else {
      setUiState("live", "已恢复 WebRTC 实时收音翻译");
    }
    return;
  }

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.paused = !state.paused;
  if (state.paused) {
    state.ws.send(JSON.stringify({ type: "pause" }));
    setUiState("paused", "已暂停收音（唱诗/祷告期间不推流、不产生音频费用）");
  } else {
    state.ws.send(JSON.stringify({ type: "resume" }));
    setUiState("live", "已恢复实时收音翻译");
  }
}

async function stopSession(notifyServer = true) {
  state.running = false;
  state.paused = false;
  stopTimer();
  finalizeTurn(null);
  state.player.clearQueue();
  state.activeAudioTurnId = null;

  if (state.webrtcClient) {
    const client = state.webrtcClient;
    state.webrtcClient = null;
    await client.stop();
  }

  await stopAudioCapture();

  if (state.ws) {
    const ws = state.ws;
    state.ws = null;
    if (notifyServer && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "stop" }));
      } catch {
        // Ignore
      }
    }
    try {
      ws.close();
    } catch {
      // Ignore
    }
  }

  setUiState("idle", "已停止，随时可重新开始或切换模型/翻译方向");
}

function exportTranscript() {
  finalizeTurn(null);
  if (state.transcriptHistory.length === 0) {
    showBanner("当前还没有可导出的字幕内容。", "info");
    return;
  }
  const lines = state.transcriptHistory.map(
    (entry) => `[${entry.time}] ${entry.lang}: ${entry.text}`
  );
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `sermon-translation-${state.direction}-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearCaptions() {
  state.targetEntriesByTurn.clear();
  state.targetTurnOrder = [];
  state.sourceEntriesByTurn.clear();
  state.transcriptHistory = [];
  state.speakingTurnId = null;

  el.targetStream.innerHTML = "";
  el.targetStream.appendChild(el.targetEmptyState);
  el.targetEmptyState.classList.remove("hidden");

  el.sourceStream.innerHTML = "";
  el.sourceStream.appendChild(el.sourceEmptyState);
  el.sourceEmptyState.classList.remove("hidden");
  renderFullscreenCaptions();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  el.themeToggleBtn.textContent = theme === "dark" ? "切换浅色" : "切换深色";
}

function adjustFontSize(delta) {
  state.captionSizeRem = Math.max(1.0, Math.min(2.6, state.captionSizeRem + delta));
  document.documentElement.style.setProperty("--caption-size", `${state.captionSizeRem}rem`);
}

function adjustFsFontSize(delta) {
  state.fsCaptionSizeRem = Math.max(1.8, Math.min(5.5, state.fsCaptionSizeRem + delta));
  document.documentElement.style.setProperty("--fs-caption-size", `${state.fsCaptionSizeRem}rem`);
}

async function init() {
  const prefs = loadPrefs();
  applyTheme(prefs.theme || "dark");
  applySplitPct(prefs.splitPct || DEFAULT_SPLIT_PCT, false);
  applySourceCollapsed(Boolean(prefs.sourceCollapsed), false);
  setupSplitter();

  const res = await fetch("/api/config");
  const cfg = await res.json();
  state.serverConfig = cfg;

  state.rulesByDirection = { ...(prefs.rulesByDirection || {}) };
  state.glossaryByDirection = { ...(prefs.glossaryByDirection || {}) };
  for (const d of cfg.directions) {
    if (!state.rulesByDirection[d.id]) {
      state.rulesByDirection[d.id] = d.default_rules;
    }
    if (!state.glossaryByDirection[d.id]) {
      state.glossaryByDirection[d.id] = d.default_glossary;
    }
  }

  // Populate models (fallback safely if saved model was removed)
  el.modelSelect.innerHTML = "";
  const validModelIds = new Set();
  for (const m of cfg.models) {
    validModelIds.add(m.id);
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    el.modelSelect.appendChild(opt);
  }
  el.modelSelect.value =
    prefs.model && validModelIds.has(prefs.model) ? prefs.model : cfg.default_model;

  // Populate Qwen transport modes
  el.qwenTransportSelect.innerHTML = "";
  for (const t of cfg.qwen_transport_modes || []) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.label;
    el.qwenTransportSelect.appendChild(opt);
  }
  el.qwenTransportSelect.value =
    prefs.qwenTransport || cfg.defaults.qwen_transport_mode || "webrtc";

  // Populate DashScope regions
  el.dashscopeRegionSelect.innerHTML = "";
  for (const r of cfg.dashscope_regions) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.label;
    el.dashscopeRegionSelect.appendChild(opt);
  }
  el.dashscopeRegionSelect.value =
    prefs.dashscopeRegion || cfg.default_dashscope_region || "cn-beijing";

  // Populate Qwen voice modes (safely ignore deprecated/unsupported cached voice ids)
  el.qwenVoiceModeSelect.innerHTML = "";
  const validVoiceIds = new Set();
  for (const v of cfg.qwen_voice_modes) {
    validVoiceIds.add(v.id);
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.label;
    el.qwenVoiceModeSelect.appendChild(opt);
  }
  el.qwenVoiceModeSelect.value =
    prefs.qwenVoiceMode && validVoiceIds.has(prefs.qwenVoiceMode)
      ? prefs.qwenVoiceMode
      : cfg.defaults.qwen_voice_mode || "clone_once";
  el.qwenCustomVoiceInput.value = prefs.qwenCustomVoiceId || "";
  el.qwenCustomVoiceField.classList.toggle(
    "hidden",
    el.qwenVoiceModeSelect.value !== "custom"
  );

  // Populate Qwen VAD modes
  el.qwenVadModeSelect.innerHTML = "";
  for (const v of cfg.qwen_vad_modes || []) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.label;
    el.qwenVadModeSelect.appendChild(opt);
  }
  el.qwenVadModeSelect.value =
    prefs.qwenVadMode || cfg.defaults.qwen_vad_mode || "sermon_fast";

  el.dashscopeWorkspaceInput.value = prefs.dashscopeWorkspace || "";
  el.dashscopeApiKeyInput.value = prefs.dashscopeApiKey || "";
  el.apiKeyInput.value = prefs.geminiApiKey || "";

  applyDirection(prefs.direction || cfg.default_direction || "zh-en", false);
  updateModelUI();

  el.sermonContextInput.value = prefs.sermonContext || "";
  el.mixerCleanMode.checked = Boolean(prefs.mixerCleanMode);
  el.echoTargetCheckbox.checked =
    prefs.echoTarget !== undefined ? Boolean(prefs.echoTarget) : cfg.defaults.echo_target_language;
  el.saveTranscriptCheckbox.checked =
    prefs.saveTranscript !== undefined ? Boolean(prefs.saveTranscript) : cfg.defaults.save_transcript;
  el.compressionTriggerInput.value =
    prefs.compressionTrigger || cfg.defaults.compression_trigger_tokens;
  el.compressionTargetInput.value =
    prefs.compressionTarget || cfg.defaults.compression_target_tokens;

  refreshApiKeyHints();

  if (cfg.has_env_workspace_id && el.workspaceHelp) {
    el.workspaceHelp.textContent =
      "已从本地 .env 自动加载业务空间 ID（此处留空即可直接启用 WebRTC 直连）。";
  }

  const activeSpec = getSelectedModelSpec();
  const needsKey =
    (activeSpec?.provider === "dashscope" &&
      !cfg.has_env_dashscope_key &&
      !el.dashscopeApiKeyInput.value.trim()) ||
    (activeSpec?.provider === "gemini" &&
      !cfg.has_env_gemini_key &&
      !el.apiKeyInput.value.trim());
  const needsWorkspace =
    activeSpec?.provider === "dashscope" &&
    el.qwenTransportSelect.value === "webrtc" &&
    !cfg.has_env_workspace_id &&
    !el.dashscopeWorkspaceInput.value.trim();
  if (needsKey || needsWorkspace) {
    document.getElementById("advancedDetails").open = true;
  }

  await refreshAudioDevices(false);
  if (prefs.inputDeviceId) el.inputDeviceSelect.value = prefs.inputDeviceId;
  if (prefs.outputDeviceId) el.outputDeviceSelect.value = prefs.outputDeviceId;

  // Bind events
  el.dirZhEnBtn.addEventListener("click", () => {
    if (!state.running) applyDirection("zh-en", true);
  });
  el.dirEnZhBtn.addEventListener("click", () => {
    if (!state.running) applyDirection("en-zh", true);
  });

  el.toggleSourceBtn.addEventListener("click", () => {
    applySourceCollapsed(!state.sourceCollapsed, true);
  });

  el.startBtn.addEventListener("click", startSession);
  el.pauseBtn.addEventListener("click", togglePause);
  el.stopBtn.addEventListener("click", () => stopSession(true));
  el.refreshDevicesBtn.addEventListener("click", () => refreshAudioDevices(true));

  el.outputDeviceSelect.addEventListener("change", async () => {
    savePrefs();
    try {
      await state.player.setOutputDevice(el.outputDeviceSelect.value);
      if (state.webrtcClient) {
        await state.webrtcClient.setOutputDevice(el.outputDeviceSelect.value);
      }
    } catch (err) {
      showBanner(`切换音频输出设备失败：${err.message}`);
    }
  });

  el.volumeSlider.addEventListener("input", () => {
    const v = Number(el.volumeSlider.value);
    el.volumeValue.textContent = `${Math.round(v * 100)}%`;
    state.player.setVolume(v);
    if (state.webrtcClient) {
      state.webrtcClient.setVolume(v);
    }
  });

  el.muteOutputBtn.addEventListener("click", () => {
    state.outputMuted = !state.outputMuted;
    state.player.setMuted(state.outputMuted);
    if (state.webrtcClient) {
      state.webrtcClient.setMuted(state.outputMuted);
    }
    el.muteOutputBtn.textContent = state.outputMuted ? "取消静音" : "静音输出";
  });

  el.modelSelect.addEventListener("change", () => {
    updateModelUI();
    savePrefs();
  });

  el.dashscopeRegionSelect.addEventListener("change", () => {
    updateModelUI();
    savePrefs();
  });

  el.qwenVoiceModeSelect.addEventListener("change", () => {
    el.qwenCustomVoiceField.classList.toggle(
      "hidden",
      el.qwenVoiceModeSelect.value !== "custom"
    );
    savePrefs();
  });

  el.apiKeyInput.addEventListener("change", async () => {
    savePrefs();
    const val = el.apiKeyInput.value.trim();
    if (val) {
      await syncApiKeyWithServer("gemini", "save", val);
    } else {
      refreshApiKeyHints();
    }
  });

  el.dashscopeApiKeyInput.addEventListener("change", async () => {
    savePrefs();
    const val = el.dashscopeApiKeyInput.value.trim();
    if (val) {
      await syncApiKeyWithServer("dashscope", "save", val);
    } else {
      refreshApiKeyHints();
    }
  });

  el.clearGeminiKeyBtn.addEventListener("click", async () => {
    el.apiKeyInput.value = "";
    savePrefs();
    await syncApiKeyWithServer("gemini", "clear");
    showBanner("已清空 GEMINI_API_KEY（浏览器缓存与本地 .env 均已清除）。", "info");
  });

  el.clearDashscopeKeyBtn.addEventListener("click", async () => {
    el.dashscopeApiKeyInput.value = "";
    savePrefs();
    await syncApiKeyWithServer("dashscope", "clear");
    showBanner("已清空 DASHSCOPE_API_KEY（浏览器缓存与本地 .env 均已清除）。", "info");
  });

  [
    el.inputDeviceSelect,
    el.mixerCleanMode,
    el.sermonContextInput,
    el.qwenTransportSelect,
    el.qwenCustomVoiceInput,
    el.qwenVadModeSelect,
    el.dashscopeWorkspaceInput,
    el.glossaryInput,
    el.rulesInput,
    el.echoTargetCheckbox,
    el.saveTranscriptCheckbox,
    el.compressionTriggerInput,
    el.compressionTargetInput,
  ].forEach((node) => node.addEventListener("change", savePrefs));

  el.resetRulesBtn.addEventListener("click", () => {
    const spec = getDirectionSpec();
    if (spec) {
      el.rulesInput.value = spec.default_rules;
      state.rulesByDirection[spec.id] = spec.default_rules;
      savePrefs();
    }
  });

  el.resetGlossaryBtn.addEventListener("click", () => {
    const spec = getDirectionSpec();
    if (spec) {
      el.glossaryInput.value = spec.default_glossary;
      state.glossaryByDirection[spec.id] = spec.default_glossary;
      savePrefs();
    }
  });

  el.fontSmallerBtn.addEventListener("click", () => adjustFontSize(-0.15));
  el.fontLargerBtn.addEventListener("click", () => adjustFontSize(0.15));
  el.fsFontSmallerBtn.addEventListener("click", () => adjustFsFontSize(-0.35));
  el.fsFontLargerBtn.addEventListener("click", () => adjustFsFontSize(0.35));
  el.exportBtn.addEventListener("click", exportTranscript);
  el.clearCaptionsBtn.addEventListener("click", clearCaptions);

  el.themeToggleBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    savePrefs();
  });

  el.fullscreenBtn.addEventListener("click", () => {
    el.fullscreenOverlay.classList.remove("hidden");
    renderFullscreenCaptions();
  });

  el.exitFullscreenBtn.addEventListener("click", () => {
    el.fullscreenOverlay.classList.add("hidden");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.fullscreenOverlay.classList.contains("hidden")) {
      el.fullscreenOverlay.classList.add("hidden");
    }
  });
}

init().catch((err) => {
  showBanner(`初始化页面失败：${err.message}`);
});
