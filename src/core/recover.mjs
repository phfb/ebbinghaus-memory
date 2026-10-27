/**
 * 分区「炸了」之后的恢复：从镜像里把**本地缺失的条目**补回来。
 *
 * 设计前提（都是踩过坑才这么定的）：
 *  1. **只补缺失，绝不覆盖。** 镜像那份可能比本地旧 —— 整个盖回去等于把后来
 *     记的东西全删了。所以按 id 做差集，本地有的一个字节都不动。
 *  2. **不编内容。** 镜像里读不出来的行直接跳过并计数，不猜、不修、不补。
 *  3. 纯函数 / 零依赖，IO 全交给调用方（host），这样测试不用碰磁盘布局。
 */

/**
 * 把一段 jsonl 文本解析成条目数组。
 * 坏行跳过并计数 —— 恢复过程本身不该因为某个历史坏行整批失败。
 *
 * @param {unknown} text
 * @returns {{ entries: object[], badLines: number }}
 */
export function parseJsonl(text) {
  const out = [];
  let badLines = 0;
  const raw = typeof text === 'string' ? text : '';
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(t);
    } catch {
      badLines += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      badLines += 1;
      continue;
    }
    out.push(parsed);
  }
  return { entries: out, badLines };
}

/**
 * 算「镜像里有、本地没有」的那批条目。
 *
 * @param {Set<string>|string[]} localIds 本地已有的 id
 * @param {object[]} mirrorEntries 镜像里读出来的条目
 * @returns {{ add: object[], skipped: number }} add 是待补的；skipped 是重复/无效被跳过的条数
 */
export function pickMissing(localIds, mirrorEntries) {
  const have = localIds instanceof Set ? localIds : new Set(Array.isArray(localIds) ? localIds : []);
  const add = [];
  const seen = new Set();
  let skipped = 0;
  for (const e of Array.isArray(mirrorEntries) ? mirrorEntries : []) {
    const id = typeof e?.id === 'string' ? e.id : '';
    if (id === '' || have.has(id) || seen.has(id)) {
      skipped += 1;
      continue;
    }
    // 只认「字段齐全到能安全落盘」的条目：残缺的写进去会变成新的坏行
    if (!Number.isFinite(Number(e?.ts)) || typeof e?.zone !== 'string' || !Array.isArray(e?.keywords)) {
      skipped += 1;
      continue;
    }
    seen.add(id);
    add.push(e);
  }
  return { add, skipped };
}

/**
 * 把待补条目按分区归类（恢复时要写回各自对应的 jsonl）。
 *
 * @param {object[]} entries
 * @param {string[]} zones 合法分区列表
 * @returns {Record<string, object[]>}
 */
export function groupByZone(entries, zones) {
  const out = {};
  for (const z of Array.isArray(zones) ? zones : []) out[z] = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const z = typeof e?.zone === 'string' ? e.zone : '';
    if (!Object.prototype.hasOwnProperty.call(out, z)) continue;
    out[z].push(e);
  }
  return out;
}

/**
 * 体检：一段 jsonl 文本里有多少行读不出来。
 * 和 `parseJsonl` 分开，是因为这里**只关心坏行数**，不需要把条目都建出来。
 *
 * @param {unknown} text
 * @returns {{ total: number, bad: number }}
 */
export function scanJsonl(text) {
  const raw = typeof text === 'string' ? text : '';
  let total = 0;
  let bad = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    total += 1;
    try {
      const v = JSON.parse(t);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { total, bad };
}
