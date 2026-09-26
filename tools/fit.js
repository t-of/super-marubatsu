'use strict';
// NN の学習だけを行う道具（node 専用。ブラウザは js/net.js の forward だけを使う）。
// 損失 = 方策のクロスエントロピー + 価値の二乗誤差 + 重みの小さいさ（L2）。Adam で少しずつ動かす。
const SMNet = require('../js/net.js');

const D = SMNet.INPUT; // 270

// 1 サンプルぶんの前向き計算（勾配計算に要る中間値も返す）
function forwardOne(net, x) {
  const { H1, H2, POLICY } = net;
  const h1 = Float64Array.from(net.b1);
  for (let i = 0; i < D; i++) {
    if (!x[i]) continue;
    const off = i * H1;
    for (let j = 0; j < H1; j++) h1[j] += net.W1[off + j];
  }
  for (let j = 0; j < H1; j++) if (h1[j] < 0) h1[j] = 0;
  const h2 = Float64Array.from(net.b2);
  for (let j = 0; j < H1; j++) {
    const v = h1[j];
    if (!v) continue;
    const off = j * H2;
    for (let k = 0; k < H2; k++) h2[k] += net.W2[off + k] * v;
  }
  for (let k = 0; k < H2; k++) if (h2[k] < 0) h2[k] = 0;
  const logits = Float64Array.from(net.bp);
  for (let k = 0; k < H2; k++) {
    const v = h2[k];
    if (!v) continue;
    const off = k * POLICY;
    for (let m = 0; m < POLICY; m++) logits[m] += net.Wp[off + m] * v;
  }
  let preVal = net.bv;
  for (let k = 0; k < H2; k++) preVal += net.Wv[k] * h2[k];
  return { h1, h2, logits, preVal, value: Math.tanh(preVal) };
}

// 打てる手だけの softmax（x[162+m] が 1 のマスだけ）
function maskedSoftmax(logits, x) {
  let maxL = -Infinity;
  for (let m = 0; m < 81; m++) if (x[162 + m] && logits[m] > maxL) maxL = logits[m];
  let sum = 0;
  const p = new Float64Array(81);
  for (let m = 0; m < 81; m++) if (x[162 + m]) { const e = Math.exp(logits[m] - maxL); p[m] = e; sum += e; }
  if (sum > 0) for (let m = 0; m < 81; m++) if (x[162 + m]) p[m] /= sum;
  return p;
}

// net を書き換えながら学習する。X: サンプル数ぶんの 270 要素、PI: 81 要素（読んだ回数の割合）、Y: 価値の目標（-1〜1）
// 戻り値: { policyLoss, valueLoss }（検証ぶんの平均）
function fit(net, X, PI, Y, { epochs = 3, lr = 1e-3, batch = 256, l2 = 1e-5, log = () => {} } = {}) {
  const { H1, H2, POLICY } = net;
  const n = Y.length;
  const params = ['W1', 'b1', 'W2', 'b2', 'Wp', 'bp', 'Wv'];
  const sizes = { W1: D * H1, b1: H1, W2: H1 * H2, b2: H2, Wp: H2 * POLICY, bp: POLICY, Wv: H2 };
  const M = {}, V = {};
  for (const k of params) { M[k] = new Float64Array(sizes[k]); V[k] = new Float64Array(sizes[k]); }
  let mBv = 0, vBv = 0, step = 0;
  const b1c = 0.9, b2c = 0.999, eps = 1e-8;

  const idx = Int32Array.from({ length: n }, (_, i) => i);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; } };
  const nVal = Math.min(2000, Math.floor(n * 0.05));

  let valPolicyLoss = 0, valValueLoss = 0;
  for (let ep = 0; ep < epochs; ep++) {
    shuffle(idx);
    const val = idx.subarray(0, nVal), train = idx.subarray(nVal);
    let trainLoss = 0;
    for (let s0 = 0; s0 < train.length; s0 += batch) {
      const end = Math.min(train.length, s0 + batch), bs = end - s0;
      const G = {};
      for (const k of params) G[k] = new Float64Array(sizes[k]);
      let gBv = 0;
      for (let q = s0; q < end; q++) {
        const r = train[q];
        const x = X.subarray(r * D, r * D + D);
        const pi = PI.subarray(r * 81, r * 81 + 81);
        const y = Y[r];
        const { h1, h2, logits, value } = forwardOne(net, x);
        const p = maskedSoftmax(logits, x);
        const dLogits = new Float64Array(81);
        for (let m = 0; m < 81; m++) dLogits[m] = p[m] - pi[m];
        const dPreVal = 2 * (value - y) * (1 - value * value);
        trainLoss += 0.5 * (value - y) * (value - y);
        // 価値の頭: Wv, bv
        gBv += dPreVal;
        const dH2 = new Float64Array(H2);
        for (let k = 0; k < H2; k++) { G.Wv[k] += dPreVal * h2[k]; dH2[k] += dPreVal * net.Wv[k]; }
        // 方策の頭: Wp, bp
        for (let m = 0; m < 81; m++) {
          const d = dLogits[m];
          if (!d) continue;
          G.bp[m] += d;
          const off = m; // Wp は [H2][POLICY] なので k*POLICY+m でアクセス
          for (let k = 0; k < H2; k++) { G.Wp[k * POLICY + m] += d * h2[k]; dH2[k] += d * net.Wp[k * POLICY + m]; }
        }
        // h2 の relu
        for (let k = 0; k < H2; k++) if (h2[k] <= 0) dH2[k] = 0;
        // W2, b2
        const dH1 = new Float64Array(H1);
        for (let k = 0; k < H2; k++) {
          const d = dH2[k];
          if (!d) continue;
          G.b2[k] += d;
          for (let j = 0; j < H1; j++) { const v = h1[j]; if (!v) continue; G.W2[j * H2 + k] += d * v; dH1[j] += d * net.W2[j * H2 + k]; }
        }
        // h1 の relu
        for (let j = 0; j < H1; j++) if (h1[j] <= 0) dH1[j] = 0;
        // W1, b1（x が疎なので、立っている入力の行だけ更新）
        for (let j = 0; j < H1; j++) if (dH1[j]) G.b1[j] += dH1[j];
        for (let i = 0; i < D; i++) {
          if (!x[i]) continue;
          const off = i * H1;
          for (let j = 0; j < H1; j++) if (dH1[j]) G.W1[off + j] += dH1[j];
        }
      }
      step++;
      const c1 = 1 - b1c ** step, c2 = 1 - b2c ** step;
      for (const k of params) {
        const p = net[k], g = G[k], m = M[k], v = V[k];
        for (let i = 0; i < p.length; i++) {
          const gi = g[i] / bs + l2 * p[i];
          m[i] = b1c * m[i] + (1 - b1c) * gi;
          v[i] = b2c * v[i] + (1 - b2c) * gi * gi;
          p[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + eps);
        }
      }
      const gi = gBv / bs;
      mBv = b1c * mBv + (1 - b1c) * gi;
      vBv = b2c * vBv + (1 - b2c) * gi * gi;
      net.bv -= lr * (mBv / c1) / (Math.sqrt(vBv / c2) + eps);
    }
    // 検証
    valPolicyLoss = 0; valValueLoss = 0;
    for (const r of val) {
      const x = X.subarray(r * D, r * D + D);
      const pi = PI.subarray(r * 81, r * 81 + 81);
      const { logits, value } = forwardOne(net, x);
      const p = maskedSoftmax(logits, x);
      let ce = 0;
      for (let m = 0; m < 81; m++) if (pi[m] > 0) ce -= pi[m] * Math.log(Math.max(p[m], 1e-9));
      valPolicyLoss += ce;
      valValueLoss += (value - Y[r]) ** 2;
    }
    valPolicyLoss /= Math.max(1, val.length);
    valValueLoss /= Math.max(1, val.length);
    log(`  エポック ${ep + 1}/${epochs}  学習 ${(trainLoss / train.length).toFixed(4)}  検証方策 ${valPolicyLoss.toFixed(4)}  検証価値 ${valValueLoss.toFixed(4)}`);
  }
  return { policyLoss: valPolicyLoss, valueLoss: valValueLoss };
}

module.exports = { fit, forwardOne, maskedSoftmax };
