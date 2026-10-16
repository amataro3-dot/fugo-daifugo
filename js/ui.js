import {
  label, SUIT_MARK, isJoker, suitOf, numOf, sortHand, judge, suitCheck,
  lockChoices, canSpe3, gekCan, isFoulFinish, isForbidden
} from "./rules.js";

let selected = [];
let lastNoteId = null;
let winShownId = null;

export function cardEl(c, cls) {
  const d = document.createElement("div");
  d.className = "card " + (cls || "");
  if (c === "back") {
    d.classList.add("back");
    return d;
  }
  if (isJoker(c)) {
    d.classList.add("joker");
    d.textContent = "JOKER";
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
  if (game.turn === id) d.classList.add("turn");
  const nm = document.createElement("div");
  nm.className = "nm";
  nm.textContent = (p.debt > 0 ? "㊎ " : "") + p.name;
  const coin = document.createElement("div");
  coin.className = "coin";
  coin.textContent = "🪙" + p.coins;
  const backs = document.createElement("div");
  backs.className = "backs";
  if (openHand) {
    sortHand(hand || []).forEach((c) => backs.appendChild(cardEl(c, "mini")));
  } else {
    for (let i = 0; i < count; i++) backs.appendChild(cardEl("back", "mini"));
  }
  d.appendChild(nm);
  d.appendChild(coin);
  d.appendChild(backs);
  if (game.out && game.out[id]) {
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
export function renderGame(root, room, uid, onLeave, onAction) {
  const g = room.game || {};
  const players = room.players || {};
  const hands = room.hands || {};
  const order = g.order || [];
  const me = players[uid] || {};
  const spectator = !!me.spectator || !order.includes(uid);

  const myHand = hands[uid] || [];
  selected = selected.filter((c) => myHand.includes(c));

  if (g.notice && g.notice.id !== lastNoteId) {
    lastNoteId = g.notice.id;
    const pop = document.createElement("div");
    pop.className = "popup";
    pop.textContent = g.notice.text;
    document.body.appendChild(pop);
    setTimeout(() => pop.remove(), 2200);
  }

    document.querySelectorAll(".foulov").forEach((e) => e.remove());
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

  let start = order.indexOf(uid);
  if (start < 0) start = 0;
  const rotated = order.slice(start).concat(order.slice(0, start));
  const others = spectator ? rotated : rotated.slice(1);

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

  const grid = document.createElement("div");
  grid.className = "g-grid";
  const mk = (cls, ids) => {
    const box = document.createElement("div");
    box.className = cls;
    ids.forEach((id) => {
      const h = hands[id] || [];
      box.appendChild(seatEl(id, players[id], h.length, g, spectator, h));
    });
    return box;
  };
  grid.appendChild(mk("g-top", top));
  grid.appendChild(mk("g-left", left));

  const field = document.createElement("div");
  field.className = "g-field";
  if (g.lock) {
    const lk = document.createElement("div");
    lk.className = "revmark";
    const names = g.lock.suits.map((s) => SUIT_MARK[s]).join("");
    lk.textContent =
      (g.lock.gek ? "激しばり " : g.lock.mode === "both" ? "両しばり " : "しばり ") + names;
    field.appendChild(lk);
  }
  if (g.rev) {
    const rv = document.createElement("div");
    rv.className = "revmark";
    rv.textContent = "11バック中";
    field.appendChild(rv);
  }
    if (g.foul && !g.field) {
    const row = document.createElement("div");
    row.className = "hand";
    (g.foul.cards || []).forEach((c) => row.appendChild(cardEl(c, "small")));
    field.appendChild(row);
  } else if (g.field) {
    const row = document.createElement("div");
    row.className = "hand";
    g.field.cards.forEach((c) => row.appendChild(cardEl(c, "small")));
    field.appendChild(row);
  } else {
    field.textContent = "場にカードなし";
  }
  if (g.phase === "result" && winShownId !== g.winner + "_" + g.round) {
    winShownId = g.winner + "_" + g.round;
    const w = players[g.winner];
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.textContent = w
      ? "🎉 " + w.name + " さん上がり!!\n(タップで閉じる)"
      : "ノーゲーム\n(タップで閉じる)";
    ov.onclick = () => ov.remove();
    document.body.appendChild(ov);
  }
  grid.appendChild(field);
  grid.appendChild(mk("g-right", right));
  root.appendChild(grid);

  if (spectator) {
    const t = document.createElement("div");
    t.className = "me-box";
    t.textContent = "観戦中";
    root.appendChild(t);
    return;
  }

  const myTurn = g.phase === "play" && g.turn === uid;
  const info = document.createElement("div");
  info.className = "me-box";
  info.textContent =
    me.name + "  🪙" + me.coins +
    (g.out && g.out[uid] ? "  【反則負け】" : "") +
    (g.passed && g.passed[uid] ? "  【パス】" : "") +
    (myTurn ? "  ← あなたの番" : "");
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
    el.onclick = () => {
      if (selected.includes(c)) selected = selected.filter((x) => x !== c);
      else if (selected.length < 3) selected.push(c);
      renderGame(root, room, uid, onLeave, onAction);
    };
    hd.appendChild(el);
  });
  root.appendChild(hd);

  const msg = document.createElement("div");
  msg.className = "msg";
  root.appendChild(msg);

  const btns = document.createElement("div");
  btns.className = "g-btns";
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
    let gek = false;
    const canGek = (mode) =>
      gekCan(g.field || null, g.lock || null, sc.suits, j.str, cards.length, !!g.rev, mode);
    const yesNo = [
      { label: "発動する", value: "yes" },
      { label: "しない", value: "no" }
    ];
    if (!g.lock) {
      const ch = lockChoices(g.field || null, sc.suits, cards.length);
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
        if (cards.length === 2 && lock === "both" && canGek("both")) {
          gek = (await askChoice("激しばりしますか?", yesNo)) === "yes";
        }
      }
    } else if (!g.lock.gek && canGek(g.lock.mode)) {
      gek = (await askChoice("激しばりしますか?", yesNo)) === "yes";
    }
    selected = [];
    onAction({ type: "play", cards, jsuits: jokers.length ? jsuits : null, lock, gek });
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
