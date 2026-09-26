'use strict';
// ルールのテスト: node tools/test.js
const assert = require('node:assert/strict');
const {
  newGame, place, undo, replay, canPlace, legalMoves, legalBoards,
  decided, freeTurn, boardOwner, boardDrawn,
} = require('../js/game.js');

const test = (name, fn) => { fn(); console.log('✓', name); };
const at = (board, cell) => board * 9 + cell;
const bits = (...ix) => ix.reduce((a, i) => a | (1 << i), 0);

test('最初の手はどこでも打てる', () => {
  const s = newGame();
  assert.deepEqual(legalBoards(s), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(legalMoves(s).length, 81);
});

test('打った位置が、次の人が打つ小盤を決める', () => {
  const s = newGame();
  place(s, at(0, 4));               // 小盤 0 のマス 4 に打つ
  assert.equal(s.next, 4);
  assert.deepEqual(legalBoards(s), [4]);
  assert.equal(s.turn, 1);
});

test('決着した小盤には、空きマスがあっても打てない', () => {
  const s = newGame();
  s.owner[0] = bits(3); // 小盤 3 は × が取った、とする
  assert.ok(decided(s, 3));
  assert.ok(!canPlace(s, at(3, 0)));
  assert.throws(() => place(s, at(3, 0)));
});

test('フリーターン: 送り先が取られていたら、決着していない小盤ならどこでも', () => {
  const s = newGame();
  s.owner[0] = bits(4);
  s.next = 4;
  assert.ok(freeTurn(s));
  assert.deepEqual(legalBoards(s), [0, 1, 2, 3, 5, 6, 7, 8]);
});

test('フリーターン: 送り先が引き分けでも、決着していない小盤ならどこでも', () => {
  const s = newGame();
  s.drawn = bits(2);
  s.next = 2;
  assert.ok(freeTurn(s));
  assert.ok(!legalBoards(s).includes(2));
});

test('引き分けの小盤は、どちらのものにもならない', () => {
  const s = newGame();
  // X O X / X O O / O X X の並び（誰も 3 つ並ばない）を、最後の 1 手で埋める
  s.cells[0][5] = bits(0, 2, 3, 8);   // ×（マス 7 抜き）
  s.cells[1][5] = bits(1, 4, 5, 6);   // ○
  s.next = 5; s.turn = 0;
  place(s, at(5, 7));                 // × が最後の空きに打つ
  assert.ok(boardDrawn(s, 5));
  assert.equal(boardOwner(s, 5), -1);
  assert.ok(!s.over);
});

test('小盤で 3 つ並べた人が、その小盤を取る。大盤も 3 つ並べば勝ち', () => {
  const s = newGame();
  s.owner[0] = bits(0, 1);            // × が小盤 0・1 をすでに取っている
  s.cells[0][2] = bits(0, 1);
  s.next = 2; s.turn = 0;
  place(s, at(2, 2));                 // 小盤 2 の [0,1,2] がそろい、大盤も [0,1,2] がそろう
  assert.ok(boardOwner(s, 2) === 0);
  assert.ok(s.over);
  assert.equal(s.winner, 0);
  assert.deepEqual(s.line, [0, 1, 2]);
});

test('どちらも大盤で 3 つ並べられず、打てる小盤がなくなったら引き分け', () => {
  const s = newGame();
  s.owner[0] = bits(0, 2, 3, 8);       // ×（小盤 7 抜き）。3 つ並ばない配置
  s.owner[1] = bits(1, 4, 5, 6);       // ○
  s.cells[0][7] = bits(0, 1);          // 小盤 7 は × があと 1 手で取る
  s.next = 7; s.turn = 0;
  place(s, at(7, 2));                  // 小盤 7 を × が取り、大盤の全小盤が決着する
  assert.equal(boardOwner(s, 7), 0);
  assert.ok(s.over);
  assert.ok(s.draw);
  assert.equal(s.winner, -1);
});

test('1 手戻すと、その手をもう一度打てる', () => {
  let s = newGame();
  place(s, at(0, 4));
  place(s, at(4, 0));
  const moves = s.moves.slice();
  s = undo(s);
  assert.deepEqual(s.moves, moves.slice(0, -1));
  assert.equal(s.turn, 1);   // ○ の番に戻る
  assert.equal(s.next, 4);
  assert.ok(canPlace(s, at(4, 0)));
});

test('保存された手を並べ直すとき、打てない手が混ざっていたらそこで捨てる', () => {
  const s = replay([at(0, 4), 999, at(4, 0)]);
  assert.deepEqual(s.moves, [at(0, 4)]);
});

test('でたらめな対局を何本打っても、必ず決着する（引き分けも起きる）', () => {
  let sawDraw = false, sawWin = [false, false];
  let seed = 1;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let g = 0; g < 300; g++) {
    const s = newGame();
    let guard = 0;
    while (!s.over && guard++ < 90) {
      const moves = legalMoves(s);
      place(s, moves[Math.floor(rand() * moves.length)]);
    }
    assert.ok(s.over, `81 手までに決着する（${guard} 手）`);
    if (s.draw) sawDraw = true; else sawWin[s.winner] = true;
  }
  assert.ok(sawDraw, '300 局のどこかで引き分けが起きる');
  assert.ok(sawWin[0] && sawWin[1], '300 局のどこかで × と ○ の両方が勝つ');
});

console.log('全部 OK');
