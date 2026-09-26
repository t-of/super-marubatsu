// スーパーマルバツゲームの遊びの中身（DOM に頼らない）。
// ブラウザでは <script src="./js/game.js"> のグローバル SMGame から、node では require('./game.js') から使う（同じファイル）。
// 第 2 版の AI がそのまま使えるよう、盤は 9 ビットの整数で持つ（docs/private/specs/super-marubatsu.md「6. 盤の持ち方」）。
//
// マスの番号: 小盤・小盤の中の位置とも 0〜8（3 の段 × 3 の列、左上から）。
// 打った手 m（0〜80）= 小盤の番号 × 9 + 小盤の中の位置。手番 0 = ×（先攻）、1 = ○。
(function (global) {
  'use strict';

  const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  const FULL = 0b111111111; // 9 マス全部

  // 512 通り（9 ビット）の表を 1 回だけ作る。3 つ並んでいれば 1（小盤にも大盤にも使う）
  const WIN_TABLE = (() => {
    const t = new Uint8Array(512);
    for (let bits = 0; bits < 512; bits++) {
      t[bits] = LINES.some((l) => l.every((i) => (bits >> i) & 1)) ? 1 : 0;
    }
    return t;
  })();

  function newGame() {
    return {
      cells: [new Array(9).fill(0), new Array(9).fill(0)], // cells[手番][小盤] = その小盤に打った 9 ビット
      owner: [0, 0],   // owner[手番] = 取った小盤の 9 ビット
      drawn: 0,        // 引き分けの小盤の 9 ビット
      turn: 0,         // 0 = ×、1 = ○
      next: -1,        // 次に打つ小盤（-1 = フリーターン）
      moves: [],       // 打った手の履歴（0〜80）
      over: false,
      winner: -1,      // 0 / 1 / -1（決着していない・引き分け）
      draw: false,
      line: null,      // 勝ったときの大盤の 3 小盤（例 [0, 1, 2]）
    };
  }

  // 小盤 b が決着している（取られた、または引き分け）か
  const decided = (s, b) => !!(((s.owner[0] | s.owner[1] | s.drawn) >> b) & 1);

  // フリーターン中（送り先の指定がない、またはそこが決着済み）か
  const freeTurn = (s) => s.next < 0 || decided(s, s.next);

  // 打てる小盤の番号
  function legalBoards(s) {
    if (s.over) return [];
    if (!freeTurn(s)) return [s.next];
    const list = [];
    for (let b = 0; b < 9; b++) if (!decided(s, b)) list.push(b);
    return list;
  }

  // 打てる手（0〜80）の一覧
  function legalMoves(s) {
    const moves = [];
    for (const b of legalBoards(s)) {
      const occ = s.cells[0][b] | s.cells[1][b];
      for (let c = 0; c < 9; c++) if (!((occ >> c) & 1)) moves.push(b * 9 + c);
    }
    return moves;
  }

  function canPlace(s, m) {
    if (s.over || !Number.isInteger(m) || m < 0 || m > 80) return false;
    const b = (m / 9) | 0, c = m % 9;
    if (decided(s, b)) return false;
    if (!freeTurn(s) && s.next !== b) return false;
    return !(((s.cells[0][b] | s.cells[1][b]) >> c) & 1);
  }

  // 打つ。s を書き換えて返す。打てない手は例外
  function place(s, m) {
    if (!canPlace(s, m)) throw new Error(`打てないマス: ${m}`);
    const b = (m / 9) | 0, c = m % 9, p = s.turn;
    s.cells[p][b] |= 1 << c;
    s.moves.push(m);

    if (WIN_TABLE[s.cells[p][b]]) s.owner[p] |= 1 << b;
    else if ((s.cells[0][b] | s.cells[1][b]) === FULL) s.drawn |= 1 << b;

    if (WIN_TABLE[s.owner[p]]) {
      s.over = true;
      s.winner = p;
      s.line = LINES.find((l) => l.every((i) => (s.owner[p] >> i) & 1));
    } else if ((s.owner[0] | s.owner[1] | s.drawn) === FULL) {
      s.over = true;
      s.draw = true;
    } else {
      s.next = c;
      s.turn = 1 - p;
    }
    return s;
  }

  // moves を最初から並べ直す。途中で打てない手が出たら、そこで捨てる（壊れた保存データ対策）
  function replay(moves) {
    const s = newGame();
    for (const m of moves) {
      if (!canPlace(s, m)) break;
      place(s, m);
    }
    return s;
  }

  // 1 手戻す
  const undo = (s) => replay(s.moves.slice(0, -1));

  // ---- 画面が使う小さな見方 ----
  function cellAt(s, b, c) {
    if ((s.cells[0][b] >> c) & 1) return 0;
    if ((s.cells[1][b] >> c) & 1) return 1;
    return -1;
  }
  function boardOwner(s, b) {
    if ((s.owner[0] >> b) & 1) return 0;
    if ((s.owner[1] >> b) & 1) return 1;
    return -1;
  }
  const boardDrawn = (s, b) => !!((s.drawn >> b) & 1);

  const SMGame = {
    LINES, newGame, place, undo, replay, canPlace, legalMoves, legalBoards,
    decided, freeTurn, cellAt, boardOwner, boardDrawn,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SMGame;
  else global.SMGame = SMGame;
})(typeof self !== 'undefined' ? self : this);
