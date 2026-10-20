import {
  findMoves, effStr, lockChoices, canSpe3, gekCan, isFoulFinish, isForbidden, isJoker, judge,
  numOf, strength
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
  let lockSuit = null;
  const ch = lockChoices(field, m.suits, m.cards.length);
  if (!lock) {
    if (ch.length && Math.random() < 0.4) {
      lockMode = ch.includes("both") && Math.random() < 0.5 ? "both" : ch[0];
    }
    if (lockMode === "one" && m.cards.length === 2) {
      // 片しば: 前の札と同じマークから1つ選ぶ
      const common = m.suits.filter((s) => field.suits.includes(s));
      lockSuit = common[Math.floor(Math.random() * common.length)];
    }
  } else if (lock.mode === "one" && !lock.gek && m.cards.length === 2 && ch.includes("both")) {
    // 片しばの場で、もう片方もしばる(両しばにする)
    if (Math.random() < 0.5) lockMode = "both";
  }
  const mode = lockMode === "both" ? "both" : lock ? lock.mode : lockMode;
  if (gekCan(field, lock, m.suits, m.str, m.cards.length, rev, mode) && Math.random() < 0.5) {
    gek = true;
    if (!lock && lockMode === "none") lockMode = "one";
  }
  return { type: "play", cards: m.cards, jsuits: m.jsuits, lock: lockMode, lockSuit, gek };
}

// ===== 親決めオークション =====

// 3枚で一気に上がれる手か(親になれば即上がり)
function instantWin(hand) {
  if (hand.length !== 3) return false;
  return judge(hand, null, false).ok && !isFoulFinish(hand, hand, false);
}

// ブラインド入札の枚数(1〜上限)
export function cpuBid(hand, coins, max) {
  const cap = Math.min(max, coins);
  if (cap <= 1) return 1;
  if (instantWin(hand)) return cap;
  if (coins < 10) return 1;
  const n = 1 + Math.floor(Math.random() * Math.min(3, cap));
  return Math.min(n, cap);
}

// 競り上げで上乗せするか(pay = 今回払う枚数)
export function cpuRaise(hand, coins, pay) {
  if (coins < pay) return false;
  if (instantWin(hand)) return true;
  return pay <= 2 && coins - pay >= 8 && Math.random() < 0.5;
}

// カードチェンジ: 反則負けになりそうな札を替える。コインに余裕がなければパス
export function cpuChange(hand, count, coins, canBorrow) {
  const pass = { type: "cpass", cards: [] };
  const cost = Math.pow(2, count);
  if (count >= 3) return pass;
  const bad = hand.filter((c) => isForbidden(c, false));
  const badNoJoker = bad.filter((c) => !isJoker(c));
  const allBad = hand.length > 0 && bad.length === hand.length;
  const change = (c) => ({ type: "change", cards: [c] });
  if (coins < cost) {
    // コイン不足: 上がり禁止カードしかないときだけ、神の手を借りてチェンジ
    if (allBad && canBorrow && coins >= 1) {
      return { type: "change", cards: [badNoJoker[0] || bad[0]], borrow: true };
    }
    return pass;
  }
  if (allBad) return change(badNoJoker[0] || bad[0]);
  if (coins < cost + 5) return pass;
  if (badNoJoker.length && Math.random() < 0.7) return change(badNoJoker[0]);
  if (count === 0 && Math.random() < 0.3) {
    return change(hand[Math.floor(Math.random() * hand.length)]);
  }
  return pass;
}

// ===== 席決めオークション =====
// 少なめに入札(1〜2枚)、ときどきパス
export function cpuSeatBid(coins, max) {
  const cap = Math.min(max, coins);
  if (cap < 1 || coins < 6 || Math.random() < 0.3) return { type: "spass" };
  return { type: "sbid", n: Math.min(cap, 1 + Math.floor(Math.random() * 2)) };
}

// 親決めの競り上げで、神の手を借りて(借金して)上乗せするか: 親になれば即上がりのときだけ
export function cpuBorrowRaise(hand) {
  return instantWin(hand);
}

// ===== カードマーケット =====

// カードの欲しさ(ジョーカー・♠3・2が高い。手札と同じ数字ならペアになるので高い)
function wantValue(card, hand) {
  let v = 0;
  if (isJoker(card)) v = 9;
  else if (card === "S3") v = 7;
  else if (numOf(card) === 2) v = 5;
  else if (numOf(card) === 1) v = 4;
  else v = (strength(card) - 3) / 4;
  if (!isJoker(card) && hand.some((h) => !isJoker(h) && numOf(h) === numOf(card))) v += 4;
  return v;
}

// ベット: 一番欲しいカードに、少なめに賭ける
export function cpuMarketBet(hand, cards, avail, coins) {
  const pass = { type: "mpass" };
  if (coins < 1 || !avail.length) return pass;
  let best = avail[0];
  avail.forEach((c) => {
    if (wantValue(cards[c], hand) > wantValue(cards[best], hand)) best = c;
  });
  const v = wantValue(cards[best], hand);
  if (v >= 8 && coins >= 6) return { type: "mbet", c: best, n: Math.min(coins, 2 + Math.floor(Math.random() * 2)) };
  if (v >= 6 && coins >= 6) return { type: "mbet", c: best, n: Math.min(coins, 1 + Math.floor(Math.random() * 2)) };
  if (v >= 4 && coins >= 12 && Math.random() < 0.4) return { type: "mbet", c: best, n: 1 };
  return pass;
}

// 交換: いちばん要らない手札を捨てる(ペアになっている札は残す)
export function cpuMarketSwap(hand, newCard) {
  const all = hand.concat([newCard]);
  const score = (c) => {
    let v = strength(c);
    if (!isJoker(c) && all.filter((x) => x !== c && !isJoker(x) && numOf(x) === numOf(c)).length) v += 10;
    if (!isJoker(c) && isForbidden(c, false)) v -= 3;
    return v;
  };
  return hand.slice().sort((a, b) => score(a) - score(b))[0];
}
