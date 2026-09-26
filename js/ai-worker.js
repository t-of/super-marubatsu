// スーパーマルバツゲームの AI の探索を画面から切り離して行う Web Worker。
// 画面（main.js）とはメッセージだけでやり取りする。
//   → { type: 'init', net: <ai/net.json の中身 か null> }
//   ← { type: 'ready', hasNet }
//   → { type: 'move', id, level, moves }
//   ← { type: 'result', id, move, iterations, ms }
// importScripts は worker スクリプト自身から見た相対パス（同じ js/ フォルダ）。
importScripts('./game.js', './net.js', './mcts.js');

let net = null;      // SMNet.load(...) の戻り値（{ evaluate }）。読めなければ null のまま
let hasNet = false;

// net が読めないときの段階 4・5 の代わり（素の MCTS、時間で決める版。仕様「6. AI／重みのファイル」）
const NO_NET_FALLBACK = { 4: 300, 5: 2000 };

function levelOpts(level) {
  const base = SMAI.LEVELS[level - 1];
  const opts = {};
  if (base.needsNet && !hasNet) {
    opts.timeMs = NO_NET_FALLBACK[level];
    return opts;
  }
  if (base.iterations) opts.iterations = base.iterations;
  if (base.timeMs) opts.timeMs = base.timeMs;
  if (base.randomRate) opts.randomRate = base.randomRate;
  if (base.needsNet) opts.net = net;
  return opts;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    if (msg.net) {
      try { net = SMNet.load(msg.net); hasNet = true; } catch { net = null; hasNet = false; }
    }
    self.postMessage({ type: 'ready', hasNet });
    return;
  }
  if (msg.type === 'move') {
    const r = SMAI.chooseMove(msg.moves, levelOpts(msg.level));
    self.postMessage({ type: 'result', id: msg.id, move: r.move, iterations: r.iterations, ms: r.ms });
  }
};
