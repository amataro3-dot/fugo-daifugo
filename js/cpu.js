import { findMoves, effStr } from "./rules.js";

export function cpuChoose(hand, field, rev) {
  const moves = findMoves(hand, field, rev);
  if (moves.length === 0) return { type: "pass", cards: [] };
  const finish = moves.find((m) => m.cards.length === hand.length);
  if (finish) return { type: "play", cards: finish.cards };
  moves.sort((a, b) => effStr(a.str, rev) - effStr(b.str, rev));
  return { type: "play", cards: moves[0].cards };
}
