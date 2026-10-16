import { db, ref, update, set } from "./firebase.js";
import { makeLot, shuffle, judge } from "./rules.js";
import { cpuChoose } from "./cpu.js";

function draw(state, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!state.deck || state.deck.length === 0) {
      state.deck = shuffle(makeLot());
      state.lot = (state.lot || 0) + 1;
      state.notice = "次のロットを使用します";
    }
    out.push(state.deck.shift());
  }
  return out;
}

export async function startGame(roomId, roomData) {
  const settings = roomData.settings;
  const players = roomData.players || {};

  const humans = Object.entries(players)
    .filter(([, p]) => !p.spectator)
    .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
    .map(([id]) => id);

  const limit = settings.players;
  const playing = humans.slice(0, limit);
  const watchers = humans.slice(limit);

  const cpus = [];
  for (let i = playing.length; i < limit; i++) cpus.push("cpu" + (i + 1));

  const seatOrder = shuffle(playing.concat(cpus));
  const state = { deck: shuffle(makeLot()), lot: 1, notice: "" };
  const updates = {};

  seatOrder.forEach((id, i) => {
    const isCpu = id.startsWith("cpu");
    const hand = draw(state, 3);
    updates["hands/" + id] = hand;
    if (isCpu) {
      updates["players/" + id] = {
        name: "CPU" + (i + 1), cpu: true, coins: settings.coins,
        debt: 0, debtTotal: 0, seat: i, ready: true,
        joinedAt: Date.now() + i, spectator: false, online: true
      };
    } else {
      updates["players/" + id + "/coins"] = settings.coins;
      updates["players/" + id + "/debt"] = 0;
      updates["players/" + id + "/debtTotal"] = 0;
      updates["players/" + id + "/seat"] = i;
    }
  });
  watchers.forEach((id) => {
    updates["players/" + id + "/spectator"] = true;
  });

  updates["deck"] = state.deck;
  updates["lot"] = state.lot;
  // 今はテスト用に、席の先頭の人が親(あとでオークションで決める)
  updates["game"] = {
    round: 1, phase: "play", pot: 0, order: seatOrder, turn: seatOrder[0]
  };
  updates["meta/started"] = true;

  await update(ref(db, "rooms/" + roomId), updates);
}

// 操作を「受付箱」に書く(全員が使う)
export function sendAction(roomId, uid, act) {
  const key = Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  return set(ref(db, "rooms/" + roomId + "/actions/" + key), {
    uid, type: act.type, cards: act.cards || []
  });
}

function nextPlayer(order, passed, idx) {
  const n = order.length;
  for (let i = 1; i <= n; i++) {
    const id = order[(idx + i) % n];
    if (!passed[id]) return id;
  }
  return null;
}

// 1つの操作をルールで確認して、更新内容を作る
function applyAction(room, act) {
  const g = room.game;
  if (!g || g.phase !== "play" || act.uid !== g.turn) return null;
  const uid = act.uid;
  const order = g.order;
  const idx = order.indexOf(uid);
  const upd = {};

  if (act.type === "pass") {
    if (!g.field) return null;
    const passed = Object.assign({}, g.passed || {}, { [uid]: true });
    const next = nextPlayer(order, passed, idx);
    if (next === g.last) {
      upd["game/field"] = null;
      upd["game/passed"] = null;
      upd["game/turn"] = g.last;
    } else {
      upd["game/passed"] = passed;
      upd["game/turn"] = next;
    }
    return upd;
  }

  if (act.type === "play") {
    const hand = (room.hands && room.hands[uid]) || [];
    const cards = act.cards || [];
    if (new Set(cards).size !== cards.length) return null;
    if (!cards.every((c) => hand.includes(c))) return null;
    const j = judge(cards, g.field || null);
    if (!j.ok) return null;
    const rest = hand.filter((c) => !cards.includes(c));
    upd["hands/" + uid] = rest.length ? rest : null;
    upd["game/field"] = { cards, by: uid, count: cards.length, str: j.str };
    upd["game/last"] = uid;
    if (rest.length === 0) {
      upd["game/phase"] = "result";
      upd["game/winner"] = uid;
      upd["game/turn"] = null;
    } else {
      upd["game/turn"] = nextPlayer(order, g.passed || {}, idx);
    }
    return upd;
  }
  return null;
}

// ホストだけが呼ぶ: 受付箱の操作を順番に処理する
let busy = false;
export async function processActions(roomId, getRoom) {
  if (busy) return;
  busy = true;
  try {
    for (let guard = 0; guard < 50; guard++) {
      const room = getRoom();
      if (!room || !room.actions) break;
      const key = Object.keys(room.actions).sort()[0];
      const act = room.actions[key];
      const upd = applyAction(room, act) || {};
      upd["actions/" + key] = null;
      await update(ref(db, "rooms/" + roomId), upd);
    }
  } finally {
    busy = false;
  }
}

// ホストだけが呼ぶ: コンピューターの手番なら、1.5秒待って出す
let cpuTimer = null;
export function maybeCpu(roomId, getRoom) {
  if (cpuTimer) return;
  const room = getRoom();
  const g = room && room.game;
  if (!g || g.phase !== "play" || room.actions) return;
  const p = room.players && room.players[g.turn];
  if (!p || !p.cpu) return;
  const turn = g.turn;
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    const r = getRoom();
    if (!r || !r.game || r.game.phase !== "play" || r.game.turn !== turn) {
      maybeCpu(roomId, getRoom);
      return;
    }
    const hand = (r.hands && r.hands[turn]) || [];
    sendAction(roomId, turn, cpuChoose(hand, r.game.field || null));
  }, 1500);
}
