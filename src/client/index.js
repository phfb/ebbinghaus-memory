/**
 * Ebbinghaus-memory · 客户端半边（手写 bundle，无构建步骤）
 *
 * ─────────────────────────────────────────────────────────────
 * DSH 浏览器插件的契约只有三条，都是端到端侦察出来的，别自己发明：
 *
 *   1. 文件必须调用 `window.__ModuleLoader__.load({ id, factory })`。
 *      执行 bundle 只注册工厂；模块副作用在物化时才跑，所以整个插件体
 *      都待在 factory 闭包里。
 *   2. `id` **必须等于包名**（ebbinghaus-memory）。浏览器模块身份就是
 *      解析出来的包名，两个来源解析到同一个包名会让组合直接失败。
 *   3. `factory(require)` 返回一个 Cordis 插件：`{ name, inject, apply }`。
 *
 * `require` 只能解析外壳那张冻结的模块表。这里只 require `react` ——
 * 多 require 一个就得写进 `dsh.client.external`，那是白白多出来的风险面。
 *
 * 【不用 JSX】没有打包器就没有 JSX 变换，全程 `React.createElement`。
 * 【不引入 UI 组件库】照官方规范抄 markup、只吃主题 token，不跟任何插件
 *   共享运行时代码 —— 别人换 React 版本伤不到我们。
 * 【颜色只走主题 token】面板里所有颜色都是 `var(--dsw-alias-*)`，
 *   这类 token 的 requiresLightAndDark 是 true，写死色值在深浅色切换时翻车。
 *
 * ─────────────────────────────────────────────────────────────
 * 面板要回答的问题只有一个：**它还记着什么，什么时候会忘。**
 *
 * 所以界面是三段：容量条（还剩多少）→ 条目（都是些什么）→ 到期（什么时候忘）。
 * 「压缩」和「忘掉」不是管理功能，是这套曲线里唯一两个需要人来拍板的动作：
 * 超容了要合并、记错了要删。别的都交给定时收割，不给用户添按钮。
 *
 * ─────────────────────────────────────────────────────────────
 * 【host 响应形状】（与 host-agent 对齐后冻结，SPEC §12.9）
 *
 *   GET /ebbinghaus/state[?q=<关键词>]  ->
 *     { ok, ready, degraded, dir, now, query, hits[], total,
 *       zones: { short|long|permanent: { label, count, max, ratio,
 *                                        nextInDays, expired, entries[] } },
 *       config: { shortDays, longDays, writeEveryTurns },
 *       error? }                                  ← ok:false 时的人话
 *   POST /ebbinghaus/forget    { id }  -> { ok, removed, count }
 *   POST /ebbinghaus/compress  { zone }-> { ok, zone, before, after, merged }
 *   POST /ebbinghaus/harvest   {}      -> { ok, plan, zones }
 *
 * 条目：{ id, ts, iso, zone, weight, title, detail, keywords, depth, source,
 *         stamp, relative }   ← stamp / relative 由 host 算好，面板直接用
 *
 * 【为什么时间词不自己算】
 * 注入层用 core/time.mjs 算一遍、面板再算一遍，两处必然漂移 —— 用户会在
 * 注入里看到「昨天 21:30」、在面板里看到「3 天前 21:30」，然后谁都不信。
 * 所以 `relative` 优先；只有 host 没给（旧版本 / 半截响应）才本地兜底。
 *
 * 【为什么不假设字段齐全】host 是另一双手同时在写的。缺 zones、entries
 * 不是数组、ratio 是字符串、nextInDays 缺席 —— 全在 readZones 里被抹平，
 * 面板绝不因为少一个字段而白屏。宁可显示「—」也不要显示 undefined。
 */
window.__ModuleLoader__.load({
  id: 'ebbinghaus-memory',

  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    /** 侧栏格子的 id，同时是主面板的 key。**必须与注册时一致**，否则点了没反应。 */
    const PANEL_ID = 'ebbinghaus-memory';
    /** 数据接口前缀，与 host 侧的注册路径必须对得上 */
    const API = '/ebbinghaus';

    /** 三分区的展示顺序：从最新鲜到最久远。schema.mjs 里 ZONES 也是这个顺序。 */
    const ZONE_ORDER = ['short', 'long', 'permanent'];
    const ZONE_LABEL = { short: '短期', long: '长期', permanent: '永久' };
    /** 副标题沿用注入块的措辞（SPEC §11）—— 同一个东西两个说法，等于两套心智模型。 */
    const ZONE_NOTE = { short: '刚发生的', long: '偶尔想起来的', permanent: '我一直记得的' };

    /** 折叠时露几条。3 条够看出这区记的是什么事，又不至于把面板撑长。 */
    const COLLAPSED = 3;
    /** 超过这个占比就变色。不是「满」才提醒 —— 满了再动手就已经在回滚压缩了。 */
    const WARN_AT = 0.8;
    const DAY_MS = 86400000;
    const DETAIL_PREVIEW = 140;

    /**
     * 设置窗口里的分组。**键名必须与 core/config.mjs 的 TUNABLE_KEYS 对得上** ——
     * 对不上不是报错，是那一行输入框永远不出现（比报错更难查）。
     */
    const SETTING_GROUPS = [
      { title: '每个区最多放几条', keys: ['shortCapacity', 'longCapacity', 'permanentCapacity'] },
      { title: '上下文总量（token）', keys: ['totalTokenCapacity', 'budgetTokens'] },
      { title: '记忆库自检（重复合并）', keys: ['dedupEnabled', 'dedupEveryEntries', 'dedupThreshold'] },
      { title: '周期与写入频率', keys: ['shortDays', 'longDays', 'writeEveryTurns'] },
      { title: '每轮载入几条', keys: ['loadShortCount', 'loadLongRandom', 'loadPermanentCount'] },
      { title: '自动备份镜像（记忆 + 人格 + 配置）', keys: ['mirrorEnabled', 'mirrorEveryEntries', 'mirrorDir', 'mirrorExtraPaths'] },
      // 2026-10-27：频率和链路兜底。这几项都直接决定固化调模型的次数 ——
      // 调得越密，Token 花得越多，所以标题里就把话说明白。
      { title: '固化频率与链路兜底（会消耗 Token）', keys: ['minIntervalSeconds', 'fallbackEnabled', 'fallbackAfter', 'fallbackCooldownSeconds', 'modelCallsPaused'] },
    ];

    /**
     * 镜像状态一句话。没开 / 目录不对 / 正常，三种说法分开写。
     * @param {any} m
     * @returns {string}
     */
    function mirrorLineText(m) {
      if (!m || typeof m !== 'object') return '';
      if (!m.enabled) return '自动备份镜像：关着（在上面那组里打开开关、填好目录才会自动同步）';
      if (!m.dirOk) return `自动备份镜像：目录还不能用 —— ${m.dirReason || '还没填目录'}`;
      const parts = [`自动备份镜像：每 ${num(m.every, 5)} 条同步一次`];
      parts.push(`待同步 ${num(m.pending, 0)} 条`);
      if (m.lastAt) {
        const when = String(m.lastAt).replace('T', ' ').slice(0, 19);
        parts.push(`上次 ${when}${m.lastOk === false ? `（失败：${m.lastError || '原因不明'}）` : ''}`);
      } else {
        parts.push('还没同步过');
      }
      if (num(m.lastFiles, 0) > 0) parts.push(`上次 ${num(m.lastFiles, 0)} 个文件`);
      parts.push('（只同步当前分区）');
      return parts.join(' · ');
    }


    /**
     * token 开销说明。用户点名要的：让他自己看着选，而不是插件替他决定。
     * 三条都必须留着 —— 少一条就会有人以为「库大了每轮都多花钱」。
     */
    const WIKI = [
      '条数上限管「每个区最多几条」。超了自动回滚压缩：最老的几条揉成一条更模糊的，原文进 _archive，随时能捞回来。',
      '总量上限管「整库渲染成上下文一共多少 token」（中文约 1.8 字 = 1 token）。超了自动回收最老、最不重要的那几条 —— 同样是压缩不是删除。',
      '两道闸谁先到谁算数：条数没超、总量超了，一样会回收。300K 是硬顶。',
      '真正的每轮 token 开销由「注入预算」决定（默认 1400），库里有 10 万字不等于每轮多花 10 万 —— 每次只有十几条进上下文。',
      '「记忆库自检」是第三道：每隔 N 条新记忆，把**说的是同一件事**的条目跨分区并成一条。它不注入对话、不调模型，纯本地跑，所以既不占上下文也不花钱；合并后细节留最全的那份，原文进 _archive。',
      '库越大，检索、面板渲染、每次回收判断都会慢一点。日常聊 60K～100K 够用很久；把库当日志天天猛写再往上调。',
      '「自动备份镜像」把记忆库全部文件 + AGENT.md / prompt-inject.md 同步到另一个目录，每写入 N 条同步一次。镜像目录里会有一个 恢复记忆.cmd，双击就能把这份备份写回去（会先问你，也会先把当前库备份一份）。',
      '镜像目录要填绝对路径，且不能和记忆库目录互相嵌套。想让它也带上其它插件的数据（比如 alive / qq-bot 的 data 目录），在「额外要镜像的路径」里一行写一个。',
    ];

    /** token 数缩写：10400 → 10.4K，100000 → 100K。 */
    function fmtTokens(n) {
      const v = num(n, 0);
      if (v >= 100000) return `${Math.round(v / 1000)}K`;
      if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
      return String(Math.round(v));
    }

    /**
     * 主题 token。浅色/深色自动跟着切。
     * 刻意只用侦察时确认存在的那几个 —— 拼错一个 token 的表现是「那行字看不见」，
     * 没有任何报错指向这里。
     */
    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text1: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      err: 'var(--dsw-alias-state-error-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    };

    /* ───────────────────────── 时间 ───────────────────────── */

    function two(n) {
      return String(n).padStart(2, '0');
    }

    /**
     * 相对时间 + 点钟：`今天 21:30` / `昨天 03:12` / `3 天前 14:00` / `10-05 09:20`。
     *
     * 为什么这里抄一份 core/time.mjs 的 relativeStamp 而不是共用：
     * 客户端 bundle 不能 import 项目里的任何文件（没有打包器），而这份渲染规则
     * 只有十来行。代价是两处措辞要**手工保持一致** —— 面板说「3 天前」、注入说
     * 「三天前」，用户会以为在看两套数据。
     *
     * 用日历天而不是 24 小时：人的「昨天晚上」和「今天凌晨」是两天。
     */
    function relativeStamp(ts, now) {
      if (!Number.isFinite(ts)) return '时间不明';
      const startOfDay = (t) => {
        const d = new Date(t);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      };
      const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
      const d = new Date(ts);
      const hhmm = `${two(d.getHours())}:${two(d.getMinutes())}`;
      if (days <= 0) return `今天 ${hhmm}`;
      if (days === 1) return `昨天 ${hhmm}`;
      if (days < 7) return `${days} 天前 ${hhmm}`;
      return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hhmm}`;
    }

    /** 还剩几天到期。已过期的返回 0；不足一天算 1 —— 人不说「还有 0.3 天」。 */
    function daysUntil(ts, windowDays, now) {
      if (!Number.isFinite(ts) || !Number.isFinite(windowDays) || windowDays <= 0) return 0;
      const left = ts + windowDays * DAY_MS - now;
      if (left <= 0) return 0;
      return Math.max(1, Math.ceil(left / DAY_MS));
    }

    /* ───────────────────── 响应整形（防御面） ───────────────────── */

    /** host 给的任何东西都可能不是数字：字符串、null、NaN。统一收口。 */
    function num(v, fallback) {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
    }

    function isObj(v) {
      return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    }

    /**
     * 一条记忆整形。host 少给 detail 就少显示一行，少给 ts 就用 iso 反解，
     * 两个都没有就说「时间不明」—— 一条没有时间的记忆在这个面板里是最刺眼的
     * 那种错，宁可显式说出来也不要静默排到最前面。
     *
     * 时间显示三档，优先级从高到低：
     *   relative（host 算好的人话，如「昨天 21:30」）
     *   → 本地 relativeStamp 兜底（旧版 host / 半截响应）
     *   → 「时间不明」
     */
    function readEntry(raw, now) {
      const src = isObj(raw) ? raw : {};
      let ts = num(src.ts, NaN);
      if (!Number.isFinite(ts) && typeof src.iso === 'string') {
        const parsed = Date.parse(src.iso);
        if (Number.isFinite(parsed)) ts = parsed;
      }
      const zone = typeof src.zone === 'string' ? src.zone : '';
      const weight = num(src.weight, 0);
      const title = typeof src.title === 'string' ? src.title.trim() : '';
      const detail = typeof src.detail === 'string' ? src.detail : '';
      const relative = typeof src.relative === 'string' ? src.relative.trim() : '';
      return {
        id: typeof src.id === 'string' ? src.id : '',
        ts,
        when: relative || relativeStamp(ts, now),
        // 精确时间挂 title，鼠标停一下能看到年月日 —— 相对时间看着舒服但不精确
        stamp: typeof src.stamp === 'string' && src.stamp ? src.stamp : '',
        title: title || '（这条没有标题）',
        detail,
        weight,
        weightText: weight.toFixed(2),
        depth: Math.max(0, num(src.depth, 0)),
        zone,
        zoneLabel: ZONE_LABEL[zone] || '',
      };
    }

    /**
     * 按 ts 倒序（新的在前）。契约里 host 已经给倒序了，这里再排一次是
     * **幂等**的防御：真踩过的坑是 host 某条路径按升序返回（store.all() 是升序的），
     * 面板会把最老的一条摆在最上面，看着像记忆卡住了。
     */
    function newestFirst(list) {
      return list
        .slice()
        .sort((a, b) => (Number.isFinite(b.ts) ? b.ts : 0) - (Number.isFinite(a.ts) ? a.ts : 0));
    }

    /**
     * 本地算到期概览，host 没给 nextInDays / expired 时兜底。
     * 永久区没有周期（windowDays 为 0）→ 永远「没过期这回事」。
     */
    function localExpiry(entries, windowDays, now) {
      if (!Number.isFinite(windowDays) || windowDays <= 0) return { nextInDays: null, expired: 0 };
      let expired = 0;
      let soonest = null;
      for (const e of entries) {
        if (!Number.isFinite(e.ts)) continue;
        if (now - e.ts >= windowDays * DAY_MS) {
          expired += 1;
          continue;
        }
        const left = daysUntil(e.ts, windowDays, now);
        if (soonest === null || left < soonest) soonest = left;
      }
      return { nextInDays: soonest, expired };
    }

    /**
     * 三区整形。这是整个面板的承重墙：`zones` 缺区、`entries` 不是数组、
     * `ratio` 是字符串 —— 全在这里被抹平。面板拿到的一定是一个数组，
     * 里面每一项都是完整数字，所以渲染代码里不必再写 `|| 0` 的防御。
     */
    function readZones(rawZones, cfg, now) {
      const src = isObj(rawZones) ? rawZones : {};
      return ZONE_ORDER.map((key) => {
        const zRaw = isObj(src[key]) ? src[key] : {};
        const rawEntries = Array.isArray(zRaw.entries) ? zRaw.entries : [];
        const entries = newestFirst(rawEntries.map((e) => readEntry(e, now)));
        const max = Math.max(0, num(zRaw.max, 0));
        const count = Math.max(0, num(zRaw.count, entries.length));
        // ratio 不可信就用 count/max 重算：host 的 ratio 可能按别的口径算过
        let ratio = num(zRaw.ratio, max > 0 ? count / max : 0);
        if (!(ratio >= 0)) ratio = 0;
        if (ratio > 1) ratio = 1;

        const windowDays =
          key === 'short' ? num(cfg.shortDays, 7) : key === 'long' ? num(cfg.longDays, 28) : 0;

        // host 明确的字段优先（它知道全部条目，而 entries 只是最近若干条）
        let nextInDays;
        let expired;
        if ('nextInDays' in zRaw || 'expired' in zRaw) {
          // null = 这一区没有未到期的条目。**不等于 0** —— 0 是「马上到期」。
          nextInDays =
            zRaw.nextInDays === null || zRaw.nextInDays === undefined ? null : num(zRaw.nextInDays, null);
          expired = Math.max(0, num(zRaw.expired, 0));
        } else {
          const local = localExpiry(entries, windowDays, now);
          nextInDays = local.nextInDays;
          expired = local.expired;
        }

        return {
          key,
          label: typeof zRaw.label === 'string' && zRaw.label.trim() ? zRaw.label.trim() : ZONE_LABEL[key],
          note: ZONE_NOTE[key],
          count,
          max,
          ratio,
          pct: Math.round(ratio * 100),
          left: max > 0 ? Math.max(0, max - count) : null,
          over: max > 0 && count > max,
          hot: ratio >= WARN_AT,
          windowDays,
          entries,
          nextInDays,
          expired,
          // entries 是「最近若干条」，条数对不上时要在面板上说清楚，别让人以为丢了
          truncated: count > entries.length,
        };
      });
    }

    function readHits(raw, now) {
      return Array.isArray(raw) ? newestFirst(raw.map((e) => readEntry(e, now))) : [];
    }

    /* ───────────────────────── 图标 ───────────────────────── */

    /**
     * 侧栏图标。owner 传 `{ size, active }`（SidebarPanelIconOwnerProps），
     * 别改成别的 props 名；也**不能**假设一定传了 —— 无参调用要能渲染。
     * 画一条衰减曲线：记忆随时间往下掉，正是这个插件说的事。
     */
    function Icon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = Boolean(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          role: 'img',
          'aria-label': '记忆',
          style: { display: 'block', opacity: active ? 1 : 0.72 },
        },
        h('path', {
          d: 'M3 6.5 C8 6.5 10 18 21 18.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M3 19.5 H21',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeOpacity: 0.45,
          strokeDasharray: '2 3',
        }),
        h('circle', { cx: 8, cy: 6.5, r: 1.6, fill: 'currentColor' }),
      );
    }

    /* ───────────────────────── 小组件 ───────────────────────── */

    function linkStyle(color) {
      return {
        margin: 0,
        padding: 0,
        border: 0,
        background: 'none',
        color,
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        textDecoration: 'underline',
        textUnderlineOffset: 3,
      };
    }

    /** 小按钮（压缩 / 收割 / 重试）：有点边框，跟「忘掉」那种内联链接分开。 */
    function chipStyle(color, disabled) {
      return {
        margin: 0,
        padding: '3px 9px',
        borderRadius: 999,
        border: `1px solid ${C.border2}`,
        background: 'none',
        color,
        font: 'inherit',
        fontSize: 12,
        lineHeight: 1.6,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      };
    }

    function Section(props) {
      return h(
        'section',
        { style: { marginTop: 22 } },
        h(
          'h3',
          {
            style: {
              margin: '0 0 10px',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.06em',
              color: C.text2,
            },
          },
          props.title,
        ),
        props.children,
      );
    }

    function Empty(props) {
      return h(
        'p',
        { style: { margin: 0, fontSize: 13, lineHeight: 1.75, color: C.text2 } },
        props.text,
      );
    }

    /* ─────────────────────── 一根容量条 ─────────────────────── */

    /**
     * 容量条。三个信息叠在一起才有用：
     * 数字（已用/上限）、占比（人对「八成满」有直觉）、视觉剩余（空掉的那截）。
     * 只剩数字的话，60 条到底算多算少得靠心算。
     *
     * `fmt` / `overText` / `hotText` 是给「全库总量」那根条用的：
     * token 数要缩写成 10.4K，提示语也不能说「条」。
     */
    function Meter(props) {
      const z = props.zone;
      const fill = z.hot ? C.err : C.brand;
      const fmt = typeof props.fmt === 'function' ? props.fmt : (n) => String(n);
      const overText =
        typeof z.overText === 'string' ? z.overText : `超容 ${z.count - z.max} 条，除了末位淘汰还得压缩一次`;
      const hotText = typeof z.hotText === 'string' ? z.hotText : '快满了 —— 下一条进来就会触发回滚压缩';
      return h(
        'div',
        { style: { marginBottom: 14 } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 10,
              fontSize: 12,
            },
          },
          h(
            'span',
            { style: { color: C.text1, fontWeight: 600 } },
            z.label,
            h('span', { style: { color: C.text2, fontWeight: 400 } }, ` · ${z.note}`),
          ),
          h(
            'span',
            {
              style: {
                color: z.hot ? C.err : C.text2,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              },
            },
            z.max > 0 ? `${fmt(z.count)} / ${fmt(z.max)}` : `${fmt(z.count)}`,
            ` · ${z.pct}%`,
            z.left !== null ? ` · 剩 ${fmt(z.left)}` : '',
          ),
        ),
        // 轨道底色就是「还没用掉的部分」，填充是「已经用掉的」。
        // 两个颜色都来自 token，深浅色各自对得上对比度。
        h(
          'div',
          {
            style: {
              position: 'relative',
              height: 6,
              marginTop: 6,
              borderRadius: 3,
              background: C.layer2,
              overflow: 'hidden',
            },
            'aria-label': `${z.label}已用 ${fmt(z.count)} / ${fmt(z.max)}`,
          },
          h('div', {
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${z.pct}%`,
              background: fill,
              borderRadius: 3,
              transition: 'width 0.25s ease',
            },
          }),
        ),
        z.over
          ? h('div', { style: { marginTop: 5, fontSize: 11, color: C.err } }, overText)
          : z.hot
            ? h('div', { style: { marginTop: 5, fontSize: 11, color: C.err } }, hotText)
            : null,
      );
    }

    /* ───────────────────────── 一条记忆 ───────────────────────── */

    /**
     * 单条记忆。确认状态由 Panel 持有（confirmingId），这里不持 hook：
     * 一来「同时只有一条在待确认」本来就该是全局约束，
     * 二来测试用的桩渲染器里所有组件的 hook 槽位是共享的，状态下沉到
     * 每条一个实例反而会读出别人的值。
     */
    function EntryRow(props) {
      const e = props.entry;
      const confirming = props.confirming;
      const busy = props.busy;
      const detail =
        e.detail.length > DETAIL_PREVIEW ? `${e.detail.slice(0, DETAIL_PREVIEW)}…` : e.detail;

      return h(
        'article',
        {
          // 悬停看精确时间：相对时间读着舒服，但要核对「到底是哪天」时得有地方看
          title: e.stamp || undefined,
          style: {
            padding: '10px 12px',
            marginBottom: 8,
            borderRadius: 10,
            background: C.layer1,
            border: `1px solid ${C.border1}`,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: 8,
              fontSize: 11,
              color: C.text2,
            },
          },
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, e.when),
          props.zoneLabel
            ? h(
                'span',
                {
                  style: {
                    padding: '0 6px',
                    borderRadius: 999,
                    border: `1px solid ${C.border2}`,
                    color: C.text2,
                  },
                },
                props.zoneLabel,
              )
            : null,
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `· 权重 ${e.weightText}`),
          e.depth > 0 ? h('span', null, `· 压缩 ${e.depth} 层`) : null,
        ),
        h(
          'p',
          { style: { margin: '6px 0 0', fontSize: 13, lineHeight: 1.7, color: C.text1 } },
          e.title,
        ),
        detail
          ? h(
              'p',
              { style: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.7, color: C.text2 } },
              detail,
            )
          : null,
        h(
          'div',
          { style: { marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 10 } },
          confirming
            ? h(
                'span',
                { style: { display: 'inline-flex', gap: 10, alignItems: 'center', fontSize: 12 } },
                h('span', { style: { color: C.text2 } }, '确定忘掉？'),
                h(
                  'button',
                  { type: 'button', onClick: () => props.onForget(e.id), style: linkStyle(C.err) },
                  '忘掉',
                ),
                h(
                  'button',
                  { type: 'button', onClick: () => props.onCancel(), style: linkStyle(C.text2) },
                  '算了',
                ),
              )
            : h(
                'button',
                {
                  type: 'button',
                  onClick: () => props.onConfirm(e.id),
                  disabled: Boolean(busy) || !e.id,
                  title: e.id ? '从磁盘上删掉这一条' : '这条没有 id，删不了',
                  style: { ...linkStyle(C.text2), opacity: busy || !e.id ? 0.45 : 0.75 },
                },
                '忘掉',
              ),
        ),
      );
    }

    /* ───────────────────────── 一个分区 ───────────────────────── */

    function ZoneCard(props) {
      const z = props.zone;
      const expanded = Boolean(props.expanded);
      const visible = expanded ? z.entries : z.entries.slice(0, COLLAPSED);
      const hidden = Math.max(0, z.entries.length - COLLAPSED);
      const compressBusy = props.busy === `zone:${z.key}`;

      return h(
        'section',
        {
          style: {
            marginBottom: 14,
            padding: '12px 14px',
            borderRadius: 12,
            background: C.layer1,
            border: `1px solid ${C.border1}`,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              marginBottom: 10,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 13, fontWeight: 600, color: C.text1 } }, z.label),
            h('span', { style: { fontSize: 11, color: C.text2 } }, `共 ${z.count} 条`),
            z.truncated
              ? h(
                  'span',
                  { style: { fontSize: 11, color: C.text2 } },
                  `（面板只取了最近 ${z.entries.length} 条）`,
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => props.onCompress(z.key),
              disabled: compressBusy || z.entries.length === 0,
              title: '把最老的几条合并成一条更模糊的，压进下一区',
              style: chipStyle(C.brand, compressBusy || z.entries.length === 0),
            },
            compressBusy ? '压缩中…' : '压缩',
          ),
        ),
        z.entries.length === 0
          ? h(Empty, { text: '这一层还是空的。' })
          : h(
              'div',
              null,
              visible.map((e, i) =>
                h(EntryRow, {
                  key: e.id || `${z.key}-${i}`,
                  entry: e,
                  zoneLabel: props.withZoneLabel ? e.zoneLabel || z.label : '',
                  confirming: props.confirmingId === e.id && Boolean(e.id),
                  busy: props.busy === e.id,
                  onConfirm: props.onConfirm,
                  onForget: props.onForget,
                  onCancel: props.onCancel,
                }),
              ),
              // 「共 N 条」是可点的入口，不是一句话 —— 用户要的是「剩下的在哪儿」
              hidden > 0 || expanded
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => props.onToggle(z.key),
                      style: { ...linkStyle(C.brand), fontSize: 12, marginTop: 2 },
                    },
                    expanded ? '收起' : `展开全部（还有 ${hidden} 条）`,
                  )
                : null,
            ),
      );
    }

    /* ─────────────────────── 底部：到期 ─────────────────────── */

    /**
     * 这一块是这个插件的「为什么」：记忆不是无限留着的。
     * 每区一行：还有几天到期 / 已到期几条。没有周期的永久区说「不过期」，
     * 别写 0 —— 0 会被读成「马上到期」。
     */
    function ExpiryFoot(props) {
      return h(
        'div',
        {
          style: {
            marginTop: 18,
            padding: '12px 14px',
            borderRadius: 12,
            background: C.layer1,
            border: `1px solid ${C.border1}`,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              marginBottom: 8,
            },
          },
          h(
            'h3',
            {
              style: { margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: '0.06em', color: C.text2 },
            },
            '什么时候会忘',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: props.onHarvest,
              disabled: props.busy === 'harvest',
              title: '立刻按遗忘曲线跑一次到期收割',
              style: chipStyle(C.text2, props.busy === 'harvest'),
            },
            props.busy === 'harvest' ? '收割中…' : '收割到期',
          ),
        ),
        props.zones.map((z) =>
          h(
            'div',
            {
              key: z.key,
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                gap: 10,
                fontSize: 12,
                lineHeight: 1.9,
                color: C.text2,
              },
            },
            h('span', null, z.label),
            h(
              'span',
              { style: { fontVariantNumeric: 'tabular-nums', textAlign: 'right' } },
              expiryText(z),
            ),
          ),
        ),
      );
    }

    function expiryText(z) {
      if (!(z.windowDays > 0)) return '不过期';
      if (z.count === 0) return '没有条目';
      // nextInDays === null 在契约里是「这一区没有未到期的条目」，
      // 显示「—」而不是「null 天」；0 才是「有条已经到点了」。
      const soon =
        z.nextInDays === null || z.nextInDays === undefined
          ? '最近到期 —'
          : z.nextInDays > 0
            ? `最近一条还有 ${z.nextInDays} 天`
            : '有条已经到点了';
      return z.expired > 0 ? `${soon} · 已到期 ${z.expired} 条` : soon;
    }

    /* ─────────────────── 调整容量（设置窗口） ─────────────────── */

    function settingInputStyle() {
      return {
        width: 96,
        padding: '5px 8px',
        fontSize: 12,
        color: C.text1,
        background: C.layer1,
        border: `1px solid ${C.border1}`,
        borderRadius: 6,
        outline: 'none',
        fontVariantNumeric: 'tabular-nums',
      };
    }

    /**
     * 调整窗口。默认收起 —— 面板的主线是「它还记着什么」，不是配置编辑器。
     *
     * 但入口必须一眼看见（标题 + 展开按钮），说明文字也必须写在面板里：
     * 用户原话是「我没看到在哪可以调」，把答案只放在 README 里等于没给。
     *
     * 字段表由 host 给（`settings.fields`），客户端不重复写一遍 min/max ——
     * 两处各写一份，早晚会有一处忘了改。
     */
    function SettingsCard(props) {
      const fields = Array.isArray(props.fields) ? props.fields : [];
      const byKey = {};
      for (const f of fields) {
        if (f && typeof f.key === 'string') byKey[f.key] = f;
      }
      const draft = props.draft && typeof props.draft === 'object' ? props.draft : {};
      const open = Boolean(props.open);
      const busy = typeof props.busy === 'string' && props.busy !== '';
      const notice = typeof props.notice === 'string' ? props.notice : '';
      const overridden = Boolean(props.overridden);

      /** 读某个设置项「当前会生效的值」（草稿优先于已存值）。 */
  const valueOfSetting = (key) => {
    const field = byKey[key]
    if (!field) return undefined
    const raw = Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : field.value
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }

  /**
   * 「按现在的设置，每轮大概塞多少 memory 进上下文」。
   *
   * 为什么要有：面板上只写了注入预算（budgetTokens）的 token 上限，
   * 却没告诉人「这几个条数加起来大概占多少」—— 用户 2026-10-28 提的。
   * 每条的单价用「全库 token ÷ 全库条数」推，所以是**估算**，不是精确值。
   */
  const injectPreview = () => {
    const counts = props.entryCounts && typeof props.entryCounts === 'object' ? props.entryCounts : null
    if (!counts) return null
    const avg = Number(props.avgTokensPerEntry)
    const want = (key, zone) => {
      const asked = valueOfSetting(key) ?? 0
      const have = Number(counts[zone]) || 0
      return Math.max(0, Math.min(asked, have))
    }
    const nShort = want('loadShortCount', 'short')
    const nLong = want('loadLongRandom', 'long')
    const nPerm = want('loadPermanentCount', 'permanent')
    const n = nShort + nLong + nPerm
    const budget = valueOfSetting('budgetTokens') ?? 0
    const est = avg > 0 ? Math.round(n * avg) : 0
    const pct = budget > 0 && est > 0 ? Math.round((est / budget) * 100) : 0
    const detail = `短 ${nShort} / 长 ${nLong} / 永 ${nPerm}`
    const text =
      est > 0
        ? `按现在的设置：每轮最多带 ${n} 条（${detail}），估算约 ${est} token，占注入上限 ${budget > 0 ? `${budget} token 的 ${pct}%` : '（未设）'}` +
          (pct >= 100 ? ' —— 超了，多出来的会被预算裁掉' : '')
        : `按现在的设置：每轮最多带 ${n} 条（${detail}）；库里还没有可估价的条目，算不出 token`
    return h(
      'div',
      {
        key: 'inject-preview',
        style: { marginBottom: 8, fontSize: 11, lineHeight: 1.7, color: C.text2 },
      },
      text,
    )
  }

  const row = (f) => {
        const edited = Object.prototype.hasOwnProperty.call(draft, f.key);

        // 布尔字段（目前只有「记忆库自检」开关）：渲染成勾选框。
        // 值是 true/false，不是 'true' 字符串 —— 保存时按字段类型走。
        if (f.type === 'boolean') {
          const on = edited ? draft[f.key] === true || draft[f.key] === 'true' : f.value === true;
          return h(
            'label',
            {
              key: f.key,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 7,
                fontSize: 12,
                color: C.text1,
                cursor: 'pointer',
              },
            },
            h('input', {
              type: 'checkbox',
              checked: on,
              'aria-label': f.label || f.key,
              onChange: (ev) => props.onChange(f.key, Boolean(ev && ev.target && ev.target.checked)),
              style: { accentColor: C.brand, width: 14, height: 14, margin: 0 },
            }),
            h(
              'span',
              { style: { flex: '1 1 auto' } },
              f.label || f.key,
              f.overridden ? h('span', { style: { color: C.brand, fontSize: 11 } }, ' · 面板改过') : null,
            ),
            h('span', { style: { color: C.text2, fontSize: 11 } }, on ? '开着' : '关着'),
          );
        }

        // 字符串字段（镜像目录 / 额外路径）：渲染成文本框或文本域。
        // 面板只负责原样回传，路径合不合法由 host 的 isSafeMirrorDir 判 ——
        // 前端再写一遍路径校验，早晚会和后端判得不一样。
        if (f.type === 'string') {
          const text = edited ? String(draft[f.key] ?? '') : String(f.value ?? '');
          const multiline = f.key === 'mirrorExtraPaths';
          const boxStyle = {
            ...settingInputStyle(),
            width: '100%',
            boxSizing: 'border-box',
            fontFamily: 'Consolas, ui-monospace, monospace',
          };
          return h(
            'label',
            { key: f.key, style: { display: 'block', marginBottom: 8, fontSize: 12 } },
            h(
              'span',
              { style: { display: 'block', color: C.text1, marginBottom: 3 } },
              f.label || f.key,
              f.overridden ? h('span', { style: { color: C.brand, fontSize: 11 } }, ' · 面板改过') : null,
            ),
            multiline
              ? h('textarea', {
                  value: text,
                  rows: 3,
                  'aria-label': f.label || f.key,
                  placeholder: '每行一个绝对路径，比如 D:/plugin-data（可留空）',
                  onChange: (ev) => props.onChange(f.key, ev && ev.target ? String(ev.target.value ?? '') : ''),
                  style: { ...boxStyle, minHeight: 58, resize: 'vertical', lineHeight: 1.5 },
                })
              : h('input', {
                  type: 'text',
                  value: text,
                  'aria-label': f.label || f.key,
                  placeholder: '绝对路径，比如 D:/mirror/ebbinghaus（留空 = 不备份）',
                  onChange: (ev) => props.onChange(f.key, ev && ev.target ? String(ev.target.value ?? '') : ''),
                  style: boxStyle,
                }),
          );
        }
        const value = edited ? draft[f.key] : String(f.value ?? '');
        return h(
          'label',
          {
            key: f.key,
            style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, fontSize: 12 },
          },
          h(
            'span',
            { style: { flex: '1 1 auto', color: C.text1 } },
            f.label || f.key,
            f.overridden ? h('span', { style: { color: C.brand, fontSize: 11 } }, ' · 面板改过') : null,
          ),
          h('input', {
            type: 'number',
            value,
            min: f.min,
            max: f.max,
            step: f.step,
            'aria-label': f.label || f.key,
            onChange: (ev) =>
              props.onChange(f.key, ev && ev.target ? String(ev.target.value ?? '') : ''),
            style: settingInputStyle(),
          }),
          h(
            'span',
            {
              style: {
                width: 90,
                textAlign: 'right',
                color: C.text2,
                fontSize: 11,
                fontVariantNumeric: 'tabular-nums',
              },
            },
            f.min !== undefined && f.max !== undefined ? `${f.min}–${f.max}` : '',
          ),
        );
      };

      const groups = SETTING_GROUPS.map((g) => {
        const rows = g.keys.map((k) => byKey[k]).filter(Boolean);
        if (rows.length === 0) return null;
        // 「每轮载入几条」这组：标题下面先给一行估算，再列三个输入框
        const preview = g.title === '每轮载入几条' ? injectPreview() : null
        return h(
          'div',
          { key: g.title, style: { marginTop: 12 } },
          h(
            'div',
            { style: { marginBottom: 6, fontSize: 11, letterSpacing: '0.05em', color: C.text2 } },
            g.title,
          ),
          preview,
          rows.map(row),
        );
      }).filter(Boolean);

      return h(
        'section',
        { style: { marginTop: 22 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 } },
          h(
            'h3',
            {
              style: {
                margin: 0,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '0.06em',
                color: C.text2,
              },
            },
            '调整容量',
          ),
          h(
            'button',
            { type: 'button', onClick: props.onToggle, style: chipStyle(C.brand, false) },
            open ? '收起' : '展开',
          ),
        ),
        open
          ? h(
              'div',
              { style: { marginTop: 10 } },
              h(
                'ul',
                {
                  style: {
                    margin: 0,
                    padding: '10px 12px 10px 26px',
                    borderRadius: 10,
                    background: C.layer1,
                    border: `1px solid ${C.border1}`,
                    fontSize: 11,
                    lineHeight: 1.85,
                    color: C.text2,
                  },
                },
                WIKI.map((line, i) => h('li', { key: `wiki-${i}` }, line)),
              ),
              groups,
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 } },
                h(
                  'button',
                  { type: 'button', onClick: props.onSave, style: chipStyle(C.brand, busy), disabled: busy },
                  busy ? '处理中…' : '保存',
                ),
                h(
                  'button',
                  { type: 'button', onClick: props.onReset, style: chipStyle(C.text2, busy), disabled: busy },
                  '恢复 DSH 配置',
                ),
                h(
                  'button',
                  { type: 'button', onClick: props.onReclaim, style: chipStyle(C.text2, busy), disabled: busy },
                  '按总量回收一次',
                ),
                h(
                  'button',
                  { type: 'button', onClick: props.onMirror, style: chipStyle(C.text2, busy === '镜像'), disabled: busy },
                  busy === '镜像' ? '同步中…' : '立即同步镜像',
                ),
                h(
                  'p',
                  { style: { margin: '10px 0 0', fontSize: 11, color: C.text2, lineHeight: 1.7 } },
                  mirrorLineText(props.mirror),
                ),
              ),
              notice
                ? h(
                    'p',
                    { style: { margin: '10px 0 0', fontSize: 12, color: C.text2, lineHeight: 1.7 } },
                    notice,
                  )
                : null,
              h(
                'p',
                { style: { margin: '8px 0 0', fontSize: 11, color: C.text2, lineHeight: 1.7 } },
                typeof props.file === 'string' && props.file !== ''
                  ? `这些值存在 ${props.file}，优先于 DSH 设置页；删掉它或者点「恢复」就回到原值。`
                  : '这些值会存在记忆库目录的 settings.json 里，优先于 DSH 设置页。',
                overridden ? '' : '（现在没有任何面板覆盖值）',
              ),
            )
          : null,
      );
    }

    /* ───────────────────────── 主面板 ───────────────────────── */

    /** POST 收口：统一头、统一错误、统一「返回体可能是空/非 JSON」。 */
    function postJson(path, body) {
      return fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body || {}),
      }).then((r) => {
        if (r && r.ok === false) return Promise.reject(new Error(`HTTP ${r.status}`));
        if (!r || typeof r.json !== 'function') return {};
        return r.json().catch(() => ({}));
      });
    }

    function urlFor(query) {
      // 关键词里可能有空格、中文、& —— 不编码会让 host 收到半截查询
      return query ? `${API}/state?q=${encodeURIComponent(query)}` : `${API}/state`;
    }

    function Panel() {
      const [phase, setPhase] = useState('loading');
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState('');
      /** 分区操作的小表单：{ mode: "create"|"rename"|"delete", value, id } */
      const [spaceOp, setSpaceOp] = useState(null);
      const [tick, setTick] = useState(0);
      // 输入框里正在打的字 与 已经提交给 host 的关键词分开：
      // 合成一个的话，每敲一个字都会打一次接口。
      const [draft, setDraft] = useState('');
      const [query, setQuery] = useState('');
      const [expanded, setExpanded] = useState({});
      const [confirmingId, setConfirmingId] = useState('');
      // ── 调整容量 ──
      const [settingsOpen, setSettingsOpen] = useState(false);
      /** 正在编辑的值（key → 输入框里的原始字符串）。空对象 = 没改动，显示生效值 */
      const [settingsDraft, setSettingsDraft] = useState({});
      const [settingsNotice, setSettingsNotice] = useState('');
      const [dedupNotice, setDedupNotice] = useState('');
      /** 「复制诊断」的状态提示 + 剪贴板不可用时的兜底文本 */
      const [diagNotice, setDiagNotice] = useState('');
      const [diagText, setDiagText] = useState('');

      useEffect(() => {
        let alive = true;
        fetch(urlFor(query), { headers: { Accept: 'application/json' } })
          .then((r) => (r && r.ok === false ? Promise.reject(new Error(`HTTP ${r.status}`)) : r.json()))
          .then((payload) => {
            if (!alive) return;
            const p = payload && typeof payload === 'object' ? payload : {};
            // ok:false 不是传输失败，是 host 自己说「这次没成」——
            // 它带了一句人话在 error 里，照抄比我们编一句准。
            if (p.ok === false) {
              setData(p);
              setError(
                typeof p.error === 'string' && p.error.trim() ? p.error.trim() : '记忆库这会儿读不出来',
              );
              setPhase('error');
              return;
            }
            setData(p);
            setError('');
            setPhase('ready');
          })
          .catch((err) => {
            if (!alive) return;
            setError(String((err && err.message) || err));
            setPhase('error');
          });
        return () => {
          alive = false;
        };
      }, [tick, query]);

      function reload() {
        setTick((n) => n + 1);
      }

      function actThenReload(path, body, label) {
        setBusy(label);
        setNotice('');
        return postJson(path, body)
          .then(() => {
            setBusy('');
            setConfirmingId('');
            reload();
          })
          .catch((err) => {
            setBusy('');
            setNotice(`${label}没成功：${String((err && err.message) || err)}`);
          });
      }

      function forget(id) {
        if (!id) return;
        actThenReload('/forget', { id }, '忘掉');
      }

      function compress(zone) {
        actThenReload('/compress', { zone }, '压缩');
      }

      function harvest() {
        actThenReload('/harvest', {}, '收割');
      }

      function toggle(key) {
        setExpanded((prev) => {
          const next = { ...(prev || {}) };
          next[key] = !next[key];
          return next;
        });
      }

      /* ── 调整容量：改 / 保存 / 恢复 / 手动回收 ── */

      function editSetting(key, value) {
        setSettingsDraft((prev) => ({ ...(prev || {}), [key]: value }));
      }

      function saveSettings() {
        /** @type {Record<string, any>} */
        const body = {};
        let bad = '';
        const fields = isObj(data) && isObj(data.settings) && Array.isArray(data.settings.fields)
          ? data.settings.fields
          : [];
        for (const key of Object.keys(settingsDraft || {})) {
          const raw = settingsDraft[key];
          const field = fields.find((f) => f && f.key === key);
          // 布尔字段直接传 true/false —— 走 Number() 会把它变成 1/0
          if (field && field.type === 'boolean') {
            body[key] = raw === true || raw === 'true';
            continue;
          }
          // 字符串字段（镜像目录 / 额外路径）：值本来就是文本，路径过 Number()
          // 必然是 NaN，会被当成「填错了」把整次保存吞掉。而且这一格**空串是
          // 有意义的**（"留空 = 不备份"），所以空也要提交 —— 只有数字字段才把
          // 空当"没动"。
          if (field && field.type === 'string') {
            body[key] = String(raw ?? '').trim();
            continue;
          }
          const s = String(raw ?? '').trim();
          // 空 = 这一项没动。**不能按 0 提交** —— 那会被钳到最小值。
          if (s === '') continue;
          const n = Number(s);
          if (!Number.isFinite(n)) {
            bad = key;
            break;
          }
          body[key] = n;
        }
        if (bad !== '') {
          setSettingsNotice(`「${bad}」不是数字，这次没保存`);
          return;
        }
        if (Object.keys(body).length === 0) {
          setSettingsNotice('没有改动');
          return;
        }
        setBusy('设置');
        setSettingsNotice('');
        postJson('/settings', body)
          .then((r) => {
            setBusy('');
            setSettingsDraft({});
            const parts = [];
            if (Array.isArray(r.changed) && r.changed.length > 0) parts.push(`保存了 ${r.changed.length} 项`);
            if (Array.isArray(r.rejected) && r.rejected.length > 0) parts.push(`拒收：${r.rejected.join('、')}`);
            if (r.reclaim) parts.push('已经超过新上限，后台正在回收');
            setSettingsNotice(parts.join(' · ') || '已保存（值没变）');
            reload();
          })
          .catch((err) => {
            setBusy('');
            setSettingsNotice(`保存没成功：${String((err && err.message) || err)}`);
          });
      }

      function resetSettings() {
        setBusy('恢复');
        setSettingsNotice('');
        postJson('/settings', { reset: true })
          .then(() => {
            setBusy('');
            setSettingsDraft({});
            setSettingsNotice('已恢复为 DSH 配置里的值');
            reload();
          })
          .catch((err) => {
            setBusy('');
            setSettingsNotice(`恢复没成功：${String((err && err.message) || err)}`);
          });
      }

      function reclaimTotal() {
        setBusy('回收');
        setSettingsNotice('');
        postJson('/reclaim', {})
          .then((r) => {
            setBusy('');
            const rounds = num(r.rounds, 0);
            if (rounds > 0) {
              setSettingsNotice(
                `回收了 ${rounds} 轮：${fmtTokens(r.before)} → ${fmtTokens(r.after)} token（原文进 _archive）`,
              );
            } else if (r.exhausted) {
              setSettingsNotice('没得压了 —— 剩下的都是人格底色，或者某个区只剩一条。');
            } else {
              setSettingsNotice('本来就在上限内，不用回收。');
            }
            reload();
          })
          .catch((err) => {
            setBusy('');
            setSettingsNotice(`回收没成功：${String((err && err.message) || err)}`);
          });
      }

      /**
       * 「立刻自检」—— 手动跑一次重复合并。
       * 纯本地算法，毫秒级，所以能等它跑完再刷新（用户点了按钮就该看到结果）。
       */
      /** bot 专区的提示 + 分区体检的提示 */
      const [botNotice, setBotNotice] = useState('');
      const [botPick, setBotPick] = useState('');

      /** 把 bot 专区钉死在某个分区（钉死后不可改）。 */
      function saveBotSpace() {
        const spaceId = botPick || (isObj(d.botSpace) ? String(d.botSpace.spaceId || '') : '');
        if (!spaceId) {
          setBotNotice('先选一个分区');
          return;
        }
        postJson('/bot-space', { spaceId })
          .then((r) => {
            if (r && r.ok === false) {
              setBotNotice(String(r.error || '保存失败'));
              return;
            }
            setBotNotice(`已设为存到「${r.spaceLabel || spaceId}」，之后不允许更改`);
            reload();
          })
          .catch(() => setBotNotice('保存失败'));
      }

      /** 从镜像把某个分区缺失的条目补回来。 */
      function recoverPartition(spaceId) {
        postJson('/recover', { spaceId })
          .then((r) => {
            if (r && r.ok === false) {
              setBotNotice(String(r.reason || '恢复失败'));
              return;
            }
            setBotNotice(`已从镜像补回 ${num(r.added, 0)} 条（跳过 ${num(r.skipped, 0)}，坏行 ${num(r.badLines, 0)}）`);
            reload();
          })
          .catch(() => setBotNotice('恢复失败'));
      }

      /** 生成诊断文本并尽量塞进剪贴板（不给权限就摊在框里让人手抄）。 */
      function copyDiagnostics() {
        setDiagNotice('正在生成…');
        setDiagText('');
        fetch(`${API}/diagnostics`, { headers: { Accept: 'application/json' } })
          .then((r) => (r && typeof r.json === 'function' ? r.json() : {}))
          .then(async (d) => {
            const text = typeof d?.text === 'string' ? d.text : '';
            if (text === '') {
              setDiagNotice('生成失败：没拿到内容');
              return;
            }
            try {
              if (!navigator || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
                throw new Error('no clipboard');
              }
              await navigator.clipboard.writeText(text);
              setDiagNotice('已复制到剪贴板 —— 直接贴进 issue 就行');
            } catch {
              // 浏览器不给剪贴板权限（非安全上下文常见）：摊在框里，手动全选复制
              setDiagText(text);
              setDiagNotice('剪贴板不可用，内容在下面，手动全选复制');
            }
          })
          .catch(() => setDiagNotice('生成失败，看看控制台'));
      }

      function runDedup() {
        setBusy('自检');
        setDedupNotice('');
        postJson('/dedup', {})
          .then((r) => {
            setBusy('');
            const groups = num(r.groups, 0);
            const merged = num(r.merged, 0);
            if (groups > 0) {
              setDedupNotice(
                `合了 ${groups} 组，少了 ${merged} 条（${num(r.before, 0)} → ${num(r.after, 0)}）· 原文进 _archive/dedup.jsonl`,
              );
            } else if (r.skipped === 'degraded') {
              setDedupNotice('记忆库现在是只读模式，自检跑不了。');
            } else {
              setDedupNotice('没找到重复的，库挺干净。');
            }
            reload();
          })
          .catch((err) => {
            setBusy('');
            setDedupNotice(`自检没成功：${String((err && err.message) || err)}`);
          });
      }

      /**
       * 「立即同步镜像」—— 手动跑一次全量镜像。
       * 结果写进设置卡的 notice 里（和「保存」共用一行提示，省一块 UI）。
       */
      function runMirror() {
        setBusy('镜像');
        postJson('/mirror', {})
          .then((r) => {
            setBusy('');
            if (r && r.ok) {
              const mb = num(r.bytes, 0) / 1048576;
              setSettingsNotice(`已同步 ${num(r.files, 0)} 项（${mb.toFixed(1)} MB）→ ${r.dir || ''}`);
            } else {
              setSettingsNotice(`镜像没成功：${String((r && r.reason) || '未知原因')}`);
            }
            reload();
          })
          .catch((err) => {
            setBusy('');
            setSettingsNotice(`镜像没成功：${String((err && err.message) || err)}`);
          });
      }
      /**
       * 切当前记忆分区。
       * **只影响之后新开的对话** —— 已经聊着的会话按绑定走，记忆不会换人。
       * @param {string} id
       */
      /** 提交分区操作（新建 / 改名 / 删除共用一个表单）。 */
      function submitSpaceOp() {
        if (!spaceOp) return;
        const op = spaceOp;
        const path =
          op.mode === 'create'
            ? '/spaces/create'
            : op.mode === 'rename'
              ? '/spaces/rename'
              : '/spaces/delete';
        const body =
          op.mode === 'create'
            ? { name: op.value }
            : op.mode === 'rename'
              ? { id: op.id, name: op.value }
              : { id: op.id };
        setBusy('分区');
        postJson(path, body)
          .then((r) => {
            setBusy('');
            setSpaceOp(null);
            if (r && r.ok === false) {
              setSettingsNotice(`分区操作没成功：${r.error || '未知原因'}`);
            } else if (op.mode === 'delete' && num(r.unbound, 0) > 0) {
              setSettingsNotice(`已删掉，目录搬到 _trash；顺带解绑了 ${num(r.unbound, 0)} 个会话`);
            }
            reload();
          })
          .catch((err) => {
            setBusy('');
            setSettingsNotice(`分区操作没成功：${String((err && err.message) || err)}`);
          });
      }

      function switchSpace(id) {
        const target = typeof id === 'string' ? id.trim() : '';
        if (target === '') return;
        setBusy('分区');
        postJson('/spaces/active', { id: target })
          .then(() => {
            setBusy('');
            reload();
          })
          .catch((err) => {
            setBusy('');
            setSettingsNotice(`切分区没成功：${String((err && err.message) || err)}`);
          });
      }
      function submit() {
        const q = draft.trim();
        setQuery(q);
        setExpanded({});
        // 同一个词再回车也要重取 —— 用户按回车的心理预期是「刷新一下」
        reload();
      }

      const wrap = { height: '100%', overflowY: 'auto', background: C.bg, color: C.text1 };
      const inner = { maxWidth: 760, margin: '0 auto', padding: '28px 24px 60px' };

      if (phase === 'loading') {
        return h('div', { style: wrap }, h('div', { style: inner }, h(Empty, { text: '翻记忆…' })));
      }
      if (phase === 'error') {
        return h(
          'div',
          { style: wrap },
          h(
            'div',
            { style: inner },
            h(Empty, { text: `读不到记忆库：${error}` }),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  setPhase('loading');
                  reload();
                },
                style: { ...linkStyle(C.brand), marginTop: 10 },
              },
              '再试一次',
            ),
          ),
        );
      }

      const d = data && typeof data === 'object' ? data : {};
      const cfg = d.config && typeof d.config === 'object' ? d.config : {};
      // 用 host 的 now 做本地区间计算：面板和 host 各拿一次 Date.now()，
      // 跨秒的时候会出现「host 说 3 天、面板算 4 天」这种对不上的小毛病。
      const now = num(d.now, Date.now());
      const zones = readZones(d.zones, cfg, now);
      const hits = readHits(d.hits, now);
      const searching = typeof d.query === 'string' ? d.query.trim() : query.trim();
      const total = num(
        d.total,
        zones.reduce((sum, z) => sum + z.count, 0),
      );
      const shortDays = num(cfg.shortDays, 7);
      const longDays = num(cfg.longDays, 28);
      const ready = d.ready !== false;

      // ── 全库总量（第二道闸）：host 没给就不显示这根条，绝不用 0 假装「很空」 ──
      const tokens = isObj(d.tokens) ? d.tokens : null;
      const tokenTotal = tokens !== null ? Math.max(0, num(tokens.total, 0)) : 0;
      const tokenCap = tokens !== null ? Math.max(0, num(tokens.capacity, 0)) : 0;
      let totalZone = null;
      if (tokenCap > 0) {
        const ratio = Math.min(1, tokenTotal / tokenCap);
        totalZone = {
          key: 'total',
          label: '全库总量',
          note: '每一条都渲染成上下文后的大小',
          count: tokenTotal,
          max: tokenCap,
          ratio,
          pct: Math.round(ratio * 100),
          left: Math.max(0, tokenCap - tokenTotal),
          over: tokenTotal > tokenCap,
          hot: ratio >= WARN_AT,
          overText: `超了 ${fmtTokens(tokenTotal - tokenCap)} token —— 会先压缩最老最不重要的那几条（原文进 _archive）`,
          hotText: '快满了 —— 再攒下去会开始按总量回收',
        };
      }

      const head = [`三层记忆 · 共 ${total} 条`, `短期 ${shortDays} 天 / 长期 ${longDays} 天`];
      if (tokenCap > 0) head.push(`总量 ${fmtTokens(tokenTotal)} / ${fmtTokens(tokenCap)} token`);
      if (typeof d.dir === 'string' && d.dir) head.push(d.dir);

  /* 设置卡里那条「预计注入占用」要用的数据：各分区现有条数 + 每条平均 token。
     平均单价用「全库 token ÷ 全库条数」推，只做量级参考 —— 面板上会写明是估算。 */
  const zoneCountOf = (key) => {
    const zone = zones.find((item) => item && item.key === key);
    return zone ? Math.max(0, num(zone.count, 0)) : 0;
  };
  const injectMeta = {
    entryCounts: {
      short: zoneCountOf('short'),
      long: zoneCountOf('long'),
      permanent: zoneCountOf('permanent'),
    },
    avgTokensPerEntry: total > 0 && tokenTotal > 0 ? tokenTotal / total : 0,
  };

      const searchBar = h(
        'div',
        { style: { display: 'flex', gap: 8, marginTop: 16 } },
        h('input', {
          type: 'search',
          value: draft,
          placeholder: '按关键词找一条旧事，回车',
          'aria-label': '检索记忆',
          onChange: (ev) => setDraft(ev && ev.target ? String(ev.target.value ?? '') : ''),
          onKeyDown: (ev) => {
            if (!ev) return;
            const key = ev.key || ev.keyCode;
            if (key === 'Enter' || key === 13) {
              if (ev.preventDefault) ev.preventDefault();
              submit();
            }
            if (key === 'Escape' || key === 27) {
              setDraft('');
              setQuery('');
              setExpanded({});
              reload();
            }
          },
          style: {
            flex: '1 1 auto',
            minWidth: 0,
            padding: '7px 10px',
            fontSize: 13,
            color: C.text1,
            background: C.layer1,
            border: `1px solid ${C.border1}`,
            borderRadius: 8,
            outline: 'none',
          },
        }),
        searching
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  setDraft('');
                  setQuery('');
                  setExpanded({});
                  reload();
                },
                style: chipStyle(C.text2, false),
              },
              '清空',
            )
          : h(
              'button',
              { type: 'button', onClick: submit, style: chipStyle(C.brand, false) },
              '检索',
            ),
      );

      // ── 记忆库自检：一行状态 + 一个手动按钮 ──
      // 这块的意义是让「它到底有没有在打扫」看得见。自检是后台跑的，
      // 不给状态的话，用户只能靠「条数好像少了」猜。
      const dedup = isObj(d.dedup) ? d.dedup : null;
      let dedupText = '';
      if (dedup === null) {
        dedupText = '这次没拿到自检状态（host 那边版本旧了）。';
      } else {
        const every = num(dedup.every, 30);
        const threshold = num(dedup.threshold, 0.5);
        const pending = num(dedup.pending, 0);
        const lastAt = num(dedup.lastCheckAt, 0);
        const bits = [];
        bits.push(dedup.enabled ? `每再写 ${every} 条自检一次` : '自检关着（还能手动跑）');
        bits.push(`阈值 ${threshold}`);
        if (lastAt > 0) {
          const minutes = Math.max(0, Math.round((now - lastAt) / 60000));
          const when =
            minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
          const groups = num(dedup.lastGroups, 0);
          bits.push(`上次 ${when}${groups > 0 ? `，合了 ${groups} 组` : '，没重复'}`);
        } else {
          bits.push('还没跑过');
        }
        if (dedup.enabled && pending > 0) {
          bits.push(`再写 ${Math.max(0, every - pending)} 条触发下一次`);
        }
        dedupText = bits.join(' · ');
      }

      /* 固化日志：只给形状（时间 / 结果 / 条数 / 链路），不含对话正文 */
      const diagInfo = isObj(d.consolidate) ? d.consolidate : {};
      const pluginVersion = String(diagInfo.version ?? '');
      const repoUrl = String(diagInfo.repo ?? '');
      const chainInfo = isObj(d.consolidate) && isObj(d.consolidate.chain) ? d.consolidate.chain : {};
      const logRows =
        isObj(d.consolidate) && Array.isArray(d.consolidate.log)
          ? d.consolidate.log.slice(-12).reverse()
          : [];
      const outcomeText = (o) =>
        ({
          ok: '入库',
          'no-model': '没模型',
          'model-error': '调用出错',
          truncated: '被截断',
          empty: '正文为空',
          'parse-failed': '解析失败',
          'nothing-worth': '判断不值得记',
          'no-valid': '校验没过',
        }[o] ?? String(o));
      const hhmm = (ms) => {
        const dt = new Date(Number(ms) || 0);
        const p2 = (n) => String(n).padStart(2, '0');
        return `${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
      };
      const consolidateBody = h(
        'div',
        null,
        // bot 记忆专区被锁的时候，把「为什么关不掉」写在最前面 —— 否则用户会反复
        // 去关那个开关，以为是插件坏了。
        (() => {
          const bs = isObj(d.botSpace) ? d.botSpace : null
          if (!bs || !bs.locked) return null
          return h(
            'div',
            {
              style: {
                marginBottom: 8,
                padding: '6px 8px',
                borderRadius: 6,
                background: 'rgba(255,180,0,0.12)',
                color: C.err,
                fontSize: 11,
                lineHeight: 1.6,
              },
            },
            `🔒 ${bs.reason || 'bot 记忆专区已锁定为开启，请先卸载 Qbot 插件后再关闭。'}`,
          )
        })(),
        h(
          'p',
          { style: { margin: '0 0 8px', fontSize: 11, color: C.text2, lineHeight: 1.75 } },
          chainInfo.fallbackActive
            ? `当前链路：临时切到兜底 ${chainInfo.fallbackProvider || '?'}/${chainInfo.fallbackModel || '?'}（已连续失败 ${num(
                chainInfo.consecutiveFailures,
                0,
              )} 次，存成功一次就自动切回聊天模型）`
            : `当前链路：跟随聊天模型${
                chainInfo.paused ? ' · 已暂停模型调用' : ''
              }${chainInfo.fallbackEnabled ? ` · 连续失败 ${num(chainInfo.after, 3)} 次自动切官方` : ' · 兜底关着'}`,
        ),
        logRows.length === 0
          ? h(Empty, { text: `还没有固化记录。攒够 ${num(chainInfo.writeEveryTurns, 2)} 轮对话会写第一条。` })
          : h(
              'div',
              {
                style: {
                  display: 'grid',
                  gap: 2,
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  fontSize: 11,
                  color: C.text2,
                },
              },
              logRows.map((r, i) =>
                h(
                  'div',
                  { key: `cl-${i}` },
                  `${hhmm(r.at)} · ${outcomeText(r.outcome)}${
                    num(r.added, 0) > 0 ? ` +${num(r.added, 0)} 条` : ''
                  }${r.fallback ? ' · 兜底' : ''}${num(r.failures, 0) >= 2 ? ` · 连败 ${num(r.failures, 0)}` : ''}`,
                ),
              ),
            ),
        // 「复制诊断」+「报告问题」：开源之后用户不用知道日志在哪，
        // 点一下拿到一段脱敏的纯文本，贴进 issue 就行。
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 } },
          h(
            'button',
            {
              type: 'button',
              onClick: copyDiagnostics,
              title: '生成一段脱敏的诊断文本（版本 / 路由 / 最近几次固化的结果），直接贴进 issue',
              style: chipStyle(C.brand, false),
            },
            '复制诊断',
          ),
          repoUrl
            ? h(
                'a',
                {
                  href: `${repoUrl}/issues/new?title=${encodeURIComponent(`[v${pluginVersion || '?'}] 固化问题：`)}`,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { fontSize: 11, color: C.brand, textDecoration: 'none' },
                },
                '报告问题',
              )
            : null,
        ),
        diagNotice
          ? h('div', { style: { marginTop: 6, fontSize: 11, color: C.text2 } }, diagNotice)
          : null,
        diagText
          ? h('textarea', {
              readOnly: true,
              value: diagText,
              'aria-label': '诊断文本',
              style: {
                marginTop: 6,
                width: '100%',
                minHeight: 140,
                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                fontSize: 11,
                color: C.text2,
              },
            })
          : null,
      );

      /* bot 记忆专区：QQ 号（自动收集）+ 分区（钉死不可改） */
      const botInfo = isObj(d.botSpace) ? d.botSpace : {};
      const botSeen = Array.isArray(botInfo.seenUins) ? botInfo.seenUins : [];
      const botSpaces = Array.isArray(botInfo.spaces) ? botInfo.spaces : [];
      const botLocked = Boolean(botInfo.locked);
      const botBody = h(
        'div',
        null,
        h(
          'p',
          { style: { margin: '0 0 8px', fontSize: 12, color: C.text2, lineHeight: 1.75 } },
          botInfo.pluginPresent
            ? '检测到 dsh-qq-bot：这一区锁定为开启（不允许关闭，除非先卸载 Qbot 插件）'
            : '没检测到 dsh-qq-bot —— 这一区不影响任何东西',
        ),
        h(
          'div',
          { style: { fontSize: 11, color: C.text2, lineHeight: 1.8 } },
          botSeen.length === 0
            ? '记录对话的 QQ 号：还没有人发过消息'
            : `记录对话的 QQ 号：${botSeen.map((x) => `${x.uin}（${hhmm(x.at)}）`).join('、')}`,
        ),
        h(
          'div',
          { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          botLocked
            ? h(
                'span',
                { style: { fontSize: 11, color: C.text2 } },
                `存到：${botInfo.spaceLabel || botInfo.spaceId || '?'} —— 不允许更改（要换得手动删掉库根的 bot-space.json）`,
              )
            : [
                h(
                  'select',
                  {
                    key: 'botpick',
                    value: botPick || botInfo.spaceId || '',
                    onChange: (e) => setBotPick(e && e.target ? String(e.target.value) : ''),
                    style: { ...settingInputStyle(), minWidth: 160 },
                  },
                  h('option', { key: 'none', value: '' }, '— 选一个分区 —'),
                  ...botSpaces.map((s) => h('option', { key: s.id, value: s.id }, `${s.name}（${s.id}）`)),
                ),
                h(
                  'button',
                  {
                    key: 'botsave',
                    type: 'button',
                    onClick: saveBotSpace,
                    style: chipStyle(C.brand, false),
                    title: '选定之后不能更改，确认好再点',
                  },
                  '存到这个分区',
                ),
              ],
        ),
        botNotice ? h('div', { style: { marginTop: 6, fontSize: 11, color: C.text2 } }, botNotice) : null,
      );

      /* 分区体检：只列有问题的那些 */
      const healthList = Array.isArray(d.health) ? d.health : [];
      const healthBody = h(
        'div',
        null,
        healthList.length === 0
          ? h(Empty, { text: '分区都读得出来，没问题。' })
          : healthList.map((row) =>
              h(
                'div',
                { key: `hl-${row.id}`, style: { fontSize: 11, color: C.err, lineHeight: 1.9 } },
                `⛔ ${row.name && row.name !== row.id ? `${row.name}（${row.id}）` : row.name || row.id}：${(row.problems || []).join('；')}`,
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => recoverPartition(row.id),
                    disabled: !row.hasMirror,
                    title: row.hasMirror ? '从镜像只补缺失的条目，不覆盖已有' : '镜像里没有这个分区的备份',
                    style: { ...chipStyle(C.text2, !row.hasMirror), marginLeft: 8 },
                  },
                  row.hasMirror ? '从镜像恢复' : '镜像里没有备份',
                ),
              ),
            ),
      );

      const dedupBody = h(
        'div',
        null,
        h(
          'p',
          { style: { margin: '0 0 10px', fontSize: 12, color: C.text2, lineHeight: 1.75 } },
          dedupText,
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } },
          h(
            'button',
            {
              type: 'button',
              onClick: runDedup,
              disabled: busy === '自检',
              title: '立刻把「说的是同一件事」的记忆并成一条（原文进 _archive）',
              style: chipStyle(C.brand, busy === '自检'),
            },
            busy === '自检' ? '自检中…' : '立刻自检',
          ),
          dedup !== null && num(dedup.totalMerged, 0) > 0
            ? h(
                'span',
                { style: { fontSize: 11, color: C.text2 } },
                `累计合过 ${num(dedup.totalGroups, 0)} 组、少 ${num(dedup.totalMerged, 0)} 条`,
              )
            : null,
        ),
        dedupNotice
          ? h(
              'p',
              { style: { margin: '8px 0 0', fontSize: 12, color: C.text2, lineHeight: 1.7 } },
              dedupNotice,
            )
          : null,
      );

      const body = searching
        ? h(
            'section',
            { style: { marginTop: 18 } },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 10,
                  marginBottom: 10,
                },
              },
              h(
                'h3',
                {
                  style: {
                    margin: 0,
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: '0.06em',
                    color: C.text2,
                  },
                },
                `「${searching}」命中 ${hits.length} 条`,
              ),
              busy
                ? null
                : h(
                    'span',
                    { style: { fontSize: 11, color: C.text2 } },
                    '检索是查找不是载入，命中的才会进上下文',
                  ),
            ),
            hits.length === 0
              ? h(Empty, { text: '没找到。换个词试试，或者清空回到全部。' })
              : hits.map((e, i) =>
                  h(EntryRow, {
                    key: e.id || `hit-${i}`,
                    entry: e,
                    zoneLabel: e.zoneLabel || '所在区未知',
                    confirming: confirmingId === e.id && Boolean(e.id),
                    busy: busy === e.id,
                    onConfirm: (id) => setConfirmingId(id),
                    onForget: forget,
                    onCancel: () => setConfirmingId(''),
                  }),
                ),
          )
        : h(
            'div',
            { style: { marginTop: 18 } },
            zones.map((z) =>
              h(ZoneCard, {
                key: z.key,
                zone: z,
                expanded: Boolean(expanded[z.key]),
                withZoneLabel: false,
                busy,
                confirmingId,
                onToggle: toggle,
                onCompress: compress,
                onConfirm: (id) => setConfirmingId(id),
                onForget: forget,
                onCancel: () => setConfirmingId(''),
              }),
            ),
          );

      return h(
        'div',
        { style: wrap },
        h(
          'div',
          { style: inner },

          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, '记忆'),
          h(
            'p',
            { style: { margin: '6px 0 0', fontSize: 12, color: C.text2, lineHeight: 1.8 } },
            head.join(' · '),
          ),

          // 操作失败了不掀掉整块面板：数据还在，只是这一次动作没成
          notice
            ? h('p', { style: { margin: '8px 0 0', fontSize: 12, color: C.err } }, notice)
            : null,

          // 记忆库还没建好（第一次启动 / store.load 还没回来）：
          // 这不是错误，别用红色吓人，给一句实话加一个手动重试
          ready
            ? null
            : h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    margin: '10px 0 0',
                  },
                },
                h(
                  'span',
                  { style: { fontSize: 12, color: C.text2 } },
                  '记忆库还没就绪 —— 等第一次固化完成，或者手动再读一次。',
                ),
                h(
                  'button',
                  { type: 'button', onClick: reload, style: chipStyle(C.brand, false) },
                  '再试一次',
                ),
              ),

          searchBar,

          h(
            Section,
            { title: '还剩下多少' },
            zones.map((z) => h(Meter, { key: z.key, zone: z })),
            totalZone !== null ? h(Meter, { key: 'total', zone: totalZone, fmt: fmtTokens }) : null,
          ),

          (() => {
            const sp = isObj(d.spaces) ? d.spaces : null;
            const list = sp && Array.isArray(sp.list) ? sp.list : [];
            if (list.length === 0) return null;
            const cur = list.find((x) => x.id === sp.active) ?? list[0];
            const curName = cur ? cur.name : sp.active;
            const ago = (iso) => {
              if (!iso) return '空库';
              const t = Date.parse(String(iso));
              if (!Number.isFinite(t)) return '';
              const min = Math.floor((Date.now() - t) / 60000);
              if (min < 1) return '刚刚';
              if (min < 60) return `${min} 分钟前`;
              if (min < 1440) return `${Math.floor(min / 60)} 小时前`;
              return `${Math.floor(min / 1440)} 天前`;
            };
            const fmt = (s) =>
              `${s.name}（短 ${num(s.counts && s.counts.short, 0)} · 长 ${num(s.counts && s.counts.long, 0)} · 永 ${num(
                s.counts && s.counts.permanent,
                0,
              )} · ${ago(s.lastActivityAt)}）`;
            return h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 14,
                  flexWrap: 'wrap',
                },
              },
              h('span', { style: { fontSize: 12, color: C.text2 } }, '当前记忆分区'),
              h(
                'select',
                {
                  value: sp.active || '',
                  'aria-label': '当前记忆分区',
                  onChange: (ev) => switchSpace(ev && ev.target ? ev.target.value : ''),
                  style: { ...settingInputStyle(), minWidth: 190 },
                },
                list.map((s) => h('option', { key: s.id, value: s.id }, fmt(s))),
              ),
              h(
                'span',
                { style: { fontSize: 11, color: C.text2 } },
                '切换只影响新开的对话；已经聊着的会话留在原分区',
              ),
              h('button', {
                type: 'button',
                onClick: () => setSpaceOp({ mode: 'create', value: '', id: null }),
                disabled: busy,
                style: chipStyle(C.text2, busy),
              }, '新建'),
              h('button', {
                type: 'button',
                onClick: () =>
                  setSpaceOp({ mode: 'rename', value: curName, id: sp.active }),
                disabled: busy,
                style: chipStyle(C.text2, busy),
              }, '改名'),
              h('button', {
                type: 'button',
                onClick: () =>
                  setSpaceOp({ mode: 'delete', value: curName, id: sp.active }),
                disabled: busy,
                style: chipStyle(C.text2, busy),
              }, '删除'),
            );
          })(),

          spaceOp
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 14,
                    flexWrap: 'wrap',
                  },
                },
                spaceOp.mode === 'delete'
                  ? h(
                      'span',
                      { style: { fontSize: 12, color: C.text2 } },
                      `确认删掉「${spaceOp.value}」？整个目录会搬到 _trash，不真删`,
                    )
                  : h('input', {
                      type: 'text',
                      value: spaceOp.value,
                      'aria-label': '分区名字',
                      placeholder: '分区叫什么（最多 24 字）',
                      onChange: (ev) =>
                        setSpaceOp({ ...spaceOp, value: ev && ev.target ? String(ev.target.value) : '' }),
                      style: { ...settingInputStyle(), minWidth: 200 },
                    }),
                h('button', {
                  type: 'button',
                  onClick: submitSpaceOp,
                  disabled: busy === '分区',
                  style: chipStyle(C.brand, busy === '分区'),
                }, spaceOp.mode === 'delete' ? '确认删除' : '确定'),
                h('button', {
                  type: 'button',
                  onClick: () => setSpaceOp(null),
                  disabled: busy,
                  style: chipStyle(C.text2, busy),
                }, '取消'),
              )
            : null,

          h(Section, { title: 'bot 记忆专区' }, botBody),

          h(Section, { title: '分区体检' }, healthBody),

          h(Section, { title: '固化日志' }, consolidateBody),

          h(Section, { title: '记忆库自检' }, dedupBody),

          h(SettingsCard, {
            fields: isObj(d.settings) && Array.isArray(d.settings.fields) ? d.settings.fields : [],
            file: isObj(d.settings) && typeof d.settings.file === 'string' ? d.settings.file : '',
            overridden: Boolean(isObj(d.settings) && d.settings.overridden),
            open: settingsOpen,
            busy,
            notice: settingsNotice,
            draft: settingsDraft,
            onToggle: () => setSettingsOpen((v) => !v),
            onChange: editSetting,
            onSave: saveSettings,
            onReset: resetSettings,
            onReclaim: reclaimTotal,
            onMirror: runMirror,
            mirror: isObj(d.mirror) ? d.mirror : null,
            entryCounts: injectMeta.entryCounts,
            avgTokensPerEntry: injectMeta.avgTokensPerEntry,
          }),

          body,

          h(ExpiryFoot, { zones, busy, onHarvest: harvest }),

          h(
            Section,
            { title: '落盘位置' },
            h(Empty, {
              text: `每个分区一个 jsonl，一行一条，按事件时间升序。可以直接打开看或者拷走。${
                typeof d.dir === 'string' && d.dir ? `位置：${d.dir}` : ''
              }`,
            }),
          ),
        ),
      );
    }

    /* ───────────────────────── 注册 ───────────────────────── */

    /**
     * 两条注册，缺一条的表现都是「图标点了没反应」：
     *  - sidebar.panellist 用**自己的 id**，复用别人的会把人家格子顶掉；
     *  - main 的 key 必须与侧栏 id 一致，侧栏按钮就是靠这个 key 找面板的。
     *
     * order 42：排在插件市场(0)、上下文洞察(20)、日记类插件(40)后面 ——
     * 侧栏位置是稀缺资源，不抢。
     */
    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 42, label: () => '记忆' },
          Icon,
        ),
      );

      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel));
    }

    return { name: 'ebbinghaus-memory', inject: ['slots'], apply };
  },
});
