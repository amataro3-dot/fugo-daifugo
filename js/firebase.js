import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getDatabase, ref, get, set, update, remove, onValue,
  onDisconnect, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCCA_IKQNNVfYrXNsE24VbDgVySrAZiiDA",
  authDomain: "fugo-daifugo.firebaseapp.com",
  databaseURL: "https://fugo-daifugo-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "fugo-daifugo",
  storageBucket: "fugo-daifugo.firebasestorage.app",
  messagingSenderId: "798672656087",
  appId: "1:798672656087:web:2b0fe52939d6e388008292"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

// サーバーの時刻(スマホごとの時計のずれをなくす。切断の3分を数えるのに使う)
let serverOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
  serverOffset = Number(snap.val()) || 0;
});
export function serverNow() {
  return Date.now() + serverOffset;
}

export {
  ref, get, set, update, remove, onValue,
  onDisconnect, serverTimestamp, runTransaction, signInAnonymously
};
