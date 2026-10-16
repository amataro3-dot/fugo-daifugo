// カード: "S3" = ♠3 / "H12" = ♡Q / "JK1","JK2" = ジョーカー
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

// 表示用の文字: 1→A, 11→J, 12→Q, 13→K
export function label(n) {
  return { 1: "A", 11: "J", 12: "Q", 13: "K" }[n] || String(n);
}

// 強さ: 3<4<...<K<A<2<ジョーカー(通常時)
export function strength(c) {
  if (isJoker(c)) return 16;
  const n = numOf(c);
  if (n === 1) return 14;
  if (n === 2) return 15;
  return n;
}

// 手札の並べ替え用(弱い順)
export function sortHand(cards) {
  return cards.slice().sort((a, b) => strength(a) - strength(b) || a.localeCompare(b));
}
