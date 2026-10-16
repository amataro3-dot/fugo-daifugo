import { db, ref, update, set } from "./firebase.js";
import {
  makeLot, shuffle, judge, hasNum, suitCheck, lockChoices,
  canSpe3, gekCan, gekFollow, isJoker, isFoulFinish
} from "./rules.js";
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
  updates["game"] = {
    round: 1, phase: "play", pot: 0, order: seatOrder, turn: seatOrder[0], rev: false
  };
  updates["meta/started"] = true;

  await update(ref(db, "rooms/" + roomId), updates);
}

export function sendAction(roomId, uid, act) {
  const key = Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  return set(ref(db, "rooms/" + roomId + "/actions/" + key), {
    uid,
    type: act.type,
    cards: act.cards || [],
    jsuits: act.jsuits || null,
    lock: act.lock || "none",
    gek: !!act.gek
  });
}

let curOut = {};

function nextPlayer(order, passed, idx) {
  const n = order.length;
  for (let i = 1; i <= n; i++) {
    const id = order[(idx + i) % n];
    if (!passed[id] && !curOut[id]) return id;
  }
  return null;
}

function note(text) {
  return { text, id: Date.now() };
}

function applyAction(room, act) {
  const g = room.game;
  if (!g || g.phase !== "play" || act.uid !== g.turn) return null;
  if (g.foul || g.clear) return null;
  const uid = act.uid;
  curOut = g.out || {};
  const order = g.order;
  const idx = order.indexOf(uid);
  const rev = !!g.rev;
  const upd = {};

  if (act.type === "pass") {
    if (!g.field) return null;
    const passed = Object.assign({}, g.passed || {}, { [uid]: true });
    const next = nextPlayer(order, passed, idx);
    if (next === g.last || next === null) {
      const lp = room.players[g.last];
      upd["game/field"] = null;
      upd["game/passed"] = null;
      upd["game/rev"] = false;
      upd["game/lock"] = null;
      upd["game/turn"] = g.last;
      upd["game/notice"] = note(
        "全員パスで場が流れます\n" + (lp ? lp.name : "") + " さんから"
      );
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
    const field = g.field || null;
    const lockNow = g.lock || null;

    // スペ3返し
    if (canSpe3(field, lockNow, cards)) {
      const rest0 = hand.filter((c) => !cards.includes(c));
      upd["hands/" + uid] = rest0.length ? rest0 : null;
      upd["game/last"] = uid;
      upd["game/lock"] = null;
      upd["game/rev"] = false;
      upd["game/passed"] = null;
      if (rest0.length === 0) {
        upd["game/field"] = { cards, by: uid, count: 1, str: 3, suits: ["S"] };
        upd["game/phase"] = "result";
        upd["game/winner"] = uid;
        upd["game/turn"] = null;
     } else {
        upd["game/field"] = { cards, by: uid, count: 1, str: 3, suits: ["S"] };
        upd["game/clear"] = { id: Date.now(), turn: uid };
        upd["game/turn"] = null;
        upd["game/notice"] = note("スペ3返し!");
      }
      return upd;
    }

    const j = judge(cards, field, rev);
    if (!j.ok) return null;
    const sc = suitCheck(cards, act.jsuits || null, lockNow);
    if (!sc.ok) return null;

    // 激しばり中は、同じマークの次の数字だけ(ジョーカー単体は例外)
    const jokerSingle = cards.length === 1 && isJoker(cards[0]);
    if (lockNow && lockNow.gek && !jokerSingle) {
      if (!gekFollow(field, sc.suits, j.str, rev)) return null;
    }

        // 禁止上がり(反則負け)
    if (isFoulFinish(cards, hand, rev)) {
      const me = room.players[uid];
      const nm = (me ? me.name : "") + " さん反則負け!";
      const outNow = Object.assign({}, g.out || {}, { [uid]: true });
      upd["hands/" + uid] = null;
      upd["game/out/" + uid] = true;
      const alive = order.filter((id) => !outNow[id]);
      if (alive.length === 0) {
        upd["game/phase"] = "result";
        upd["game/winner"] = null;
        upd["game/turn"] = null;
        upd["game/notice"] = note(nm + "\nノーゲーム");
        return upd;
      }
      curOut = outNow;
      upd["game/foul"] = { id: Date.now(), name: me ? me.name : "", cards, acks: {} };
      upd["game/field"] = g.field || null;
      const next = nextPlayer(order, g.passed || {}, idx);
      if (field && (next === null || next === g.last)) {
        upd["game/field"] = null;
        upd["game/passed"] = null;
        upd["game/rev"] = false;
        upd["game/lock"] = null;
        upd["game/turn"] = g.last;
        upd["game/notice"] = note(nm + "\n場が流れます");
      } else {
        upd["game/turn"] = next;
        if (!field) upd["game/last"] = next;
        upd["game/notice"] = note(nm);
      }
      return upd;
    }

    let newLock = lockNow;
    const msgs = [];
    if (!lockNow && act.lock && act.lock !== "none") {
      const ch = lockChoices(field, sc.suits, cards.length);
      if (ch.includes(act.lock)) {
        newLock = { mode: act.lock, suits: sc.suits };
        msgs.push(act.lock === "both" ? "両しば!" : "しばり!");
      }
    }
    if (act.gek && newLock && !newLock.gek) {
        if (gekCan(field, lockNow, sc.suits, j.str, cards.length, rev, lockNow ? lockNow.mode : act.lock)) {
        newLock = { mode: newLock.mode, suits: newLock.suits, gek: true };
        msgs.length = 0;
        msgs.push("激しばり!");
      }
    }

    const rest = hand.filter((c) => !cards.includes(c));
    const eight = hasNum(cards, 8);
    const jack = hasNum(cards, 11);
    const newRev = jack ? true : rev;
    const fieldObj = { cards, by: uid, count: cards.length, str: j.str, suits: sc.suits };

    upd["hands/" + uid] = rest.length ? rest : null;
    upd["game/last"] = uid;

    if (rest.length === 0) {
      upd["game/field"] = fieldObj;
      upd["game/lock"] = null;
      upd["game/phase"] = "result";
      upd["game/winner"] = uid;
      upd["game/turn"] = null;
    } else if (eight) {
      upd["game/field"] = fieldObj;
      upd["game/clear"] = { id: Date.now(), turn: uid };
      upd["game/turn"] = null;
      upd["game/notice"] = note("8切り!");
    } else {
      upd["game/field"] = fieldObj;
      upd["game/rev"] = newRev;
      upd["game/lock"] = newLock;
      upd["game/turn"] = nextPlayer(order, g.passed || {}, idx);
      if (jack && !rev) msgs.push("11バック!");
      if (msgs.length) upd["game/notice"] = note(msgs.join("\n"));
    }
    return upd;
  }
  return null;
}

let busy = false;
export function sendAck(roomId, uid) {
  return set(ref(db, "rooms/" + roomId + "/game/foul/acks/" + uid), true);
}

export async function checkFoulAcks(roomId, getRoom) {
  const room = getRoom();
  const f = room && room.game && room.game.foul;
  if (!f) return;
  const acks = f.acks || {};
  const need = Object.entries(room.players || {})
    .filter(([id, p]) => !p.cpu && !p.spectator && p.online !== false && (room.game.order || []).includes(id))
    .map(([id]) => id);
  if (need.every((id) => acks[id])) {
    await update(ref(db, "rooms/" + roomId + "/game"), { foul: null });
  }
}

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

let cpuTimer = null;
export function maybeCpu(roomId, getRoom) {
  if (cpuTimer) return;
  const room = getRoom();
  const g = room && room.game;
  if (!g || g.phase !== "play" || room.actions || g.foul) return;
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
    const a = cpuChoose(hand, r.game.field || null, !!r.game.rev, r.game.lock || null);
    sendAction(roomId, turn, a);
  }, 1500);
          }
let cpuTimer = null;
export function maybeCpu(roomId, getRoom) {
  if (cpuTimer) return;
  const room = getRoom();
  const g = room && room.game;
  if (!g || g.phase !== "play" || room.actions || g.foul || g.clear) return;
  const p = room.players && room.players[g.turn];
  if (!p || !p.cpu) return;
  const turn = g.turn;
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    const r = getRoom();
    if (!r || !r.game) return;
    const gg = r.game;
    if (gg.phase !== "play" || gg.turn !== turn || gg.foul || gg.clear || r.actions) {
      maybeCpu(roomId, getRoom);
      return;
    }
    const hand = (r.hands && r.hands[turn]) || [];
    const a = cpuChoose(hand, gg.field || null, !!gg.rev, gg.lock || null);
    sendAction(roomId, turn, a);
  }, 1500);
}

let clearTimer = null;
export function checkClear(roomId, getRoom) {
  if (clearTimer) return;
  const room = getRoom();
  const g = room && room.game;
  if (!g || !g.clear || g.phase !== "play") return;
  const c = g.clear;
  clearTimer = setTimeout(async () => {
    clearTimer = null;
    const r = getRoom();
    if (!r || !r.game || !r.game.clear || r.game.clear.id !== c.id) return;
    await update(ref(db, "rooms/" + roomId + "/game"), {
      field: null,
      passed: null,
      rev: false,
      lock: null,
      clear: null,
      turn: c.turn
    });
  }, 1500);
}
