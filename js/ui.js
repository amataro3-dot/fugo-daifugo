import { label, SUIT_MARK, isJoker, suitOf, numOf, sortHand } from "./rules.js";

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
  return d;
}

export function renderGame(root, room, uid, onLeave) {
  const g = room.game || {};
  const players = room.players || {};
  const hands = room.hands || {};
  const order = g.order || [];
  const me = players[uid] || {};
  const spectator = !!me.spectator || !order.includes(uid);

  root.innerHTML = "";

  // 上のバー
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

  // 席の並べ方: 自分(観戦者は先頭)から時計回り
  let start = order.indexOf(uid);
  if (start < 0) start = 0;
  const rotated = order.slice(start).concat(order.slice(0, start));
  const others = spectator ? rotated : rotated.slice(1);

  // 上・左・右に振り分ける
  const n = others.length;
  let left = [], top = [], right = [];
  if (n <= 3) {
    top = others;
  } else {
    const side = Math.min(3, Math.floor(n / 3));
    left = others.slice(0, side);
    right = others.slice(n - side).reverse();
    top = others.slice(side, n - side).reverse();
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
  field.textContent = "場(これから作ります)";
  grid.appendChild(field);
  grid.appendChild(mk("g-right", right));
  root.appendChild(grid);

  // 自分の手札
  if (spectator) {
    const t = document.createElement("div");
    t.className = "me-box";
    t.textContent = "観戦中";
    root.appendChild(t);
  } else {
    const info = document.createElement("div");
    info.className = "me-box";
    info.textContent = me.name + "  🪙" + me.coins;
    root.appendChild(info);
    const hd = document.createElement("div");
    hd.className = "hand";
    sortHand(hands[uid] || []).forEach((c) => hd.appendChild(cardEl(c)));
    root.appendChild(hd);
  }
                                            }
