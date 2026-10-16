export const SUITS = ["S", "H", "D", "C"];
export const SUIT_MARK = { S: "♠", H: "♥", D: "♦", C: "♣" };

export function makeLot() {
  const cards = [];
  for (const s of SUITS) {
    for (let n = 1; n <= 13; n++) cards.push(s + n);
  }
  cards.push("JK1", "JK2");
  return cards;
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function isJoker(c) {
  return c.startsWith("JK");
}

export function suitOf(c) {
  return isJoker(c) ? null : c[0];
}

export function numOf(c) {
  return isJoker(c) ? 99 : Number(c.slice(1));
}

export function label(n) {
  return { 1: "A", 11: "J", 12: "Q", 13: "K" }[n] || String(n);
}

export function strength(c) {
  if (isJoker(c)) return 16;
  const n = numOf(c);
  if (n === 1) return 14;
  if (n === 2) return 15;
  return n;
}

export function effStr(s, rev) {
  if (s === 16) return 16;
  return rev ? 18 - s : s;
}

export function sortHand(cards) {
  return cards.slice().sort((a, b) => strength(a) - strength(b) || a.localeCompare(b));
}

export function hasNum(cards, n) {
  const normal = cards.filter((c) => !isJoker(c));
  return normal.length > 0 && numOf(normal[0]) === n;
}

export function judge(cards, field, rev) {
  const n = cards.length;
  if (n < 1 || n > 3) return { ok: false, msg: "1〜3枚で出してください" };
  const normal = cards.filter((c) => !isJoker(c));
  if (normal.length > 0) {
    const num = numOf(normal[0]);
    if (normal.some((c) => numOf(c) !== num)) {
      return { ok: false, msg: "同じ数字のカードを選んでください" };
    }
  }
  const str = normal.length ? strength(normal[0]) : 16;
  if (field) {
    if (field.count !== n) return { ok: false, msg: "場と同じ枚数で出してください" };
    if (effStr(str, rev) <= effStr(field.str, rev)) {
      return { ok: false, msg: "場より強いカードを出してください" };
    }
  }
  return { ok: true, str };
}

export function playSuits(cards, jsuits) {
  const out = [];
  cards.forEach((c) => {
    if (isJoker(c)) {
      const s = jsuits && jsuits[c];
      if (s) out.push(s);
    } else {
      out.push(suitOf(c));
    }
  });
  return out;
}

export function lockOk(suits, lock) {
  if (!lock) return true;
  if (lock.mode === "both") {
    return suits.length === lock.suits.length && lock.suits.every((s) => suits.includes(s));
  }
  return suits.some((s) => lock.suits.includes(s));
}

export function suitCheck(cards, jsuits, lock) {
  const n = cards.length;
  if (n === 1 && isJoker(cards[0])) return { ok: true, suits: [] };
  const suits = playSuits(cards, jsuits);
  if (suits.length !== n) return { ok: false, msg: "ジョーカーのマークを選んでください" };
  if (new Set(suits).size !== n) return { ok: false, msg: "同じマークは重ねられません" };
  if (lock && !lockOk(suits, lock)) {
    return { ok: false, msg: lock.mode === "both" ? "両しばりです" : "しばりです。同じマークを含めてください" };
  }
  return { ok: true, suits };
}

export function lockChoices(field, suits, n) {
  if (!field || !field.suits || field.suits.length !== n || n < 1 || n > 2) return [];
  const common = suits.filter((s) => field.suits.includes(s)).length;
  const out = [];
  if (n === 1 && common === 1) out.push("one");
  if (n === 2) {
    if (common >= 1) out.push("one");
    if (common === 2) out.push("both");
  }
  return out;
}

// ---- ここから新規: スペ3返し・激しばり ----

// 場がジョーカー単体か
export function isJokerSingle(field) {
  return !!field && field.cards.length === 1 && isJoker(field.cards[0]);
}

// スペ3返しができるか(♠以外のしばり中は不可)
export function canSpe3(field, lock, cards) {
  if (!isJokerSingle(field)) return false;
  if (cards.length !== 1 || cards[0] !== "S3") return false;
  if (lock && !lock.suits.includes("S")) return false;
  return true;
}

// 「次の数字」の強さ(11バック中は逆向き)。なければ null
export function nextStr(s, rev) {
  if (s === 16) return null;
  const eff = effStr(s, rev) + 1;
  if (eff > 15) return null;
  return rev ? 18 - eff : eff;
}

// 場と同じマークで、次の数字か
export function gekFollow(field, suits, str, rev) {
  if (!field || !field.suits) return false;
  if (suits.length !== field.suits.length) return false;
  if (!suits.every((s) => field.suits.includes(s))) return false;
  return nextStr(field.str, rev) === str;
}

// 激しばりを発動できる出し方か(mode は今回選んだしばりの種類)
export function gekCan(field, lock, suits, str, n, rev, mode) {
  if (lock && lock.gek) return false;
  if (n < 1 || n > 2) return false;
  if (!gekFollow(field, suits, str, rev)) return false;
  if (n === 1) return true;
  return mode === "both";
}

function assigns(jokers) {
  let res = [{}];
  jokers.forEach((j) => {
    const next = [];
    res.forEach((a) => {
      SUITS.forEach((s) => {
        if (!Object.values(a).includes(s)) next.push(Object.assign({}, a, { [j]: s }));
      });
    });
    res = next;
  });
  return res;
}

export function findMoves(hand, field, rev, lock) {
  const moves = [];
  const n = hand.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const cards = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) cards.push(hand[i]);
    if (cards.length > 3) continue;
    const j = judge(cards, field, rev);
    if (!j.ok) continue;
    const jokers = cards.length >= 2 ? cards.filter(isJoker) : [];
    for (const js of assigns(jokers)) {
      const sc = suitCheck(cards, js, lock || null);
      if (!sc.ok) continue;
      const jokerSingle = cards.length === 1 && isJoker(cards[0]);
      if (lock && lock.gek && !jokerSingle && !gekFollow(field, sc.suits, j.str, rev)) continue;
      moves.push({ cards, str: j.str, jsuits: js, suits: sc.suits });
      break;
    }
  }
  return moves;
}
// ---- 禁止上がり ----
export function isForbidden(c, rev) {
  if (isJoker(c)) return true;
  const n = numOf(c);
  return n === 2 || n === 8 || (rev && n === 3);
}

export function isFoulFinish(cards, hand, rev) {
  return cards.length === hand.length && cards.some((c) => isForbidden(c, rev));
}
