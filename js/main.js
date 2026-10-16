import { auth, signInAnonymously } from "./firebase.js";

const status = document.getElementById("status");

signInAnonymously(auth)
  .then((cred) => {
    status.textContent = "接続成功!ID: " + cred.user.uid.slice(0, 6);
  })
  .catch((e) => {
    status.textContent = "接続失敗: " + e.message;
  });
