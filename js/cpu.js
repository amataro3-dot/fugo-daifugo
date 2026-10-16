import { findMoves, effStr, lockChoices } from "./rules.js";

export function cpuChoose(hand, field, rev, lock) {
  const moves = findMoves(hand, field, rev, lock);
  if (moves.length === 0) return { type: "pass", cards: [] };
  let m = moves.find((x) => x.cards.length === hand.length);
  if (!m) {
    moves.sort((a, b) => effStr(a.str, rev) - effStr(b.str, rev));
    m = moves[0];
  }
  let lockMode = "none";
  if (!lock) {
    const ch = lockChoices(field, m.suits, m.cards.length);
    if (ch.length && Math.random() < 0.4) lockMode = ch[0];
  }
  return { type: "play", cards: m.cards, jsuits: m.jsuits, lock: lockMode };
}
