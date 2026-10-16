import { findMoves } from "./rules.js";

// 今は簡単版: 上がれるなら上がる。なければいちばん弱い手を出す。なければパス
export function cpuChoose(hand, field) {
  const moves = findMoves(hand, field);
  if (moves.length === 0) return { type: "pass", cards: [] };
  const finish = moves.find((m) => m.cards.length === hand.length);
  if (finish) return { type: "play", cards: finish.cards };
  moves.sort((a, b) => a.str - b.str);
  return { type: "play", cards: moves[0].cards };
}
