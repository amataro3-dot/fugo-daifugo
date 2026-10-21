import {
  label, SUIT_MARK, isJoker, suitOf, numOf, sortHand, judge, suitCheck,
  lockChoices, canSpe3, gekCan, isFoulFinish, isForbidden, isJokerSingle, hasNum
} from "./rules.js";
import { waitingIds } from "./host.js";
import { serverNow } from "./firebase.js";

let selected = [];
let lastNoteId = null;
let winShownId = null;
let winDone = null;
let lastArgs = null;
let lastFxId = null;
let introClosed = null;

// 途中のログ(上の段のプレイヤーと、場の間に出す。次のログが来るまで残す)
function logEl(g, uid, spectator) {
  const d = document.createElement("div");
  d.style.cssText =
    "grid-area:log;background:rgba(0,0,0,0.35);border-radius:10px;padding:6px 10px;" +
    "font-size:14px;line-height:1.45;color:#fff;white-space:pre-line;text-align:center;min-height:1.45em";
  let t = (g.notice && g.notice.text) || "";
  if (g.intro && !spectator && g.intro.acks && g.intro.acks[uid]) {
    t = (t ? t + "\n" : "") + "全員が説明を読むのを待っています…";
  }
  d.textContent = t;
  return d;
}
const GRID_AREAS = '"top top top" "log log log" "left field right"';
let bidPick = 1;
let marketSel = null;
let marketKey = "";
let curSettings = {};

const GOD_ASK = "次のターンからマイナスになります。\n富豪の神の手を借りますか?";

// 神の手を借りられるか(借金ルールあり、かつ、このゲームでまだ使っていない)
function canBorrowMe(p) {
  return curSettings.debt === "on" && !!p && !((p.debtTotal || 0) > 0);
}

// 「神の手を借りますか?」を聞く(借りるなら true)
async function askBorrow(short) {
  const ok = await askChoice(GOD_ASK + "\n(足りない " + short + " 枚を借ります)", [
    { label: "借りる", value: "yes" },
    { label: "借りない", value: "no" }
  ]);
  return ok === "yes";
}

// 「借りない」を選んだとき: 枚数を手持ちの枚数に戻して、選び直し
function backToHave(have) {
  bidPick = Math.max(1, have);
  if (lastArgs) renderGame(...lastArgs);
}

// 自分の名前の前に「貧」マークを付ける
function addPoor(el, p) {
  if (!(p && p.debt > 0)) return;
  const t = el.textContent;
  el.textContent = "";
  el.appendChild(poorMark());
  el.appendChild(document.createTextNode(t));
}

// 丸で囲んだ「貧」マーク(借金中の人)
function poorMark() {
  const m = document.createElement("span");
  m.textContent = "貧";
  m.style.cssText =
    "display:inline-block;width:18px;height:18px;line-height:16px;border:1.5px solid #ff8a8a;" +
    "border-radius:50%;font-size:11px;color:#ff8a8a;text-align:center;margin-right:3px;vertical-align:middle";
  return m;
}
let bidRound = null;

// jsuit: ジョーカーを何のマークとして出したか(場のカード用)
export function cardEl(c, cls, jsuit) {
  const d = document.createElement("div");
  d.className = "card " + (cls || "");
  if (c === "back") {
    d.classList.add("back");
    return d;
  }
  if (isJoker(c)) {
    d.classList.add("joker");
    d.textContent = "JOKER";
    if (jsuit) {
      const m = document.createElement("div");
      m.textContent = "(" + SUIT_MARK[jsuit] + ")";
      m.style.fontSize = "12px";
      m.style.color = jsuit === "H" || jsuit === "D" ? "#d22" : "#222";
      d.appendChild(m);
    }
    return d;
  }
  const s = suitOf(c);
  if (s === "H" || s === "D") d.classList.add("red");
  const n = document.createElement("div");
  n.textContent = label(numOf(c));
  const m = document.createElement("div");
  m.className = "s";
  m.textContent = SUIT_MARK[s];
  d.appendChild(n);
  d.appendChild(m);
  return d;
}

function seatEl(id, p, count, game, openHand, hand) {
  const d = document.createElement("div");
  d.className = "seat";
  d.style.fontSize = "14px";
  d.style.padding = "6px 4px";
  if (game.turn === id) d.classList.add("turn");
  const nm = document.createElement("div");
  nm.className = "nm";
  nm.style.fontSize = "15px";
  if (p.debt > 0) nm.appendChild(poorMark());
  nm.appendChild(document.createTextNode(p.name));
  const coin = document.createElement("div");
  coin.className = "coin";
  coin.style.fontSize = "15px";
  coin.textContent = "🪙" + p.coins;
  const backs = document.createElement("div");
  backs.className = "backs";
  if (openHand) {
    // 観戦者: 表向きの小さいカード
    sortHand(hand || []).forEach((c) => {
      const e = cardEl(c, "small");
      e.style.cssText = "width:24px;height:34px;font-size:11px";
      backs.appendChild(e);
    });
  } else {
    for (let i = 0; i < count; i++) {
      const e = cardEl("back", "mini");
      e.style.width = "20px";
      e.style.height = "29px";
      backs.appendChild(e);
    }
  }
  d.appendChild(nm);
  d.appendChild(coin);
  d.appendChild(backs);
  if (game.phase === "change") {
    const ch = game.change || {};
    const n = (ch.counts && ch.counts[id]) || 0;
    const fin = ch.done && ch.done[id];
    if (n > 0 || fin) {
      const t = document.createElement("div");
      t.className = "small";
      t.textContent = "チェンジ" + n + "回" + (fin ? "・終了" : "");
      d.appendChild(t);
    }
  }
  if (game.phase === "bid" && game.bid) {
    const b = game.bid;
    const bids = b.bids || {};
    const inBid = (b.need || []).includes(id);
    const t = document.createElement("div");
    t.className = "small";
    if (!inBid) t.textContent = "パス(0枚)";
    else if (b.stage === "blind") t.textContent = bids[id] !== undefined ? "入札済み" : "考え中…";
    else if (!(bids[id] > 0)) t.textContent = "パス";
    else {
      t.textContent = "入札 " + bids[id] + "枚" + (b.folded && b.folded[id] ? "・降りた" : "");
      t.style.color = "#f2c230";
    }
    d.appendChild(t);
  }
  if (game.phase === "market" && game.market) {
    const m = game.market;
    const bets = m.bets || {};
    const t = document.createElement("div");
    t.className = "small";
    const b = bets[id];
    if (m.stage === "blind") {
      t.textContent = !(m.need || []).includes(id) ? "パス(0枚)" : b === undefined ? "考え中…" : b.n > 0 ? "ベット済み" : "パス";
    } else if (m.stage === "raise" && m.raise && m.raise.tied.includes(id)) {
      t.textContent = "競り " + (m.raise.bids || {})[id] + "枚" + (m.raise.folded && m.raise.folded[id] ? "・降りた" : "");
      t.style.color = "#f2c230";
    } else if (b && b.n > 0) {
      t.textContent = CIRCLE[b.c] + "に" + b.n + "枚";
      t.style.color = "#f2c230";
    } else if (b) {
      t.textContent = "パス";
    }
    if (t.textContent) d.appendChild(t);
  }
  if (p.retired) {
    const rm = document.createElement("div");
    rm.className = "passmark";
    rm.textContent = "リタイヤ";
    d.appendChild(rm);
  } else if (p.online === false && !p.cpu) {
    const om = document.createElement("div");
    om.className = "passmark";
    om.textContent = "切断中";
    d.appendChild(om);
  }
  if (game.out && game.out[id] && !p.retired) {
    const fm = document.createElement("div");
    fm.className = "passmark";
    fm.textContent = "反則負け";
    d.appendChild(fm);
  }
  if (game.passed && game.passed[id]) {
    const ps = document.createElement("div");
    ps.className = "passmark";
    ps.textContent = "パス";
    d.appendChild(ps);
  }
  return d;
}

function askChoice(title, opts) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "choice";
    const box = document.createElement("div");
    box.className = "choice-box";
    const t = document.createElement("div");
    t.className = "choice-title";
    t.textContent = title;
    box.appendChild(t);
    opts.forEach((o) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = o.label;
      b.onclick = () => {
        ov.remove();
        resolve(o.value);
      };
      box.appendChild(b);
    });
    ov.appendChild(box);
    document.body.appendChild(ov);
  });
}

function renderFinal(root, g, onAction) {
  root.innerHTML = "";
  const t = document.createElement("h2");
  t.textContent = "🏆 最終順位";
  root.appendChild(t);
  const list = document.createElement("div");
  list.className = "rank-list";
  (g.ranking || []).forEach((x) => {
    const row = document.createElement("div");
    row.className = "rank-row" + (x.rank === 1 ? " first" : "");
    const left = document.createElement("span");
    left.textContent = x.rank + "位  " + x.name;
    const right = document.createElement("span");
    let txt = "🪙" + x.coins;
    if (x.debtTotal > 0) txt += "(借金-" + x.debtTotal + " → " + x.score + ")";
    if (x.exitRound) {
      txt += "  退場(第" + x.exitRound + "ラウンド" +
        (x.exitReason === "debt" ? "・借金" : x.exitReason === "retire" ? "・リタイヤ" : "") + ")";
    }
    right.textContent = txt;
    row.appendChild(left);
    row.appendChild(right);
    list.appendChild(row);
  });
  root.appendChild(list);
  const b = document.createElement("button");
  b.className = "btn main";
  b.textContent = "ロビーに戻る";
  b.onclick = () => onAction({ type: "lobby" });
  root.appendChild(b);
}

function showResult(g, players, onAction) {
  const r = g.result;
  const ov = document.createElement("div");
  ov.className = "overlay resultov";
  const add = (text, cls) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text;
    ov.appendChild(d);
  };
  const w = r.winner ? players[r.winner] : null;
  add(w ? "🎉 " + w.name + " さんの勝ち!" : "ノーゲーム");
  if (r.gain > 0) add("ポット " + r.gain + " 枚を獲得", "rs");
  if (r.repaid) add("神の手の借金 " + r.repaid + " 枚を先に返済", "rs");
  else if (r.carry > 0) add("ポット " + r.carry + " 枚は次のラウンドへ持ち越し", "rs");
  else add("ポットは 0 枚", "rs");
  // コインが多い人の順に並べる(同じ枚数は同じ順位)
  const rows = (g.order || [])
    .filter((id) => players[id])
    .map((id) => ({ id, p: players[id], c: players[id].coins || 0 }))
    .sort((a, b) => b.c - a.c);
  rows.forEach((x, i) => {
    x.rank = i > 0 && x.c === rows[i - 1].c ? rows[i - 1].rank : i + 1;
    let line = x.rank + "位  " + x.p.name + "  🪙" + x.c;
    if (r.winner === x.id && r.gain > 0) line += "  (+" + r.gain + ")";
    add(line, "rs");
  });
  if (r.outIds && r.outIds.length) {
    const nm = (id) => (players[id] ? players[id].name : "");
    const debtOut = r.outIds.filter((id) => players[id] && players[id].debt > 0);
    const zeroOut = r.outIds.filter((id) => !debtOut.includes(id));
    if (zeroOut.length) add("コインが0枚の " + zeroOut.map(nm).join("、") + " は退場(観戦になります)", "rs warn");
    if (debtOut.length) add("借金を返せなかった " + debtOut.map(nm).join("、") + " は退場(観戦になります)", "rs warn");
  }
  if (r.last) add("これで対戦は終了です", "rs warn");
  const b = document.createElement("button");
  b.className = "btn main";
  b.textContent = r.last ? "最終順位へ(OK)" : "OK(次のラウンドへ)";
  b.onclick = () => {
    ov.remove();
    onAction({ type: "rack" });
  };
  ov.appendChild(b);
  document.body.appendChild(ov);
}

// 親決めオークション中の、場の表示
function bidFieldEl(field, b, players) {
  const line = (text, color, size) => {
    const d = document.createElement("div");
    d.textContent = text;
    if (color) d.style.color = color;
    if (size) d.style.fontSize = size;
    field.appendChild(d);
  };
  const nm = (id) => (players[id] ? players[id].name : "");
  const bids = b.bids || {};
  if (b.stage === "blind") {
    line("親決めオークション", "#ffd84a", "17px");
    const n = (b.need || []).filter((id) => bids[id] !== undefined).length;
    line("入札 " + n + " / " + (b.need || []).length + " 人");
    return;
  }
  if (b.stage === "open") {
    line("一斉公開!", "#ffd84a", "17px");
    (b.need || []).slice().sort((x, y) => (bids[y] || 0) - (bids[x] || 0)).forEach((id) => {
      const debt = b.debtors && b.debtors[id] ? "(神の手)" : "";
      line(nm(id) + "  " + (bids[id] > 0 ? bids[id] + "枚" + debt : "パス"), bids[id] === b.top && b.top > 0 ? "#fff" : "#aaa");
    });
    if (b.parent && !(b.top > 0)) line("→ 誰も入札せず。" + nm(b.parent) + " さんが親", "#ffd84a");
    else if (b.parent) line("→ " + nm(b.parent) + " さんが親!", "#ffd84a");
    else line("→ 同点!競り上げへ", "#ffd84a");
    return;
  }
  line("競り上げ中(" + b.top + "枚)", "#ffd84a", "17px");
  (b.tied || []).forEach((id) => {
    const out = b.folded && b.folded[id];
    line(nm(id) + "  " + bids[id] + "枚" + (out ? "(降りた)" : ""), out ? "#999" : "#fff");
  });
}

// 枚数を −/+ で選ぶパネル(親決め・席決めで共通)
function bidStepper(root, cap, key, goLabel, onGo) {
  if (bidRound !== key) {
    bidRound = key;
    bidPick = 1;
  }
  bidPick = Math.max(1, Math.min(cap, bidPick));
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;justify-content:center;gap:18px;margin:6px 0";
  const step = (t, d) => {
    const s = document.createElement("button");
    s.className = "btn";
    s.textContent = t;
    s.style.cssText = "width:56px;margin:0;padding:8px";
    s.disabled = d;
    return s;
  };
  const minus = step("−", bidPick <= 1);
  const num = document.createElement("div");
  num.textContent = bidPick + "枚";
  num.style.cssText = "font-size:28px;font-weight:bold;min-width:70px;text-align:center;color:#f2c230";
  const plus = step("+", bidPick >= cap);
  const go = document.createElement("button");
  go.className = "btn main";
  go.textContent = goLabel + "(" + bidPick + "枚)";
  const redraw = () => {
    num.textContent = bidPick + "枚";
    minus.disabled = bidPick <= 1;
    plus.disabled = bidPick >= cap;
    go.textContent = goLabel + "(" + bidPick + "枚)";
  };
  minus.onclick = () => { bidPick = Math.max(1, bidPick - 1); redraw(); };
  plus.onclick = () => { bidPick = Math.min(cap, bidPick + 1); redraw(); };
  go.onclick = () => {
    go.disabled = true;
    onGo(bidPick);
  };
  row.appendChild(minus);
  row.appendChild(num);
  row.appendChild(plus);
  root.appendChild(row);
  root.appendChild(go);
  return go;
}

// 競り上げの「上乗せ / 降りる」ボタン(親決め・席決めで共通)
// debtor: この競りですでに神の手を借りている(何枚でも上げられる)
// canB: まだ神の手を借りられる
function raiseButtons(root, msg, top, myBid, coins, onAction, debtor, canB) {
  const pay = top + 1 - (myBid || 0);
  const short = (coins || 0) < pay;
  msg.textContent = "上乗せすると合計 " + (top + 1) + "枚(今回 " + pay + "枚払う)" +
    (short && debtor ? "\n足りない分は借金になります" : "") +
    (short && !debtor && canB ? "\nコインが足りません。神の手を借りれば上乗せできます" : "");
  const btns = document.createElement("div");
  btns.className = "g-btns";
  const up = document.createElement("button");
  up.className = "btn main";
  up.textContent = !short ? "上乗せ(+" + pay + "枚)"
    : debtor ? "上乗せ(借金で+" + pay + ")"
    : "神の手で上乗せ";
  up.disabled = short && !debtor && !canB;
  up.onclick = async () => {
    if (short && !debtor) {
      const ok = await askChoice(GOD_ASK, [
        { label: "借りる", value: "yes" },
        { label: "借りない", value: "no" }
      ]);
      if (ok !== "yes") return;
    }
    up.disabled = true;
    onAction({ type: "raise", borrow: short });
  };
  const fold = document.createElement("button");
  fold.className = "btn";
  fold.textContent = "降りる";
  fold.onclick = () => {
    fold.disabled = true;
    onAction({ type: "fold" });
  };
  btns.appendChild(up);
  btns.appendChild(fold);
  root.appendChild(btns);
}

function msgEl(root) {
  const msg = document.createElement("div");
  msg.className = "msg";
  msg.style.color = "#fff";
  msg.style.whiteSpace = "pre-line";
  msg.style.fontSize = "15px";
  root.appendChild(msg);
  return msg;
}

// 親決めオークション中の、自分の操作エリア
function bidControls(root, g, me, uid, maxBid, onAction) {
  const b = g.bid;
  const bids = b.bids || {};
  const msg = msgEl(root);
  if (!(b.need || []).includes(uid)) {
    msg.textContent = "コインが0枚なので、今回の親決めはパスです";
    return;
  }
  if (b.stage === "blind") {
    if (bids[uid] !== undefined) {
      msg.textContent = (bids[uid] > 0 ? "入札済み(" + bids[uid] + "枚)" : "パスしました") + "。全員の入札を待っています";
      return;
    }
    const have = me.coins || 0;
    const cap = canBorrowMe(me) ? maxBid : Math.min(maxBid, have);
    msg.textContent = "賭ける枚数を選んでください(1〜" + cap + "枚)\n単独で最高額なら親(最初に出す人)。出したコインはポットへ" +
      (have < cap ? "\n手持ちより多い枚数は、神の手を借りて賭けられます" : "");
    bidStepper(root, cap, "b" + g.round, "入札する", async (n) => {
      if (n > have) {
        if (await askBorrow(n - have)) onAction({ type: "bid", n, borrow: true });
        else backToHave(have);
        return;
      }
      onAction({ type: "bid", n });
    });
    if (have < 1) {
      const ps = document.createElement("button");
      ps.className = "btn";
      ps.textContent = "パス(神の手を借りない)";
      ps.onclick = () => {
        ps.disabled = true;
        onAction({ type: "bpass" });
      };
      root.appendChild(ps);
    }
    return;
  }
  if (b.stage === "open") {
    msg.textContent = "結果発表中…";
    return;
  }
  if (!(b.tied || []).includes(uid) || (b.folded && b.folded[uid])) {
    msg.textContent = "同点の人が競り上げ中です";
    return;
  }
  if (g.turn !== uid) {
    msg.textContent = "相手の番です(今 " + b.top + "枚)";
    return;
  }
  raiseButtons(root, msg, b.top, bids[uid], me.coins, onAction,
    !!(b.debtors && b.debtors[uid]), canBorrowMe(me));
}

// ===== 席決めオークション =====

// 席決め中の、場(真ん中)の表示
function seatFieldEl(field, s, players, turn) {
  const line = (text, color, size) => {
    const d = document.createElement("div");
    d.textContent = text;
    if (color) d.style.color = color;
    if (size) d.style.fontSize = size;
    field.appendChild(d);
  };
  const nm = (id) => (players[id] ? players[id].name : "");
  const bids = s.bids || {};
  const ask = s.ask || [];
  if (s.stage === "blind") {
    line("席決めオークション", "#ffd84a", "17px");
    ask.forEach((id) => {
      const st = !(s.need || []).includes(id) ? "パス" : bids[id] !== undefined ? "決定済み" : "考え中…";
      line(nm(id) + "  " + st);
    });
    return;
  }
  if (s.stage === "open") {
    line("一斉公開!", "#ffd84a", "17px");
    ask.slice().sort((a, b) => (bids[b] || 0) - (bids[a] || 0)).forEach((id) => {
      line(nm(id) + "  " + (bids[id] > 0 ? bids[id] + "枚" : "パス"), bids[id] > 0 ? "#fff" : "#aaa");
    });
    return;
  }
  if (s.stage === "raise" && s.raise) {
    line("競り合い中(" + s.raise.top + "枚)", "#ffd84a", "17px");
    s.raise.tied.forEach((id) => {
      const out = s.raise.folded && s.raise.folded[id];
      line(nm(id) + "  " + bids[id] + "枚" + (out ? "(降りた)" : ""), out ? "#999" : id === turn ? "#ffd84a" : "#fff");
    });
    if ((s.rank || []).length) line("決まった順: " + s.rank.map(nm).join(" → "), "#cfe5da", "13px");
    return;
  }
  // 席を選ぶ
  line("席を選ぶ順", "#ffd84a", "17px");
  const rank = s.rank || [];
  const seats = s.seats || [];
  rank.forEach((id, i) => {
    const done = seats.includes(id);
    line((i + 1) + ". " + nm(id) + (done ? " ✓" : id === turn ? " ←" : ""), done ? "#aaa" : id === turn ? "#ffd84a" : "#fff");
  });
  const rnd = ask.filter((id) => !rank.includes(id));
  if (rnd.length) line("ランダム: " + rnd.map(nm).join("・"), "#cfe5da", "13px");
}

// 席決め中の、テーブルの1つの席(空席 or 座っている人)
function seatSlotEl(i, s, players, game, myPick, onAction) {
  const id = (s.seats || [])[i];
  if (id) {
    const d = seatEl(id, players[id] || { name: "", coins: 0 }, 0, game, false, []);
    if (id === s.first) {
      const t = document.createElement("div");
      t.className = "small";
      t.textContent = "前回の勝者";
      d.appendChild(t);
    }
    return d;
  }
  const d = document.createElement("div");
  d.className = "seat";
  d.style.cssText =
    "font-size:15px;padding:10px 4px;background:transparent;border:2px dashed " +
    (myPick ? "#f2c230" : "#8bbba5") + ";color:" + (myPick ? "#f2c230" : "#cfe5da");
  d.textContent = myPick ? "空席\nタップ" : "空席";
  d.style.whiteSpace = "pre-line";
  if (myPick) {
    d.onclick = async () => {
      const ok = await askChoice("この席に座りますか?", [
        { label: "座る", value: "yes" },
        { label: "やめる", value: "no" }
      ]);
      if (ok === "yes") onAction({ type: "pick", n: i });
    };
  }
  return d;
}

// 席決め中の、自分の操作エリア
function seatControls(root, g, me, uid, players, onAction) {
  const s = g.seat;
  const bids = s.bids || {};
  const msg = msgEl(root);
  const nm = (id) => (players[id] ? players[id].name : "");
  if (uid === s.first) {
    msg.textContent = "前回の勝者なので、先に座っています";
    return;
  }
  if (!(s.ask || []).includes(uid)) {
    msg.textContent = "席決めを見ています";
    return;
  }
  if (s.stage === "blind") {
    if (!(s.need || []).includes(uid)) {
      msg.textContent = "コインが0枚なので、余った席にランダムで座ります";
      return;
    }
    if (bids[uid] !== undefined) {
      msg.textContent = (bids[uid] > 0 ? "入札済み(" + bids[uid] + "枚)" : "パスしました") + "。全員を待っています";
      return;
    }
    const borrowOk = canBorrowMe(me);
    const cap = borrowOk ? 5 : Math.min(5, me.coins || 0);
    msg.textContent = "席を選ぶ順番の入札(1〜" + cap + "枚)\n多い人から好きな席を選べます。パスは余った席にランダム";
    let goBtn = null;
    goBtn = bidStepper(root, cap, "s" + g.round, "入札する", async (n) => {
      if (n > (me.coins || 0)) {
        // 手持ちより多い → 神の手の確認。「借りない」なら手持ちの枚数に戻す
        if (await askBorrow(n - (me.coins || 0))) onAction({ type: "sbid", n, borrow: true });
        else backToHave(me.coins || 0);
        return;
      }
      onAction({ type: "sbid", n });
    });
    const ps = document.createElement("button");
    ps.className = "btn";
    ps.textContent = "パス(余った席にランダム)";
    ps.onclick = () => {
      ps.disabled = true;
      onAction({ type: "spass" });
    };
    root.appendChild(ps);
    return;
  }
  if (s.stage === "open") {
    msg.textContent = "結果発表中…";
    return;
  }
  if (s.stage === "raise" && s.raise) {
    const R = s.raise;
    if (!R.tied.includes(uid) || (R.folded && R.folded[uid])) {
      msg.textContent = "同点の人が競り合い中です";
      return;
    }
    if (g.turn !== uid) {
      msg.textContent = "相手の番です(今 " + R.top + "枚)";
      return;
    }
    raiseButtons(root, msg, R.top, bids[uid], me.coins, onAction, false, canBorrowMe(me));
    return;
  }
  // 席を選ぶ
  if ((s.seats || []).includes(uid)) {
    msg.textContent = "着席しました。他の人を待っています";
  } else if (g.turn === uid) {
    msg.textContent = "空いている席をタップして座ってください";
  } else if ((s.rank || []).includes(uid)) {
    msg.textContent = nm(g.turn) + " さんが席を選んでいます";
  } else {
    msg.textContent = "あとで、余った席にランダムで座ります";
  }
}

// 席決め中の画面(テーブル・場・自分のエリア)
function renderSeatPhase(root, g, players, uid, spectator, onAction) {
  const s = g.seat;
  const seats = s.seats || [];
  const N = seats.length;
  const mySlot = spectator ? -1 : seats.indexOf(uid);
  const myPick = !spectator && s.stage === "pick" && g.turn === uid;
  // 自分が座っていれば、自分の次の席から時計回り。まだなら全部の席
  let list = [];
  if (mySlot >= 0) for (let k = 1; k < N; k++) list.push((mySlot + k) % N);
  else for (let k = 0; k < N; k++) list.push(k);
  const L = splitLayout(list);
  const grid = document.createElement("div");
  grid.className = "g-grid";
  grid.style.gridTemplateColumns = "1fr 2.2fr 1fr";
  const mk = (cls, idx) => {
    const box = document.createElement("div");
    box.className = cls;
    idx.forEach((i) => box.appendChild(seatSlotEl(i, s, players, g, myPick, onAction)));
    return box;
  };
  grid.style.gridTemplateAreas = GRID_AREAS;
  grid.appendChild(mk("g-top", L.top));
  grid.appendChild(logEl(g, uid, spectator));
  grid.appendChild(mk("g-left", L.left));
  const field = document.createElement("div");
  field.className = "g-field";
  field.style.minHeight = "170px";
  field.style.fontSize = "15px";
  seatFieldEl(field, s, players, g.turn);
  grid.appendChild(field);
  grid.appendChild(mk("g-right", L.right));
  root.appendChild(grid);

  if (spectator) {
    const t = document.createElement("div");
    t.className = "me-box";
    t.textContent = "観戦中";
    root.appendChild(t);
    return;
  }
  const me = players[uid] || {};
  const info = document.createElement("div");
  info.className = "me-box";
  info.style.fontSize = "17px";
  info.style.fontWeight = "bold";
  info.textContent =
    me.name + "  🪙" + me.coins + (mySlot >= 0 ? "" : "  (未着席)") +
    (g.turn === uid ? "  ← あなたの番" : "");
  addPoor(info, me);
  root.appendChild(info);
  seatControls(root, g, me, uid, players, onAction);
}

// まわりの人を「左・上・右」に分ける(手番が時計回りに見える並び)
function splitLayout(others) {
  const n = others.length;
  let left = [], top = [], right = [];
  if (n <= 3) {
    top = others;
  } else {
    const side = Math.min(3, Math.floor(n / 3));
    left = others.slice(0, side).reverse();
    right = others.slice(n - side);
    top = others.slice(side, n - side);
  }
  return { left, top, right };
}

// ===== カードマーケット =====

const CIRCLE = ["①", "②", "③"];

function mkCardName(c) {
  if (!c) return "";
  if (isJoker(c)) return "JOKER";
  return SUIT_MARK[suitOf(c)] + label(numOf(c));
}

// マーケット中の、場の表示(3枚のカード)
function marketFieldEl(field, m, players, uid, canPick) {
  const nm = (id) => (players[id] ? players[id].name : "");
  const bets = m.bets || {};
  const sold = m.sold || {};
  const avail = m.avail || [];
  const head = document.createElement("div");
  head.textContent = "カードマーケット" + (m.lap === 2 ? "(2周目)" : "");
  head.style.cssText = "color:#ffd84a;font-size:17px;font-weight:bold;margin-bottom:4px";
  field.appendChild(head);
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;justify-content:center";
  (m.cards || []).forEach((card, c) => {
    const box = document.createElement("div");
    box.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:2px;min-width:50px";
    const lb = document.createElement("div");
    lb.textContent = CIRCLE[c];
    lb.style.cssText = "font-size:15px;color:#fff";
    box.appendChild(lb);
    const el = cardEl(card);
    const owner = sold["c" + c];
    const open = avail.includes(c) && !owner;
    if (!open) el.style.opacity = "0.35";
    if (m.stage === "raise" && m.raise && m.raise.c === c) el.style.outline = "3px solid #ff9a5c";
    if (canPick && open) {
      if (marketSel === c) el.classList.add("sel");
      el.onclick = () => {
        marketSel = c;
        if (lastArgs) renderGame(...lastArgs);
      };
    }
    box.appendChild(el);
    const st = document.createElement("div");
    st.style.cssText = "font-size:12px;color:#cfe5da;text-align:center;line-height:1.3";
    if (owner) st.textContent = nm(owner);
    else if (!avail.includes(c)) st.textContent = "—";
    else if (m.stage === "open") {
      const list = (m.need || []).filter((id) => bets[id] && bets[id].c === c && bets[id].n > 0);
      st.textContent = list.length ? list.map((id) => nm(id) + bets[id].n).join("\n") : "なし";
      st.style.whiteSpace = "pre-line";
      st.style.color = "#fff";
    } else if (m.stage === "swap") {
      const a = (m.awards || []).find((x) => x.c === c);
      st.textContent = a ? "→" + nm(a.w) : "";
    }
    box.appendChild(st);
    row.appendChild(box);
  });
  field.appendChild(row);
  const foot = document.createElement("div");
  foot.style.cssText = "font-size:13px;margin-top:4px;color:#cfe5da";
  if (m.stage === "blind") {
    const n = (m.need || []).filter((id) => bets[id] !== undefined).length;
    foot.textContent = "ベット " + n + " / " + (m.need || []).length + " 人";
  } else if (m.stage === "open") {
    foot.textContent = "一斉公開!";
    foot.style.color = "#ffd84a";
  } else if (m.stage === "raise" && m.raise) {
    foot.textContent = CIRCLE[m.raise.c] + " 競り合い中(" + m.raise.top + "枚)";
    foot.style.color = "#ffd84a";
  } else if (m.stage === "swap") {
    const a = (m.awards || [])[0];
    if (a) foot.textContent = nm(a.w) + " さんが交換中";
  }
  field.appendChild(foot);
}

// マーケット中の、自分の操作エリア
function marketControls(root, g, me, uid, players, onAction) {
  const m = g.market;
  const bets = m.bets || {};
  const msg = msgEl(root);
  const nm = (id) => (players[id] ? players[id].name : "");
  if (m.stage === "blind") {
    if (!(m.need || []).includes(uid)) {
      msg.textContent = "コインが0枚なので、今回のマーケットはパスです";
      return;
    }
    const b = bets[uid];
    if (b !== undefined) {
      msg.textContent = (b.n > 0 ? "ベット済み(" + CIRCLE[b.c] + "に" + b.n + "枚)" : "パスしました") + "。全員を待っています";
      return;
    }
    const have = me.coins || 0;
    const cap = canBorrowMe(me) ? 5 : Math.min(5, have);
    const pick = marketSel !== null && (m.avail || []).includes(marketSel) && !(m.sold || {})["c" + marketSel];
    msg.textContent = (pick ? "選択中: " + CIRCLE[marketSel] + mkCardName(m.cards[marketSel]) : "場のカードをタップして選んでください") +
      "\nベット(1〜" + cap + "枚)はポットへ。競り負けても戻りません";
    if (cap >= 1) {
      bidStepper(root, cap, "m" + g.round + "_" + m.lap, "ベットする", async (n) => {
        if (!pick) {
          if (lastArgs) renderGame(...lastArgs);
          return;
        }
        if (n > have) {
          if (await askBorrow(n - have)) onAction({ type: "mbet", c: marketSel, n, borrow: true });
          else backToHave(have);
          return;
        }
        onAction({ type: "mbet", c: marketSel, n });
      });
    }
    const ps = document.createElement("button");
    ps.className = "btn";
    ps.textContent = "パス(ベットしない)";
    ps.onclick = () => {
      ps.disabled = true;
      onAction({ type: "mpass" });
    };
    root.appendChild(ps);
    return;
  }
  if (m.stage === "open") {
    msg.textContent = "結果発表中…";
    return;
  }
  if (m.stage === "raise" && m.raise) {
    const R = m.raise;
    if (!R.tied.includes(uid) || (R.folded && R.folded[uid])) {
      msg.textContent = "同点の人が " + CIRCLE[R.c] + " を競り合い中です";
      return;
    }
    if (g.turn !== uid) {
      msg.textContent = "相手の番です(今 " + R.top + "枚)";
      return;
    }
    raiseButtons(root, msg, R.top, (R.bids || {})[uid], me.coins, onAction,
      !!(m.debtors && m.debtors[uid]), canBorrowMe(me));
    return;
  }
  if (m.stage === "swap") {
    const a = (m.awards || [])[0];
    if (a && a.w === uid && g.turn === uid) {
      msg.textContent = CIRCLE[a.c] + mkCardName(m.cards[a.c]) + " を獲得!\n交換して捨てる手札を1枚タップしてください";
      msg.style.color = "#ffd84a";
    } else if (a) {
      msg.textContent = nm(a.w) + " さんが交換する手札を選んでいます";
    }
  }
}

// ===== 切断の待機表示 =====
// 「〇〇さん接続が切れました。復帰中です。」を全員の画面に出す(残り時間つき)
function updateWait() {
  if (!lastArgs) return;
  const room = lastArgs[1];
  const uid = lastArgs[2];
  const g = room.game || {};
  const players = room.players || {};
  const ids = g.phase === "final" ? [] : waitingIds(room).filter((id) => id !== uid);
  let ov = document.querySelector(".waitov");
  if (!ids.length) {
    if (ov) ov.remove();
    return;
  }
  if (!ov) {
    ov = document.createElement("div");
    ov.className = "overlay waitov";
    ov.style.cssText = "flex-direction:column;gap:10px;font-size:20px;color:#fff;z-index:300;padding:20px";
    document.body.appendChild(ov);
  }
  const lines = ids.map((id) => {
    const p = players[id] || {};
    const left = p.offAt ? Math.max(0, 180 - Math.floor((serverNow() - p.offAt) / 1000)) : 180;
    const mm = Math.floor(left / 60);
    const ss = String(left % 60).padStart(2, "0");
    return p.name + " さん接続が切れました。\n復帰中です。(残り " + mm + ":" + ss + ")";
  });
  ov.textContent = lines.join("\n\n") + "\n\n3分たつとリタイヤになります";
}
setInterval(updateWait, 1000);

export function renderGame(root, room, uid, onLeave, onAction) {
  lastArgs = [root, room, uid, onLeave, onAction];
  curSettings = room.settings || {};
  updateWait();
  const g = room.game || {};
  const players = room.players || {};
  const hands = room.hands || {};
  const order = g.order || [];
  const me = players[uid] || {};
  const spectator = !!me.spectator || !order.includes(uid);

  const myHand = hands[uid] || [];
  selected = selected.filter((c) => myHand.includes(c));

  document.querySelectorAll(".foulov,.resultov").forEach((e) => e.remove());

  if (g.phase === "final") {
    document.querySelectorAll(".overlay").forEach((e) => e.remove());
    renderFinal(root, g, onAction);
    return;
  }
  if (g.phase === "play" || g.phase === "change" || g.phase === "bid" || g.phase === "seat" || g.phase === "market") {
    winShownId = null;
    winDone = null;
  }

  // しばり・8切り・11バックなどを、約1秒だけ大きく出す(タップ不要)
  if (g.fx && g.fx.id !== lastFxId) {
    lastFxId = g.fx.id;
    if (Date.now() - g.fx.id < 5000) {
      document.querySelectorAll(".fxov").forEach((e) => e.remove());
      const fx = document.createElement("div");
      fx.className = "fxov";
      fx.textContent = g.fx.text;
      fx.style.cssText =
        "position:fixed;top:42%;left:50%;transform:translate(-50%,-50%);z-index:260;pointer-events:none;" +
        "font-size:44px;font-weight:bold;color:#ffd84a;white-space:pre-line;text-align:center;line-height:1.2;" +
        "background:rgba(0,0,0,0.6);padding:14px 26px;border-radius:16px;text-shadow:0 2px 6px #000";
      document.body.appendChild(fx);
      setTimeout(() => fx.remove(), 1100);
    }
  }

  // フェーズ最初の説明(全画面)。タップで「読んだ」。全員が読んだらゲームが進む
  document.querySelectorAll(".introov").forEach((e) => e.remove());
  const it = g.intro;
  const iDone = it && ((it.acks && it.acks[uid]) || (spectator && introClosed === it.id));
  if (it && !iDone) {
    const ov = document.createElement("div");
    ov.className = "overlay introov";
    ov.style.cssText = "flex-direction:column;gap:16px;padding:24px;z-index:250;background:rgba(0,0,0,0.9)";
    const t = document.createElement("div");
    t.textContent = it.title;
    t.style.cssText = "font-size:30px;color:#f2c230;font-weight:bold";
    const b = document.createElement("div");
    b.textContent = it.text;
    b.style.cssText = "font-size:17px;color:#fff;font-weight:normal;line-height:1.6;white-space:pre-line;max-width:440px";
    const tap = document.createElement("div");
    tap.textContent = spectator ? "(タップで閉じる)" : "タップして開始";
    tap.style.cssText = "font-size:18px;color:#222;background:#f2c230;border-radius:10px;padding:10px 24px;margin-top:6px";
    ov.appendChild(t);
    ov.appendChild(b);
    ov.appendChild(tap);
    ov.onclick = () => {
      ov.remove();
      if (spectator) introClosed = it.id;
      else onAction({ type: "iack" });
    };
    document.body.appendChild(ov);
  }

  if (g.foul && !(g.foul.acks && g.foul.acks[uid]) && !spectator) {
    const ov = document.createElement("div");
    ov.className = "overlay foulov";
    const t = document.createElement("div");
    t.textContent = "😱 " + g.foul.name + " さん反則負け!";
    ov.appendChild(t);
    const row = document.createElement("div");
    row.className = "hand";
    (g.foul.cards || []).forEach((c) => row.appendChild(cardEl(c, "small")));
    ov.appendChild(row);
    const tap = document.createElement("div");
    tap.className = "small";
    tap.textContent = "(タップで進む)";
    ov.appendChild(tap);
    ov.onclick = () => {
      ov.remove();
      onAction({ type: "ack" });
    };
    document.body.appendChild(ov);
  }

  root.innerHTML = "";

  const bar = document.createElement("div");
  bar.className = "g-bar";
  const deckN = room.deck ? room.deck.length : 0;
  bar.innerHTML =
    "<span>ラウンド <b>" + g.round + " / " + room.settings.rounds + "</b></span>" +
    "<span>ポット <b>" + (g.pot || 0) + "</b></span>" +
    "<span>山札 <b>" + deckN + "</b></span>";
  const leave = document.createElement("button");
  leave.textContent = "ロビーに戻る";
  leave.onclick = onLeave;
  bar.appendChild(leave);
  root.appendChild(bar);

  if (g.phase === "seat" && g.seat) {
    renderSeatPhase(root, g, players, uid, spectator, onAction);
    return;
  }

  let start = order.indexOf(uid);
  if (start < 0) start = 0;
  const rotated = order.slice(start).concat(order.slice(0, start));
  const others = spectator ? rotated : rotated.slice(1);

  const { left, top, right } = splitLayout(others);

  const grid = document.createElement("div");
  grid.className = "g-grid";
  grid.style.gridTemplateColumns = "1fr 2.2fr 1fr"; // 真ん中(場)を広く
  const mk = (cls, ids) => {
    const box = document.createElement("div");
    box.className = cls;
    ids.forEach((id) => {
      if (!players[id]) return;
      const h = hands[id] || [];
      box.appendChild(seatEl(id, players[id], h.length, g, spectator, h));
    });
    return box;
  };
  grid.style.gridTemplateAreas = GRID_AREAS;
  grid.appendChild(mk("g-top", top));
  grid.appendChild(logEl(g, uid, spectator));
  grid.appendChild(mk("g-left", left));

  const field = document.createElement("div");
  field.className = "g-field";
  field.style.minHeight = "170px";
  field.style.fontSize = "15px";
  // しばり・11バックなどの目立つ帯
  const band = (text, bg) => {
    const e = document.createElement("div");
    e.textContent = text;
    e.style.cssText =
      "font-size:18px;font-weight:bold;color:#222;background:" + bg +
      ";border-radius:8px;padding:3px 10px;margin:2px 0;text-align:center";
    field.appendChild(e);
  };
  const jokerSolo = isJokerSingle(g.field || null);
  if (g.lock) {
    const names = g.lock.suits.map((s) => SUIT_MARK[s]).join("");
    let t =
      (g.lock.gek ? "激しばり "
        : g.lock.mode === "both" ? "両しばり "
        : g.lock.pair ? "片しば "
        : "しばり ") + names;
    if (jokerSolo) t += g.lock.suits.includes("S") ? "(♠3のみ)" : "(返せません)";
    band(t, g.lock.gek ? "#ff9a5c" : "#ffd84a");
  } else if (jokerSolo) {
    band("ジョーカー(♠3のみ)", "#d9b3ff");
  }
  if (g.rev) band("11バック中", "#8fd3ff");
  if (g.foul && !g.field) {
    const row = document.createElement("div");
    row.className = "hand";
    (g.foul.cards || []).forEach((c) => row.appendChild(cardEl(c)));
    field.appendChild(row);
  } else if (g.field) {
    const row = document.createElement("div");
    row.className = "hand";
    const js = g.field.jsuits || {};
    g.field.cards.forEach((c) => row.appendChild(cardEl(c, "", js[c])));
    field.appendChild(row);
  } else if (g.phase === "market" && g.market) {
    const mm = g.market;
    const mk2 = g.round + "_" + mm.lap;
    if (marketKey !== mk2) {
      marketKey = mk2;
      marketSel = null;
    }
    const canPick = !spectator && mm.stage === "blind" && (mm.need || []).includes(uid) &&
      (mm.bets || {})[uid] === undefined;
    marketFieldEl(field, mm, players, uid, canPick);
  } else if (g.phase === "bid" && g.bid) {
    bidFieldEl(field, g.bid, players);
  } else if (g.phase === "change") {
    field.textContent = "カードチェンジ中";
  } else {
    field.textContent = "場にカードなし";
  }
  grid.appendChild(field);
  grid.appendChild(mk("g-right", right));
  root.appendChild(grid);

  if (g.phase === "result") {
    const key = g.round + "_" + (g.winner || "none");
    if (winDone !== key) {
      if (winShownId !== key) {
        winShownId = key;
        const w = players[g.winner];
        const ov = document.createElement("div");
        ov.className = "overlay";
        ov.textContent = w
          ? "🎉 " + w.name + " さん上がり!!\n(タップで閉じる)"
          : "ノーゲーム\n(タップで閉じる)";
        ov.onclick = () => {
          ov.remove();
          winDone = key;
          if (lastArgs) renderGame(...lastArgs);
        };
        document.body.appendChild(ov);
      }
    } else if (g.result && !spectator && !(g.result.acks && g.result.acks[uid])) {
      showResult(g, players, onAction);
    }
  }

  if (spectator) {
    const t = document.createElement("div");
    t.className = "me-box";
    t.textContent = "観戦中";
    root.appendChild(t);
    return;
  }

  const inChange = g.phase === "change";
  const inBid = g.phase === "bid" && !!g.bid;
  const inMarket = g.phase === "market" && !!g.market;
  const myTurn = (g.phase === "play" || inChange || inBid || inMarket) && g.turn === uid;
  const info = document.createElement("div");
  info.className = "me-box";
  info.style.fontSize = "17px";
  info.style.fontWeight = "bold";
  info.textContent =
    me.name + "  🪙" + me.coins +
    (g.out && g.out[uid] ? "  【反則負け】" : "") +
    (g.passed && g.passed[uid] ? "  【パス】" : "") +
    (myTurn ? "  ← あなたの番" : "");
  addPoor(info, me);
  root.appendChild(info);
  if (myHand.length && myHand.every((c) => isForbidden(c, !!g.rev))) {
    const w = document.createElement("div");
    w.className = "msg";
    w.textContent = "上がり禁止カードしかありません";
    root.appendChild(w);
  }

  const hd = document.createElement("div");
  hd.className = "hand";
  sortHand(myHand).forEach((c) => {
    const el = cardEl(c);
    if (selected.includes(c)) el.classList.add("sel");
    el.onclick = async () => {
      if (inBid) return;
      if (inMarket) {
        // マーケットで手に入れたカードと交換する手札を選ぶ
        const m = g.market;
        const a = (m.awards || [])[0];
        if (m.stage !== "swap" || !a || a.w !== uid || g.turn !== uid) return;
        const ok = await askChoice(mkCardName(c) + " を捨てて\n" + mkCardName(m.cards[a.c]) + " と交換しますか?", [
          { label: "交換する", value: "yes" },
          { label: "やめる", value: "no" }
        ]);
        if (ok === "yes") onAction({ type: "mswap", cards: [c] });
        return;
      }
      if (selected.includes(c)) {
        selected = selected.filter((x) => x !== c);
      } else if (inChange) {
        selected = [c];
      } else if (selected.length < 3) {
        selected.push(c);
      }
      renderGame(root, room, uid, onLeave, onAction);
    };
    hd.appendChild(el);
  });
  root.appendChild(hd);

  if (inBid) {
    bidControls(root, g, me, uid, (room.settings && room.settings.bidMax) || 5, onAction);
    return;
  }
  if (inMarket) {
    marketControls(root, g, me, uid, players, onAction);
    return;
  }

  const msg = document.createElement("div");
  msg.className = "msg";
  root.appendChild(msg);

  const btns = document.createElement("div");
  btns.className = "g-btns";

  // ===== カードチェンジ中のボタン =====
  if (inChange) {
    const ch = g.change || {};
    const cnt = (ch.counts && ch.counts[uid]) || 0;
    const cost = Math.pow(2, cnt);
    const fin = !!(ch.done && ch.done[uid]);
    const short = (me.coins || 0) < cost;
    const borrowOk = short && (me.coins || 0) >= 1 && canBorrowMe(me);
    const canChange = myTurn && !fin && cnt < 3 && (!short || borrowOk);
    if (myTurn) {
      msg.textContent = "替えるカードを1枚選んでください(コスト " + cost + " コイン)";
    } else if (fin || cnt >= 3) {
      msg.textContent = "あなたのチェンジは終了しました";
    } else {
      msg.textContent = "他の人のチェンジを待っています";
    }
    const chBtn = document.createElement("button");
    chBtn.className = "btn main";
    chBtn.textContent = "チェンジ(" + cost + "コイン)" + (borrowOk ? "・神の手" : "");
    chBtn.disabled = !canChange;
    chBtn.onclick = async () => {
      if (selected.length !== 1) {
        msg.textContent = "替えるカードを1枚選んでください";
        return;
      }
      const card = selected[0];
      if (short) {
        const ok = await askChoice(GOD_ASK + "\n(足りない " + (cost - (me.coins || 0)) + " 枚を借ります)", [
          { label: "借りる", value: "yes" },
          { label: "借りない(パス)", value: "no" }
        ]);
        selected = [];
        if (ok === "yes") onAction({ type: "change", cards: [card], borrow: true });
        else onAction({ type: "cpass" });
        return;
      }
      selected = [];
      onAction({ type: "change", cards: [card] });
    };
    const cpBtn = document.createElement("button");
    cpBtn.className = "btn";
    cpBtn.textContent = "パス(チェンジ終了)";
    cpBtn.disabled = !myTurn;
    cpBtn.onclick = async () => {
      if (canChange && myHand.length && myHand.every((c) => isForbidden(c, false))) {
        const ok = await askChoice(
          "このままだと反則負けになりますが、本当にチェンジしなくていいですか?",
          [
            { label: "チェンジしない(パス)", value: "yes" },
            { label: "やめる", value: "no" }
          ]
        );
        if (ok !== "yes") return;
      }
      selected = [];
      onAction({ type: "cpass" });
    };
    btns.appendChild(chBtn);
    btns.appendChild(cpBtn);
    root.appendChild(btns);
    return;
  }

  // ===== 対戦中のボタン =====
  const playBtn = document.createElement("button");
  playBtn.className = "btn main";
  playBtn.textContent = "出す";
  playBtn.disabled = !myTurn;
  playBtn.onclick = async () => {
    if (canSpe3(g.field || null, g.lock || null, selected)) {
      const c3 = selected.slice();
      selected = [];
      onAction({ type: "play", cards: c3 });
      return;
    }
    const j = judge(selected, g.field || null, !!g.rev);
    if (!j.ok) {
      msg.textContent = j.msg;
      return;
    }
    const cards = selected.slice();
    const jsuits = {};
    const jokers = cards.length >= 2 ? cards.filter(isJoker) : [];
    for (const jk of jokers) {
      const used = Object.values(jsuits).concat(
        cards.filter((c) => !isJoker(c)).map(suitOf)
      );
      const opts = ["S", "H", "D", "C"]
        .filter((s) => !used.includes(s))
        .map((s) => ({ label: SUIT_MARK[s], value: s }));
      jsuits[jk] = await askChoice("ジョーカーのマークは?", opts);
    }
    const sc = suitCheck(cards, jsuits, g.lock || null);
    if (!sc.ok) {
      msg.textContent = sc.msg;
      return;
    }
    if (isFoulFinish(cards, myHand, !!g.rev)) {
      const okk = await askChoice("反則負けになりますがよろしいですか?", [
        { label: "出す(反則負け)", value: "yes" },
        { label: "やめる", value: "no" }
      ]);
      if (okk !== "yes") return;
    }
    let lock = "none";
    let lockSuit = null;
    let gek = false;
    const canGek = (mode) =>
      gekCan(g.field || null, g.lock || null, sc.suits, j.str, cards.length, !!g.rev, mode);
    const yesNo = [
      { label: "発動する", value: "yes" },
      { label: "しない", value: "no" }
    ];
    const ch = lockChoices(g.field || null, sc.suits, cards.length);
    if (g.lock && g.lock.mode === "one" && !g.lock.gek && cards.length === 2 && ch.includes("both")) {
      // 片しばの場で、もう片方のマークも前の札と同じ → 両しばにできる
      const other = sc.suits.filter((s) => !g.lock.suits.includes(s)).map((s) => SUIT_MARK[s]).join("");
      const up = await askChoice("もう片方(" + other + ")もしばりますか?", [
        { label: "しばる(両しばり)", value: "both" },
        { label: "しばらない", value: "none" }
      ]);
      if (up === "both") {
        lock = "both";
        if (canGek("both")) gek = (await askChoice("激しばりしますか?", yesNo)) === "yes";
      }
    } else if (!g.lock) {
      if (ch.length) {
        const opts = [];
        if (cards.length === 1) {
          if (canGek("one")) opts.push({ label: "激しばり", value: "gek" });
          opts.push({ label: "しばる", value: "one" });
        } else {
          opts.push({ label: "片しば", value: "one" });
          if (ch.includes("both")) opts.push({ label: "両しば", value: "both" });
        }
        opts.push({ label: "しばらない", value: "none" });
        const ans = await askChoice("しばりますか?", opts);
        if (ans === "gek") {
          lock = "one";
          gek = true;
        } else {
          lock = ans;
        }
        if (cards.length === 2 && lock === "one") {
          // 片しば: 前の札と同じマークから1つ選ぶ(1つしかなければ自動)
          const common = sc.suits.filter((s) => g.field.suits.includes(s));
          lockSuit = common.length === 1 ? common[0] : await askChoice(
            "どのマークでしばりますか?",
            common.map((s) => ({ label: SUIT_MARK[s], value: s }))
          );
        }
        if (cards.length === 2 && lock === "both" && canGek("both")) {
          gek = (await askChoice("激しばりしますか?", yesNo)) === "yes";
        }
      }
    } else if (!g.lock.gek && canGek(g.lock.mode)) {
      gek = (await askChoice("激しばりしますか?", yesNo)) === "yes";
    }
    // 11バックするか(Jを出したとき。すでに逆転中・上がりのときは聞かない)
    let back = false;
    if (hasNum(cards, 11) && !g.rev && cards.length < myHand.length) {
      back = (await askChoice("11バックしますか?", [
        { label: "バックする", value: "yes" },
        { label: "しない", value: "no" }
      ])) === "yes";
    }
    selected = [];
    onAction({ type: "play", cards, jsuits: jokers.length ? jsuits : null, lock, lockSuit, gek, back });
  };
  const passBtn = document.createElement("button");
  passBtn.className = "btn";
  passBtn.textContent = "パス";
  passBtn.disabled = !myTurn || !g.field;
  passBtn.onclick = () => {
    selected = [];
    onAction({ type: "pass" });
  };
  btns.appendChild(playBtn);
  btns.appendChild(passBtn);
  root.appendChild(btns);
}
