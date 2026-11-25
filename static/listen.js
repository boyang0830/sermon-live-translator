import { Pcm24kPlayer } from "/static/audio-player.js?v=4";

const PREFS_KEY = "sermon_listener_prefs_v2";
const PIN_SESSION_KEY = "sermon_listener_pin";

const I18N = {
  zh: {
    pageTitle: "教会实时同声传译",
    headerTitle: "教会实时同声传译",
    langToggleText: "EN",
    statusLive: "直播中",
    statusPaused: "暂停中",
    statusStandby: "待机",
    statusConnecting: "连接中",
    subConnecting: "正在连接教会同传频道...",
    subStandby: "已连接 · 等待讲员开始发言",
    subLiveFallback: "实时同声传译广播中",
    subPausedFallback: "唱诗 / 祷告暂停",
    dirZhEn: "中文 → 英文 · Live English",
    dirEnZh: "英文 → 中文 · 简体普通话",
    pauseNotice: "当前为唱诗/祷告暂停时间，讲道恢复后将自动继续播报",
    unlockTitle: "点击开启实时语音播报",
    unlockSub: "请佩戴耳机收听 · 支持锁屏播报（息屏如被系统中断点屏即恢复）",
    resumeTitle: "点击此处恢复实时语音播报",
    resumeSub: "手机刚从息屏唤醒，轻触任意位置即可恢复声音",
    placeholderMain: "已连接教会同传频道",
    placeholderSub: "讲员开始讲道后，实时译文语音与字幕将自动出现。",
    speakingBadge: "播报中",
    jumpLatest: "↓ 回到最新字幕",
    dockEnableAudio: "开启语音",
    dockAudioLive: "语音中",
    dockAudioMuted: "已静音",
    dockResumeAudio: "恢复语音",
    dockShowSource: "原文",
    dockHideSource: "隐原文",
    pinTitle: "输入房间口令",
    pinDesc: "请输入大屏或音控台显示的口令以加入实时语音与字幕收听。",
    pinPlaceholder: "例如 1234",
    pinSubmit: "进入收听",
    pinInvalid: "房间口令不正确或已更新，请重新输入",
    audioErrorPrefix: "无法开启音频播报，请再次点击重试：",
  },
  en: {
    pageTitle: "Live Sermon Interpretation",
    headerTitle: "Live Sermon Interpretation",
    langToggleText: "中文",
    statusLive: "LIVE",
    statusPaused: "PAUSED",
    statusStandby: "STANDBY",
    statusConnecting: "CONNECTING",
    subConnecting: "Connecting to church live channel...",
    subStandby: "Connected · Waiting for the sermon to begin",
    subLiveFallback: "Live audio interpretation active",
    subPausedFallback: "Paused for worship / prayer",
    dirZhEn: "Mandarin → American English",
    dirEnZh: "English → Mandarin Chinese",
    pauseNotice: "Paused for worship or prayer — live interpretation will resume automatically.",
    unlockTitle: "Tap to Start Live Audio",
    unlockSub: "Please wear headphones · Tap screen to resume if paused after sleep",
    resumeTitle: "Tap to Resume Live Audio",
    resumeSub: "Screen unlocked — tap anywhere to reconnect audio playback",
    placeholderMain: "Connected to Church Live Channel",
    placeholderSub: "Live voice interpretation and captions will appear automatically when the speaker begins.",
    speakingBadge: "Live",
    jumpLatest: "↓ Jump to Latest",
    dockEnableAudio: "Listen",
    dockAudioLive: "Listening",
    dockAudioMuted: "Muted",
    dockResumeAudio: "Resume",
    dockShowSource: "Source",
    dockHideSource: "Hide Src",
    pinTitle: "Enter Room PIN",
    pinDesc: "Enter the room PIN shown on the church screen or soundbooth to join.",
    pinPlaceholder: "e.g. 1234",
    pinSubmit: "Join Live Audio",
    pinInvalid: "Incorrect or updated room PIN. Please try again.",
    audioErrorPrefix: "Unable to start audio playback, please tap again: ",
  },
};

const el = {
  statusDot: document.getElementById("statusDot"),
  headerTitle: document.getElementById("headerTitle"),
  directionSubtitle: document.getElementById("directionSubtitle"),
  statusBadge: document.getElementById("statusBadge"),
  langToggleBtn: document.getElementById("langToggleBtn"),
  themeBtn: document.getElementById("themeBtn"),

  pinGate: document.getElementById("pinGate"),
  pinTitle: document.getElementById("pinTitle"),
  pinDesc: document.getElementById("pinDesc"),
  pinForm: document.getElementById("pinForm"),
  pinInput: document.getElementById("pinInput"),
  pinSubmitBtn: document.getElementById("pinSubmitBtn"),
  pinError: document.getElementById("pinError"),

  audioPrompt: document.getElementById("audioPrompt"),
  unlockAudioBtn: document.getElementById("unlockAudioBtn"),
  unlockTitle: document.getElementById("unlockTitle"),
  unlockSub: document.getElementById("unlockSub"),
  noticeBanner: document.getElementById("noticeBanner"),

  captionViewport: document.getElementById("captionViewport"),
  emptyPlaceholder: document.getElementById("emptyPlaceholder"),
  placeholderMain: document.getElementById("placeholderMain"),
  placeholderSub: document.getElementById("placeholderSub"),
  jumpLatestBtn: document.getElementById("jumpLatestBtn"),

  audioToggleBtn: document.getElementById("audioToggleBtn"),
  audioIndicator: document.getElementById("audioIndicator"),
  audioToggleLabel: document.getElementById("audioToggleLabel"),
  volumeRange: document.getElementById("volumeRange"),
  sourceToggleBtn: document.getElementById("sourceToggleBtn"),
  fontDownBtn: document.getElementById("fontDownBtn"),
  fontUpBtn: document.getElementById("fontUpBtn"),
};

const state = {
  ws: null,
  reconnectTimer: null,
  pingTimer: null,
  pongWatchdogTimer: null,
  reconnectAttempt: 0,
  wakeLock: null,

  uiLang: "zh",
  uiLangManual: false,

  roomPin: "",
  live: false,
  paused: false,
  direction: "zh-en",

  audioEnabled: false,
  audioMuted: false,
  needsAudioResume: false,
  showSource: false,
  fontSizeRem: 1.32,
  autoScroll: true,

  speakingTurnId: null,
  lastServerTurnId: null,
  entriesByTurn: new Map(),
  turnOrder: [],
};

function t(key) {
  return (I18N[state.uiLang] || I18N.zh)[key] || I18N.zh[key] || key;
}

const player = new Pcm24kPlayer({
  lookaheadSeconds: 0.22,
  maxBufferSeconds: 2.2,
  turnClearHoldMs: 950,
  enableKeepAlive: true,
  onActiveTurnChange: (turnId) => {
    if (state.audioEnabled && !state.audioMuted && !state.needsAudioResume) {
      setSpeakingTurn(turnId);
    }
  },
  onAudioLevel: (rms) => {
    if (!state.audioEnabled || state.audioMuted || state.needsAudioResume) return;
    const scale = 1 + Math.min(0.65, rms * 4.2);
    el.audioIndicator.style.transform = `scale(${scale.toFixed(2)})`;
  },
  onStateChange: (ctxState) => {
    if (!state.audioEnabled || state.audioMuted) return;
    if (ctxState === "running") {
      state.needsAudioResume = false;
      el.audioPrompt.classList.add("hidden");
      updateAudioDockUI();
    } else if (ctxState === "suspended" || ctxState === "interrupted") {
      // iOS Safari puts AudioContext in "interrupted" or "suspended" after lock screen
      state.needsAudioResume = true;
      updateAudioPromptUI();
      updateAudioDockUI();
    }
  },
});

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        theme: document.documentElement.dataset.theme || "dark",
        uiLang: state.uiLang,
        uiLangManual: state.uiLangManual,
        showSource: state.showSource,
        fontSizeRem: state.fontSizeRem,
        volume: Number(el.volumeRange.value),
      })
    );
  } catch {
    // Ignore
  }
}

function applyUiLanguage(lang, isManual = false) {
  state.uiLang = lang === "en" ? "en" : "zh";
  if (isManual) {
    state.uiLangManual = true;
  }
  document.documentElement.lang = state.uiLang === "en" ? "en" : "zh-CN";
  document.title = t("pageTitle");
  el.headerTitle.textContent = t("headerTitle");
  el.langToggleBtn.textContent = t("langToggleText");
  el.pinTitle.textContent = t("pinTitle");
  el.pinDesc.textContent = t("pinDesc");
  el.pinInput.placeholder = t("pinPlaceholder");
  el.pinSubmitBtn.textContent = t("pinSubmit");
  el.placeholderMain.textContent = t("placeholderMain");
  el.placeholderSub.textContent = t("placeholderSub");
  el.jumpLatestBtn.textContent = t("jumpLatest");

  // Update existing speaking badges on rendered captions
  for (const entry of state.entriesByTurn.values()) {
    if (entry.badgeTextEl) {
      entry.badgeTextEl.textContent = t("speakingBadge");
    }
  }

  applyShowSource(state.showSource);
  updateAudioPromptUI();
  updateAudioDockUI();
  updateSessionStatusUI();
}

function maybeAutoSelectUiLanguageForDirection(direction) {
  if (state.uiLangManual) return;
  // Listeners of Mandarin -> English are typically English speakers; English -> Mandarin are Chinese speakers
  const autoLang = direction === "zh-en" ? "en" : "zh";
  if (autoLang !== state.uiLang) {
    applyUiLanguage(autoLang, false);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  el.themeBtn.textContent = theme === "dark" ? "☀" : "🌙";
}

function applyShowSource(show) {
  state.showSource = Boolean(show);
  el.captionViewport.classList.toggle("hide-source", !state.showSource);
  el.sourceToggleBtn.setAttribute("aria-pressed", String(state.showSource));
  el.sourceToggleBtn.textContent = state.showSource ? t("dockHideSource") : t("dockShowSource");
}

function applyFontSize(rem) {
  state.fontSizeRem = Math.max(0.95, Math.min(2.3, Number(rem) || 1.32));
  document.documentElement.style.setProperty("--caption-size", `${state.fontSizeRem}rem`);
}

function showNotice(text, kind = "warning") {
  if (!text) {
    el.noticeBanner.classList.add("hidden");
    return;
  }
  el.noticeBanner.textContent = text;
  el.noticeBanner.className = `notice-banner${kind === "info" ? " info" : ""}`;
}

function updateAudioPromptUI() {
  if (!state.audioEnabled) {
    el.unlockTitle.textContent = t("unlockTitle");
    el.unlockSub.textContent = t("unlockSub");
    el.audioPrompt.classList.remove("hidden");
  } else if (state.needsAudioResume && !state.audioMuted) {
    el.unlockTitle.textContent = t("resumeTitle");
    el.unlockSub.textContent = t("resumeSub");
    el.audioPrompt.classList.remove("hidden");
  } else {
    el.audioPrompt.classList.add("hidden");
  }
}

function directionDisplayLabel() {
  if (state.direction === "en-zh") return t("dirEnZh");
  return t("dirZhEn");
}

function updateSessionStatusUI() {
  el.statusDot.className = "status-dot";
  el.statusBadge.className = "status-badge";

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    el.statusDot.classList.add("reconnecting");
    el.statusBadge.textContent = t("statusConnecting");
    el.directionSubtitle.textContent = t("subConnecting");
    return;
  }

  if (state.live && state.paused) {
    el.statusDot.classList.add("paused");
    el.statusBadge.classList.add("paused");
    el.statusBadge.textContent = t("statusPaused");
    el.directionSubtitle.textContent = directionDisplayLabel() || t("subPausedFallback");
    showNotice(t("pauseNotice"));
  } else if (state.live) {
    el.statusDot.classList.add("live");
    el.statusBadge.classList.add("live");
    el.statusBadge.textContent = t("statusLive");
    el.directionSubtitle.textContent = directionDisplayLabel() || t("subLiveFallback");
    showNotice("");
  } else {
    el.statusBadge.textContent = t("statusStandby");
    el.directionSubtitle.textContent = t("subStandby");
    showNotice("");
  }
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch {
    // Wake Lock optional
  }
}

function registerMediaSessionHandlers() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler("play", () => {
      if (state.audioEnabled) {
        state.audioMuted = false;
        player.setMuted(false);
        player.resumeIfNeeded();
        updateAudioDockUI();
      }
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      if (state.audioEnabled) {
        state.audioMuted = true;
        player.setMuted(true);
        player.clearQueue();
        updateAudioDockUI();
      }
    });
  } catch {
    // Ignore unsupported actions
  }
}

async function enableAudioFromUserGesture() {
  try {
    const running = await player.ensureReady();
    player.setVolume(Number(el.volumeRange.value));
    player.setMuted(false);
    state.audioEnabled = true;
    state.audioMuted = false;
    state.needsAudioResume = !running;
    updateAudioPromptUI();
    updateAudioDockUI();
    registerMediaSessionHandlers();
    requestWakeLock();
    if (running && state.lastServerTurnId && state.speakingTurnId === null) {
      setSpeakingTurn(state.lastServerTurnId);
    }
  } catch (err) {
    showNotice(`${t("audioErrorPrefix")}${err.message}`);
  }
}

async function recoverAfterWake() {
  if (state.audioEnabled) {
    requestWakeLock();
  }

  // 1. Resume AudioContext (handles both "suspended" AND iOS Safari "interrupted")
  if (state.audioEnabled && !state.audioMuted) {
    const ok = await player.resumeIfNeeded();
    state.needsAudioResume = !ok;
    updateAudioPromptUI();
    updateAudioDockUI();
    if (!ok) {
      attachOneShotTapResume();
    }
  }

  // 2. Verify WebSocket is genuinely alive (iOS sleep leaves zombie OPEN sockets!)
  if (!state.ws || state.ws.readyState === WebSocket.CLOSED || state.ws.readyState === WebSocket.CLOSING) {
    connectListenerWs();
    return;
  }

  if (state.ws.readyState === WebSocket.OPEN) {
    clearTimeout(state.pongWatchdogTimer);
    try {
      state.ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      connectListenerWs();
      return;
    }
    state.pongWatchdogTimer = setTimeout(() => {
      // No pong within 3s after screen wake -> zombie TCP socket, force clean reconnect!
      connectListenerWs();
    }, 3000);
  }
}

let _tapResumeBound = false;
function attachOneShotTapResume() {
  if (_tapResumeBound) return;
  _tapResumeBound = true;
  const onAnyTap = async () => {
    _tapResumeBound = false;
    document.removeEventListener("pointerdown", onAnyTap, true);
    document.removeEventListener("touchstart", onAnyTap, true);
    if (state.audioEnabled && !state.audioMuted && state.needsAudioResume) {
      await enableAudioFromUserGesture();
    }
  };
  document.addEventListener("pointerdown", onAnyTap, { capture: true, once: true });
  document.addEventListener("touchstart", onAnyTap, { capture: true, once: true });
}

function updateAudioDockUI() {
  const active = state.audioEnabled && !state.audioMuted && !state.needsAudioResume;
  el.audioToggleBtn.classList.toggle("active", active);
  el.audioToggleBtn.setAttribute("aria-pressed", String(active));
  if (!state.audioEnabled) {
    el.audioToggleLabel.textContent = t("dockEnableAudio");
    el.audioIndicator.style.transform = "scale(1)";
  } else if (state.audioMuted) {
    el.audioToggleLabel.textContent = t("dockAudioMuted");
    el.audioIndicator.style.transform = "scale(1)";
  } else if (state.needsAudioResume) {
    el.audioToggleLabel.textContent = t("dockResumeAudio");
    el.audioIndicator.style.transform = "scale(1)";
  } else {
    el.audioToggleLabel.textContent = t("dockAudioLive");
  }
}

function nowTimeStr() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function scrollToBottom(force = false) {
  if (!force && !state.autoScroll) return;
  el.captionViewport.scrollTop = el.captionViewport.scrollHeight;
}

function refreshLatestHighlight() {
  const latestTurn =
    state.turnOrder.length > 0 ? state.turnOrder[state.turnOrder.length - 1] : null;
  for (const [tid, entry] of state.entriesByTurn.entries()) {
    entry.node.classList.toggle("latest", tid === latestTurn);
  }
}

function setSpeakingTurn(turnId) {
  if (state.speakingTurnId === turnId) return;
  state.speakingTurnId = turnId;
  for (const [tid, entry] of state.entriesByTurn.entries()) {
    entry.node.classList.toggle("speaking", turnId !== null && tid === turnId);
  }
}

function getOrCreateEntry(turnId, timeLabel = null) {
  const tid = Number(turnId);
  if (state.entriesByTurn.has(tid)) {
    return state.entriesByTurn.get(tid);
  }

  el.emptyPlaceholder.classList.add("hidden");

  const node = document.createElement("article");
  node.className = "caption-item";
  node.dataset.turnId = String(tid);

  const meta = document.createElement("div");
  meta.className = "caption-meta";

  const timeEl = document.createElement("span");
  timeEl.className = "caption-time";
  timeEl.textContent = timeLabel || nowTimeStr();

  const badge = document.createElement("span");
  badge.className = "speaking-pill";
  const eq = document.createElement("span");
  eq.className = "eq-bars";
  eq.setAttribute("aria-hidden", "true");
  eq.innerHTML = "<span></span><span></span><span></span>";
  const badgeTextEl = document.createElement("span");
  badgeTextEl.textContent = t("speakingBadge");
  badge.appendChild(eq);
  badge.appendChild(badgeTextEl);

  meta.appendChild(timeEl);
  meta.appendChild(badge);

  const targetEl = document.createElement("p");
  targetEl.className = "caption-target";

  const confirmedSpan = document.createElement("span");
  const stashSpan = document.createElement("span");
  stashSpan.className = "caption-stash";
  targetEl.appendChild(confirmedSpan);
  targetEl.appendChild(stashSpan);

  const sourceEl = document.createElement("p");
  sourceEl.className = "caption-source";

  node.appendChild(meta);
  node.appendChild(targetEl);
  node.appendChild(sourceEl);
  el.captionViewport.appendChild(node);

  const entry = {
    turnId: tid,
    node,
    badgeTextEl,
    confirmedSpan,
    stashSpan,
    sourceEl,
    targetText: "",
    stashText: "",
    sourceText: "",
    sourceStash: "",
  };
  state.entriesByTurn.set(tid, entry);
  state.turnOrder.push(tid);

  while (state.turnOrder.length > 120) {
    const oldestId = state.turnOrder.shift();
    const oldEntry = state.entriesByTurn.get(oldestId);
    if (oldEntry) {
      oldEntry.node.remove();
      state.entriesByTurn.delete(oldestId);
    }
  }

  refreshLatestHighlight();
  return entry;
}

function renderEntry(entry) {
  entry.confirmedSpan.textContent = entry.targetText;
  entry.stashSpan.textContent = entry.stashText;
  const fullSource = (entry.sourceText + entry.sourceStash).trim();
  entry.sourceEl.textContent = fullSource;
  entry.sourceEl.classList.toggle("hidden", !fullSource);
  scrollToBottom(false);
}

function clearCaptions() {
  state.entriesByTurn.clear();
  state.turnOrder = [];
  state.speakingTurnId = null;
  state.lastServerTurnId = null;
  el.captionViewport.innerHTML = "";
  el.captionViewport.appendChild(el.emptyPlaceholder);
  el.emptyPlaceholder.classList.remove("hidden");
}

function hydrateHistory(historyItems) {
  clearCaptions();
  if (!Array.isArray(historyItems) || historyItems.length === 0) return;
  for (const item of historyItems) {
    if (!item || item.turn_id === undefined) continue;
    if (!item.target_text && !item.stash_text && !item.source_text) continue;
    const entry = getOrCreateEntry(item.turn_id, item.time);
    entry.targetText = item.target_text || "";
    entry.stashText = item.stash_text || "";
    entry.sourceText = item.source_text || "";
    entry.sourceStash = item.source_stash || "";
    renderEntry(entry);
  }
  scrollToBottom(true);
}

function handleServerMessage(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === "pong") {
    clearTimeout(state.pongWatchdogTimer);
    return;
  }

  if (msg.type === "auth_required") {
    showPinGate(t("pinInvalid"));
    return;
  }

  if (msg.type === "welcome") {
    hidePinGate();
    state.live = Boolean(msg.live);
    state.paused = Boolean(msg.paused);
    state.direction = msg.direction || "zh-en";
    maybeAutoSelectUiLanguageForDirection(state.direction);
    hydrateHistory(msg.history);
    if (msg.active_turn_id) {
      state.lastServerTurnId = Number(msg.active_turn_id);
      setSpeakingTurn(state.lastServerTurnId);
    }
    updateSessionStatusUI();
    return;
  }

  if (msg.type === "session_state") {
    const wasLive = state.live;
    state.live = Boolean(msg.live);
    state.paused = Boolean(msg.paused);
    state.direction = msg.direction || state.direction;
    maybeAutoSelectUiLanguageForDirection(state.direction);
    if (!wasLive && state.live) {
      clearCaptions();
    }
    if (state.paused || !state.live) {
      player.clearQueue();
      setSpeakingTurn(null);
    }
    updateSessionStatusUI();
    return;
  }

  if (msg.type === "output_transcript" && msg.turn_id !== undefined) {
    const entry = getOrCreateEntry(msg.turn_id);
    entry.targetText += msg.text || "";
    entry.stashText = "";
    renderEntry(entry);
    return;
  }

  if (msg.type === "output_transcript_replace" && msg.turn_id !== undefined) {
    const entry = getOrCreateEntry(msg.turn_id);
    entry.targetText = msg.text || "";
    entry.stashText = msg.stash || "";
    renderEntry(entry);
    return;
  }

  if (msg.type === "input_transcript" && msg.turn_id !== undefined) {
    const entry = getOrCreateEntry(msg.turn_id);
    entry.sourceText += msg.text || "";
    entry.sourceStash = "";
    renderEntry(entry);
    return;
  }

  if (msg.type === "input_transcript_replace" && msg.turn_id !== undefined) {
    const entry = getOrCreateEntry(msg.turn_id);
    entry.sourceText = msg.text || "";
    entry.sourceStash = msg.stash || "";
    renderEntry(entry);
    return;
  }

  if (msg.type === "turn_complete" && msg.turn_id !== undefined) {
    const entry = state.entriesByTurn.get(Number(msg.turn_id));
    if (entry && entry.stashText) {
      entry.targetText = (entry.targetText + entry.stashText).trim();
      entry.stashText = "";
      renderEntry(entry);
    }
    return;
  }

  if (msg.type === "active_turn" || msg.type === "audio_turn") {
    const tid = msg.turn_id !== null && msg.turn_id !== undefined ? Number(msg.turn_id) : null;
    if (tid !== null) {
      state.lastServerTurnId = tid;
    }
    // When muted/reading-only OR waiting for audio resume, follow server active_turn directly
    if (!state.audioEnabled || state.audioMuted || state.needsAudioResume) {
      setSpeakingTurn(tid);
    }
    return;
  }

  if (msg.type === "interrupted") {
    player.clearQueue();
  }
}

function handleBinaryAudio(arrayBuffer) {
  if (!state.audioEnabled || state.audioMuted) return;
  if (!arrayBuffer || arrayBuffer.byteLength < 6) return;

  // If iOS suspended/interrupted AudioContext while locked, prompt clean one-tap resume
  if (!player.isRunning()) {
    player.resumeIfNeeded().then((ok) => {
      if (!ok) {
        state.needsAudioResume = true;
        updateAudioPromptUI();
        updateAudioDockUI();
        attachOneShotTapResume();
      }
    });
    return;
  }

  const view = new DataView(arrayBuffer);
  const codec = view.getUint8(0);
  const turnId = view.getUint32(1, true) || null;
  if (turnId) {
    state.lastServerTurnId = turnId;
  }

  if (codec === 3 && arrayBuffer.byteLength >= 9) {
    const sampleRate = view.getUint16(5, true) || 24000;
    player.enqueuePcm16(arrayBuffer.slice(7), turnId, sampleRate);
  } else if (codec === 4 && arrayBuffer.byteLength >= 8) {
    const sampleRate = view.getUint16(5, true) || 24000;
    player.enqueueUlaw24k(new Uint8Array(arrayBuffer, 7), turnId, sampleRate);
  } else if (codec === 1) {
    player.enqueuePcm16(arrayBuffer.slice(5), turnId, 24000);
  } else if (codec === 2) {
    player.enqueueUlaw24k(new Uint8Array(arrayBuffer, 5), turnId, 24000);
  }
}

function showPinGate(errorMessage = "") {
  el.pinGate.classList.remove("hidden");
  if (errorMessage) {
    el.pinError.textContent = errorMessage;
    el.pinError.classList.remove("hidden");
  } else {
    el.pinError.classList.add("hidden");
  }
  el.pinInput.focus();
}

function hidePinGate() {
  el.pinGate.classList.add("hidden");
  el.pinError.classList.add("hidden");
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  const delayMs = Math.min(5000, 1000 * Math.pow(1.6, state.reconnectAttempt));
  state.reconnectAttempt = Math.min(state.reconnectAttempt + 1, 6);
  state.reconnectTimer = setTimeout(() => {
    connectListenerWs();
  }, delayMs);
}

function connectListenerWs() {
  clearTimeout(state.reconnectTimer);
  clearInterval(state.pingTimer);
  clearTimeout(state.pongWatchdogTimer);

  if (state.ws) {
    try {
      state.ws.onclose = null;
      state.ws.close();
    } catch {
      // Ignore
    }
    state.ws = null;
  }

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const pinQuery = state.roomPin ? `?pin=${encodeURIComponent(state.roomPin)}` : "";
  const ws = new WebSocket(`${proto}://${window.location.host}/ws/listen${pinQuery}`);
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  updateSessionStatusUI();

  ws.onopen = () => {
    state.reconnectAttempt = 0;
    updateSessionStatusUI();
    state.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 15000);
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleBinaryAudio(event.data);
      return;
    }
    if (event.data instanceof Blob) {
      event.data.arrayBuffer().then(handleBinaryAudio).catch(() => {});
      return;
    }
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch {
      // Ignore invalid JSON
    }
  };

  ws.onclose = (event) => {
    clearInterval(state.pingTimer);
    clearTimeout(state.pongWatchdogTimer);
    if (state.ws === ws) {
      state.ws = null;
    }
    updateSessionStatusUI();
    if (event.code === 4401) {
      sessionStorage.removeItem(PIN_SESSION_KEY);
      showPinGate(t("pinInvalid"));
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will handle reconnect
  };
}

async function init() {
  const prefs = loadPrefs();
  applyTheme(prefs.theme || "dark");
  state.uiLangManual = Boolean(prefs.uiLangManual);
  const initialLang =
    prefs.uiLang || ((navigator.language || "").toLowerCase().startsWith("en") ? "en" : "zh");
  applyUiLanguage(initialLang, state.uiLangManual);
  applyShowSource(Boolean(prefs.showSource));
  applyFontSize(prefs.fontSizeRem || 1.32);
  if (prefs.volume !== undefined) {
    el.volumeRange.value = String(prefs.volume);
    player.setVolume(Number(prefs.volume));
  }

  // Language switcher (Chinese <-> English)
  el.langToggleBtn.addEventListener("click", () => {
    const next = state.uiLang === "zh" ? "en" : "zh";
    applyUiLanguage(next, true);
    savePrefs();
  });

  el.themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    savePrefs();
  });

  el.unlockAudioBtn.addEventListener("click", enableAudioFromUserGesture);

  el.audioToggleBtn.addEventListener("click", async () => {
    if (!state.audioEnabled || state.needsAudioResume) {
      await enableAudioFromUserGesture();
      return;
    }
    state.audioMuted = !state.audioMuted;
    player.setMuted(state.audioMuted);
    if (state.audioMuted) {
      player.clearQueue();
    } else {
      await player.resumeIfNeeded();
    }
    updateAudioPromptUI();
    updateAudioDockUI();
  });

  el.volumeRange.addEventListener("input", () => {
    const v = Number(el.volumeRange.value);
    player.setVolume(v);
    if (v === 0 && !state.audioMuted) {
      state.audioMuted = true;
      player.setMuted(true);
      updateAudioDockUI();
    } else if (v > 0 && state.audioMuted && state.audioEnabled) {
      state.audioMuted = false;
      player.setMuted(false);
      player.resumeIfNeeded();
      updateAudioDockUI();
    }
    savePrefs();
  });

  el.sourceToggleBtn.addEventListener("click", () => {
    applyShowSource(!state.showSource);
    savePrefs();
  });

  el.fontDownBtn.addEventListener("click", () => {
    applyFontSize(state.fontSizeRem - 0.14);
    savePrefs();
  });

  el.fontUpBtn.addEventListener("click", () => {
    applyFontSize(state.fontSizeRem + 0.14);
    savePrefs();
  });

  // Smart auto-scroll pause when listener scrolls up to re-read scripture
  el.captionViewport.addEventListener("scroll", () => {
    const distFromBottom =
      el.captionViewport.scrollHeight -
      el.captionViewport.scrollTop -
      el.captionViewport.clientHeight;
    state.autoScroll = distFromBottom < 72;
    el.jumpLatestBtn.classList.toggle("hidden", state.autoScroll);
  });

  el.jumpLatestBtn.addEventListener("click", () => {
    state.autoScroll = true;
    el.jumpLatestBtn.classList.add("hidden");
    scrollToBottom(true);
  });

  el.pinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const entered = el.pinInput.value.trim();
    if (!entered) return;
    state.roomPin = entered;
    sessionStorage.setItem(PIN_SESSION_KEY, entered);
    await enableAudioFromUserGesture();
    connectListenerWs();
  });

  // Robust mobile screen-lock & app-switch recovery
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      recoverAfterWake();
    }
  });
  window.addEventListener("pageshow", () => {
    recoverAfterWake();
  });
  window.addEventListener("focus", () => {
    recoverAfterWake();
  });

  // Check URL query ?pin=... or saved sessionStorage PIN, then probe broadcast status
  const urlPin = new URLSearchParams(window.location.search).get("pin") || "";
  state.roomPin = (urlPin || sessionStorage.getItem(PIN_SESSION_KEY) || "").trim();

  try {
    const res = await fetch("/api/broadcast/status");
    if (res.ok) {
      const status = await res.json();
      if (status.direction) {
        state.direction = status.direction;
        maybeAutoSelectUiLanguageForDirection(status.direction);
      }
      if (status.requires_pin && !state.roomPin) {
        showPinGate();
        return;
      }
    }
  } catch {
    // Proceed directly to WS connect
  }

  connectListenerWs();
}

init();
