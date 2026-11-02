/* 戻るボタンの確認(Muddy's Games の全ゲーム共通。どのゲームも同じファイル。2026-11-02)
   - Android の戻るボタン(と Safari の左はしスワイプ)で、すぐにページから出ないように確認を出す。
   - ゲームは、画面が変わるたびに BackGuard.set(level, action) を呼ぶ。
     または BackGuard.use(() => [level, action]) で、戻るを押したときに今の画面から決める関数を渡す。
       level 'home' … ルームに入る画面・ゲームの最初の画面。「ホームに戻りますか？」→ はいでサイトのトップへ
       level 'room' … ルームの中(待ちあい)。「ルームから出ますか？」→ はいで action()(ルームから出る)
       level 'game' … ゲーム中。「ゲームをやめますか？」→ はいで action()(1つ前の画面へ)
   - しくみ: 最初に画面にさわったとき、履歴を1つ足しておく。戻るでそれが消えたら(popstate)確認を出し、
     「いいえ」ならもう一度足す。ブラウザのきまりで、一度もさわっていないページでは確認を出せない。 */
(function () {
  const MSG = {
    home: { ja: 'ホームに戻りますか？', en: 'Go back to the home page?', ko: '홈으로 돌아갈까요?' },
    room: { ja: 'ルームから出ますか？', en: 'Leave the room?', ko: '방에서 나갈까요?' },
    game: { ja: 'ゲームをやめますか？', en: 'Quit the game?', ko: '게임을 그만둘까요?' },
  };
  let level = 'home', action = null, pick = null, armed = !!(history.state && history.state.backGuard);   // 読みこみ直したときは、足した履歴が残っている
  function lang() {
    let l = '';
    try { l = localStorage.getItem('muddys-lang') || ''; } catch (e) { /* 読めなくてもよい */ }
    if (!MSG.home[l]) l = (document.documentElement.lang || navigator.language || 'ja').slice(0, 2).toLowerCase();
    return MSG.home[l] ? l : 'ja';
  }
  function homeUrl() { const l = lang(); return l === 'en' ? '/en/' : l === 'ko' ? '/ko/' : '/'; }
  function arm() {
    if (armed) return;
    armed = true;
    try { history.pushState({ backGuard: 1 }, ''); } catch (e) { armed = false; }
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach(t => window.addEventListener(t, arm, { capture: true, passive: true }));
  window.addEventListener('popstate', () => {
    if (!armed) return;
    armed = false;
    if (pick) { try { const r = pick() || []; level = MSG[r[0]] ? r[0] : 'home'; action = r[1] || null; } catch (e) { level = 'home'; action = null; } }
    if (!window.confirm(MSG[level][lang()])) { arm(); return; }
    if (level === 'home' || typeof action !== 'function') { location.href = homeUrl(); return; }
    try { action(); } finally { arm(); }
  });
  window.BackGuard = {
    set(lv, fn) { level = MSG[lv] ? lv : 'home'; action = fn || null; },
    use(fn) { pick = typeof fn === 'function' ? fn : null; },
    get level() { if (pick) { try { const r = pick() || []; return MSG[r[0]] ? r[0] : 'home'; } catch (e) { return 'home'; } } return level; },
  };
})();
