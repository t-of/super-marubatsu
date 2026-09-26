'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'super-marubatsu.' で始める。
const STORE = 'super-marubatsu.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}
function drop(key) {
  try { localStorage.removeItem(STORE + key); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'スーパーマルバツゲーム', text: '9 つの三目並べを 3×3 に並べた「スーパー三目並べ」（英語では Ultimate Tic-Tac-Toe）。打ったマスの位置で相手が次に打つ盤が決まるので、先を読んで送り込む。1 台の端末でふたり対戦。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// iPhone のマナーモードでも音を出す（RULES.md §5「音」）。音がオンのときだけ 'playback' にする
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----
const $ = (id) => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const G = SMGame;
const at = (b, c) => b * 9 + c;

// 読めない・範囲外の値ははじめの値に戻す（第 2 版で項目が増えても、第 1 版の記録はそのまま読める）
function loadSettings() {
  const s = load('settings', {}) || {};
  return {
    v: 1,
    sound: typeof s.sound === 'boolean' ? s.sound : true,
    volume: typeof s.volume === 'number' && s.volume >= 0 && s.volume <= 1 ? s.volume : 0.7,
    confirm: s.confirm === true,
    coached: s.coached === true,
  };
}
function loadStats() {
  const p = (load('stats', {}) || {}).pvp || {};
  const n = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);
  return { v: 1, pvp: { x: n(p.x), o: n(p.o), d: n(p.d) } };
}
let settings = loadSettings();
let stats = loadStats();

function loadSavedGame() {
  const g = load('game', null);
  if (!g || !Array.isArray(g.moves) || g.moves.length === 0) return null;
  const s = G.replay(g.moves);
  if (s.over || s.moves.length === 0) return null;   // 終わっていた・全部捨てられたなら続きはない
  s.undos = Number.isInteger(g.undos) && g.undos >= 0 ? g.undos : 0;
  return s;
}
function saveGame(s) {
  save('game', { v: 1, mode: 'pvp', moves: s.moves, undos: s.undos || 0 });
}

// ---- 効果音（Web Audio で作る。音声ファイルは使わない） ----
const Sound = {
  ctx: null, out: null,
  ensure() {
    if (!settings.sound) return null;
    if (!this.ctx || this.ctx.state === 'suspended') setAudioSession(true);
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      this.out = this.ctx.createGain();
      this.out.gain.value = settings.volume;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  setVolume(v) { if (this.out) this.out.gain.value = v; },
  tone(freq, dur, { type = 'sine', gain = 0.09, at = 0, bend = 1 } = {}) {
    const c = this.ensure();
    if (!c) return;
    const t = c.currentTime + at;
    const o = c.createOscillator(), v = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (bend !== 1) o.frequency.exponentialRampToValueAtTime(freq * bend, t + dur);
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(v).connect(this.out);
    o.start(t); o.stop(t + dur + 0.05);
  },
  click() { this.tone(1500, 0.03, { gain: 0.045 }); },
  tapPending() { this.tone(1100, 0.025, { gain: 0.03 }); },
  put(p) { this.tone(p === 0 ? 700 : 480, 0.07, { gain: 0.1, bend: 0.93 }); },
  bad() { this.tone(120, 0.09, { type: 'triangle', gain: 0.08 }); },
  free() { [900, 1200].forEach((f, i) => this.tone(f, 0.09, { gain: 0.05, at: i * 0.07 })); },
  boardTaken() { [523, 659, 784].forEach((f, i) => this.tone(f, 0.16, { type: 'triangle', gain: 0.06, at: i * 0.07 })); },
  boardDraw() { this.tone(392, 0.2, { type: 'triangle', gain: 0.05 }); },
  undo() { this.tone(400, 0.12, { type: 'triangle', gain: 0.06, bend: 0.6 }); },
  win() { [523, 659, 784, 880, 1046].forEach((f, i) => this.tone(f, 0.2, { type: 'triangle', gain: 0.07, at: i * 0.08 })); },
  draw() { [494, 440].forEach((f, i) => this.tone(f, 0.2, { type: 'triangle', gain: 0.06, at: i * 0.15 })); },
};
setAudioSession(settings.sound);
document.addEventListener('pointerdown', () => Sound.ensure(), { capture: true });
document.addEventListener('click', (e) => { if (e.target.closest('button:not(.cell)')) Sound.click(); });

function renderSound() {
  document.querySelectorAll('#sound-btn, #menu-sound').forEach((b) => {
    b.setAttribute('aria-pressed', settings.sound);
    b.querySelector('span').textContent = settings.sound ? (b.id === 'sound-btn' ? '音 オン' : 'オン') : (b.id === 'sound-btn' ? '音 オフ' : 'オフ');
  });
}
function toggleSound() {
  settings = { ...settings, sound: !settings.sound };
  save('settings', settings);
  setAudioSession(settings.sound);
  renderSound();
}
$('sound-btn').addEventListener('click', toggleSound);
$('menu-sound').addEventListener('click', toggleSound);
renderSound();

$('menu-volume').value = settings.volume;
$('menu-volume').addEventListener('input', (e) => {
  settings = { ...settings, volume: +e.target.value };
  save('settings', settings);
  Sound.setVolume(settings.volume);
});

function renderConfirm() {
  const b = $('menu-confirm');
  b.setAttribute('aria-pressed', settings.confirm);
  b.querySelector('span').textContent = settings.confirm ? 'オン' : 'オフ';
}
$('menu-confirm').addEventListener('click', () => {
  settings = { ...settings, confirm: !settings.confirm };
  save('settings', settings);
  pending = -1;
  renderConfirm();
  render();
});
renderConfirm();

// ---- 盤（対局とタイトルの見本で同じものを使う） ----
const SVG = 'http://www.w3.org/2000/svg';
const center = (i) => [(i % 3) * 100 / 3 + 50 / 3, Math.floor(i / 3) * 100 / 3 + 50 / 3];

function markEl(p, cls = '') {
  const m = document.createElementNS(SVG, 'svg');
  m.setAttribute('viewBox', '0 0 100 100');
  m.setAttribute('class', `mark ${p === 0 ? 'x' : 'o'} ${cls}`.trim());
  m.innerHTML = p === 0
    ? '<path class="glyph" d="M25 25 75 75M75 25 25 75"/>'
    : '<circle class="glyph" cx="50" cy="50" r="30"/>';
  return m;
}

function buildBoard(tag) {
  const el = document.createElement('div');
  el.className = 'board';
  const subs = [];
  for (let b = 0; b < 9; b++) {
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.style.gridArea = `${Math.floor(b / 3) + 1} / ${(b % 3) + 1}`;
    const cells = [];
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement(tag);
      cell.className = 'cell';
      cell.style.gridArea = `${Math.floor(c / 3) + 1} / ${(c % 3) + 1}`;
      if (tag === 'button') cell.setAttribute('aria-label', `${Math.floor(b / 3) * 3 + Math.floor(c / 3) + 1} 番目のマス`);
      sub.append(cell);
      cells.push(cell);
    }
    const owner = document.createElement('div');
    owner.className = 'sub-owner';
    sub.append(owner);
    el.append(sub);
    subs.push({ el: sub, cells, owner });
  }
  const win = document.createElementNS(SVG, 'svg');
  win.setAttribute('class', 'board__win');
  win.setAttribute('viewBox', '0 0 100 100');
  win.innerHTML = '<line/>';
  el.append(win);
  return { el, subs, win: win.querySelector('line') };
}

// 盤を s に合わせて描く。interactive: 対局盤なら true（ボタンの押せる/押せないを更新する）
function paint(view, s, interactive) {
  const legal = G.legalBoards(s);
  const lastMove = s.moves.length ? s.moves[s.moves.length - 1] : -1;
  for (let b = 0; b < 9; b++) {
    const sub = view.subs[b];
    const owner = G.boardOwner(s, b);
    const drawn = G.boardDrawn(s, b);
    sub.el.classList.toggle('playable', !s.over && legal.includes(b));
    sub.el.classList.toggle('taken', owner >= 0);
    sub.el.classList.toggle('drawn', drawn);
    sub.el.classList.toggle('owner-x', owner === 0);
    sub.el.classList.toggle('owner-o', owner === 1);
    sub.owner.replaceChildren();
    if (owner >= 0) sub.owner.append(markEl(owner));
    for (let c = 0; c < 9; c++) {
      const cell = sub.cells[c];
      const m = b * 9 + c;
      const v = G.cellAt(s, b, c);
      cell.replaceChildren();
      if (v >= 0) cell.append(markEl(v));
      else if (m === pending) cell.append(markEl(s.turn, 'pending'));
      cell.classList.toggle('last', m === lastMove);
      if (interactive) cell.disabled = s.over || v >= 0 || !sub.el.classList.contains('playable');
    }
  }
  if (s.line) {
    const [a, z] = [center(s.line[0]), center(s.line[2])];
    view.win.setAttribute('x1', a[0]); view.win.setAttribute('y1', a[1]);
    view.win.setAttribute('x2', z[0]); view.win.setAttribute('y2', z[1]);
    view.el.dataset.win = s.winner === 0 ? 'x' : 'o';
  } else {
    view.el.removeAttribute('data-win');
  }
}

// ---- 対局 ----
const view = buildBoard('button');
view.el.id = 'board';
document.querySelector('.board-wrap').append(view.el);
view.subs.forEach((sub, b) => sub.cells.forEach((cell, c) => cell.addEventListener('click', () => tap(at(b, c)))));

let g = null;
let pending = -1;   // 確定タップの 1 回目（マス番号）。-1 なら何もない
let flashTimer = 0;

function flashDestination(board) {
  if (reduced.matches) return;   // 光の動きは止め、明るくなるだけにする（すでに playable のハイライトで示される）
  const sub = view.subs[board];
  sub.el.classList.remove('flash');
  void sub.el.offsetWidth;
  sub.el.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => sub.el.classList.remove('flash'), 500);
}

function tap(m) {
  if (!g || g.over) return;
  if (!G.canPlace(g, m)) {
    Sound.bad();
    const cell = view.subs[(m / 9) | 0].cells[m % 9];
    cell.classList.remove('shake');
    void cell.offsetWidth;
    cell.classList.add('shake');
    return;
  }
  if (settings.confirm && pending !== m) {
    pending = m;
    Sound.tapPending();
    render();
    return;
  }
  pending = -1;
  commit(m);
}

function commit(m) {
  const wasFree = G.freeTurn(g);
  const board = (m / 9) | 0;
  const p = g.turn;
  G.place(g, m);
  Sound.put(p);
  if (G.boardOwner(g, board) >= 0) Sound.boardTaken();
  else if (G.boardDrawn(g, board)) Sound.boardDraw();
  if (!g.over && G.freeTurn(g) && !wasFree) Sound.free();
  if (!g.over && g.next >= 0) flashDestination(g.next);
  if (g.over) { drop('game'); finish(); } else { saveGame(g); render(); }
}

function undoMove() {
  if (!g || g.moves.length === 0) return;
  pending = -1;
  const undos = (g.undos || 0) + 1;
  g = G.undo(g);
  g.undos = undos;
  Sound.undo();
  $('result').hidden = true;
  saveGame(g);
  render();
}
$('undo-btn').addEventListener('click', undoMove);

function render() {
  paint(view, g, true);
  $('turn').textContent = g.over ? (g.draw ? '引き分け' : `${g.winner === 0 ? '×' : '○'} が 3 つ並んだ`) : `${g.turn === 0 ? '×' : '○'} の番`;
  $('ply').textContent = `${g.moves.length} 手`;
  $('free-turn').hidden = g.over || !G.freeTurn(g);
  $('undo-btn').disabled = g.moves.length === 0;
}

// ---- 画面 ----
function show(screen) {
  $('title').hidden = screen !== 'title';
  $('game').hidden = screen !== 'game';
}

function renderTitleStats() {
  const { x, o, d } = stats.pvp;
  $('stats').textContent = x + o + d
    ? `ふたり対戦　× ${x} 勝 ・ ○ ${o} 勝 ・ 引き分け ${d}`
    : '';
  const saved = loadSavedGame();
  $('continue').hidden = !saved;
}

function startNewGame() {
  g = G.newGame();
  g.undos = 0;
  drop('game');
  $('result').hidden = true;
  show('game');
  render();
}

function resumeGame() {
  const saved = loadSavedGame();
  if (!saved) return startNewGame();
  g = saved;
  $('result').hidden = true;
  show('game');
  render();
}

function play() {
  if (settings.coached) { save('settings', settings); return startNewGame(); }
  settings = { ...settings, coached: true };
  save('settings', settings);
  openHelp(startNewGame);
}
$('play-pvp').addEventListener('click', play);
$('continue').addEventListener('click', resumeGame);

function toTitle() {
  g = null;
  $('menu').close();
  renderTitleStats();
  show('title');
}

function finish() {
  let head;
  if (g.draw) { head = '引き分け'; Sound.draw(); }
  else { head = `${g.winner === 0 ? '×' : '○'} の勝ち`; Sound.win(); }
  const r = g.draw ? 'd' : g.winner === 0 ? 'x' : 'o';
  stats = { v: 1, pvp: { ...stats.pvp, [r]: stats.pvp[r] + 1 } };
  save('stats', stats);
  $('result-head').textContent = head;
  $('result-head').className = `result__head ${g.draw ? '' : g.winner === 1 ? 'o' : ''}`;
  const undoNote = g.undos ? `　（1 手戻す: ${g.undos} 回）` : '';
  $('result-sub').textContent = `${g.moves.length} 手${undoNote}`;
  $('result').hidden = false;
  render();
  const buttons = $('result').querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  setTimeout(() => buttons.forEach((b) => { b.disabled = false; }), 500);
}

function shareText() {
  if (g.draw) return `スーパーマルバツゲームのふたり対戦、引き分け（${g.moves.length} 手）`;
  return `スーパーマルバツゲームのふたり対戦、${g.winner === 0 ? '×' : '○'} の勝ち（${g.moves.length} 手）`;
}
$('again').addEventListener('click', startNewGame);
$('share-result').addEventListener('click', () => WebAppKit.share({ text: shareText(), url: 'https://t-of.github.io/super-marubatsu/' }));
$('to-title').addEventListener('click', toTitle);
$('peek').addEventListener('click', () => { $('result').hidden = true; });

// ---- 遊び方 ----
const help = $('help');
let afterHelp = null;
function openHelp(then = null) { afterHelp = then; help.showModal(); }
help.addEventListener('close', () => { const f = afterHelp; afterHelp = null; if (f) f(); });
$('help-close').addEventListener('click', () => help.close());
$('howto').addEventListener('click', () => openHelp());

// ---- メニュー ----
const menu = $('menu');
$('menu-open').addEventListener('click', () => menu.showModal());
$('menu-open2').addEventListener('click', () => menu.showModal());
$('menu-close').addEventListener('click', () => menu.close());
$('menu-resume').addEventListener('click', () => menu.close());
$('menu-restart').addEventListener('click', () => { menu.close(); startNewGame(); });
$('menu-resign').addEventListener('click', () => {
  if (!g || g.over) { menu.close(); return; }
  if (!confirm('投了して、対局を終えますか？')) return;
  const loser = g.turn;
  g.over = true;
  g.winner = 1 - loser;
  g.draw = false;
  menu.close();
  drop('game');
  finish();
});
$('menu-title').addEventListener('click', () => {
  if (g && !g.over && g.moves.length > 0 && !confirm('対局をやめて、タイトルへ戻りますか？')) return;
  toTitle();
});

// PC 用のキー操作
document.addEventListener('keydown', (e) => {
  if (help.open || menu.open) return;
  if ($('game').hidden) return;
  if (e.key === 'Escape') { menu.showModal(); return; }
  if (e.key === 'z' || e.key === 'Z' || e.key === 'Backspace') undoMove();
});

// ---- タイトルの見本: 数手打ってある形を見せる（静止画） ----
const demo = buildBoard('div');
demo.el.id = 'demo';
demo.el.classList.add('board--demo');
demo.el.setAttribute('aria-hidden', 'true');
$('demo').replaceWith(demo.el);
{
  const s = G.newGame();
  [at(4, 0), at(0, 4), at(4, 4), at(4, 8), at(8, 0), at(0, 1)].forEach((m) => G.place(s, m));
  paint(demo, s, false);
}

renderTitleStats();
show('title');
