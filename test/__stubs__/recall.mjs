/**
 * `src/core/recall.mjs` 的**测试桩**（见 zones.mjs 里的说明）。
 *
 * 检索只做到「关键词/标题包含」这种最笨的程度 —— host 层测试要验的是
 * **宿主怎么用检索结果**，不是检索本身打得好不好。
 */

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[\s,，。；;、：:!！?？/|]+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

export function scoreEntry(entry, queryTokens) {
  const tokens = Array.isArray(queryTokens) ? queryTokens : [];
  if (tokens.length === 0) return 0;
  const keywords = Array.isArray(entry?.keywords) ? entry.keywords.map((k) => String(k).toLowerCase()) : [];
  const title = String(entry?.title ?? '').toLowerCase();
  const detail = String(entry?.detail ?? '').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (keywords.some((k) => k.includes(t))) score += 3;
    else if (title.includes(t)) score += 2;
    else if (detail.includes(t)) score += 1;
  }
  return score === 0 ? 0 : score * (0.5 + (Number(entry?.weight) || 0));
}

export function search(zones, query, { top = 3, threshold = 0 } = {}) {
  const tokens = tokenize(query);
  const all = [...(zones?.short ?? []), ...(zones?.long ?? []), ...(zones?.permanent ?? [])];
  return all
    .map((e) => ({ e, s: scoreEntry(e, tokens) }))
    .filter((x) => x.s >= threshold && x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(1, top))
    .map((x) => x.e);
}

export function autoRecall(_zones, _lastUserText, _cfg) {
  // 保守：测试里不做自动检索，命中只走显式 search
  return [];
}
