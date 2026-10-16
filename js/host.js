import { db, ref, get, set, update } from "./firebase.js";
import { makeLot, shuffle } from "./rules.js";

// 山札から n 枚引く。足りなければ新しい54枚で続行する
function draw(state, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!state.deck || state.deck.length === 0) {
      state.deck = shuffle(makeLot());
      state.lot = (state.lot || 0) + 1;
      state.notice = "次のロットを使用します";
    }
    out.push(state.deck.shift());
  }
  return out;
}

// ゲーム開始: 席決め・コンピューター補充・配札(ホストだけが呼ぶ)
export async function startGame(roomId, roomData) {
  const settings = roomData.settings;
  const players = roomData.players || {};

  // 参加する人(観戦者以外)
  const humans = Object.entries(players)
    .filter(([, p]) => !p.spectator)
    .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
    .map(([id]) => id);

  // 人数が多すぎるときは、後から入った人を観戦に
  const limit = settings.players;
  const playing = humans.slice(0, limit);
  const watchers = humans.slice(limit);

  // 足りない分はコンピューター
  const cpus = [];
  for (let i = playing.length; i < limit; i++) cpus.push("cpu" + (i + 1));

  const seatOrder = shuffle(playing.concat(cpus));

  const state = { deck: shuffle(makeLot()), lot: 1, notice: "" };
  const updates = {};

  seatOrder.forEach((id, i) => {
    const isCpu = id.startsWith("cpu");
    const hand = draw(state, 3);
    updates["hands/" + id] = hand;
    if (isCpu) {
      updates["players/" + id] = {
        name: "CPU" + (i + 1), cpu: true, coins: settings.coins,
        debt: 0, debtTotal: 0, seat: i, ready: true,
        joinedAt: Date.now() + i, spectator: false, online: true
      };
    } else {
      updates["players/" + id + "/coins"] = settings.coins;
      updates["players/" + id + "/debt"] = 0;
      updates["players/" + id + "/debtTotal"] = 0;
      updates["players/" + id + "/seat"] = i;
    }
  });
  watchers.forEach((id) => {
    updates["players/" + id + "/spectator"] = true;
  });

  updates["deck"] = state.deck;
  updates["lot"] = state.lot;
  updates["game"] = {
    round: 1, phase: "deal", pot: 0, order: seatOrder
  };
  updates["meta/started"] = true;

  await update(ref(db, "rooms/" + roomId), updates);
               }
