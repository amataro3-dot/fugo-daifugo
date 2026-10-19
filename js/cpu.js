import {
  findMoves, effStr, lockChoices, canSpe3, gekCan, isFoulFinish, isForbidden, isJoker
} from "./rules.js";

export function cpuChoose(hand, field, rev, lock) {
  if (hand.includes("S3") && canSpe3(field, lock, ["S3"])) {
    return { type: "play", cards: ["S3"], jsuits: null, lock: "none", gek: false };
  }
  const all = findMoves(hand, field, rev, lock);
  const moves = all.filter((x) => !isFoulFinish(x.cards, hand, rev));
  if (moves.length === 0) {
    if (field || all.length === 0) return { type: "pass", cards: [] };
    moves.push(all[0]);
  }
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

// カードチェンジ: 反則負けになりそうな札を替える。コインに余裕がなければパス
export function cpuChange(hand, count, coins) {
  const pass = { type: "cpass", cards: [] };
  const cost = Math.pow(2, count);
  if (count >= 3 || coins < cost) return pass;
  const bad = hand.filter((c) => isForbidden(c, false));
  const badNoJoker = bad.filter((c) => !isJoker(c));
  const allBad = hand.length > 0 && bad.length === hand.length;
  const change = (c) => ({ type: "change", cards: [c] });
  if (allBad) return change(badNoJoker[0] || bad[0]);
  if (coins < cost + 5) return pass;
  if (badNoJoker.length && Math.random() < 0.7) return change(badNoJoker[0]);
  if (count === 0 && Math.random() < 0.3) {
    return change(hand[Math.floor(Math.random() * hand.length)]);
  }
  return pass;
}
