// 你画我猜 - P2P 前端（房主权威架构）
// 说明：创建房间者 = 房主，房主浏览器运行权威游戏逻辑；其余玩家通过 PeerJS 直连房主同步。
// 单人模式不创建任何网络连接，机器人由房主本地模拟。

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const lobby = $("lobby");
const game = $("game");
const nameInput = $("nameInput");
const codeInput = $("codeInput");
const lobbyMsg = $("lobbyMsg");
const roomNameInput = $("roomNameInput");
const inviteBtn = $("inviteBtn");
const toastEl = $("toast");
const roomCodeEl = $("roomCode");
const roundInfo = $("roundInfo");
const timerEl = $("timer");
const wordStatus = $("wordStatus");
const board = $("board");
const ctx = board.getContext("2d");
const colorsEl = $("colors");
const sizesEl = document.querySelectorAll(".sizes button");
const eraserBtn = $("eraserBtn");
const clearBtn = $("clearBtn");
const customColor = $("customColor");
const newWordBtn = $("newWordBtn");
const tools = $("tools");
const playerList = $("playerList");
const playerCount = $("playerCount");
const chatLog = $("chatLog");
const guessInput = $("guessInput");
const sendBtn = $("sendBtn");
const hostActions = $("hostActions");
const startBtn = $("startBtn");
const restartBtn = $("restartBtn");
const dissolveBtn = $("dissolveBtn");
const exitBtn = $("exitBtn");
const roundsSelect = $("roundsSelect");
const botPersonalitySel = $("botPersonality");
const joinModal = $("joinModal");
const joinRoomNameEl = $("joinRoomName");
const joinMembersEl = $("joinMembers");
const joinAcceptBtn = $("joinAcceptBtn");
const joinRejectBtn = $("joinRejectBtn");

// ---- 通用状态 ----
let me = { id: null, isDrawer: false, isHost: false };
let penColor = "#111111";
let penSize = 10;
let erasing = false;
let drawing = false;
let last = null;

// ---- 网络层（公共 MQTT 中转，不依赖 WebRTC 打洞，任何网络都能连）----
// 客户端连公共 MQTT Broker（国内直连），所有游戏消息（笔画/聊天/状态）经它转发。
// 架构仍是"房主权威"：房主运行游戏逻辑，玩家把操作发给房主，房主广播状态。
let mqttClient = null;      // mqtt.js 客户端实例
let myId = null;            // 本机在房间内的唯一 id
let roomTopicBase = null;   // 本房间的话题前缀，形如 "dg/xxxx/"
let mqttReconnectFn = null; // 断线后自动重连的闭包
let presenceSeen = false;   // 玩家侧：是否见到房主在线标记（retained）
let joinedConfirmed = false;// 玩家侧：是否已确认进房
const pending = new Map();  // 房主侧：待确认加入的 clientId -> name

// 依次尝试的公共 Broker（EMQ 中国节点优先，国内直连最稳）
const MQTT_URLS = [
  "wss://broker-cn.emqx.io:8084/mqtt",
  "wss://broker.emqx.io:8084/mqtt",
  "wss://test.mosquitto.org:8081/mqtt"
];

// ---- 房主侧房间状态 ----
let room = null;
const ROUND_SECONDS = 90;
const REVEAL_SECONDS = 4;

// ---- 调色板 ----
const PALETTE = ["#111111", "#ff4d4f", "#ff9f1c", "#ffd60a", "#2ecc71", "#1e90ff", "#9b5de5", "#ff6fb5", "#8b5a2b", "#ffffff"];
PALETTE.forEach((c, i) => {
  const d = document.createElement("div");
  d.className = "swatch" + (i === 0 ? " active" : "");
  d.style.background = c;
  d.addEventListener("click", () => {
    penColor = c; erasing = false;
    customColor.value = c;
    document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
    d.classList.add("active");
  });
  colorsEl.appendChild(d);
});

sizesEl.forEach((b) => {
  b.addEventListener("click", () => {
    penSize = parseInt(b.dataset.size, 10);
    sizesEl.forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  });
});

eraserBtn.addEventListener("click", () => {
  erasing = !erasing;
  eraserBtn.style.background = erasing ? "var(--accent2)" : "";
});
clearBtn.addEventListener("click", () => {
  if (isHost && me.isDrawer) { clearCanvas(); broadcastToAll({ t: "clear" }); }
  else if (!isHost) sendToHost({ t: "clear" });
});
customColor.addEventListener("input", () => {
  penColor = customColor.value; erasing = false; eraserBtn.style.background = "";
  document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
});
newWordBtn.addEventListener("click", () => {
  if (isHost && me.isDrawer) hostNewWord();
  else if (!isHost) sendToHost({ t: "newWord" });
});

// ---- 进入房间 ----
function enter() {
  const name = nameInput.value.trim();
  if (!name) { lobbyMsg.textContent = "请先输入昵称"; return null; }
  return name;
}
function genCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
// 规范化房间名：去首尾/内部空白，最长 20 字符，保留大小写与中文（区分大小写）
function normalizeRoom(s) {
  return String(s || "").trim().replace(/\s+/g, "").slice(0, 20);
}
// 信令服务器只接受字母/数字的 ID，中文房间号直接注册会被拒（房间"隐身"）。
// 因此用房间名的稳定哈希生成底层 ID：房主和加入者对同一房间名算出同一 ID。
function hostIdFor(code) {
  const s = "drawguess|" + code;
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 2246822519) >>> 0;
  }
  return "dg-" + h1.toString(16) + h2.toString(16);
}
function enterGameScreen() {
  lobby.classList.add("hidden");
  game.classList.remove("hidden");
}
function backToLobby(msg) {
  game.classList.add("hidden");
  lobby.classList.remove("hidden");
  lobbyMsg.textContent = msg || "";
  roomCodeEl.textContent = "----";
  playerList.innerHTML = "";
  chatLog.innerHTML = "";
  clearCanvas();
  me = { id: null, isDrawer: false, isHost: false };
  // 清掉自己的在线标记并断开 MQTT（要在清空 id 之前做）
  const wasHost = isHost, oldId = myId, oldBase = roomTopicBase;
  isHost = false; roomCode = null; myId = null; room = null;
  try {
    if (mqttClient) {
      if (oldBase && oldId && !wasHost) clearRetained(oldBase + "p/" + oldId);
      mqttClient.end(true);
    }
  } catch (e) {}
  mqttClient = null; mqttReconnectFn = null; roomTopicBase = null;
  presenceSeen = false; joinedConfirmed = false;
  pending.clear();
  inviteBtn.classList.add("hidden");
  roomNameInput.value = "";
}

// ---- 邀请链接（短链接分享）----
function buildInviteUrl(code) {
  const base = location.origin + location.pathname.split("?")[0];
  return base + "?room=" + encodeURIComponent(code);
}
function showInviteLink(code) {
  inviteBtn.dataset.url = buildInviteUrl(code);
  inviteBtn.classList.remove("hidden");
}
function copyInvite() {
  const url = inviteBtn.dataset.url;
  if (!url) return;
  const ok = () => showToast("邀请链接已复制，发给朋友即可加入 👇<br>" + url);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(ok).catch(() => fallbackCopy(url, ok));
  } else {
    fallbackCopy(url, ok);
  }
}
function fallbackCopy(text, ok) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta);
    ok();
  } catch (e) {
    showToast("复制失败，请手动复制：" + text);
  }
}
let toastTimer = null;
function showToast(html, ms) {
  toastEl.innerHTML = html;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), ms || 4000);
}
inviteBtn.addEventListener("click", copyInvite);

// ---- 从邀请链接进入时，自动填入房间号 ----
(function initFromUrl() {
  const params = new URLSearchParams(location.search);
  const r = params.get("room");
  if (r) {
    const code = normalizeRoom(decodeURIComponent(r));
    codeInput.value = code;
    lobbyMsg.textContent = "已为你填入房间「" + code + "」，输入昵称后点击「加入房间」即可。";
  }
})();

$("createBtn").addEventListener("click", () => {
  const name = enter(); if (!name) return;
  const custom = normalizeRoom(roomNameInput.value);
  lobbyMsg.textContent = "";
  createHost(custom || genCode(), name, "multi", botPersonalitySel.value);
});
$("soloBtn").addEventListener("click", () => {
  const name = enter(); if (!name) return;
  lobbyMsg.textContent = "";
  createHost(genCode(), name, "solo", botPersonalitySel.value);
});
$("joinBtn").addEventListener("click", () => {
  const name = enter(); if (!name) return;
  const code = normalizeRoom(codeInput.value);
  if (!code) { lobbyMsg.textContent = "请输入房间号"; return; }
  lobbyMsg.textContent = "";
  joinAsPlayer(name, code);
});

// ---- MQTT 网络底层 ----
// 房间话题：dg/<房间名哈希>/msg    所有游戏消息
//          dg/<房间名哈希>/presence 房主在线标记（retained，玩家据此判断房间是否存在）
//          dg/<房间名哈希>/p/<id>   各玩家在线标记（retained + 遗嘱，房主据此感知进出）
function topicsFor(code) {
  const base = "dg/" + hostIdFor(code) + "/";
  return { msg: base + "msg", presence: base + "presence", players: base + "p/" };
}
function connectMqtt(willTopic, onReady, onFail) {
  let i = 0;
  const tryNext = () => {
    if (i >= MQTT_URLS.length) { onFail(); return; }
    const url = MQTT_URLS[i++];
    let everUp = false, advanced = false;
    const opts = {
      clientId: "dg-" + Math.random().toString(16).slice(2, 10),
      connectTimeout: 8000, keepalive: 30, reconnectPeriod: 0, clean: true
    };
    if (willTopic) opts.will = { topic: willTopic, payload: "", retain: true, qos: 0 };
    const c = mqtt.connect(url, opts);
    c.on("connect", () => {
      everUp = true; mqttClient = c; mqttEverUp = true;
      onReady(c);
    });
    c.on("message", onMqttMessage);
    const giveUpOrReconnect = () => {
      if (!everUp) {
        if (advanced) return; advanced = true;
        try { c.end(true); } catch (e) {}
        tryNext();
      } else {
        // 连上过之后意外断线：2 秒后自动重连（重订阅 + 重发在线标记）
        mqttClient = null;
        if (mqttReconnectFn) setTimeout(mqttReconnectFn, 2000);
      }
    };
    c.on("close", giveUpOrReconnect);
    c.on("error", () => {});  // close 会跟着来，交给 giveUpOrReconnect
  };
  tryNext();
}
function mqttSetup(code, willTopic, whenReady, onFail) {
  const run = () => connectMqtt(willTopic, whenReady, onFail || (() => {
    if (lobby.classList.contains("hidden")) showToast("与服务器的连接断开，正在重连…", 3000);
    else lobbyMsg.textContent = "无法连接服务器，请稍后重试。";
  }));
  run();
  mqttReconnectFn = run;
}
function subAll(topics, cb) {
  let left = topics.length;
  topics.forEach((t) => {
    mqttClient.subscribe(t, { qos: 0 }, (err) => { if (!err && --left === 0 && cb) cb(); });
  });
}
function mqttPublish(topic, obj, retain) {
  if (mqttClient && mqttClient.connected) mqttClient.publish(topic, JSON.stringify(obj), { retain: !!retain, qos: 0 });
}
function clearRetained(topic) {
  if (mqttClient) try { mqttClient.publish(topic, "", { retain: true, qos: 0 }); } catch (e) {}
}
// 玩家 -> 房主
function sendToHost(body) {
  if (roomTopicBase) mqttPublish(roomTopicBase + "msg", { from: myId, role: "player", to: "host", body });
}
// 房主 -> 指定玩家
function publishTo(pid, body) {
  mqttPublish(roomTopicBase + "msg", { from: myId, role: "host", to: pid, body });
}
function notFoundMsg(code) {
  return "❌ 找不到房间「" + escapeHtml(code) + "」，请依次检查：<br>" +
    "1️⃣ 房主的页面还开着吗？（房主关了页面，房间就没了）<br>" +
    "2️⃣ 房间号和房主顶栏显示的<b>完全一致</b>吗？（区分大小写，建议直接点房主发的 🔗 邀请链接进入，别手输）<br>" +
    "3️⃣ 都没问题的话，让房主刷新页面重建一个房间再试。";
}
// 所有 MQTT 消息的统一入口
function onMqttMessage(topic, payloadStr) {
  if (!roomTopicBase) return;
  const tp = topicsFor(roomCode);
  if (topic === tp.presence) { handlePresence(payloadStr); return; }
  if (topic.startsWith(tp.players)) {
    if (isHost) handlePlayerPresence(topic.slice(tp.players.length), payloadStr);
    return;
  }
  if (topic !== tp.msg) return;
  let m; try { m = JSON.parse(payloadStr); } catch (e) { return; }
  if (!m || m.from === myId) return;
  if (m.except && m.except === myId) return;
  if (m.to && m.to !== "*" && m.to !== myId) return;
  if (isHost) { if (m.role === "player") onHostMessage(m.body, m.from); }
  else { if (m.role === "host") dispatch(m.body); }
}
// 玩家侧：房主在线标记（retained；房主掉线时 MQTT 遗嘱会发空标记）
function handlePresence(payloadStr) {
  if (isHost) return;
  let pl = null; try { pl = JSON.parse(payloadStr); } catch (e) {}
  const online = !!(pl && pl.online);
  if (joinedConfirmed) {
    if (!online) backToLobby("房主已离开或掉线，房间已关闭。");
    return;
  }
  if (!online) {
    if (!presenceSeen) lobbyMsg.innerHTML = notFoundMsg(roomCode);
    return;
  }
  if (!presenceSeen) {
    presenceSeen = true;
    lobbyMsg.textContent = "已找到房间，正在加入…";
    sendHello();
  }
}
// 房主侧：玩家在线标记（含 MQTT 遗嘱：掉线时会自动收到空标记）
function handlePlayerPresence(pid, payloadStr) {
  if (!room || pid === myId) return;
  let pl = null; try { pl = JSON.parse(payloadStr); } catch (e) {}
  if (!pl || !pl.online) { handleDisconnect(pid, false); return; }
  // 玩家上线/重连：若已在房间，补发一份状态
  if (room.players.some((p) => p.id === pid)) publishTo(pid, { t: "state", ...buildView(pid) });
}

// ---- 玩家：加入房间 ----
let pendingName = null;
function joinAsPlayer(name, code) {
  roomCode = code; isHost = false; me.isHost = false; pendingName = name;
  joinedConfirmed = false; presenceSeen = false; helloCount = 0;
  myId = "p-" + Math.random().toString(16).slice(2, 10);
  roomTopicBase = "dg/" + hostIdFor(code) + "/";
  lobbyMsg.textContent = "正在连接服务器…";
  showToast("正在加入房间「" + code + "」…<br>只需房间码，或打开房主发的邀请链接即可进入。", 2000);
  const tp = topicsFor(code);
  mqttSetup(code, tp.players + myId, (c) => {
    subAll([tp.msg, tp.presence], () => {
      // retained 的房主在线标记会立刻送达 handlePresence；超时仍未见则视为找不到房间
      setTimeout(() => {
        if (joinedConfirmed || presenceSeen) return;
        if (!lobby.classList.contains("hidden")) lobbyMsg.innerHTML = notFoundMsg(code);
      }, 8000);
    });
  }, () => {
    lobbyMsg.textContent = "无法连接服务器（所有线路均失败），请稍后重试。";
  });
}
// 向房主报到（QoS0 可能丢，未确认前每 2.5 秒重发，最多 5 次）
let helloCount = 0;
function sendHello() {
  sendToHost({ t: "hello", name: pendingName });
  if (++helloCount <= 5) setTimeout(() => { if (!joinedConfirmed && roomTopicBase) sendHello(); }, 2500);
}
// 房主回传房间信息 -> 弹出加入确认框（含房间名 + 成员名单）
function showJoinConfirm(roomName, members) {
  joinRoomNameEl.textContent = roomName || roomCode || "----";
  joinMembersEl.innerHTML = "";
  (members && members.length ? members : ["（暂无其他成员）"]).forEach((n) => {
    const li = document.createElement("li");
    li.textContent = n;
    joinMembersEl.appendChild(li);
  });
  joinModal.classList.remove("hidden");
}
joinAcceptBtn.addEventListener("click", () => {
  joinModal.classList.add("hidden");
  joinedConfirmed = true;
  // 发布自己的在线标记（retained），房主据此确认
  mqttPublish(roomTopicBase + "p/" + myId, { online: true, name: pendingName }, true);
  sendToHost({ t: "joinConfirm" });
});
joinRejectBtn.addEventListener("click", () => {
  joinModal.classList.add("hidden");
  clearRetained(roomTopicBase + "p/" + myId);
  backToLobby("你已取消加入该房间。");
});

// ---- 房主：创建房间 ----
function createHost(code, name, mode, personality) {
  isHost = true; me.isHost = true;
  myId = "h-" + Math.random().toString(16).slice(2, 10);
  me.id = myId; roomCode = code;
  room = makeRoom(code);
  room.solo = mode === "solo";
  if (personality === "instant" || personality === "chatty") room.botPersonality = personality;
  room.players.push({ id: myId, name, score: 0, correct: false });
  room.hostId = myId;
  if (mode === "solo") addBot(room);
  enterGameScreen();
  broadcastStateHost();

  if (mode === "solo") {
    startGame(5);
    return;
  }
  // 多人：连 MQTT，登记房间在线标记，等待朋友加入
  showInviteLink(code);
  roomTopicBase = "dg/" + hostIdFor(code) + "/";
  const tp = topicsFor(code);
  lobbyMsg.textContent = "";
  const readyUp = (c) => {
    subAll([tp.msg, tp.players + "+"], () => {
      mqttPublish(tp.presence, { online: true, room: code }, true);
      showToast("✅ 房间已就绪，朋友可通过邀请链接或房间号加入了。", 3500);
    });
  };
  mqttSetup(code, tp.presence, readyUp, () => {
    lobbyMsg.textContent = "无法连接服务器（所有线路均失败），请稍后重试。";
  });
}

// ---- 房主：收到玩家的消息 ----
function onHostMessage(d, pid) {
  if (!room) return;
  switch (d.t) {
    case "hello": {
      const name = String(d.name || "玩家").slice(0, 12) || "玩家";
      if (room.players.some((p) => p.id === pid)) {
        publishTo(pid, { t: "state", ...buildView(pid) });
        return;
      }
      // 先不进房：把房间名 + 现有成员发回，等玩家点「加入」确认（确保进对房间）
      pending.set(pid, name);
      publishTo(pid, { t: "roomInfo", roomName: room.code, members: room.players.map((p) => p.name) });
      break;
    }
    case "joinConfirm": {
      if (!pending.has(pid)) {
        if (room.players.some((p) => p.id === pid)) publishTo(pid, { t: "state", ...buildView(pid) });
        break;
      }
      const name = pending.get(pid);
      pending.delete(pid);
      if (room.players.some((p) => p.id === pid)) break;
      room.players.push({ id: pid, name, score: 0, correct: false });
      chatHost(name, "加入了房间", "join");
      broadcastStateHost();
      break;
    }
    case "joinReject": {
      pending.delete(pid);
      break;
    }
    case "start": if (pid === room.hostId) startGame(parseInt(d.rounds, 10)); break;
    case "draw":
      if (pid === room.drawerId) {
        const seg = d.seg;
        room.strokes.push(seg);
        stroke(seg.from, seg.to, seg.color, seg.size);
        broadcastToAllExcept({ t: "draw", seg }, pid);
      }
      break;
    case "clear": if (pid === room.drawerId) { clearCanvas(); broadcastToAllExcept({ t: "clear" }, pid); } break;
    case "newWord": if (pid === room.drawerId) hostNewWord(); break;
    case "guess": {
      const p = room.players.find((x) => x.id === pid);
      if (p) { chatHost(p.name, d.text, "msg"); checkGuess(p, d.text); }
      break;
    }
    case "restart": if (pid === room.hostId) hostRestart(); break;
    case "dissolve": if (pid === room.hostId) hostDissolve(); break;
    case "leave": handleDisconnect(pid, true); break;
  }
}

// ---- 房主：游戏逻辑 ----
function makeRoom(code) {
  return {
    code, players: [], hostId: null, drawerId: null, word: null, wordCategory: null,
    round: 0, totalRounds: 0, drawerIndex: -1, strokes: [], guessed: {},
    started: false, phase: "lobby", timer: null, timeLeft: 0,
    newWordUsed: false, solo: false, botPersonality: "chatty",
    botScheduled: false, botTimers: []
  };
}
function pickWord(doodleOnly) {
  if (doodleOnly) {
    const w = DOODLE_WORDS[Math.floor(Math.random() * DOODLE_WORDS.length)];
    const meta = WORDS.find((x) => x.w === w) || { c: "物品" };
    return { w, c: meta.c };
  }
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}
function botLabel(p) { return p === "instant" ? "秒猜" : "话痨"; }
function addBot(room) {
  const bot = { id: "bot-" + room.code, name: `🤖 小猜(${botLabel(room.botPersonality)})`, score: 0, correct: false, isBot: true };
  room.players.push(bot);
  room.solo = true;
  return bot;
}
function circleFallback() {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const a = (Math.PI * 2 * i) / 24;
    pts.push({ x: 0.5 + 0.18 * Math.cos(a), y: 0.5 + 0.18 * Math.sin(a) });
  }
  return [pts];
}
function clearBotTimers() {
  if (!room.botTimers) room.botTimers = [];
  room.botTimers.forEach((t) => clearTimeout(t));
  room.botTimers = [];
}
function randomWrongWord(correct) {
  let w;
  do { w = WORDS[Math.floor(Math.random() * WORDS.length)].w; } while (w === correct);
  return w;
}
function drawerName() {
  const d = room.players.find((p) => p.id === room.drawerId);
  return d ? d.name : "";
}

function chatHost(name, text, type) {
  const m = { type: type || "msg", name, text };
  addChat(m);
  broadcastToAll({ t: "chat", ...m });
}
function systemChatHost(text) { chatHost("系统", text, "system"); }

function broadcastToAll(obj) {
  mqttPublish(roomTopicBase + "msg", { from: myId, role: "host", to: "*", body: obj });
}
function broadcastToAllExcept(obj, exceptId) {
  mqttPublish(roomTopicBase + "msg", { from: myId, role: "host", to: "*", except: exceptId, body: obj });
}
// 房主产生事件：本机应用 + 广播给玩家
function hostSend(obj) { broadcastToAll(obj); dispatch(obj); }

function buildView(forId) {
  const isDrawer = forId === room.drawerId;
  return {
    code: room.code,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, score: p.score, correct: !!room.guessed[p.id],
      isDrawer: p.id === room.drawerId, isHost: p.id === room.hostId,
      isYou: p.id === forId, isBot: !!p.isBot
    })),
    hostId: room.hostId, drawerId: room.drawerId, drawerName: drawerName(),
    phase: room.phase, round: room.round, totalRounds: room.totalRounds,
    timeLeft: room.timeLeft, started: room.started, youAreDrawer: isDrawer,
    solo: !!room.solo,
    word: isDrawer ? room.word : null,
    wordLen: room.word ? room.word.length : 0, wordCategory: room.wordCategory
  };
}
function broadcastStateHost() {
  applyState(buildView(myId));
  for (const p of room.players) if (p.id !== myId) publishTo(p.id, { t: "state", ...buildView(p.id) });
}

function startGame(rounds) {
  if (!room) return;
  if (room.players.length < 1) { lobbyMsg.textContent = "请先加入玩家"; return; }
  const r = parseInt(rounds, 10);
  room.totalRounds = (r > 0 && r <= 20) ? r : room.players.length;
  room.started = true; room.drawerIndex = -1; room.round = 0;
  room.players.forEach((p) => (p.score = 0));
  startRound();
}

function startRound() {
  clearBotTimers();
  room.round += 1;
  room.phase = "playing";
  let drawer;
  if (room.solo) {
    const human = room.players.find((p) => !p.isBot);
    const bot = room.players.find((p) => p.isBot);
    drawer = room.round % 2 === 1 ? human : bot;
  } else {
    room.drawerIndex = (room.drawerIndex + 1) % room.players.length;
    drawer = room.players[room.drawerIndex];
  }
  room.drawerId = drawer.id;
  room.guessed = {};
  room.strokes = [];
  room.newWordUsed = false;
  room.botScheduled = false;
  const picked = pickWord(room.solo && drawer.isBot);
  room.word = picked.w;
  room.wordCategory = picked.c;
  room.timeLeft = ROUND_SECONDS;

  hostSend({ t: "clear" });
  hostSend({ t: "roundStart", drawerName: drawer.name, round: room.round, totalRounds: room.totalRounds, category: picked.c, wordLen: room.word.length });

  // 把词单独发给画手
  if (drawer.id === myId) applyYourWord({ word: room.word });
  else { publishTo(drawer.id, { t: "yourWord", word: room.word }); }

  broadcastStateHost();

  if (room.solo) {
    const human = room.players.find((p) => !p.isBot);
    const bot = room.players.find((p) => p.isBot);
    if (drawer.id === human.id) {
      systemChatHost(`单人模式：这一轮你画，🤖 ${bot.name} 来猜！`);
    } else {
      systemChatHost(`单人模式：这一轮 🤖 ${bot.name} 来画，你来猜！`);
      scheduleBotDrawing();
    }
  }
  startTimer();
}

function startTimer() {
  clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    hostSend({ t: "tick", timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) endRound("timeout");
  }, 1000);
}

function endRound(reason) {
  if (room.phase === "reveal" || room.phase === "over") return;
  clearInterval(room.timer);
  clearBotTimers();
  room.phase = "reveal";
  chatHost("系统", `答案：「${room.word}」（${room.wordCategory}）`, "reveal");
  hostSend({ t: "roundEnd", word: room.word, category: room.wordCategory, reason });
  setTimeout(() => {
    if (room.round >= room.totalRounds) endGame();
    else startRound();
  }, REVEAL_SECONDS * 1000);
}

function endGame() {
  clearInterval(room.timer);
  clearBotTimers();
  room.phase = "over";
  room.started = false;
  const ranking = [...room.players].sort((a, b) => b.score - a.score).map((p) => ({ name: p.name, score: p.score }));
  hostSend({ t: "gameOver", players: ranking });
  systemChatHost("游戏结束！点击「再来一局」可重新开始。");
}

function checkGuess(player, text) {
  if (!room.word) return;
  if (player.id === room.drawerId) return;
  if (room.guessed[player.id]) return;
  const norm = (s) => s.replace(/\s+/g, "").toLowerCase();
  if (norm(text) === norm(room.word)) {
    room.guessed[player.id] = true;
    player.correct = true;
    player.score += 100;
    const dr = room.players.find((p) => p.id === room.drawerId);
    if (dr) dr.score += 50;
    chatHost(player.name, "猜对了！🎉", "correct");
    broadcastStateHost();
    const others = room.players.filter((p) => p.id !== room.drawerId);
    if (others.length > 0 && others.every((p) => room.guessed[p.id])) endRound("all");
  }
}

function hostNewWord() {
  if (room.newWordUsed) return;
  room.newWordUsed = true; room.botScheduled = false; clearBotTimers();
  const picked = pickWord(false);
  room.word = picked.w; room.wordCategory = picked.c; room.strokes = [];
  clearCanvas(); broadcastToAll({ t: "clear" });
  const dr = room.players.find((p) => p.id === room.drawerId);
  if (dr && dr.id === myId) applyYourWord({ word: room.word });
  else { publishTo(dr.id, { t: "yourWord", word: room.word }); }
  broadcastStateHost();
  systemChatHost("画手更换了词语。");
}

function hostRestart() {
  room.started = false; room.phase = "lobby"; room.drawerId = null; room.word = null; room.round = 0;
  room.players.forEach((p) => (p.score = 0));
  room.strokes = []; clearBotTimers();
  clearCanvas(); broadcastToAll({ t: "clear" });
  broadcastStateHost();
}

function hostDissolve() {
  clearInterval(room.timer); clearBotTimers();
  broadcastToAll({ t: "roomDissolved" });
  room = null;
  clearRetained(roomTopicBase + "presence");   // 撤下房间在线标记
  backToLobby("房间已解散。");
}

function handleDisconnect(pid, voluntary) {
  if (!room) return;
  pending.delete(pid);
  const idx = room.players.findIndex((p) => p.id === pid);
  if (idx < 0) return;
  const [left] = room.players.splice(idx, 1);
  chatHost(left.name, voluntary ? "离开了房间" : "掉线了", "join");
  const humans = room.players.filter((p) => !p.isBot);
  if (humans.length === 0) {
    clearInterval(room.timer); clearBotTimers();
    const wasSolo = room.solo;
    room = null;
    clearRetained(roomTopicBase + "presence"); // 撤下房间在线标记
    backToLobby(wasSolo ? "机器人已离开，游戏结束。" : "所有玩家已离开。");
    return;
  }
  if (room.hostId === pid) room.hostId = humans[0].id;
  if (room.drawerId === pid && room.phase === "playing") endRound("drawerLeft");
  else broadcastStateHost();
}

// ---- 房主：机器人行为 ----
function scheduleBotDrawing() {
  clearBotTimers();
  const bot = room.players.find((p) => p.isBot);
  if (!bot || room.phase !== "playing") return;
  const word = room.word, cat = room.wordCategory, first = word ? word[0] : "";
  const instant = room.botPersonality === "instant";
  const polylines = getDoodle(word) || [circleFallback()];
  const color = "#111111", size = 8;
  let cum = instant ? 700 : 1200;
  const thinkLine = instant ? "看好了，很简单~" : "我来画啦，你来猜猜是什么🤔";
  room.botTimers.push(setTimeout(() => chatHost(bot.name, thinkLine, "msg"), 900));
  for (const pl of polylines) {
    for (let i = 0; i < pl.length - 1; i++) {
      const from = pl[i], to = pl[i + 1];
      const segDelay = instant ? 35 : 95;
      cum += segDelay;
      const t = setTimeout(() => {
        if (room.phase !== "playing") return;
        botEmitDraw({ from, to, color, size });
      }, cum);
      room.botTimers.push(t);
    }
  }
  const drawDone = cum + 300;
  room.botTimers.push(setTimeout(() => {
    if (room.phase !== "playing") return;
    chatHost(bot.name, `提示：这是「${cat}」类的哦`, "msg");
  }, instant ? 2600 : 4200));
  if (instant) {
    room.botTimers.push(setTimeout(() => {
      if (room.phase !== "playing") return;
      chatHost(bot.name, "快猜呀！", "msg");
    }, 11000));
  } else {
    room.botTimers.push(setTimeout(() => {
      if (room.phase !== "playing") return;
      chatHost(bot.name, `再给个提示：第一个字是「${first}」`, "msg");
    }, 38000));
    room.botTimers.push(setTimeout(() => {
      if (room.phase !== "playing") return;
      chatHost(bot.name, "我画好啦，快猜！", "msg");
    }, drawDone));
  }
}

function scheduleBot() {
  clearBotTimers();
  const bot = room.players.find((p) => p.isBot);
  if (!bot || room.phase !== "playing") return;
  const instant = room.botPersonality === "instant";
  chatHost(bot.name, instant ? "我来瞅瞅你画的…" : "让我看看你画的是啥😏", "msg");
  const wrong = instant ? 1 : 3 + Math.floor(Math.random() * 3);
  const wrongLines = instant ? ["是这个吗？"] : ["这画的啥呀😂", "难道是…", "我快看出来了！", "再想想…", "有点意思哈"];
  let acc = instant ? 1800 : 3500;
  for (let i = 0; i < wrong; i++) {
    const d = acc + Math.floor(Math.random() * (instant ? 800 : 2500));
    const t = setTimeout(() => {
      if (room.phase !== "playing" || room.guessed[bot.id]) return;
      const line = instant ? wrongLines[0] : wrongLines[i % wrongLines.length];
      chatHost(bot.name, line + randomWrongWord(room.word), "msg");
    }, d);
    room.botTimers.push(t);
    acc = d + (instant ? 800 : 2000);
  }
  const tCorrect = setTimeout(() => {
    if (room.phase !== "playing" || room.guessed[bot.id]) return;
    if (instant) chatHost(bot.name, "我懂了！", "msg");
    checkGuess(bot, room.word);
  }, acc + (instant ? 1200 : 4000 + Math.floor(Math.random() * 5000)));
  room.botTimers.push(tCorrect);
}

// ---- 房主：绘制下发 ----
function emitDraw(seg) {
  room.strokes.push(seg);
  stroke(seg.from, seg.to, seg.color, seg.size);
  broadcastToAll({ t: "draw", seg });
  // 单人模式：人画 -> 安排机器人陪猜
  if (room.solo && !room.botScheduled && room.drawerId !== "bot-" + room.code) {
    room.botScheduled = true;
    scheduleBot();
  }
}
function botEmitDraw(seg) {
  room.strokes.push(seg);
  stroke(seg.from, seg.to, seg.color, seg.size);
  broadcastToAll({ t: "draw", seg });
}

// ---- 玩家 / 房主通用：接收消息 ----
function dispatch(m) {
  switch (m.t) {
    case "roomInfo": showJoinConfirm(m.roomName, m.members); break;  // 弹出加入确认框
    case "state": applyState(m); break;
    case "yourWord": applyYourWord(m); break;
    case "draw": stroke(m.seg.from, m.seg.to, m.seg.color, m.seg.size); break;
    case "clear": clearCanvas(); break;
    case "chat": addChat(m); break;
    case "roundStart": applyRoundStart(m); break;
    case "roundEnd": applyRoundEnd(m); break;
    case "gameOver": applyGameOver(m); break;
    case "tick": applyTick(m); break;
    case "youLeft": backToLobby("你已退出房间，可重新创建或加入。"); break;
    case "roomDissolved": backToLobby("房间已被房主解散。"); break;
  }
}

function applyState(s) {
  joinModal.classList.add("hidden");
  joinedConfirmed = true;
  me.isDrawer = s.youAreDrawer;
  me.isHost = s.hostId === me.id;
  if (!lobby.classList.contains("hidden")) { lobby.classList.add("hidden"); game.classList.remove("hidden"); }
  roomCodeEl.textContent = s.code;
  playerCount.textContent = s.players.length;
  playerList.innerHTML = "";
  s.players.forEach((p) => {
    const li = document.createElement("li");
    if (p.isDrawer) li.classList.add("drawer");
    if (p.isYou) li.classList.add("me");
    let tag = "";
    if (p.isHost) tag += "房主 ";
    if (p.isDrawer) tag += "✏️画手 ";
    if (p.correct) tag += "✅";
    li.innerHTML = `<span>${escapeHtml(p.name)}<span class="tag">${tag}</span></span><span class="score">${p.score}</span>`;
    playerList.appendChild(li);
  });
  if (s.youAreDrawer && s.word) {
    wordStatus.innerHTML = `你画的词：<span class="mine">${escapeHtml(s.word)}</span>（${s.wordCategory}）`;
  } else if (s.phase === "playing") {
    wordStatus.textContent = `提示：${s.wordCategory} · 共 ${s.wordLen} 个字`;
  } else if (s.phase === "lobby") {
    wordStatus.textContent = "等待房主开始…";
  }
  if (s.phase === "playing") {
    roundInfo.textContent = `第 ${s.round}/${s.totalRounds} 轮 · ${s.drawerName} 在画`;
  } else if (s.phase === "lobby") {
    roundInfo.textContent = `房间人数 ${s.players.length}`;
  }
  tools.style.display = me.isDrawer ? "flex" : "none";
  board.style.cursor = me.isDrawer ? "crosshair" : "default";
  newWordBtn.style.display = me.isDrawer ? "inline-block" : "none";
  const guessRow = document.querySelector(".guess-row");
  if (guessRow) guessRow.style.display = me.isDrawer ? "none" : "";
  startBtn.classList.toggle("hidden", !(me.isHost && s.phase === "lobby"));
  restartBtn.classList.toggle("hidden", !(me.isHost && s.phase === "over"));
  roundsSelect.style.display = (me.isHost && s.phase === "lobby") ? "inline-block" : "none";
  dissolveBtn.classList.toggle("hidden", !me.isHost);
  exitBtn.classList.toggle("hidden", me.isHost);
  inviteBtn.classList.toggle("hidden", !(me.isHost && !s.solo));
}
function applyYourWord({ word }) {
  wordStatus.innerHTML = `你画的词：<span class="mine">${escapeHtml(word)}</span>`;
}
function applyRoundStart({ drawerName, round, totalRounds, category, wordLen }) {
  clearCanvas();
  if (!me.isDrawer) {
    wordStatus.textContent = `提示：${category} · 共 ${wordLen} 个字`;
    roundInfo.textContent = `第 ${round}/${totalRounds} 轮 · ${drawerName} 在画`;
  }
  chatLog.innerHTML = "";
  addChat({ type: "system", name: "系统", text: `${drawerName} 开始作画，大家猜起来！` });
}
function applyRoundEnd({ word, category, reason }) {
  const r = reason === "timeout" ? "时间到" : reason === "all" ? "全部猜对" : "回合结束";
  addChat({ type: "reveal", name: "系统", text: `${r}！答案：${word}（${category}）` });
}
function applyGameOver({ players }) {
  const list = players.map((p, i) => `${i + 1}. ${p.name} — ${p.score} 分`).join("　");
  addChat({ type: "reveal", name: "系统", text: "🏆 最终排名：" + list });
}
function applyTick({ timeLeft }) {
  timerEl.textContent = timeLeft + "s";
  timerEl.classList.toggle("low", timeLeft <= 10);
}

// ---- 聊天 / 猜词 ----
function sendGuess() {
  const text = guessInput.value.trim();
  if (!text) return;
  if (isHost) {
    const p = room.players.find((x) => x.id === myId);
    if (p) { chatHost(p.name, text, "msg"); checkGuess(p, text); }
  } else {
    sendToHost({ t: "guess", text });
  }
  guessInput.value = "";
}
sendBtn.addEventListener("click", sendGuess);
guessInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendGuess(); });
function addChat(m) {
  const div = document.createElement("div");
  if (m.type === "msg") div.innerHTML = `<span class="name">${escapeHtml(m.name)}：</span>${escapeHtml(m.text)}`;
  else { div.className = m.type; div.textContent = `${m.name}：${m.text}`; }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---- 画布 ----
function pos(e) {
  const rect = board.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height
  };
}
function stroke(from, to, color, size) {
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x * board.width, from.y * board.height);
  ctx.lineTo(to.x * board.width, to.y * board.height);
  ctx.stroke();
}
function clearCanvas() { ctx.clearRect(0, 0, board.width, board.height); }

board.addEventListener("pointerdown", (e) => {
  if (!me.isDrawer) return;
  drawing = true; last = pos(e);
  try { board.setPointerCapture(e.pointerId); } catch (err) {}
});
board.addEventListener("pointermove", (e) => {
  if (!me.isDrawer || !drawing) return;
  const p = pos(e);
  const color = erasing ? "#ffffff" : penColor;
  const size = erasing ? penSize * 2.2 : penSize;
  const seg = { from: last, to: p, color, size };
  stroke(last, p, color, size);
  if (isHost) emitDraw(seg);
  else sendToHost({ t: "draw", seg });
  last = p;
});
board.addEventListener("pointerup", () => { drawing = false; });
board.addEventListener("pointerleave", () => { drawing = false; });

// ---- 房主控制 ----
startBtn.addEventListener("click", () => {
  if (isHost) startGame(parseInt(roundsSelect.value, 10));
  else sendToHost({ t: "start", rounds: parseInt(roundsSelect.value, 10) });
});
restartBtn.addEventListener("click", () => {
  if (isHost) hostRestart();
  else sendToHost({ t: "restart" });
});
dissolveBtn.addEventListener("click", () => {
  if (confirm("确定解散房间？所有玩家都会被送回主页。")) {
    if (isHost) hostDissolve();
    else sendToHost({ t: "dissolve" });
  }
});
exitBtn.addEventListener("click", () => {
  if (confirm("确定退出房间？")) {
    if (!isHost) sendToHost({ t: "leave" });
    backToLobby("你已退出房间。");
  }
});

// ---- 工具 ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
