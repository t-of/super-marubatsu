// スーパーマルバツゲームの NN（推論だけ）。ブラウザでは <script src="./js/net.js"> のグローバル SMNet、
// node では require('./net.js') から使う。docs/private/specs/super-marubatsu.md「6. AI／NN の形」のとおり。
//
// 入力 270（手番の側から見る）: 自分の印 81・相手の印 81・打てるマス 81・自分の取った小盤 9・相手の取った小盤 9・引き分けの小盤 9
// 中間 270→256→128（ReLU）。出力: 方策 81（打てないマスを除いて softmax）、価値 1（tanh）。
// 対称: 3×3 の位置（小盤の番号、小盤の中の位置とも）を 8 通りの回転・裏返しで同じに扱う（大盤と小盤に同じ回転）。
(function (global) {
  'use strict';

  const INPUT = 270, H1 = 256, H2 = 128, POLICY = 81;

  // ---- 8 通りの対称（3×3 の位置 0〜8 の並べ替え） ----
  // sym 0〜3: 90 度ずつ回転。sym 4〜7: 左右に裏返してから同じ回転
  function transformRC(r, c, sym) {
    let r2 = r, c2 = c;
    if (sym >= 4) c2 = 2 - c2;
    for (let k = 0; k < sym % 4; k++) { const nr = c2, nc = 2 - r2; r2 = nr; c2 = nc; }
    return [r2, c2];
  }
  const posOf = (p) => [(p / 3) | 0, p % 3];
  const rcToPos = (r, c) => r * 3 + c;
  function transformPos(p, sym) { const [r, c] = posOf(p); const [r2, c2] = transformRC(r, c, sym); return rcToPos(r2, c2); }
  function transformCell(idx, sym) { const b = (idx / 9) | 0, c = idx % 9; return transformPos(b, sym) * 9 + transformPos(c, sym); }

  // POS_PERM[sym][0..8]、CELL_PERM[sym][0..80]: 元の位置 → 対称を当てたあとの位置
  const POS_PERM = [], CELL_PERM = [];
  for (let sym = 0; sym < 8; sym++) {
    const pp = new Int8Array(9);
    for (let i = 0; i < 9; i++) pp[i] = transformPos(i, sym);
    POS_PERM.push(pp);
    const cp = new Int8Array(81);
    for (let i = 0; i < 81; i++) cp[i] = transformCell(i, sym);
    CELL_PERM.push(cp);
  }

  function decided(owner0, owner1, drawn, b) { return !!(((owner0 | owner1 | drawn) >> b) & 1); }

  // state（js/game.js の局面）から、手番の側から見た 270 個の 0/1 の入力を作る。sym（0〜7）で対称を当てる
  function encode(state, sym) {
    const x = new Float64Array(INPUT);
    const cp = CELL_PERM[sym], pp = POS_PERM[sym];
    const mover = state.turn, opp = 1 - mover;
    const own = state.cells[mover], theirs = state.cells[opp];
    for (let b = 0; b < 9; b++) {
      for (let c = 0; c < 9; c++) {
        const idx = cp[b * 9 + c];
        if ((own[b] >> c) & 1) x[idx] = 1;
        if ((theirs[b] >> c) & 1) x[81 + idx] = 1;
      }
    }
    if (!state.over) {
      const freeTurn = state.next < 0 || decided(state.owner[0], state.owner[1], state.drawn, state.next);
      for (let b = 0; b < 9; b++) {
        if (decided(state.owner[0], state.owner[1], state.drawn, b)) continue;
        if (!freeTurn && state.next !== b) continue;
        const occ = state.cells[0][b] | state.cells[1][b];
        for (let c = 0; c < 9; c++) if (!((occ >> c) & 1)) x[162 + cp[b * 9 + c]] = 1;
      }
    }
    for (let b = 0; b < 9; b++) {
      const tb = pp[b];
      if ((state.owner[mover] >> b) & 1) x[243 + tb] = 1;
      if ((state.owner[opp] >> b) & 1) x[252 + tb] = 1;
      if ((state.drawn >> b) & 1) x[261 + tb] = 1;
    }
    return x;
  }

  // ---- 素の重み（学習で作る）。行列は [入力側の番号][出力側の番号] を横に並べたもの ----
  // He 初期化で新しいネットを作る
  function randn() {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function heMatrix(fanIn, fanOut) {
    const m = new Float64Array(fanIn * fanOut), s = Math.sqrt(2 / fanIn);
    for (let i = 0; i < m.length; i++) m[i] = randn() * s;
    return m;
  }
  function createNet() {
    return {
      H1, H2, POLICY,
      W1: heMatrix(INPUT, H1), b1: new Float64Array(H1),
      W2: heMatrix(H1, H2), b2: new Float64Array(H2),
      Wp: heMatrix(H2, POLICY), bp: new Float64Array(POLICY),
      Wv: heMatrix(H2, 1), bv: 0,
    };
  }

  // 前向き計算。x は 270 個の 0/1。1 層目は「1 の入力の列を足すだけ」（入力が疎なので速い）
  function forward(net, x) {
    const { H1: h1n, H2: h2n, POLICY: pn, W1, b1, W2, b2, Wp, bp, Wv, bv } = net;
    const h1 = Float64Array.from(b1);
    for (let i = 0; i < INPUT; i++) {
      if (!x[i]) continue;
      const off = i * h1n;
      for (let j = 0; j < h1n; j++) h1[j] += W1[off + j];
    }
    for (let j = 0; j < h1n; j++) if (h1[j] < 0) h1[j] = 0;
    const h2 = Float64Array.from(b2);
    for (let j = 0; j < h1n; j++) {
      const v = h1[j];
      if (!v) continue;
      const off = j * h2n;
      for (let k = 0; k < h2n; k++) h2[k] += W2[off + k] * v;
    }
    for (let k = 0; k < h2n; k++) if (h2[k] < 0) h2[k] = 0;
    const policyLogits = Float64Array.from(bp);
    for (let k = 0; k < h2n; k++) {
      const v = h2[k];
      if (!v) continue;
      const off = k * pn;
      for (let m = 0; m < pn; m++) policyLogits[m] += Wp[off + m] * v;
    }
    let value = bv;
    for (let k = 0; k < h2n; k++) value += Wv[k] * h2[k];
    return { h1, h2, policyLogits, value: Math.tanh(value) };
  }

  // 打てないマスを除いた softmax（sym を当てた座標のまま）。legalIdx は対称後の座標の一覧
  function maskedSoftmax(logits, legalIdx) {
    let maxL = -Infinity;
    for (const i of legalIdx) if (logits[i] > maxL) maxL = logits[i];
    let sum = 0;
    const p = new Float64Array(logits.length);
    for (const i of legalIdx) { const e = Math.exp(logits[i] - maxL); p[i] = e; sum += e; }
    if (sum > 0) for (const i of legalIdx) p[i] /= sum;
    return p;
  }

  // state を評価する。sym を省くとでたらめに 1 つ選ぶ（読むときの決まり。学習では 8 通り全部使う）
  function evaluate(net, state, sym) {
    const useSym = sym == null ? (Math.random() * 8) | 0 : sym;
    const x = encode(state, useSym);
    const { policyLogits, value } = forward(net, x);
    const legalIdx = [];
    for (let i = 0; i < 81; i++) if (x[162 + i]) legalIdx.push(i);
    const pT = maskedSoftmax(policyLogits, legalIdx);
    const policy = new Float64Array(81);
    const cp = CELL_PERM[useSym];
    for (let i = 0; i < 81; i++) policy[i] = pT[cp[i]]; // 元の座標 i → 対称後の座標 cp[i]
    return { policy, value };
  }

  // ---- 8 ビット整数（行ごとの倍率つき）にして base64 へ。float32 のままより軽い ----
  function quantizeMatrix(mat, fanIn, fanOut) {
    const scale = new Float64Array(fanIn), data = new Int8Array(fanIn * fanOut);
    for (let i = 0; i < fanIn; i++) {
      let maxAbs = 0;
      for (let j = 0; j < fanOut; j++) maxAbs = Math.max(maxAbs, Math.abs(mat[i * fanOut + j]));
      const s = maxAbs > 0 ? maxAbs / 127 : 1;
      scale[i] = s;
      for (let j = 0; j < fanOut; j++) data[i * fanOut + j] = Math.round(mat[i * fanOut + j] / s);
    }
    return { scale: Array.from(scale), data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') };
  }
  function dequantizeMatrix(q, fanIn, fanOut) {
    const bytes = typeof Buffer !== 'undefined' ? Buffer.from(q.data, 'base64') : Uint8Array.from(atob(q.data), (c) => c.charCodeAt(0));
    const int8 = new Int8Array(bytes.buffer, bytes.byteOffset, fanIn * fanOut);
    const mat = new Float64Array(fanIn * fanOut);
    for (let i = 0; i < fanIn; i++) {
      const s = q.scale[i];
      for (let j = 0; j < fanOut; j++) mat[i * fanOut + j] = int8[i * fanOut + j] * s;
    }
    return mat;
  }

  // 学習用ネット（素の Float64Array）→ ai/net.json の中身（8 ビット整数、約 150KB）
  function toJSON(net) {
    return JSON.stringify({
      v: 1, H1: net.H1, H2: net.H2, POLICY: net.POLICY,
      b1: Array.from(net.b1), b2: Array.from(net.b2), bp: Array.from(net.bp), bv: net.bv,
      W1: quantizeMatrix(net.W1, INPUT, net.H1),
      W2: quantizeMatrix(net.W2, net.H1, net.H2),
      Wp: quantizeMatrix(net.Wp, net.H2, net.POLICY),
      Wv: quantizeMatrix(net.Wv, net.H2, 1),
    });
  }

  // ai/net.json（8 ビット整数）を読んで、読める形（Float64Array）に戻す
  function load(json) {
    const raw = typeof json === 'string' ? JSON.parse(json) : json;
    const net = {
      H1: raw.H1, H2: raw.H2, POLICY: raw.POLICY,
      b1: Float64Array.from(raw.b1), b2: Float64Array.from(raw.b2), bp: Float64Array.from(raw.bp), bv: raw.bv,
      W1: dequantizeMatrix(raw.W1, INPUT, raw.H1),
      W2: dequantizeMatrix(raw.W2, raw.H1, raw.H2),
      Wp: dequantizeMatrix(raw.Wp, raw.H2, raw.POLICY),
      Wv: dequantizeMatrix(raw.Wv, raw.H2, 1),
    };
    return { net, evaluate: (state, sym) => evaluate(net, state, sym) };
  }

  const SMNet = {
    INPUT, H1, H2, POLICY, CELL_PERM, POS_PERM,
    encode, forward, evaluate, createNet, toJSON, load,
    quantizeMatrix, dequantizeMatrix,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SMNet;
  else global.SMNet = SMNet;
})(typeof self !== 'undefined' ? self : this);
