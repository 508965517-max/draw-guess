// 你画我猜 - 服务端
// Express 提供静态页面，Socket.IO 负责房间与实时同步。
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { WORDS } = require("./words");
const { getDoodle, DOODLE_WORDS } = require("./doodles");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const ROUND_SECONDS = 90;   // 每回合倒计时
const REVEAL_SECONDS = 4;   // 揭晓答案停留
const PORT = process.env.PORT || 3000;

// ---- 房间管理 ----
const rooms = {}; // code -> room

function genCode() {
  let c;
  do {
    c = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[c]);
  return c;
}

function makeRoom(code) {
  return {
    code,
    players: [],          // { id, name, score, correct, guessed }
    hostId: null,
    drawerId: null,
    word: null,
    wordCategory: null,
    round: 0,
    totalRounds: 0,
    drawerIndex: -1,
    strokes: [],          // 当前回合笔画快照（用于后进同步）
    guessed: {},           // id -> true
    started: false,
    phase: "lobby",       // lobby | playing | reveal | over
    timer: null,
    timeLeft: 0,
    newWordUsed: false,
    solo: false,          // 单人模式（含机器人陪猜）
    botPersonality: "chatty", // 机器人性格：chatty 话痨型 / instant 秒猜型
    botScheduled: false,  // 本回合机器人是否已安排猜词
    botTimers: []         // 机器人相关定时器
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

// ---- 单人模式：机器人陪猜 / 反画 ----
function botLabel(personality) {
  return personality === "instant" ? "秒猜" : "话痨";
}

function addBot(room) {
  const bot = {
    id: "bot-" + room.code,
    name: `🤖 小猜(${botLabel(room.botPersonality)})`,
    score: 0,
    correct: false,
    guessed: false,
    isBot: true
  };
  room.players.push(bot);
  room.solo = true;
  return bot;
}

// 机器人"反画"：把涂鸦库里的词按段 emit 出来，并配文字提示让你猜
function scheduleBotDrawing(room) {
  clearBotTimers(room);
  const bot = room.players.find((p) => p.isBot);
  if (!bot || room.phase !== "playing") return;
  const word = room.word;
  const cat = room.wordCategory;
  const first = word ? word[0] : "";
  const instant = room.botPersonality === "instant";

  const polylines = getDoodle(word) || [circleFallback()];
  const color = "#111111";
  const size = 8;
  let cum = instant ? 700 : 1200; // 先"想一下"
  // 边画边聊
  const thinkLine = instant ? "看好了，很简单~" : "我来画啦，你来猜猜是什么🤔";
  const t0 = setTimeout(() => chat(room, bot.name, thinkLine, "msg"), 900);
  room.botTimers.push(t0);

  for (const pl of polylines) {
    for (let i = 0; i < pl.length - 1; i++) {
      const from = pl[i], to = pl[i + 1];
      const segDelay = instant ? 35 : 95;
      cum += segDelay;
      const t = setTimeout(() => {
        if (room.phase !== "playing") return;
        io.to(room.code).emit("draw", { from, to, color, size });
      }, cum);
      room.botTimers.push(t);
    }
  }
  const drawDone = cum + 300;

  // 类别提示
  const tCat = setTimeout(() => {
    if (room.phase !== "playing") return;
    chat(room, bot.name, `提示：这是「${cat}」类的哦`, "msg");
  }, instant ? 2600 : 4200);
  room.botTimers.push(tCat);

  if (instant) {
    const tRush = setTimeout(() => {
      if (room.phase !== "playing") return;
      chat(room, bot.name, "快猜呀！", "msg");
    }, 11000);
    room.botTimers.push(tRush);
  } else {
    // 话痨：60% 时间再给首字提示
    const tFirst = setTimeout(() => {
      if (room.phase !== "playing") return;
      chat(room, bot.name, `再给个提示：第一个字是「${first}」`, "msg");
    }, 38000);
    room.botTimers.push(tFirst);
    const tDone = setTimeout(() => {
      if (room.phase !== "playing") return;
      chat(room, bot.name, "我画好啦，快猜！", "msg");
    }, drawDone);
    room.botTimers.push(tDone);
  }
}

function circleFallback() {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const a = (Math.PI * 2 * i) / 24;
    pts.push({ x: 0.5 + 0.18 * Math.cos(a), y: 0.5 + 0.18 * Math.sin(a) });
  }
  return [pts];
}

function clearBotTimers(room) {
  if (!room.botTimers) room.botTimers = [];
  room.botTimers.forEach((t) => clearTimeout(t));
  room.botTimers = [];
}

function randomWrongWord(correct) {
  let w;
  do {
    w = WORDS[Math.floor(Math.random() * WORDS.length)].w;
  } while (w === correct);
  return w;
}

// 画手画第一笔后，机器人“观察”一会儿，先来几个搞笑误猜，再猜对
function scheduleBot(room) {
  clearBotTimers(room);
  const bot = room.players.find((p) => p.isBot);
  if (!bot || room.phase !== "playing") return;
  const instant = room.botPersonality === "instant";
  const chatLine = instant ? "我来瞅瞅你画的…" : "让我看看你画的是啥😏";
  chat(room, bot.name, chatLine, "msg");

  const wrong = instant ? 1 : 3 + Math.floor(Math.random() * 3); // 话痨多猜几次
  const wrongLines = instant
    ? ["是这个吗？"]
    : ["这画的啥呀😂", "难道是…", "我快看出来了！", "再想想…", "有点意思哈"];
  let acc = instant ? 1800 : 3500;
  for (let i = 0; i < wrong; i++) {
    const d = acc + Math.floor(Math.random() * (instant ? 800 : 2500));
    const t = setTimeout(() => {
      if (room.phase !== "playing" || room.guessed[bot.id]) return;
      const line = instant ? wrongLines[0] : wrongLines[i % wrongLines.length];
      chat(room, bot.name, line + randomWrongWord(room.word), "msg");
    }, d);
    room.botTimers.push(t);
    acc = d + (instant ? 800 : 2000);
  }
  const tCorrect = setTimeout(() => {
    if (room.phase !== "playing" || room.guessed[bot.id]) return;
    if (instant) chat(room, bot.name, "我懂了！", "msg");
    checkGuess(room, bot, room.word);
  }, acc + (instant ? 1200 : 4000 + Math.floor(Math.random() * 5000)));
  room.botTimers.push(tCorrect);
}

function roomPlayersView(room, forId) {
  return room.players.map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    correct: !!room.guessed[p.id],
    isDrawer: p.id === room.drawerId,
    isHost: p.id === room.hostId,
    isYou: p.id === forId,
    isBot: !!p.isBot
  }));
}

// 给房间内每个人推送各自视角的状态
function broadcastState(room) {
  for (const p of room.players) {
    const isDrawer = p.id === room.drawerId;
    io.to(p.id).emit("roomState", {
      code: room.code,
      players: roomPlayersView(room, p.id),
      hostId: room.hostId,
      drawerId: room.drawerId,
      drawerName: drawerName(room),
      phase: room.phase,
      round: room.round,
      totalRounds: room.totalRounds,
      timeLeft: room.timeLeft,
      started: room.started,
      youAreDrawer: isDrawer,
      // 画手看到词，其他人只看到长度与类别提示
      word: isDrawer ? room.word : null,
      wordLen: room.word ? room.word.length : 0,
      wordCategory: room.wordCategory
    });
  }
}

function drawerName(room) {
  const d = room.players.find((p) => p.id === room.drawerId);
  return d ? d.name : "";
}

function systemChat(room, text) {
  io.to(room.code).emit("chat", { type: "system", name: "系统", text });
}

function chat(room, name, text, type = "msg") {
  io.to(room.code).emit("chat", { type, name, text });
}

// ---- 回合控制 ----
function startRound(room) {
  clearBotTimers(room);
  room.round += 1;
  room.phase = "playing";

  // 决定画手：单人模式按回合奇偶轮换（你画↔机器人画），多人模式正常轮换
  let drawer;
  if (room.solo) {
    const human = room.players.find((p) => !p.isBot);
    const bot = room.players.find((p) => p.isBot);
    drawer = room.round % 2 === 1 ? human : bot; // 奇数轮人画，偶数轮机器人画
  } else {
    room.drawerIndex = (room.drawerIndex + 1) % room.players.length;
    drawer = room.players[room.drawerIndex];
  }
  room.drawerId = drawer.id;
  room.guessed = {};
  room.strokes = [];
  room.newWordUsed = false;
  room.botScheduled = false;

  // 选词：机器人作画时优先用有涂鸦的词，保证画得出来
  const picked = pickWord(room.solo && drawer.isBot);
  room.word = picked.w;
  room.wordCategory = picked.c;
  room.timeLeft = ROUND_SECONDS;

  io.to(room.code).emit("clear");
  io.to(room.code).emit("roundStart", {
    drawerName: drawer.name,
    round: room.round,
    totalRounds: room.totalRounds,
    category: picked.c,
    wordLen: room.word.length
  });
  io.to(drawer.id).emit("yourWord", { word: room.word });
  // 关键：把各自视角的状态（含 isDrawer / 词可见性）推送给每个人，
  // 否则客户端 me.isDrawer 一直为 false，画手会“画不了”。
  broadcastState(room);

  // 仅测试模式：把词透传给唯一人类玩家，便于自动化校验"机器人画、人猜"的计分
  if (process.env.TEST_MODE && room.solo && drawer.isBot) {
    const human = room.players.find((p) => !p.isBot);
    if (human) io.to(human.id).emit("debugWord", { word: room.word });
  }

  // 单人模式提示当前是谁画
  if (room.solo) {
    const human = room.players.find((p) => !p.isBot);
    const bot = room.players.find((p) => p.isBot);
    if (drawer.id === human.id) {
      systemChat(room, `单人模式：这一轮你画，🤖 ${bot.name} 来猜！`);
    } else {
      systemChat(room, `单人模式：这一轮 🤖 ${bot.name} 来画，你来猜！`);
      scheduleBotDrawing(room); // 机器人开始作画
    }
  }

  clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    io.to(room.code).emit("tick", { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      endRound(room, "timeout");
    }
  }, 1000);
}

function endRound(room, reason) {
  if (room.phase === "reveal" || room.phase === "over") return;
  clearInterval(room.timer);
  clearBotTimers(room);
  room.phase = "reveal";
  chat(room, "系统", `答案：「${room.word}」（${room.wordCategory}）`, "reveal");
  io.to(room.code).emit("roundEnd", {
    word: room.word,
    category: room.wordCategory,
    reason
  });

  setTimeout(() => {
    if (room.round >= room.totalRounds) {
      endGame(room);
    } else {
      startRound(room);
    }
  }, REVEAL_SECONDS * 1000);
}

function endGame(room) {
  clearInterval(room.timer);
  clearBotTimers(room);
  room.phase = "over";
  room.started = false;
  const ranking = [...room.players].sort((a, b) => b.score - a.score);
  io.to(room.code).emit("gameOver", { players: ranking });
  systemChat(room, "游戏结束！点击「再来一局」可重新开始。");
}

function checkGuess(room, player, text) {
  if (!room.word) return;
  if (player.id === room.drawerId) return; // 画手不参与猜
  if (room.guessed[player.id]) return;     // 已猜对
  const norm = (s) => s.replace(/\s+/g, "").toLowerCase();
  if (norm(text) === norm(room.word)) {
    room.guessed[player.id] = true;
    player.correct = true;
    player.score += 100;
    room.players.find((p) => p.id === room.drawerId).score += 50;
    chat(room, player.name, "猜对了！🎉", "correct");
    broadcastState(room);
    // 是否所有人都猜对了
    const others = room.players.filter((p) => p.id !== room.drawerId);
    if (others.length > 0 && others.every((p) => room.guessed[p.id])) {
      endRound(room, "all");
    }
  }
}

// ---- Socket 连接 ----
io.on("connection", (socket) => {
  let roomCode = null;

  socket.on("createRoom", ({ name, botPersonality, mode }) => {
    const code = genCode();
    rooms[code] = makeRoom(code);
    // 模式：solo=单人模式（机器人出现）/ multi=多人模式（绝不出现机器人）
    rooms[code].solo = mode === "solo";
    if (botPersonality === "instant" || botPersonality === "chatty") {
      rooms[code].botPersonality = botPersonality;
    }
    joinRoom(socket, code, name);
  });

  socket.on("joinRoom", ({ name, code }) => {
    const c = String(code || "").trim();
    if (!rooms[c]) {
      socket.emit("errorMsg", { text: "房间不存在，请确认房间号。" });
      return;
    }
    if (rooms[c].started && rooms[c].phase !== "lobby") {
      // 允许中途加入（观战/下一局加入），但本局不参与
      socket.emit("errorMsg", { text: "本局正在进行，可稍后加入或等下一局。" });
      return;
    }
    joinRoom(socket, c, name);
  });

  function joinRoom(sock, code, rawName) {
    const room = rooms[code];
    const name = String(rawName || "玩家").trim().slice(0, 12) || "玩家";
    sock.join(code);
    roomCode = code;
    sock.data.name = name;
    const player = {
      id: sock.id,
      name,
      score: 0,
      correct: false,
      guessed: false
    };
    room.players.push(player);
    if (!room.hostId) room.hostId = sock.id;
    chat(room, name, "加入了房间", "join");
    broadcastState(room);
  }

  socket.on("startGame", ({ rounds }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;
    if (room.players.length < 1) {
      socket.emit("errorMsg", { text: "请至少先加入 1 名玩家。" });
      return;
    }
    // 单人模式：加入机器人（你画它猜 / 它画你猜 轮换）。多人模式绝不添加机器人。
    if (room.solo) {
      const bot = addBot(room);
      systemChat(room, `单人模式：已加入机器人 ${bot.name}，你们轮流作画与猜词！`);
    }
    const r = parseInt(rounds, 10);
    room.totalRounds = r > 0 && r <= 20 ? r : room.players.length; // 默认每人画一次
    room.started = true;
    room.drawerIndex = -1;
    room.round = 0;
    room.players.forEach((p) => (p.score = 0));
    startRound(room);
  });

  socket.on("draw", (data) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.drawerId) return;
    // 单人模式：画手开始作画后，安排机器人陪猜
    if (room.solo && !room.botScheduled) {
      room.botScheduled = true;
      scheduleBot(room);
    }
    const seg = {
      from: data.from,
      to: data.to,
      color: data.color,
      size: data.size
    };
    room.strokes.push(seg);
    socket.to(roomCode).emit("draw", seg);
  });

  socket.on("clear", () => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.drawerId) return;
    room.strokes = [];
    socket.to(roomCode).emit("clear");
  });

  socket.on("newWord", () => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.drawerId || room.newWordUsed) return;
    room.newWordUsed = true;
    room.botScheduled = false;
    clearBotTimers(room);
    const picked = pickWord();
    room.word = picked.w;
    room.wordCategory = picked.c;
    room.strokes = [];
    socket.to(roomCode).emit("clear");
    io.to(room.drawerId).emit("yourWord", { word: room.word });
    broadcastState(room);
    systemChat(room, "画手更换了词语。");
  });

  socket.on("guess", ({ text }) => {
    const room = rooms[roomCode];
    if (!room || !text) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    // 先当作聊天广播（非画手且未猜对时做判定）
    chat(room, player.name, text, "msg");
    checkGuess(room, player, text);
  });

  socket.on("restart", () => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;
    room.started = false;
    room.phase = "lobby";
    room.drawerId = null;
    room.word = null;
    room.round = 0;
    room.players.forEach((p) => (p.score = 0));
    room.strokes = [];
    clearBotTimers(room);
    io.to(roomCode).emit("clear");
    broadcastState(room);
  });

  // 房主解散房间：所有人被送回主页，房间删除
  socket.on("dissolveRoom", () => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;
    clearInterval(room.timer);
    clearBotTimers(room);
    io.to(room.code).emit("roomDissolved");
    delete rooms[roomCode];
  });

  // 玩家退出房间：自己回主页，房间继续（房主转移，单人模式删除房间）
  socket.on("leaveRoom", () => {
    const room = rooms[roomCode];
    if (!room) { socket.emit("youLeft"); return; }
    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx >= 0) {
      const [left] = room.players.splice(idx, 1);
      chat(room, left.name, "离开了房间", "join");
    }
    // 若只剩机器人或无人，直接删除房间
    const humans = room.players.filter((p) => !p.isBot);
    if (humans.length === 0) {
      clearInterval(room.timer);
      clearBotTimers(room);
      delete rooms[roomCode];
      socket.emit("youLeft");
      return;
    }
    // 房主离开则转移给第一个真人
    if (room.hostId === socket.id) {
      room.hostId = humans[0].id;
    }
    // 退出的是当前画手且正在游戏，结束本回合
    if (room.drawerId === socket.id && room.phase === "playing") {
      endRound(room, "drawerLeft");
    } else {
      broadcastState(room);
    }
    socket.emit("youLeft");
    roomCode = null;
  });

  socket.on("disconnect", () => {
    const room = rooms[roomCode];
    if (!room) return;
    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx >= 0) {
      const [left] = room.players.splice(idx, 1);
      chat(room, left.name, "离开了房间", "join");
    }
    if (room.players.length === 0) {
      clearInterval(room.timer);
      clearBotTimers(room);
      delete rooms[roomCode];
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
    }
    if (room.drawerId === socket.id && room.phase === "playing") {
      endRound(room, "drawerLeft");
    } else {
      broadcastState(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`你画我猜 已启动： http://localhost:${PORT}`);
});
