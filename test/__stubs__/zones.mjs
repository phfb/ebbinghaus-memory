/**
 * `src/core/zones.mjs` 的**测试桩**。
 *
 * 这个文件不属于插件运行时代码 —— 只有当 `src/core/zones.mjs` 还没写出来
 * （或想在 host 层单测里隔离掉分区策略）时，`test/host.test.mjs` 才会通过
 * `module.registerHooks` 把对 `../core/zones.mjs` 的解析重定向到这里。
 *
 * 行为对齐 SPEC §8 的**签名与语义**，实现刻意最简：
 *  - 新条目一律进 short（「人的记忆先都是刚发生」）
 *  - harvest 只做深拷贝，不判到期（测试里的条目都是刚写的）
 *  - 容量判定按 cfg 的上限
 */

export function initialZoneFor(_weight, _cfg) {
  return 'short';
}

export function harvest({ zones, cfg: _cfg, now: _now }) {
  return {
    zones: {
      short: [...(zones?.short ?? [])],
      long: [...(zones?.long ?? [])],
      permanent: [...(zones?.permanent ?? [])],
    },
    plan: [],
  };
}

function capOf(zone, cfg) {
  const key = zone === 'short' ? 'shortCapacity' : zone === 'long' ? 'longCapacity' : 'permanentCapacity';
  const n = Number(cfg?.[key]);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

export function isOverCapacity(zone, entries, cfg) {
  return (Array.isArray(entries) ? entries.length : 0) > capOf(zone, cfg);
}

export function overflowCount(zone, entries, cfg) {
  const n = Array.isArray(entries) ? entries.length : 0;
  return Math.max(1, n - capOf(zone, cfg));
}
