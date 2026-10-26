// 你画我猜 - 前端逻辑
const socket = io();

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const lobby = $("lobby");
const game = $("game");

const nameInput = $("nameInput");
const codeInput = $("codeInput");
const lobbyMsg = $("lobbyMsg");

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

// ---- 状态 ----
let me = { id: null, isDrawer: false, isHost: false };
let penColor = "#111111";
let penSize = 10;
let erasing = false;
let drawing = false;
let last = null;

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
clearBtn.addEventListener("click", () => socket.emit("clear"));

// 自定义颜色取色器：选色后取消橡皮并取消预设高亮
customColor.addEventListener("input", () => {
  penColor = customColor.value;
  erasing = false;
  eraserBtn.style.background = "";
  document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
});
newWordBtn.addEventListener("click", () => socket.emit("newWord"));

// ---- 进入房间 ----
function enter() {
  const name = nameInput.value.trim();
  if (!name) { lobbyMsg.textContent = "请先输入昵称"; return; }
  return name;
}
$("createBtn").addEventListener("click", () => {
  const name = enter(); if (!name) return;
  socket.emit("createRoom", { name, mode: "multi" }); // 多人模式：不出现机器人
});
$("soloBtn").addEventListener("click", () => {
  const name = enter(); if (!name) return;
  socket.emit("createRoom", { name, mode: "solo", botPersonality: botPersonalitySel.value });
});
$("joinBtn").addEventListener("click", () => {
  const name = enter(); if (!name) return;
  const code = codeInput.value.trim();
  if (!code) { lobbyMsg.textContent = "请输入房间号"; return; }
  socket.emit("joinRoom", { name, code });
});

socket.on("errorMsg", ({ text }) => { lobbyMsg.textContent = text; });

// ---- 游戏状态 ----
socket.on("roomState", (s) => {
  me.id = socket.id;
  me.isDrawer = s.youAreDrawer;
  me.isHost = s.hostId === socket.id;

  if (lobby.classList.contains("hidden") === false) {
    lobby.classList.add("hidden");
    game.classList.remove("hidden");
  }
  roomCodeEl.textContent = s.code;
  playerCount.textContent = s.players.length;

  // 玩家列表
  playerList.innerHTML = "";
  s.players.forEach((p) => {
    const li = document.createElement("li");
    if (p.isDrawer) li.classList.add("drawer");
    if (p.isYou) li.classList.add("me");
    let tag = "";
    if (p.isHost) tag += "房主 ";
    if (p.isDrawer) tag += "✏️画手 ";
    if (p.correct) tag += "✅";
    li.innerHTML = `<span>${escapeHtml(p.name)}<span class="tag">${tag}</span></span>
                    <span class="score">${p.score}</span>`;
    playerList.appendChild(li);
  });

  // 词显示
  if (s.youAreDrawer && s.word) {
    wordStatus.innerHTML = `你画的词：<span class="mine">${escapeHtml(s.word)}</span>（${s.wordCategory}）`;
  } else if (s.phase === "playing") {
    wordStatus.textContent = `提示：${s.wordCategory} · 共 ${s.wordLen} 个字`;
  } else if (s.phase === "lobby") {
    wordStatus.textContent = "等待房主开始…";
  }

  // 回合 / 计时
  if (s.phase === "playing") {
    roundInfo.textContent = `第 ${s.round}/${s.totalRounds} 轮 · ${s.drawerName} 在画`;
  } else if (s.phase === "lobby") {
    roundInfo.textContent = `房间人数 ${s.players.length}`;
  }

  // 画手工具权限
  tools.style.display = me.isDrawer ? "flex" : "none";
  board.style.cursor = me.isDrawer ? "crosshair" : "default";
  newWordBtn.style.display = me.isDrawer ? "inline-block" : "none";

  // 自己是画手时隐藏猜词框（单人模式始终为画手）
  const guessRow = document.querySelector(".guess-row");
  if (guessRow) guessRow.style.display = me.isDrawer ? "none" : "";

  // 房主操作
  startBtn.classList.toggle("hidden", !me.isHost || s.phase === "playing" || s.phase === "reveal");
  restartBtn.classList.toggle("hidden", !(me.isHost && s.phase === "over"));
  roundsSelect.style.display = (me.isHost && s.phase === "lobby") ? "inline-block" : "none";
  // 房主看到「解散房间」，普通玩家看到「退出房间」
  dissolveBtn.classList.toggle("hidden", !me.isHost);
  exitBtn.classList.toggle("hidden", me.isHost);
});

socket.on("yourWord", ({ word }) => {
  wordStatus.innerHTML = `你画的词：<span class="mine">${escapeHtml(word)}</span>`;
});

socket.on("roundStart", ({ drawerName, round, totalRounds, category, wordLen }) => {
  clearCanvas();
  if (!me.isDrawer) {
    wordStatus.textContent = `提示：${category} · 共 ${wordLen} 个字`;
    roundInfo.textContent = `第 ${round}/${totalRounds} 轮 · ${drawerName} 在画`;
  }
  chatLog.innerHTML = "";
  addChat({ type: "system", name: "系统", text: `${drawerName} 开始作画，大家猜起来！` });
});

socket.on("roundEnd", ({ word, category, reason }) => {
  const r = reason === "timeout" ? "时间到" : reason === "all" ? "全部猜对" : "回合结束";
  addChat({ type: "reveal", name: "系统", text: `${r}！答案：${word}（${category}）` });
});

socket.on("tick", ({ timeLeft }) => {
  timerEl.textContent = timeLeft + "s";
  timerEl.classList.toggle("low", timeLeft <= 10);
});
socket.on("gameOver", ({ players }) => {
  const list = players.map((p, i) => `${i + 1}. ${p.name} — ${p.score} 分`).join("　");
  addChat({ type: "reveal", name: "系统", text: "🏆 最终排名：" + list });
});

// ---- 聊天 / 猜词 ----
function sendGuess() {
  const text = guessInput.value.trim();
  if (!text) return;
  socket.emit("guess", { text });
  guessInput.value = "";
}
sendBtn.addEventListener("click", sendGuess);
guessInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendGuess(); });

socket.on("chat", (m) => addChat(m));
function addChat(m) {
  const div = document.createElement("div");
  if (m.type === "msg") div.innerHTML = `<span class="name">${escapeHtml(m.name)}：</span>${escapeHtml(m.text)}`;
  else div.className = m.type, div.textContent = `${m.name}：${m.text}`;
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
function clearCanvas() {
  ctx.clearRect(0, 0, board.width, board.height);
}

board.addEventListener("pointerdown", (e) => {
  if (!me.isDrawer) return;
  drawing = true;
  last = pos(e);
  board.setPointerCapture(e.pointerId);
});
board.addEventListener("pointermove", (e) => {
  if (!me.isDrawer || !drawing) return;
  const p = pos(e);
  const color = erasing ? "#ffffff" : penColor;
  const size = erasing ? penSize * 2.2 : penSize;
  stroke(last, p, color, size);
  socket.emit("draw", { from: last, to: p, color, size });
  last = p;
});
board.addEventListener("pointerup", () => { drawing = false; });
board.addEventListener("pointerleave", () => { drawing = false; });

// 接收他人笔画
socket.on("draw", (seg) => stroke(seg.from, seg.to, seg.color, seg.size));
socket.on("clear", () => clearCanvas());

// ---- 房主控制 ----
startBtn.addEventListener("click", () => socket.emit("startGame", { rounds: parseInt(roundsSelect.value, 10) }));
restartBtn.addEventListener("click", () => socket.emit("restart"));
dissolveBtn.addEventListener("click", () => {
  if (confirm("确定解散房间？所有玩家都会被送回主页。")) socket.emit("dissolveRoom");
});
exitBtn.addEventListener("click", () => {
  if (confirm("确定退出房间？")) socket.emit("leaveRoom");
});

// ---- 回主页 ----
function backToLobby(msg) {
  game.classList.add("hidden");
  lobby.classList.remove("hidden");
  lobbyMsg.textContent = msg || "";
  roomCodeEl.textContent = "----";
  playerList.innerHTML = "";
  chatLog.innerHTML = "";
  clearCanvas();
  me = { id: null, isDrawer: false, isHost: false };
}
socket.on("youLeft", () => backToLobby("你已退出房间，可重新创建或加入。"));
socket.on("roomDissolved", () => backToLobby("房间已被房主解散。"));

// ---- 工具 ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
