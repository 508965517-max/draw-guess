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

// ---- 网络层 ----
let peer = null;          // PeerJS Peer 实例
let hostConn = null;      // 玩家 -> 房主 的连接
let isHost = false;
let roomCode = null;
let myId = null;
const peers = new Map();  // 房主侧：peerId -> { conn, name }
const pending = new Map(); // 房主侧：待确认加入的 peerId -> name（收到 joinConfirm 才真正进房）

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
  else if (hostConn) hostConn.send({ t: "clear" });
});
customColor.addEventListener("input", () => {
  penColor = customColor.value; erasing = false; eraserBtn.style.background = "";
  document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
});
newWordBtn.addEventListener("click", () => {
  if (isHost && me.isDrawer) hostNewWord();
  else if (hostConn) hostConn.send({ t: "newWord" });
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
  isHost = false; roomCode = null; myId = null; room = null;
  try { if (hostConn) { hostConn.close(); hostConn = null; } } catch (e) {}
  try { if (peer) { peer.destroy(); peer = null; } } catch (e) {}
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

// ---- 玩家：连接房主 ----
let pendingName = null;
let joinConfirmed = false;
function joinAsPlayer(name, code) {
  roomCode = code; isHost = false; me.isHost = false; pendingName = name; joinConfirmed = false;
  lobbyMsg.textContent = "正在连接房主，请稍候…";
  // 两秒弹窗提示：正在加入的房间名，并说明只需房间码或房主链接
  showToast("正在加入房间「" + code + "」…<br>只需房间码，或打开房主发的邀请链接即可进入。", 2000);
  peer = new Peer();
  peer.on("open", (id) => {
    myId = id; me.id = id;
    const hostId = "drawguess-" + code;
    hostConn = peer.connect(hostId, { reliable: true });
    hostConn.on("open", () => { sendHello(); });   // 首包，可能丢失
    hostConn.on("data", dispatch);
    hostConn.on("close", () => backToLobby("与房主的连接已断开，请重新加入。"));
    hostConn.on("error", () => { lobbyMsg.textContent = "连接失败：请确认房间号正确，且房主页面没有关闭。"; });
    // 兜底：长时间没进入游戏（没收到房主状态，且确认框未打开）则提示
    setTimeout(() => {
      if (!game.classList.contains("hidden")) return;
      if (!joinModal.classList.contains("hidden")) return;
      lobbyMsg.textContent = "连接超时：请确认房主页面还开着，或换一个房间号重试。";
    }, 9000);
  });
  peer.on("error", (e) => { lobbyMsg.textContent = "连接错误：" + (e && e.type ? e.type : e); });
}
// 向房主报到（房主收到 welcome 后会再次触发，确保首包不丢）
function sendHello() {
  if (hostConn && hostConn.open) hostConn.send({ t: "hello", name: pendingName });
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
  joinConfirmed = true;
  if (hostConn && hostConn.open) hostConn.send({ t: "joinConfirm" });
});
joinRejectBtn.addEventListener("click", () => {
  joinModal.classList.add("hidden");
  backToLobby("你已取消加入该房间。");
  try { if (hostConn) hostConn.close(); } catch (e) {}
  try { if (peer) peer.destroy(); } catch (e) {}
});

// ---- 房主：创建房间 ----
function createHost(code, name, mode, personality) {
  isHost = true; me.isHost = true;
  me.id = "drawguess-" + code; myId = me.id; roomCode = code;
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
  // 多人：建立可连接的 Peer，等待朋友加入
  showInviteLink(code);
  try { peer = new Peer(myId); } catch (e) { lobbyMsg.textContent = "无法创建房间，请重试。"; return; }
  peer.on("open", () => {});
  peer.on("connection", (conn) => {
    peers.set(conn.peer, { conn, name: null });   // 关键：登记连接，broadcast 才能发得出去
    const sendWelcome = () => { if (conn.open) conn.send({ t: "welcome" }); };
    if (conn.open) sendWelcome();
    conn.on("open", sendWelcome);
    conn.on("data", (d) => onHostMessage(d, conn));
    conn.on("close", () => handleDisconnect(conn.peer, false));
    conn.on("error", () => {});
  });
  peer.on("error", (e) => {
    if (e && e.type === "unavailable-id") {
      lobbyMsg.textContent = "房间号被占用，请返回重新创建一个房间。";
      backToLobby("房间号被占用，请重新创建。");
    } else {
      lobbyMsg.textContent = "房间创建失败：" + (e && e.type ? e.type : e);
    }
  });
}

// ---- 房主：收到玩家的消息 ----
function onHostMessage(d, conn) {
  if (!room) return;
  const pid = conn.peer;
  switch (d.t) {
    case "hello": {
      const name = String(d.name || "玩家").slice(0, 12) || "玩家";
      if (peers.has(pid)) peers.get(pid).name = name;
      if (room.players.some((p) => p.id === pid)) {
        if (conn.open) conn.send({ t: "state", ...buildView(pid) });
        return;
      }
      // 先不进房：把房间名 + 现有成员发回，等玩家点「加入」确认（确保进对房间）
      pending.set(pid, name);
      if (conn.open) conn.send({ t: "roomInfo", roomName: room.code, members: room.players.map((p) => p.name) });
      break;
    }
    case "joinConfirm": {
      if (!pending.has(pid)) {
        if (room.players.some((p) => p.id === pid) && conn.open) conn.send({ t: "state", ...buildView(pid) });
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
      try { if (conn.open) conn.close(); } catch (e) {}
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
  for (const { conn } of peers.values()) if (conn.open) conn.send(obj);
}
function broadcastToAllExcept(obj, exceptId) {
  for (const [pid, { conn }] of peers) if (pid !== exceptId && conn.open) conn.send(obj);
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
    word: isDrawer ? room.word : null,
    wordLen: room.word ? room.word.length : 0, wordCategory: room.wordCategory
  };
}
function broadcastStateHost() {
  applyState(buildView(myId));
  for (const [pid, { conn }] of peers) if (conn.open) conn.send({ t: "state", ...buildView(pid) });
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
  else { const c = peers.get(drawer.id); if (c && c.conn.open) c.conn.send({ t: "yourWord", word: room.word }); }

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
  else { const c = peers.get(dr.id); if (c && c.conn.open) c.conn.send({ t: "yourWord", word: room.word }); }
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
  try { if (peer) peer.destroy(); } catch (e) {}
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
    try { if (peer) peer.destroy(); } catch (e) {}
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
    case "welcome": sendHello(); break;   // 房主已就绪，补发报到，确保首包不丢
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
  } else if (hostConn) {
    hostConn.send({ t: "guess", text });
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
  else if (hostConn) hostConn.send({ t: "draw", seg });
  last = p;
});
board.addEventListener("pointerup", () => { drawing = false; });
board.addEventListener("pointerleave", () => { drawing = false; });

// ---- 房主控制 ----
startBtn.addEventListener("click", () => {
  if (isHost) startGame(parseInt(roundsSelect.value, 10));
  else if (hostConn) hostConn.send({ t: "start", rounds: parseInt(roundsSelect.value, 10) });
});
restartBtn.addEventListener("click", () => {
  if (isHost) hostRestart();
  else if (hostConn) hostConn.send({ t: "restart" });
});
dissolveBtn.addEventListener("click", () => {
  if (confirm("确定解散房间？所有玩家都会被送回主页。")) {
    if (isHost) hostDissolve();
    else if (hostConn) hostConn.send({ t: "dissolve" });
  }
});
exitBtn.addEventListener("click", () => {
  if (confirm("确定退出房间？")) {
    if (hostConn) hostConn.send({ t: "leave" });
    backToLobby("你已退出房间。");
  }
});

// ---- 工具 ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
