import { Pcm24kPlayer } from "/static/audio-player.js";

const PREFS_KEY = "sermon_listener_prefs_v1";
const PIN_SESSION_KEY = "sermon_listener_pin";

const el = {
  statusDot: document.getElementById("statusDot"),
  directionSubtitle: document.getElementById("directionSubtitle"),
  statusBadge: document.getElementById("statusBadge"),
  themeBtn: document.getElementById("themeBtn"),

  pinGate: document.getElementById("pinGate"),
  pinForm: document.getElementById("pinForm"),
  pinInput: document.getElementById("pinInput"),
  pinError: document.getElementById("pinError"),

  audioPrompt: document.getElementById("audioPrompt"),
  unlockAudioBtn: document.getElementById("unlockAudioBtn"),
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
  reconnectAttempt: 0,
  wakeLock: null,

  roomPin: "",
  live: false,
  paused: false,
  direction: "zh-en",
  directionLabel: "",

  audioEnabled: false,
  audioMuted: false,
  showSource: false,
  fontSizeRem: 1.32,
  autoScroll: true,

  speakingTurnId: null,
  entriesByTurn: new Map(),
  turnOrder: [],
};

const player = new Pcm24kPlayer({
  lookaheadSeconds: 0.08,
  maxBufferSeconds: 1.4,
  onActiveTurnChange: (turnId) => {
    if (state.audioEnabled && !state.audioMuted) {
      setSpeakingTurn(turnId);
    }
  },
  onAudioLevel: (rms) => {
    if (!state.audioEnabled || state.audioMuted) return;
    const scale = 1 + Math.min(0.7, rms * 4.5);
    el.audioIndicator.style.transform = `scale(${scale.toFixed(2)})`;
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
        showSource: state.showSource,
        fontSizeRem: state.fontSizeRem,
        volume: Number(el.volumeRange.value),
      })
    );
  } catch {
    // Ignore
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
  el.sourceToggleBtn.textContent = state.showSource ? "隐原文" : "原文";
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

function updateSessionStatusUI() {
  el.statusDot.className = "status-dot";
  el.statusBadge.className = "status-badge";

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    el.statusDot.classList.add("reconnecting");
    el.statusBadge.textContent = "连接中";
    el.directionSubtitle.textContent = "正在连接教会同传频道...";
    return;
  }

  if (state.live && state.paused) {
    el.statusDot.classList.add("paused");
    el.statusBadge.classList.add("paused");
    el.statusBadge.textContent = "暂停中";
    el.directionSubtitle.textContent = state.directionLabel || "唱诗 / 祷告暂停";
    showNotice("当前为唱诗/祷告暂停时间，讲道恢复后将自动继续播报 · Paused for worship/prayer");
  } else if (state.live) {
    el.statusDot.classList.add("live");
    el.statusBadge.classList.add("live");
    el.statusBadge.textContent = "直播中";
    el.directionSubtitle.textContent = state.directionLabel || "实时同声传译广播中";
    showNotice("");
  } else {
    el.statusBadge.textContent = "待机";
    el.directionSubtitle.textContent = "已连接 · 等待讲员开始发言";
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
    // Wake Lock may be unsupported or blocked in low-power mode
  }
}

async function enableAudioFromUserGesture() {
  try {
    await player.ensureReady();
    // Unlock iOS Safari Web Audio cleanly with a tiny silent buffer inside user gesture
    if (player.ctx) {
      const silent = player.ctx.createBuffer(1, 1, player.sampleRate);
      const src = player.ctx.createBufferSource();
      src.buffer = silent;
      src.connect(player.ctx.destination);
      src.start(0);
    }
    player.setVolume(Number(el.volumeRange.value));
    player.setMuted(false);
    state.audioEnabled = true;
    state.audioMuted = false;
    el.audioPrompt.classList.add("hidden");
    updateAudioDockUI();
    requestWakeLock();
  } catch (err) {
    showNotice(`无法开启音频播报，请再次点击重试：${err.message}`);
  }
}

function updateAudioDockUI() {
  const active = state.audioEnabled && !state.audioMuted;
  el.audioToggleBtn.classList.toggle("active", active);
  el.audioToggleBtn.setAttribute("aria-pressed", String(active));
  if (!state.audioEnabled) {
    el.audioToggleLabel.textContent = "开启语音";
    el.audioIndicator.style.transform = "scale(1)";
  } else if (state.audioMuted) {
    el.audioToggleLabel.textContent = "已静音";
    el.audioIndicator.style.transform = "scale(1)";
  } else {
    el.audioToggleLabel.textContent = "语音中";
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
  badge.innerHTML =
    '<span class="eq-bars" aria-hidden="true"><span></span><span></span><span></span></span><span>播报中</span>';

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

  // Keep DOM lean on long 60-minute sermons (cap at 120 turns)
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

  if (msg.type === "auth_required") {
    showPinGate(msg.message || "口令不正确，请重新输入");
    return;
  }

  if (msg.type === "welcome") {
    hidePinGate();
    state.live = Boolean(msg.live);
    state.paused = Boolean(msg.paused);
    state.direction = msg.direction || "zh-en";
    state.directionLabel = msg.direction_label || "";
    hydrateHistory(msg.history);
    if (msg.active_turn_id) {
      setSpeakingTurn(Number(msg.active_turn_id));
    }
    updateSessionStatusUI();
    return;
  }

  if (msg.type === "session_state") {
    const wasLive = state.live;
    state.live = Boolean(msg.live);
    state.paused = Boolean(msg.paused);
    state.direction = msg.direction || state.direction;
    state.directionLabel = msg.direction_label || state.directionLabel;
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
    // When muted/reading captions only, follow server active_turn directly
    if (!state.audioEnabled || state.audioMuted) {
      setSpeakingTurn(msg.turn_id !== null && msg.turn_id !== undefined ? Number(msg.turn_id) : null);
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

  const view = new DataView(arrayBuffer);
  const codec = view.getUint8(0);
  const turnId = view.getUint32(1, true) || null;
  const payload = new Uint8Array(arrayBuffer, 5);

  if (codec === 2) {
    player.enqueueUlaw24k(payload, turnId);
  } else if (codec === 1) {
    player.enqueuePcm16(arrayBuffer.slice(5), turnId);
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
    }, 20000);
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleBinaryAudio(event.data);
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
    if (state.ws === ws) {
      state.ws = null;
    }
    updateSessionStatusUI();
    if (event.code === 4401) {
      sessionStorage.removeItem(PIN_SESSION_KEY);
      showPinGate("房间口令不正确或已更新，请重新输入");
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will trigger reconnect cleanly
  };
}

async function init() {
  const prefs = loadPrefs();
  applyTheme(prefs.theme || "dark");
  applyShowSource(Boolean(prefs.showSource));
  applyFontSize(prefs.fontSizeRem || 1.32);
  if (prefs.volume !== undefined) {
    el.volumeRange.value = String(prefs.volume);
    player.setVolume(Number(prefs.volume));
  }

  // Bind UI controls
  el.themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    savePrefs();
  });

  el.unlockAudioBtn.addEventListener("click", enableAudioFromUserGesture);

  el.audioToggleBtn.addEventListener("click", async () => {
    if (!state.audioEnabled) {
      await enableAudioFromUserGesture();
      return;
    }
    state.audioMuted = !state.audioMuted;
    player.setMuted(state.audioMuted);
    if (state.audioMuted) {
      player.clearQueue();
    }
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
    // Unlock audio in the same user gesture so phone plays immediately after PIN verification!
    await enableAudioFromUserGesture();
    connectListenerWs();
  });

  // Auto-resume AudioContext, WakeLock & WebSocket when returning from phone lock screen
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (state.audioEnabled && player.ctx && player.ctx.state === "suspended") {
        player.ctx.resume().catch(() => {});
      }
      if (state.audioEnabled) {
        requestWakeLock();
      }
      if (!state.ws || state.ws.readyState === WebSocket.CLOSED) {
        connectListenerWs();
      }
    }
  });

  // Check URL query ?pin=... or saved sessionStorage PIN, then probe broadcast status
  const urlPin = new URLSearchParams(window.location.search).get("pin") || "";
  state.roomPin = (urlPin || sessionStorage.getItem(PIN_SESSION_KEY) || "").trim();

  try {
    const res = await fetch("/api/broadcast/status");
    if (res.ok) {
      const status = await res.json();
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
