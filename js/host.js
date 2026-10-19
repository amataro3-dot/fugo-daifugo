import { db, ref, update, set } from "./firebase.js";
import {
  makeLot, shuffle, judge, hasNum, suitCheck, lockChoices,
  canSpe3, gekCan, gekFollow, isJoker, isFoulFinish
} from "./rules.js";
import { cpuChoose, cpuChange, cpuBid, cpuRaise } from "./cpu.js";

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

function note(text) {
  return { text, id: Date.now() };
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
  // 配札のあとは、カードチェンジから(1ラウンド目は席順の先頭=ランダム)
  updates["game"] = {
    round: 1, phase: "change", pot: 0, order: seatOrder, turn: seatOrder[0], rev: false
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
    lockSuit: act.lockSuit || null,
    gek: !!act.gek,
    n: act.n || 0
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

// ===== カードチェンジ =====

// 次にチェンジできる人をさがす(パス済み・3回済み・コイン不足の人は飛ばす)
function pickChanger(order, fromIdx, counts, done, coins) {
  const n = order.length;
  for (let i = 1; i <= n; i++) {
    const id = order[(fromIdx + i) % n];
    const c = counts[id] || 0;
    if (!done[id] && c < 3 && (coins[id] || 0) >= Math.pow(2, c)) return id;
  }
  return null;
}

function applyChange(room, act) {
  const g = room.game;
  const uid = act.uid;
  const order = g.order;
  const idx = order.indexOf(uid);
  const ch = g.change || {};
  const counts = Object.assign({}, ch.counts || {});
  const done = Object.assign({}, ch.done || {});
  const players = room.players || {};
  const coinsNow = {};
  order.forEach((id) => {
    coinsNow[id] = (players[id] && players[id].coins) || 0;
  });
  const cnt = counts[uid] || 0;
  const upd = {};
  const chUpd = {};
  let lotNote = "";

  if (act.type === "change") {
    const cost = Math.pow(2, cnt);
    if (cnt >= 3 || done[uid] || coinsNow[uid] < cost) return null;
    const hand = (room.hands && room.hands[uid]) || [];
    const card = (act.cards || [])[0];
    if (!card || !hand.includes(card)) return null;
    const state = { deck: (room.deck || []).slice(), lot: room.lot || 1, notice: "" };
    const nc = draw(state, 1)[0];
    upd["hands/" + uid] = hand.filter((c) => c !== card).concat([nc]);
    upd["deck"] = state.deck.length ? state.deck : null;
    upd["lot"] = state.lot;
    coinsNow[uid] -= cost;
    upd["players/" + uid + "/coins"] = coinsNow[uid];
    upd["game/pot"] = (g.pot || 0) + cost;
    counts[uid] = cnt + 1;
    chUpd["game/change/counts/" + uid] = cnt + 1;
    lotNote = state.notice;
  } else if (act.type === "cpass") {
    done[uid] = true;
    chUpd["game/change/done/" + uid] = true;
  } else {
    return null;
  }

  const next = pickChanger(order, idx, counts, done, coinsNow);
  if (next) {
    Object.assign(upd, chUpd);
    upd["game/turn"] = next;
    if (lotNote) upd["game/notice"] = note(lotNote);
  } else {
    // チェンジ終了 → 親決めのブラインドオークションへ
    upd["game/change"] = null;
    startBid(upd, order, coinsNow, players, lotNote);
  }
  return upd;
}

// ===== ブラインドオークション(親決め) =====
//
// game/bid の中身
//   stage: "blind"(伏せて入札中) / "open"(一斉公開を見せている) / "raise"(同点の競り上げ中)
//   need:  入札する人(コインを1枚以上持っている人)
//   bids:  {人: 今までに出した合計枚数}
//   top:   いちばん高い枚数
//   parent: 親に決まった人(open のときだけ)
//   tied:  同点で競り上げる人(席順)
//   folded: {人: true} 競り上げで降りた人
//   id:    公開した時刻(公開を約3秒見せるため)

function nameOf(players, id) {
  return (players[id] && players[id].name) || "";
}

// 対戦スタート(親が決まった)
function goPlay(upd, parent, text) {
  upd["game/phase"] = "play";
  upd["game/turn"] = parent;
  upd["game/bid"] = null;
  upd["game/notice"] = note(text);
}

// チェンジのあとに呼ぶ。コインがある人だけ入札する
function startBid(upd, order, coinsNow, players, lotNote) {
  const head = lotNote ? lotNote + "\n" : "";
  const need = order.filter((id) => (coinsNow[id] || 0) >= 1);
  if (need.length === 0) {
    const p = order[0];
    goPlay(upd, p, head + "コインを持っている人がいないため\n" + nameOf(players, p) + " さんから");
    return;
  }
  upd["game/phase"] = "bid";
  upd["game/turn"] = null;
  upd["game/bid"] = { stage: "blind", need };
  upd["game/notice"] = note(head + "親決めオークション!\n賭ける枚数を選んでください");
}

// 競り上げで、次に聞く人をさがす(コインが足りない人は自動で降りる)
function raiseNext(bid, coins, startIdx, notes, players) {
  const tied = bid.tied;
  const folded = bid.folded;
  for (let k = 0; k < tied.length; k++) {
    const alive = tied.filter((id) => !folded[id]);
    if (alive.length <= 1) return { parent: alive[0] };
    const id = tied[(startIdx + k) % tied.length];
    if (folded[id]) continue;
    const need = bid.top + 1 - (bid.bids[id] || 0);
    if ((coins[id] || 0) >= need) return { turn: id };
    folded[id] = true;
    notes.push(nameOf(players, id) + " さんはコイン不足で降りました");
  }
  const alive = tied.filter((id) => !folded[id]);
  return { parent: alive[0] };
}

function applyBid(room, act) {
  const g = room.game;
  const b = g.bid;
  if (!b) return null;
  const uid = act.uid;
  const players = room.players || {};
  const coins = {};
  (g.order || []).forEach((id) => {
    coins[id] = (players[id] && players[id].coins) || 0;
  });
  const need = b.need || [];
  const bids = Object.assign({}, b.bids || {});
  const max = (room.settings && room.settings.bidMax) || 5;
  const upd = {};

  // --- 伏せて入札 ---
  if (b.stage === "blind") {
    if (act.type !== "bid") return null;
    if (!need.includes(uid) || bids[uid]) return null;
    const n = Math.floor(Number(act.n) || 0);
    if (n < 1 || n > Math.min(max, coins[uid])) return null;
    bids[uid] = n;
    if (!need.every((id) => bids[id])) {
      upd["game/bid/bids/" + uid] = n;
      return upd;
    }
    // 全員そろった → 一斉公開。コインをポットへ
    let sum = 0;
    need.forEach((id) => {
      sum += bids[id];
      upd["players/" + id + "/coins"] = coins[id] - bids[id];
    });
    upd["game/pot"] = (g.pot || 0) + sum;
    const top = Math.max(...need.map((id) => bids[id]));
    const tops = need.filter((id) => bids[id] === top);
    const nb = { stage: "open", need, bids, top, id: Date.now() };
    if (tops.length === 1) nb.parent = tops[0];
    else nb.tied = tops;
    upd["game/bid"] = nb;
    upd["game/notice"] = note("一斉公開!");
    return upd;
  }

  // --- 同点の競り上げ ---
  if (b.stage === "raise") {
    if (uid !== g.turn) return null;
    const nb = {
      stage: "raise", need, bids, top: b.top,
      tied: (b.tied || []).slice(), folded: Object.assign({}, b.folded || {})
    };
    const idx = nb.tied.indexOf(uid);
    const notes = [];
    if (act.type === "raise") {
      const pay = nb.top + 1 - (bids[uid] || 0);
      if (coins[uid] < pay) return null;
      coins[uid] -= pay;
      bids[uid] = nb.top + 1;
      nb.top += 1;
      upd["players/" + uid + "/coins"] = coins[uid];
      upd["game/pot"] = (g.pot || 0) + pay;
      notes.push(nameOf(players, uid) + " さん上乗せ → " + nb.top + "枚");
    } else if (act.type === "fold") {
      nb.folded[uid] = true;
      notes.push(nameOf(players, uid) + " さんは降りました");
    } else {
      return null;
    }
    const r = raiseNext(nb, coins, idx + 1, notes, players);
    if (r.parent) {
      goPlay(upd, r.parent,
        notes.join("\n") + "\n" + nameOf(players, r.parent) + " さんが親!(" + bids[r.parent] + "枚)");
      return upd;
    }
    if (!Object.keys(nb.folded).length) delete nb.folded;
    upd["game/bid"] = nb;
    upd["game/turn"] = r.turn;
    upd["game/notice"] = note(notes.join("\n"));
    return upd;
  }
  return null;
}

// 一斉公開を約3秒見せてから、親を決める or 競り上げへ(ホストだけが呼ぶ)
let bidTimer = null;
export function checkBid(roomId, getRoom) {
  if (bidTimer) return;
  const room = getRoom();
  const g = room && room.game;
  if (!g || g.phase !== "bid" || !g.bid || g.bid.stage !== "open") return;
  const openId = g.bid.id;
  bidTimer = setTimeout(async () => {
    bidTimer = null;
    const r = getRoom();
    const gg = r && r.game;
    if (!gg || gg.phase !== "bid" || !gg.bid || gg.bid.stage !== "open" || gg.bid.id !== openId) return;
    const b = gg.bid;
    const players = r.players || {};
    const upd = {};
    if (b.parent) {
      goPlay(upd, b.parent, nameOf(players, b.parent) + " さんが親!\n" + nameOf(players, b.parent) + " さんから");
    } else {
      const coins = {};
      gg.order.forEach((id) => {
        coins[id] = (players[id] && players[id].coins) || 0;
      });
      const tied = b.tied || [];
      if (!tied.some((id) => coins[id] >= 1)) {
        // 同点の全員がコイン不足 → 抽選
        const p = tied[Math.floor(Math.random() * tied.length)];
        goPlay(upd, p, "同点の全員がコイン不足のため\n抽選で " + nameOf(players, p) + " さんが親!");
      } else {
        const nb = { stage: "raise", need: b.need, bids: b.bids, top: b.top, tied: tied.slice(), folded: {} };
        const notes = [];
        const res = raiseNext(nb, coins, 0, notes, players);
        if (res.parent) {
          goPlay(upd, res.parent, notes.join("\n") + "\n" + nameOf(players, res.parent) + " さんが親!");
        } else {
          if (!Object.keys(nb.folded).length) delete nb.folded;
          upd["game/bid"] = nb;
          upd["game/turn"] = res.turn;
          upd["game/notice"] = note(
            (notes.length ? notes.join("\n") + "\n" : "") +
            "同点!競り上げ(" + b.top + "枚から)\n1枚ずつ上乗せ。降りた人の負け"
          );
        }
      }
    }
    await update(ref(db, "rooms/" + roomId), upd);
  }, 3000);
}

function applyAction(room, act) {
  const g = room.game;
  if (!g) return null;
  if (g.phase === "bid") return applyBid(room, act);
  if (act.uid !== g.turn) return null;
  if (g.phase === "change") return applyChange(room, act);
  if (g.phase !== "play") return null;
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
      upd["game/passed"] = null;
      if (rest0.length === 0) {
        upd["game/field"] = { cards, by: uid, count: 1, str: 3, suits: ["S"] };
        upd["game/lock"] = null;
        upd["game/rev"] = false;
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
    if (act.lock && act.lock !== "none") {
      const ch = lockChoices(field, sc.suits, cards.length);
      const pair = cards.length === 2;
      if (!lockNow && ch.includes(act.lock)) {
        if (act.lock === "both") {
          newLock = { mode: "both", suits: sc.suits, pair: true };
          msgs.push("両しばり!");
        } else if (!pair) {
          newLock = { mode: "one", suits: sc.suits };
          msgs.push("しばり!");
        } else {
          // 片しば: 前の札と同じマークのうち、1つだけ
          const common = sc.suits.filter((s) => field.suits.includes(s));
          const s = common.includes(act.lockSuit) ? act.lockSuit : common[0];
          newLock = { mode: "one", suits: [s], pair: true };
          msgs.push("片しば!");
        }
      } else if (
        lockNow && !lockNow.gek && lockNow.mode === "one" && pair &&
        act.lock === "both" && ch.includes("both")
      ) {
        // 片しばの場で、もう片方もしばる → 両しば
        newLock = { mode: "both", suits: sc.suits, pair: true };
        msgs.push("両しばり!");
      }
    }
    if (act.gek && newLock && !newLock.gek) {
      if (gekCan(field, lockNow, sc.suits, j.str, cards.length, rev, newLock.mode)) {
        newLock = Object.assign({}, newLock, { gek: true });
        msgs.length = 0;
        msgs.push("激しばり!");
      }
    }

    const rest = hand.filter((c) => !cards.includes(c));
    const eight = hasNum(cards, 8);
    const jack = hasNum(cards, 11);
    const newRev = jack ? true : rev;
    const fieldObj = { cards, by: uid, count: cards.length, str: j.str, suits: sc.suits };
    if (cards.length >= 2 && cards.some(isJoker) && act.jsuits) fieldObj.jsuits = act.jsuits;

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
  if (!g || room.actions || g.foul || g.clear) return;
  if (g.phase === "bid") return maybeCpuBid(roomId, getRoom);
  if (g.phase !== "play" && g.phase !== "change") return;
  const p = room.players && room.players[g.turn];
  if (!p || !p.cpu) return;
  const turn = g.turn;
  const phase = g.phase;
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    const r = getRoom();
    if (!r || !r.game) return;
    const gg = r.game;
    if (gg.phase !== phase || gg.turn !== turn || gg.foul || gg.clear || r.actions) {
      maybeCpu(roomId, getRoom);
      return;
    }
    const hand = (r.hands && r.hands[turn]) || [];
    if (phase === "change") {
      const cnt = ((gg.change && gg.change.counts) || {})[turn] || 0;
      const coins = (r.players[turn] && r.players[turn].coins) || 0;
      sendAction(roomId, turn, cpuChange(hand, cnt, coins));
      return;
    }
    const a = cpuChoose(hand, gg.field || null, !!gg.rev, gg.lock || null);
    sendAction(roomId, turn, a);
  }, 1500);
}

// コンピューターの入札(伏せ入札は1人ずつ、競り上げは自分の番に)
function maybeCpuBid(roomId, getRoom) {
  const room = getRoom();
  const g = room.game;
  const b = g.bid;
  if (!b) return;
  let who = null;
  if (b.stage === "blind") {
    const bids = b.bids || {};
    who = (b.need || []).find((id) => !bids[id] && room.players[id] && room.players[id].cpu) || null;
  } else if (b.stage === "raise") {
    const p = room.players[g.turn];
    if (p && p.cpu) who = g.turn;
  }
  if (!who) return;
  const stage = b.stage;
  const top = b.top;
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    const r = getRoom();
    const gg = r && r.game;
    if (!gg || gg.phase !== "bid" || !gg.bid || gg.bid.stage !== stage || r.actions) {
      maybeCpu(roomId, getRoom);
      return;
    }
    const hand = (r.hands && r.hands[who]) || [];
    const coins = (r.players[who] && r.players[who].coins) || 0;
    if (stage === "blind") {
      if ((gg.bid.bids || {})[who]) return maybeCpu(roomId, getRoom);
      const max = (r.settings && r.settings.bidMax) || 5;
      sendAction(roomId, who, { type: "bid", n: cpuBid(hand, coins, max) });
    } else {
      if (gg.turn !== who || gg.bid.top !== top) return maybeCpu(roomId, getRoom);
      const pay = gg.bid.top + 1 - ((gg.bid.bids || {})[who] || 0);
      sendAction(roomId, who, { type: cpuRaise(hand, coins, pay) ? "raise" : "fold" });
    }
  }, stage === "blind" ? 800 : 1500);
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

// ===== 精算・リザルト・次ラウンド・最終順位 =====

let settling = false;
export async function settle(roomId, getRoom) {
  if (settling) return;
  const room = getRoom();
  const g = room && room.game;
  if (!g || g.phase !== "result" || g.result) return;
  settling = true;
  try {
    const players = room.players || {};
    const pot = g.pot || 0;
    const winner = g.winner || null;
    const upd = {};
    const coinsAfter = {};
    g.order.forEach((id) => {
      coinsAfter[id] = (players[id] && players[id].coins) || 0;
    });
    if (winner) {
      coinsAfter[winner] += pot;
      upd["players/" + winner + "/coins"] = coinsAfter[winner];
    }
    const outIds = g.order.filter((id) => coinsAfter[id] <= 0);
    const remaining = g.order.filter((id) => coinsAfter[id] > 0);
    const last = remaining.length <= 1 || g.round >= room.settings.rounds;
    const result = {
      gain: winner ? pot : 0,
      carry: winner ? 0 : pot,
      last,
      acks: {}
    };
    if (winner) result.winner = winner;
    if (outIds.length) result.outIds = outIds;
    upd["game/pot"] = winner ? 0 : pot;
    upd["game/result"] = result;
    await update(ref(db, "rooms/" + roomId), upd);
  } finally {
    settling = false;
  }
}

export function sendResultAck(roomId, uid) {
  return set(ref(db, "rooms/" + roomId + "/game/result/acks/" + uid), true);
}

let advancing = false;
export async function checkResultAcks(roomId, getRoom) {
  if (advancing) return;
  const room = getRoom();
  const g = room && room.game;
  if (!g || g.phase !== "result" || !g.result) return;
  const acks = g.result.acks || {};
  const need = Object.entries(room.players || {})
    .filter(([id, p]) => !p.cpu && !p.spectator && p.online !== false && (g.order || []).includes(id))
    .map(([id]) => id);
  if (!need.every((id) => acks[id])) return;
  advancing = true;
  try {
    await nextRound(roomId, room);
  } finally {
    advancing = false;
  }
}

function rankList(list, keyFn, startRank, desc) {
  const sorted = list.slice().sort((a, b) => (desc ? keyFn(b) - keyFn(a) : keyFn(a) - keyFn(b)));
  sorted.forEach((x, i) => {
    if (i > 0 && keyFn(x) === keyFn(sorted[i - 1])) x.rank = sorted[i - 1].rank;
    else x.rank = startRank + i;
  });
  return sorted;
}

async function nextRound(roomId, room) {
  const g = room.game;
  const players = room.players || {};
  const rr = g.round;
  const upd = {};

  const exit = {};
  Object.entries(players).forEach(([id, p]) => {
    if (p.exitRound) exit[id] = p.exitRound;
  });
  g.order.forEach((id) => {
    const c = (players[id] && players[id].coins) || 0;
    if (c <= 0) {
      exit[id] = rr;
      upd["players/" + id + "/exitRound"] = rr;
      upd["players/" + id + "/spectator"] = true;
    }
  });
  const remaining = g.order.filter((id) => !exit[id]);
  const last = remaining.length <= 1 || rr >= room.settings.rounds;

  if (last) {
    const all = Object.entries(players)
      .filter(([, p]) => p.coins !== undefined)
      .map(([id, p]) => ({
        id,
        name: p.name,
        coins: p.coins || 0,
        debtTotal: p.debtTotal || 0,
        score: (p.coins || 0) - (p.debtTotal || 0),
        exitRound: exit[id] || 0
      }));
    const alive = all.filter((x) => !x.exitRound);
    const gone = all.filter((x) => x.exitRound);
    const a = rankList(alive, (x) => x.score, 1, true);
    const b = rankList(gone, (x) => x.exitRound, a.length + 1, true);
    const ranking = a.concat(b).map((x) => {
      const o = { id: x.id, name: x.name, coins: x.coins, debtTotal: x.debtTotal, score: x.score, rank: x.rank };
      if (x.exitRound) o.exitRound = x.exitRound;
      return o;
    });
    upd["game"] = { round: rr, phase: "final", pot: g.pot || 0, order: g.order, ranking };
    await update(ref(db, "rooms/" + roomId), upd);
    return;
  }

  let newOrder = remaining.slice();
  const wi = g.result && g.result.winner ? newOrder.indexOf(g.result.winner) : -1;
  if (wi > 0) newOrder = newOrder.slice(wi).concat(newOrder.slice(0, wi));

  const state = { deck: (room.deck || []).slice(), lot: room.lot || 1, notice: "" };
  Object.keys(room.hands || {}).forEach((id) => {
    upd["hands/" + id] = null;
  });
  newOrder.forEach((id) => {
    upd["hands/" + id] = draw(state, 3);
  });
  upd["deck"] = state.deck.length ? state.deck : null;
  upd["lot"] = state.lot;
  const game = {
    round: rr + 1, phase: "change", pot: g.pot || 0,
    order: newOrder, turn: newOrder[0], rev: false
  };
  if (state.notice) game.notice = note(state.notice);
  upd["game"] = game;
  await update(ref(db, "rooms/" + roomId), upd);
}

export async function backToLobby(roomId, room) {
  const upd = {
    game: null, hands: null, deck: null, lot: null, actions: null,
    "meta/started": false
  };
  Object.entries((room && room.players) || {}).forEach(([id, p]) => {
    if (p.cpu) {
      upd["players/" + id] = null;
      return;
    }
    upd["players/" + id + "/spectator"] = false;
    upd["players/" + id + "/ready"] = false;
    upd["players/" + id + "/coins"] = null;
    upd["players/" + id + "/debt"] = null;
    upd["players/" + id + "/debtTotal"] = null;
    upd["players/" + id + "/seat"] = null;
    upd["players/" + id + "/exitRound"] = null;
  });
  await update(ref(db, "rooms/" + roomId), upd);
}
