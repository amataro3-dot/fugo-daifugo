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

// 11バック中は強弱が逆転(ジョーカーは常に最強)
export function effStr(s, rev) {
  if (s === 16) return 16;
  return rev ? 18 - s : s;
}

export function sortHand(cards) {
  return cards.slice().sort((a, b) => strength(a) - strength(b) || a.localeCompare(b));
}

// 出したカードに、指定の数字が含まれるか(ジョーカーは一緒に出した数字の扱い)
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

export function findMoves(hand, field, rev) {
  const moves = [];
  const n = hand.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const cards = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) cards.push(hand[i]);
    if (cards.length > 3) continue;
    const j = judge(cards, field, rev);
    if (j.ok) moves.push({ cards, str: j.str });
  }
  return moves;
}
