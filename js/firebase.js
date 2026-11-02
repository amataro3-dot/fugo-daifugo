import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getDatabase, ref, get, set, update, remove, onValue,
  onDisconnect, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js";

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

// App Check: 「本物のゲームのページから来た」ことを、Google の reCAPTCHA で確かめる。
// サイトキーは公開してよいもの(fugo-daifugo プロジェクトのキー。富豪大富豪と GRAB & RUN! で同じ)。
// うまくいかなくても、ゲームは続ける(ただし Firebase で「適用」したあとは、データベースに入れない)。
const APP_CHECK_SITE_KEY = "6Lf8UAwuAAAAAHy3r01-9YU5w5pDO7jdyYPJdzBI";
try {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
} catch (e) {
  console.warn("App Check を始められませんでした", e);
}
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
