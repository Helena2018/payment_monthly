/** money.test.ts — 整数分运算与取整约定（跨语言一致性的地基） */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  allocate,
  divRound,
  floorDiv,
  formatCents,
  fromYuanString,
  roundHalfAwayFromZero,
  sumCents,
} from '../src/money';

test('allocate：总和精确、余数优先给靠前的份额', () => {
  assert.deepEqual(allocate(100, 3), [34, 33, 33]);
  assert.equal(sumCents(allocate(100, 3)), 100);
  assert.deepEqual(allocate(300000, 11).slice(0, 2), [27273, 27273]);
  assert.equal(sumCents(allocate(300000, 11)), 300000);
  assert.deepEqual(allocate(7, 7), [1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(allocate(1, 3), [1, 0, 0]);
});

test('allocate：负额（退款）符号对称，退款不会被摊成正数', () => {
  assert.deepEqual(allocate(-100, 3), [-34, -33, -33]);
  assert.equal(sumCents(allocate(-100, 3)), -100);
});

test('allocate：非法入参必须抛错（防止 0 天 / 浮点分悄悄进系统）', () => {
  assert.throws(() => allocate(100, 0), RangeError);
  assert.throws(() => allocate(100.5, 3), RangeError);
});

test('floorDiv 与 divRound 的语义边界', () => {
  assert.equal(floorDiv(7, 2), 3);
  assert.equal(floorDiv(-7, 2), -4); // 向 -Infinity，和 Python // 一致
  assert.equal(divRound(7, 2), 4);
  assert.equal(divRound(-7, 2), -4); // 远离零
});

test('roundHalfAwayFromZero：显式约定，避免 JS/Python 舍入规则分歧', () => {
  assert.equal(roundHalfAwayFromZero(2.5), 3); // JS Math.round / Python round 在 .5 处结果不同
  assert.equal(roundHalfAwayFromZero(-2.5), -3);
  assert.equal(roundHalfAwayFromZero(-3212.116), -3212);
  assert.equal(roundHalfAwayFromZero(0), 0);
});

test('金额解析：绕开 parseFloat*100 的浮点误差', () => {
  assert.equal(fromYuanString('0.1'), 10);
  assert.equal(fromYuanString('12.3'), 1230);
  assert.equal(fromYuanString('1234.56'), 123456);
  assert.equal(fromYuanString('1,234.56'), 123456);
  assert.equal(fromYuanString('-0.07'), -7);
  assert.throws(() => fromYuanString('1.234'), TypeError);
  assert.throws(() => fromYuanString('abc'), TypeError);
});

test('展示格式化：分组与负号', () => {
  assert.equal(formatCents(123456), '1,234.56');
  assert.equal(formatCents(-59389), '-593.89');
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(2340000, 0), '23,400');
});

test('sumCents 拒绝任何非整数分（预算系统里出现小数分就是 bug）', () => {
  assert.throws(() => sumCents([1.5]), RangeError);
  assert.equal(sumCents([1, 2, 3]), 6);
});
