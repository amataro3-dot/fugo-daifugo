import { db, ref, update, set } from "./firebase.js";
import {
  makeLot, shuffle, judge, hasNum, suitCheck, lockChoices,
  canSpe3, gekCan, gekFollow, isJoker, isFoulFinish
} from "./rules.js";
import { cpuChoose, cpuChange, cpuBid, cpuRaise, cpuSeatBid, cpuBorrowRaise } from "./cpu.js";

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

// ===== 借金ルール「富豪の神の手」の共通部分 =====

const GOD_FORCE_PARENT = "全員が神の手を借りてしまったため、\n最後に神に助けを求めた人から\nゲーム始めさせてもらいます。";
const GOD_FORCE_SEAT = "全員が神の手を借りてしまいましたので、\n最後に神に助けを求めた人から\n決めてください。";

// 神の手を借りられるか(借金ルールあり、かつ、このゲームでまだ使っていない)
function canBorrow(room, id) {
  const p = (room.players || {})[id];
  return !!(room.settings && room.settings.debt === "on" && p && !((p.debtTotal || 0) > 0));
}

// コインを払う。手持ちで足りない分は借金にする(コインはマイナスになる)。借りた枚数を返す
function payCoins(upd, room, id, coins, pay) {
  const p = (room.players || {})[id] || {};
  const before = coins[id] || 0;
  const borrowed = Math.max(0, pay - Math.max(before, 0));
  coins[id] = before - pay;
  upd["players/" + id + "/coins"] = coins[id];
  if (borrowed > 0) {
    upd["players/" + id + "/debt"] = (p.debt || 0) + borrowed;
    upd["players/" + id + "/debtTotal"] = (p.debtTotal || 0) + borrowed;
  }
  return borrowed;
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
    n: act.n || 0,
    borrow: !!act.borrow
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
// (コインが足りなくても、神の手を借りられる人は番が回る)
function pickChanger(order, fromIdx, counts, done, coins, canB) {
  const n = order.length;
  for (let i = 1; i <= n; i++) {
    const id = order[(fromIdx + i) % n];
    const c = counts[id] || 0;
    const have = coins[id] || 0;
    if (!done[id] && c < 3 && (have >= Math.pow(2, c) || (have >= 1 && canB(id)))) return id;
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
    if (cnt >= 3 || done[uid]) return null;
    if (coinsNow[uid] < cost && !(act.borrow && coinsNow[uid] >= 1 && canBorrow(room, uid))) return null;
    const hand = (room.hands && room.hands[uid]) || [];
    const card = (act.cards || [])[0];
    if (!card || !hand.includes(card)) return null;
    const state = { deck: (room.deck || []).slice(), lot: room.lot || 1, notice: "" };
    const nc = draw(state, 1)[0];
    upd["hands/" + uid] = hand.filter((c) => c !== card).concat([nc]);
    upd["deck"] = state.deck.length ? state.deck : null;
    upd["lot"] = state.lot;
    const borrowed = payCoins(upd, room, uid, coinsNow, cost);
    upd["game/pot"] = (g.pot || 0) + cost;
    const godNote = borrowed ? nameOf(players, uid) + " さんが神の手を借りました(借金" + borrowed + ")" : "";
    counts[uid] = cnt + 1;
    chUpd["game/change/counts/" + uid] = cnt + 1;
    lotNote = [godNote, state.notice].filter(Boolean).join("\n");
  } else if (act.type === "cpass") {
    done[uid] = true;
    chUpd["game/change/done/" + uid] = true;
  } else {
    return null;
  }

  const next = pickChanger(order, idx, counts, done, coinsNow, (id) => canBorrow(room, id));
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
  upd["game/parent"] = parent; // 次のラウンドの席決めで使う(前回の親)
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
// canB: 神の手を借りられるか。借りられる人・借金中の人は、自動では降りない
function raiseNext(bid, coins, startIdx, notes, players, canB) {
  const tied = bid.tied;
  const folded = bid.folded;
  const debtors = bid.debtors || {};
  for (let k = 0; k < tied.length; k++) {
    const alive = tied.filter((id) => !folded[id]);
    if (alive.length <= 1) return { parent: alive[0] };
    const id = tied[(startIdx + k) % tied.length];
    if (folded[id]) continue;
    const need = bid.top + 1 - (bid.bids[id] || 0);
    if ((coins[id] || 0) >= need || debtors[id] || (canB && canB(id))) return { turn: id };
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
      tied: (b.tied || []).slice(), folded: Object.assign({}, b.folded || {}),
      debtors: Object.assign({}, b.debtors || {})
    };
    const idx = nb.tied.indexOf(uid);
    const notes = [];
    const canB = (id) => canBorrow(room, id);
    if (act.type === "raise") {
      const pay = nb.top + 1 - (bids[uid] || 0);
      const isDebtor = !!nb.debtors[uid];
      const newBorrow = !isDebtor && coins[uid] < pay;
      if (newBorrow && !(act.borrow && canB(uid))) return null;
      const borrowed = payCoins(upd, room, uid, coins, pay);
      bids[uid] = nb.top + 1;
      nb.top += 1;
      upd["game/pot"] = (g.pot || 0) + pay;
      if (newBorrow) {
        nb.debtors[uid] = true;
        notes.push(nameOf(players, uid) + " さんが神の手を借りました!");
      }
      notes.push(nameOf(players, uid) + " さん上乗せ → " + nb.top + "枚" + (borrowed ? "(借金+" + borrowed + ")" : ""));
      // 強制終了: 競りに残っている全員が借金した → 最後に借りた人が親
      const alive = nb.tied.filter((id) => !nb.folded[id]);
      if (newBorrow && alive.every((id) => nb.debtors[id])) {
        goPlay(upd, uid, GOD_FORCE_PARENT + "\n" + nameOf(players, uid) + " さんが親!");
        return upd;
      }
    } else if (act.type === "fold") {
      nb.folded[uid] = true;
      notes.push(nameOf(players, uid) + " さんは降りました");
    } else {
      return null;
    }
    const r = raiseNext(nb, coins, idx + 1, notes, players, canB);
    if (r.parent) {
      goPlay(upd, r.parent,
        notes.join("\n") + "\n" + nameOf(players, r.parent) + " さんが親!(" + bids[r.parent] + "枚)");
      return upd;
    }
    if (!Object.keys(nb.folded).length) delete nb.folded;
    if (!Object.keys(nb.debtors).length) delete nb.debtors;
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
      const canB = (id) => canBorrow(r, id);
      if (!tied.some((id) => coins[id] >= 1 || canB(id))) {
        // 同点の全員がコイン不足 → 抽選
        const p = tied[Math.floor(Math.random() * tied.length)];
        goPlay(upd, p, "同点の全員がコイン不足のため\n抽選で " + nameOf(players, p) + " さんが親!");
      } else {
        const nb = { stage: "raise", need: b.need, bids: b.bids, top: b.top, tied: tied.slice(), folded: {} };
        const notes = [];
        const res = raiseNext(nb, coins, 0, notes, players, canB);
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
  if (g.phase === "seat") return applySeat(room, act);
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
  if (g.phase === "seat") return maybeCpuSeat(roomId, getRoom);
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
      sendAction(roomId, turn, cpuChange(hand, cnt, coins, canBorrow(r, turn)));
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
      const isDebtor = !!(gg.bid.debtors && gg.bid.debtors[who]);
      if (coins >= pay) {
        sendAction(roomId, who, { type: cpuRaise(hand, coins, pay) ? "raise" : "fold" });
      } else if ((isDebtor || canBorrow(r, who)) && cpuBorrowRaise(hand)) {
        sendAction(roomId, who, { type: "raise", borrow: true });
      } else {
        sendAction(roomId, who, { type: "fold" });
      }
    }
  }, stage === "blind" ? 800 : 1500);
}

// コンピューターの席決め(入札 or パス、競り合い、席選び)
function maybeCpuSeat(roomId, getRoom) {
  const room = getRoom();
  const g = room.game;
  const s = g.seat;
  if (!s) return;
  const isCpu = (id) => room.players[id] && room.players[id].cpu;
  let who = null;
  if (s.stage === "blind") {
    const bids = s.bids || {};
    who = (s.need || []).find((id) => bids[id] === undefined && isCpu(id)) || null;
  } else if ((s.stage === "raise" || s.stage === "pick") && isCpu(g.turn)) {
    who = g.turn;
  }
  if (!who) return;
  const stage = s.stage;
  const key = JSON.stringify(s);
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    const r = getRoom();
    const gg = r && r.game;
    if (!gg || gg.phase !== "seat" || !gg.seat || r.actions || JSON.stringify(gg.seat) !== key) {
      maybeCpu(roomId, getRoom);
      return;
    }
    const ss = gg.seat;
    const coins = (r.players[who] && r.players[who].coins) || 0;
    if (stage === "blind") {
      sendAction(roomId, who, cpuSeatBid(coins, SEAT_MAX));
    } else if (stage === "raise") {
      const pay = ss.raise.top + 1 - ((ss.bids || {})[who] || 0);
      sendAction(roomId, who, { type: cpuRaise([], coins, pay) ? "raise" : "fold" });
    } else {
      const empty = (ss.seats || []).map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
      sendAction(roomId, who, { type: "pick", n: empty[Math.floor(Math.random() * empty.length)] });
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
    let repaid = 0;
    if (winner) {
      coinsAfter[winner] += pot;
      upd["players/" + winner + "/coins"] = coinsAfter[winner];
      // 借金がある勝者は、ポットから先に返す(コインがマイナスなので、足すだけで返済になる)
      const d = (players[winner] && players[winner].debt) || 0;
      if (d > 0) {
        repaid = d;
        if (coinsAfter[winner] > 0) upd["players/" + winner + "/debt"] = 0;
      }
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
    if (repaid) result.repaid = repaid;
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
  const players = Object.assign({}, room.players || {});
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
      // 退場の理由(最終順位で使う): 借金して負け / コイン0枚で負け
      const why = ((players[id] && players[id].debt) || 0) > 0 ? "debt" : "zero";
      upd["players/" + id + "/exitReason"] = why;
      players[id] = Object.assign({}, players[id], { exitReason: why });
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
        exitRound: exit[id] || 0,
        // 退場者の並び: 0枚で負け > 借金して負け > 反則・リタイヤ。同じ理由なら後で退場した人が上
        exitKey: ({ zero: 3, debt: 2 }[p.exitReason] || 1) * 1000 + (exit[id] || 0)
      }));
    const alive = all.filter((x) => !x.exitRound);
    const gone = all.filter((x) => x.exitRound);
    const a = rankList(alive, (x) => x.score, 1, true);
    const b = rankList(gone, (x) => x.exitKey, a.length + 1, true);
    const ranking = a.concat(b).map((x) => {
      const o = { id: x.id, name: x.name, coins: x.coins, debtTotal: x.debtTotal, score: x.score, rank: x.rank };
      if (x.exitRound) o.exitRound = x.exitRound;
      const why = players[x.id] && players[x.id].exitReason;
      if (x.exitRound && why) o.exitReason = why;
      return o;
    });
    upd["game"] = { round: rr, phase: "final", pot: g.pot || 0, order: g.order, ranking };
    await update(ref(db, "rooms/" + roomId), upd);
    return;
  }

  Object.keys(room.hands || {}).forEach((id) => {
    upd["hands/" + id] = null;
  });

  // 3人以上なら席決めオークション
  if (remaining.length >= 3) {
    const s = startSeat(room, g, remaining);
    if (s.need.length === 0) {
      finishSeats(upd, room, s, rr + 1, g.pot || 0);
    } else {
      upd["game"] = {
        round: rr + 1, phase: "seat", pot: g.pot || 0, order: remaining, seat: s,
        notice: note("席決めオークション!\n" + (s.first ? "前回の勝者が先に座ります\n" : "") + "入札するかパスを選んでください")
      };
    }
    await update(ref(db, "rooms/" + roomId), upd);
    return;
  }

  // 2人だけのときは席順で変わらないので、そのまま(勝者が先頭)
  let newOrder = remaining.slice();
  const wi = g.result && g.result.winner ? newOrder.indexOf(g.result.winner) : -1;
  if (wi > 0) newOrder = newOrder.slice(wi).concat(newOrder.slice(0, wi));
  dealAndChange(upd, room, newOrder, newOrder[0], rr + 1, g.pot || 0, "");
  await update(ref(db, "rooms/" + roomId), upd);
}

// 3枚ずつ配って、カードチェンジを始める
function dealAndChange(upd, room, order, firstTurn, round, pot, text) {
  // game を丸ごと書き直すので、game/〜 の書き込みは消しておく(同時に書くとエラーになるため)
  Object.keys(upd).forEach((k) => {
    if (k.startsWith("game/")) delete upd[k];
  });
  const state = { deck: (room.deck || []).slice(), lot: room.lot || 1, notice: "" };
  order.forEach((id) => {
    upd["hands/" + id] = draw(state, 3);
  });
  upd["deck"] = state.deck.length ? state.deck : null;
  upd["lot"] = state.lot;
  const game = { round, phase: "change", pot, order, turn: firstTurn, rev: false };
  const msg = [text, state.notice].filter(Boolean).join("\n");
  if (msg) game.notice = note(msg);
  upd["game"] = game;
}

// ===== 席決めオークション =====
//
// game/seat の中身
//   stage: "blind"(伏せて入札) / "open"(一斉公開) / "raise"(同点の競り合い) / "pick"(席を選ぶ)
//   ask:   席を決める人(勝者以外)。前回の親の次の人からの順
//   need:  入札・パスを選ぶ人(コイン1枚以上)
//   first: 前回の勝者(先に座っている)
//   seats: テーブルの席(時計回り)。空席は ""
//   bids:  {人: 枚数}(0 はパス)
//   groups: まだ順番が決まっていない入札額ごとのグループ
//   rank:  席を選ぶ順(決まった分)
//   raise: 競り合い中の情報 {tied, folded, foldOrder, top}
//   queue: これから席を選ぶ人

const SEAT_MAX = 5;

function startSeat(room, g, remaining) {
  const players = room.players || {};
  const winner = g.result && g.result.winner && remaining.includes(g.result.winner)
    ? g.result.winner : null;
  const N = remaining.length;
  const seats = Array(N).fill("");
  if (winner) seats[Math.floor(Math.random() * N)] = winner;
  const prev = g.order || [];
  const pi = prev.indexOf(g.parent);
  const rot = pi >= 0 ? prev.slice(pi + 1).concat(prev.slice(0, pi + 1)) : prev.slice();
  const ask = rot.filter((id) => remaining.includes(id) && id !== winner);
  const need = ask.filter((id) => ((players[id] && players[id].coins) || 0) >= 1);
  const s = { stage: "blind", ask, need, seats };
  if (winner) s.first = winner;
  return s;
}

// Firebaseから読んだ席決めデータを、扱いやすい形にそろえる(空の配列などが消えるため)
function normSeat(s) {
  const o = JSON.parse(JSON.stringify(s || {}));
  o.ask = o.ask || [];
  o.need = o.need || [];
  o.seats = o.seats || [];
  o.bids = o.bids || {};
  o.groups = (o.groups || []).map((x) => x || []);
  o.rank = o.rank || [];
  o.queue = o.queue || [];
  o.debtors = o.debtors || {};
  if (o.raise) {
    o.raise.folded = o.raise.folded || {};
    o.raise.foldOrder = o.raise.foldOrder || [];
  }
  return o;
}

// 競り合いで次に聞く人(コイン不足は自動で降りる)。決着したら done
function seatRaiseNext(s, coins, startIdx, notes, players, canB) {
  const R = s.raise;
  const tied = R.tied;
  for (let k = 0; k < tied.length; k++) {
    const alive = tied.filter((id) => !R.folded[id]);
    if (alive.length <= 1) return { done: alive[0] };
    const id = tied[(startIdx + k) % tied.length];
    if (R.folded[id]) continue;
    const need = R.top + 1 - (s.bids[id] || 0);
    if ((coins[id] || 0) >= need || (canB && canB(id))) return { turn: id };
    R.folded[id] = true;
    R.foldOrder.push(id);
    notes.push(nameOf(players, id) + " さんはコイン不足で降りました");
  }
  const alive = tied.filter((id) => !R.folded[id]);
  return { done: alive[0] };
}

// 競り合いが決着 → 選ぶ順に足す(残った人、そのあと後から降りた人から)
function seatRaiseDone(s, winnerId) {
  s.rank.push(winnerId);
  s.raise.foldOrder.slice().reverse().forEach((id) => s.rank.push(id));
  s.raise = null;
}

// 残りのグループを順に片づける。競り合いが始まれば {turn}、全部決まれば {pick}
function seatAdvance(s, coins, notes, players, canB) {
  for (;;) {
    const gr = s.groups.shift();
    if (!gr) return { pick: true };
    if (gr.length === 1) {
      s.rank.push(gr[0]);
      continue;
    }
    const names = gr.map((id) => nameOf(players, id)).join("・");
    if (!gr.some((id) => (coins[id] || 0) >= 1 || (canB && canB(id)))) {
      shuffle(gr).forEach((id) => s.rank.push(id));
      notes.push(names + " は同点でコイン不足のため抽選");
      continue;
    }
    s.raise = { tied: gr, folded: {}, foldOrder: [], top: s.bids[gr[0]] };
    notes.push("同点!" + names + " で競り合い(" + s.bids[gr[0]] + "枚)");
    const r = seatRaiseNext(s, coins, 0, notes, players, canB);
    if (r.turn) return { turn: r.turn };
    seatRaiseDone(s, r.done);
  }
}

// 席を選ぶ段階へ(だれも選ばなければ、すぐ全員ランダム)
function seatToPick(upd, room, s, pot, notes) {
  const players = room.players || {};
  s.stage = "pick";
  s.queue = s.rank.slice();
  s.raise = null;
  if (!s.queue.length) {
    finishSeats(upd, room, s, room.game.round, pot, notes.join("\n"));
    return;
  }
  upd["game/seat"] = cleanSeat(s);
  upd["game/turn"] = s.queue[0];
  notes.push(nameOf(players, s.queue[0]) + " さんから席を選びます");
  upd["game/notice"] = note(notes.join("\n"));
}

// Firebaseに書く前に、空のものを消す
function cleanSeat(s) {
  const o = JSON.parse(JSON.stringify(s));
  if (!o.groups.length) delete o.groups;
  if (!o.rank.length) delete o.rank;
  if (!o.queue.length) delete o.queue;
  if (!o.raise) delete o.raise;
  else {
    if (!Object.keys(o.raise.folded).length) delete o.raise.folded;
    if (!o.raise.foldOrder.length) delete o.raise.foldOrder;
  }
  if (!Object.keys(o.bids).length) delete o.bids;
  if (!Object.keys(o.debtors).length) delete o.debtors;
  if (o.first === undefined) delete o.first;
  return o;
}

// 席が全部決まった → 余った席にランダムで座らせて、配札・チェンジへ
function finishSeats(upd, room, s, round, pot, text) {
  const seats = (s.seats || []).slice();
  const placed = new Set(seats.filter(Boolean));
  const rest = shuffle((s.ask || []).filter((id) => !placed.has(id)));
  for (let i = 0; i < seats.length; i++) if (!seats[i]) seats[i] = rest.shift();
  const first = s.first || seats[0];
  dealAndChange(upd, room, seats, first, round, pot,
    [text, "席が決まりました!"].filter(Boolean).join("\n"));
}

function applySeat(room, act) {
  const g = room.game;
  if (!g.seat) return null;
  const s = normSeat(g.seat);
  const uid = act.uid;
  const players = room.players || {};
  const coins = {};
  Object.keys(players).forEach((id) => {
    coins[id] = players[id].coins || 0;
  });
  let pot = g.pot || 0;
  const upd = {};
  const notes = [];

  // --- 伏せて入札 / パス ---
  if (s.stage === "blind") {
    if (act.type !== "sbid" && act.type !== "spass") return null;
    if (!s.need.includes(uid) || s.bids[uid] !== undefined) return null;
    let n = 0;
    if (act.type === "sbid") {
      n = Math.floor(Number(act.n) || 0);
      // 借金ルールありなら、手持ちより多くても5枚まで選べる(足りない分は借金)
      const cap = act.borrow && canBorrow(room, uid) ? SEAT_MAX : Math.min(SEAT_MAX, coins[uid]);
      if (n < 1 || n > cap) return null;
    }
    s.bids[uid] = n;
    if (!s.need.every((id) => s.bids[id] !== undefined)) {
      upd["game/seat/bids/" + uid] = n;
      return upd;
    }
    const god = [];
    s.need.forEach((id) => {
      if (s.bids[id] > 0) {
        pot += s.bids[id];
        if (payCoins(upd, room, id, coins, s.bids[id]) > 0) {
          s.debtors[id] = true;
          god.push(nameOf(players, id));
        }
      }
    });
    upd["game/pot"] = pot;
    s.stage = "open";
    s.id = Date.now();
    upd["game/seat"] = cleanSeat(s);
    upd["game/notice"] = note("一斉公開!" + (god.length ? "\n" + god.join("・") + " さんが神の手を借りました" : ""));
    return upd;
  }

  // --- 同点の競り合い ---
  if (s.stage === "raise") {
    if (uid !== g.turn || !s.raise) return null;
    const R = s.raise;
    const idx = R.tied.indexOf(uid);
    const canB = (id) => canBorrow(room, id);
    if (act.type === "raise") {
      const pay = R.top + 1 - (s.bids[uid] || 0);
      const newBorrow = coins[uid] < pay;
      if (newBorrow && !(act.borrow && canB(uid))) return null;
      const borrowed = payCoins(upd, room, uid, coins, pay);
      pot += pay;
      s.bids[uid] = R.top + 1;
      R.top += 1;
      upd["game/pot"] = pot;
      if (newBorrow) {
        s.debtors[uid] = true;
        notes.push(nameOf(players, uid) + " さんが神の手を借りました!");
      }
      notes.push(nameOf(players, uid) + " さん上乗せ → " + R.top + "枚" + (borrowed ? "(借金+" + borrowed + ")" : ""));
      // 強制終了: 競りに残っている全員が借金した → 最後に借りた人から
      const alive = R.tied.filter((id) => !R.folded[id]);
      if (newBorrow && alive.every((id) => s.debtors[id])) {
        s.rank.push(uid);
        alive.filter((id) => id !== uid).forEach((id) => s.rank.push(id));
        R.foldOrder.slice().reverse().forEach((id) => s.rank.push(id));
        s.raise = null;
        notes.push(GOD_FORCE_SEAT);
        const a = seatAdvance(s, coins, notes, players, canB);
        if (a.turn) {
          upd["game/seat"] = cleanSeat(s);
          upd["game/turn"] = a.turn;
          upd["game/notice"] = note(notes.join("\n"));
          return upd;
        }
        seatToPick(upd, room, s, pot, notes);
        return upd;
      }
    } else if (act.type === "fold") {
      R.folded[uid] = true;
      R.foldOrder.push(uid);
      notes.push(nameOf(players, uid) + " さんは降りました");
    } else {
      return null;
    }
    const r = seatRaiseNext(s, coins, idx + 1, notes, players, canB);
    if (r.turn) {
      upd["game/seat"] = cleanSeat(s);
      upd["game/turn"] = r.turn;
      upd["game/notice"] = note(notes.join("\n"));
      return upd;
    }
    seatRaiseDone(s, r.done);
    const a = seatAdvance(s, coins, notes, players, canB);
    if (a.turn) {
      upd["game/seat"] = cleanSeat(s);
      upd["game/turn"] = a.turn;
      upd["game/notice"] = note(notes.join("\n"));
      return upd;
    }
    seatToPick(upd, room, s, pot, notes);
    return upd;
  }

  // --- 席を選ぶ ---
  if (s.stage === "pick") {
    if (act.type !== "pick" || uid !== g.turn || s.queue[0] !== uid) return null;
    const slot = Math.floor(Number(act.n));
    if (!(slot >= 0 && slot < s.seats.length) || s.seats[slot] !== "") return null;
    s.seats[slot] = uid;
    s.queue.shift();
    if (!s.queue.length) {
      finishSeats(upd, room, s, g.round, pot, nameOf(players, uid) + " さんが着席");
      return upd;
    }
    upd["game/seat"] = cleanSeat(s);
    upd["game/turn"] = s.queue[0];
    upd["game/notice"] = note(
      nameOf(players, uid) + " さんが着席\n次は " + nameOf(players, s.queue[0]) + " さん"
    );
    return upd;
  }
  return null;
}

// 一斉公開を約3秒見せてから、選ぶ順を決める(ホストだけが呼ぶ)
let seatTimer = null;
export function checkSeat(roomId, getRoom) {
  if (seatTimer) return;
  const room = getRoom();
  const g = room && room.game;
  if (!g || g.phase !== "seat" || !g.seat || g.seat.stage !== "open") return;
  const openId = g.seat.id;
  seatTimer = setTimeout(async () => {
    seatTimer = null;
    const r = getRoom();
    const gg = r && r.game;
    if (!gg || gg.phase !== "seat" || !gg.seat || gg.seat.stage !== "open" || gg.seat.id !== openId) return;
    const s = normSeat(gg.seat);
    const players = r.players || {};
    const coins = {};
    Object.keys(players).forEach((id) => {
      coins[id] = players[id].coins || 0;
    });
    const notes = [];
    const bidders = s.need.filter((id) => s.bids[id] > 0);
    const fives = bidders.filter((id) => s.bids[id] === SEAT_MAX);
    if (fives.length === 1) {
      // 5枚が単独 → その人だけが選んで、他はランダム
      s.rank = [fives[0]];
      s.groups = [];
      notes.push(nameOf(players, fives[0]) + " さんが5枚!\n他の人はランダムです");
    } else {
      const vals = [...new Set(bidders.map((id) => s.bids[id]))].sort((a, b) => b - a);
      s.groups = vals.map((v) => s.ask.filter((id) => bidders.includes(id) && s.bids[id] === v));
      s.rank = [];
    }
    const upd = {};
    const a = seatAdvance(s, coins, notes, players, (id) => canBorrow(r, id));
    if (a.turn) {
      s.stage = "raise";
      upd["game/seat"] = cleanSeat(s);
      upd["game/turn"] = a.turn;
      upd["game/notice"] = note(notes.join("\n") + "\n1枚ずつ上乗せ。降りた人が後");
    } else {
      seatToPick(upd, r, s, gg.pot || 0, notes);
    }
    await update(ref(db, "rooms/" + roomId), upd);
  }, 3000);
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
    upd["players/" + id + "/exitReason"] = null;
  });
  await update(ref(db, "rooms/" + roomId), upd);
}
