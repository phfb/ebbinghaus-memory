import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_MS,
  daysBetween,
  daysUntilExpiry,
  expiryOverview,
  fullStamp,
  isExpired,
  isoOf,
  relativeLabel,
  relativeStamp,
  stampFor,
  startOfDay,
} from '../src/core/time.mjs';

/** 本地时区构造，测试不受机器时区影响。 */
const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

test('isoOf 带本地偏移，能被 Date 解析回同一时刻', () => {
  const ts = at(2026, 10, 25, 0, 58);
  const iso = isoOf(ts);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(iso).getTime(), ts);
});

test('stampFor / fullStamp 是本地的、零填充的', () => {
  const ts = at(2026, 10, 5, 3, 7);
  assert.equal(stampFor(ts), '10-05 03:07');
  assert.equal(fullStamp(ts), '2026-10-05 03:07');
});

test('startOfDay 归零到当天 00:00', () => {
  const ts = at(2026, 10, 25, 23, 59);
  const s = new Date(startOfDay(ts));
  assert.equal(s.getHours(), 0);
  assert.equal(s.getMinutes(), 0);
  assert.equal(s.getSeconds(), 0);
  assert.equal(s.getMilliseconds(), 0);
});

test('daysBetween 按日历天算，不按 24 小时', () => {
  const lateNight = at(2026, 10, 24, 23, 30);
  const earlyMorning = at(2026, 10, 25, 0, 30);
  // 只差 1 小时，但跨了午夜 —— 对人是「两天」
  assert.equal(daysBetween(lateNight, earlyMorning), 1);
  assert.equal(daysBetween(earlyMorning, earlyMorning), 0);
  assert.equal(daysBetween(at(2026, 10, 1), at(2026, 10, 25)), 24);
});

test('relativeLabel 说人话', () => {
  const now = at(2026, 10, 25, 12);
  assert.equal(relativeLabel(at(2026, 10, 25, 3), now), '今天');
  assert.equal(relativeLabel(at(2026, 10, 24, 23), now), '昨天');
  assert.equal(relativeLabel(at(2026, 10, 22, 12), now), '3 天前');
  assert.equal(relativeLabel(at(2026, 10, 19, 12), now), '6 天前');
  // 满 7 天起换成日期：短期周期正好是 7 天，边界落在这里刚刚好
  assert.equal(relativeLabel(at(2026, 10, 18, 12), now), '10-18');
  assert.equal(relativeLabel(at(2026, 10, 5, 12), now), '10-05');
});

test('relativeStamp 带上点钟', () => {
  const now = at(2026, 10, 25, 12);
  assert.equal(relativeStamp(at(2026, 10, 24, 21, 30), now), '昨天 21:30');
  assert.equal(relativeStamp(at(2026, 10, 5, 14, 0), now), '10-05 14:00');
});

test('isExpired 用事件时间判断，边界是「满 N 天」', () => {
  const now = at(2026, 10, 25, 12);
  const exactly = now - 7 * DAY_MS;
  assert.equal(isExpired(exactly, 7, now), true, '正好满 7 天算过期');
  assert.equal(isExpired(exactly + 1000, 7, now), false, '差 1 秒没过期');
  assert.equal(isExpired(now, 7, now), false);
  // 坏窗口不该把所有东西都判过期
  assert.equal(isExpired(now - 999 * DAY_MS, 0, now), false);
  assert.equal(isExpired(Number.NaN, 7, now), false);
});

test('daysUntilExpiry：不足一天算 1 天，已过期算 0', () => {
  const now = at(2026, 10, 25, 12);
  assert.equal(daysUntilExpiry(now, 7, now), 7);
  assert.equal(daysUntilExpiry(now - 6.5 * DAY_MS, 7, now), 1);
  assert.equal(daysUntilExpiry(now - 8 * DAY_MS, 7, now), 0);
});

test('expiryOverview 数过期条数 + 最近到期天数', () => {
  const now = at(2026, 10, 25, 12);
  const entries = [
    { ts: now - 8 * DAY_MS }, // 已过期
    { ts: now - 6 * DAY_MS }, // 明天到期
    { ts: now - 1 * DAY_MS }, // 6 天后
  ];
  const o = expiryOverview(entries, 7, now);
  assert.equal(o.expired, 1);
  assert.equal(o.nextInDays, 1);
});

test('expiryOverview 空区返回 null 而不是 Infinity', () => {
  const o = expiryOverview([], 7, Date.now());
  assert.equal(o.nextInDays, null);
  assert.equal(o.expired, 0);
});
