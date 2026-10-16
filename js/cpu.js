import { findMoves, effStr, lockChoices, canSpe3, gekCan } from "./rules.js";

export function cpuChoose(hand, field, rev, lock) {
  if (hand.includes("S3") && canSpe3(field, lock, ["S3"])) {
    return { type: "play", cards: ["S3"], jsuits: null, lock: "none", gek: false };
  }
  const moves = findMoves(hand, field, rev, lock);
  if (moves.length === 0) return { type: "pass", cards: [] };
  let m = moves.find((x) => x.cards.length === hand.length);
  if (!m) {
    moves.sort((a, b) => effStr(a.str, rev) - effStr(b.str, rev));
    m = moves[0];
  }
  let lockMode = "none";
  let gek = false;
  if (!lock) {
    const ch = lockChoices(field, m.suits, m.cards.length);
    if (ch.length && Math.random() < 0.4) {
      lockMode = ch.includes("both") && Math.random() < 0.5 ? "both" : ch[0];
    }
  }
  const mode = lock ? lock.mode : lockMode;
  if (gekCan(field, lock, m.suits, m.str, m.cards.length, rev, mode) && Math.random() < 0.5) {
    gek = true;
    if (!lock && lockMode === "none") lockMode = "one";
  }
  return { type: "play", cards: m.cards, jsuits: m.jsuits, lock: lockMode, gek };
}
