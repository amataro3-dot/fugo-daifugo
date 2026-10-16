import {
  db, auth, ref, get, set, update, remove, onValue,
  onDisconnect, signInAnonymously
} from "./firebase.js";
import { startGame, sendAction, processActions, maybeCpu } from "./host.js";
import { renderGame } from "./ui.js";
const $ = (id) => document.getElementById(id);
const show = (name) => {
  ["entry", "lobby", "game"].forEach((s) =>
    $("screen-" + s).classList.toggle("hidden", s !== name)
  );
};

let uid = null;
let roomId = null;
let roomData = null;
let unsub = null;

function fillSelect(id, from, to) {
  const el = $(id);
  for (let i = from; i <= to; i++) {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = i;
    el.appendChild(o);
  }
}
fillSelect("set-coins", 20, 40);
fillSelect("set-rounds", 5, 12);
fillSelect("set-bidmax", 5, 10);
fillSelect("set-players", 2, 8);
$("set-coins").value = 30;
$("set-rounds").value = 8;
$("set-bidmax").value = 5;
$("set-players").value = 4;

signInAnonymously(auth)
  .then((cred) => {
    uid = cred.user.uid;
    $("status").textContent = "接続OK";
    tryRejoin();
  })
  .catch((e) => {
    $("status").textContent = "接続失敗: " + e.message;
  });

$("btn-create").onclick = async () => {
  const name = $("name-input").value.trim();
  if (!name) return ($("entry-msg").textContent = "名前を入力してください");
  if (!uid) return ($("entry-msg").textContent = "接続中です。少し待ってください");

  let id = null;
  for (let i = 0; i < 20; i++) {
    const c = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    const snap = await get(ref(db, "rooms/" + c + "/meta"));
    if (!snap.exists()) { id = c; break; }
  }
  if (!id) return ($("entry-msg").textContent = "ルームIDを作れませんでした");

  await set(ref(db, "rooms/" + id), {
    meta: { host: uid, started: false, created: Date.now() },
    settings: { coins: 30, rounds: 8, bidMax: 5, players: 4, debt: "on" },
    players: {
      [uid]: { name, ready: false, joinedAt: Date.now(), spectator: false }
    }
  });
  enterRoom(id);
};

$("btn-join").onclick = async () => {
  const name = $("name-input").value.trim();
  const id = $("room-input").value.trim();
  if (!name) return ($("entry-msg").textContent = "名前を入力してください");
  if (!/^\d{4}$/.test(id)) return ($("entry-msg").textContent = "ルームIDは数字4桁です");
  if (!uid) return ($("entry-msg").textContent = "接続中です。少し待ってください");

  const snap = await get(ref(db, "rooms/" + id));
  if (!snap.exists()) return ($("entry-msg").textContent = "その部屋はありません");
  const room = snap.val();
  const players = room.players || {};
  const count = Object.keys(players).length;
  const already = !!players[uid];

  if (!already && count >= 8) return ($("entry-msg").textContent = "満員です(最大8人)");

  if (!already) {
    await set(ref(db, "rooms/" + id + "/players/" + uid), {
      name,
      ready: false,
      joinedAt: Date.now(),
      spectator: !!(room.meta && room.meta.started)
    });
  }
  enterRoom(id);
};

async function tryRejoin() {
  const saved = localStorage.getItem("fugo_room");
  if (!saved) return;
  const snap = await get(ref(db, "rooms/" + saved + "/players/" + uid));
  if (snap.exists()) enterRoom(saved);
  else localStorage.removeItem("fugo_room");
      }
function enterRoom(id) {
  roomId = id;
  localStorage.setItem("fugo_room", id);

  const meRef = ref(db, "rooms/" + id + "/players/" + uid + "/online");
  set(meRef, true);
  onDisconnect(meRef).set(false);

  if (unsub) unsub();
  unsub = onValue(ref(db, "rooms/" + id), (snap) => {
    roomData = snap.val();
    if (!roomData || !roomData.players || !roomData.players[uid]) {
      leaveLocal();
      return;
    }
    ensureHost();
    render();
  });
  show("lobby");
}

function ensureHost() {
  const players = roomData.players || {};
  const host = roomData.meta && roomData.meta.host;
  const hostOk = host && players[host] && players[host].online !== false;
  if (hostOk) return;
  const alive = Object.entries(players)
    .filter(([, p]) => p.online !== false)
    .sort((a, b) => a[1].joinedAt - b[1].joinedAt);
  if (alive.length && alive[0][0] === uid) {
    update(ref(db, "rooms/" + roomId + "/meta"), { host: uid });
  }
}

function isHost() {
  return roomData && roomData.meta && roomData.meta.host === uid;
}

function render() {
  $("lobby-roomid").textContent = roomId;

  const players = roomData.players || {};
  const list = Object.entries(players).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
  const ul = $("player-list");
  ul.innerHTML = "";
  list.forEach(([pid, p]) => {
    const li = document.createElement("li");
    const left = document.createElement("span");
    left.textContent =
      (pid === roomData.meta.host ? "👑 " : "") +
      p.name + (pid === uid ? "(自分)" : "") +
      (p.online === false ? " ※切断中" : "");
    const right = document.createElement("span");
    right.textContent = p.spectator ? "観戦" : p.ready ? "準備OK" : "待機中";
    li.appendChild(left);
    li.appendChild(right);
    ul.appendChild(li);
  });

  const s = roomData.settings || {};
  const host = isHost();
  $("set-coins").value = s.coins;
  $("set-rounds").value = s.rounds;
  $("set-bidmax").value = s.bidMax;
  $("set-players").value = s.players;
  $("set-debt").value = s.debt;
  ["set-coins", "set-rounds", "set-bidmax", "set-players", "set-debt"].forEach(
    (id) => ($(id).disabled = !host)
  );
  $("host-note").textContent = host ? "(あなたが設定できます)" : "(ホストが設定します)";

  const me = players[uid] || {};
  $("btn-ready").textContent = me.ready ? "準備を取り消す" : "準備完了";
  $("btn-ready").classList.toggle("hidden", !!me.spectator);

  const humans = list.filter(([, p]) => !p.spectator);
  const allReady = humans.length > 0 && humans.every(([, p]) => p.ready);
  $("btn-start").classList.toggle("hidden", !host);
  $("btn-start").disabled = !allReady;
  $("lobby-msg").textContent =
    host && !allReady ? "全員が準備完了になるとスタートできます" : "";

    if (roomData.meta.started) {
    show("game");
        renderGame($("game-root"), roomData, uid, onLeaveGame, (act) =>
      sendAction(roomId, uid, act)
    );
    if (isHost()) {
      processActions(roomId, () => roomData);
      maybeCpu(roomId, () => roomData);
    }
  } else {
    show("lobby");
    }
}
  function onLeaveGame() {
  if (!confirm("本当に退出しますか?")) return;
  $("btn-leave").onclick();
}
["set-coins", "set-rounds", "set-bidmax", "set-players"].forEach((id) => {
  $(id).onchange = () => {
    if (!isHost()) return;
    const key = {
      "set-coins": "coins",
      "set-rounds": "rounds",
      "set-bidmax": "bidMax",
      "set-players": "players"
    }[id];
    update(ref(db, "rooms/" + roomId + "/settings"), { [key]: Number($(id).value) });
  };
});

$("set-debt").onchange = () => {
  if (!isHost()) return;
  update(ref(db, "rooms/" + roomId + "/settings"), { debt: $("set-debt").value });
};

$("btn-ready").onclick = () => {
  const me = roomData.players[uid];
  update(ref(db, "rooms/" + roomId + "/players/" + uid), { ready: !me.ready });
};

$("btn-start").onclick = () => {
  if (!isHost()) return;
    startGame(roomId, roomData);
};

$("btn-leave").onclick = async () => {
  if (!confirm("本当に退出しますか?")) return;
  const id = roomId;
  const rest = Object.keys((roomData && roomData.players) || {}).filter((k) => k !== uid);
  if (unsub) unsub();
  unsub = null;
  onDisconnect(ref(db, "rooms/" + id + "/players/" + uid + "/online")).cancel();
  if (rest.length === 0) await remove(ref(db, "rooms/" + id));
  else await remove(ref(db, "rooms/" + id + "/players/" + uid));
  leaveLocal();
};

function leaveLocal() {
  if (unsub) unsub();
  unsub = null;
  roomId = null;
  roomData = null;
  localStorage.removeItem("fugo_room");
  show("entry");
}
