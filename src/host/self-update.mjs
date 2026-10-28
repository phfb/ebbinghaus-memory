/**
 * 自更新：启动时看一眼 GitHub 上有没有比本地新的版本，有就下到暂存区，
 * **校验通过**之后留给下一次启动安装。
 *
 * 为什么是这个时序（2026-10-28 定的方案）：
 *   宿主加载插件时，lib 早就被 import 完了 —— 插件没法在自己加载之前替换自己。
 *   所以：本次启动「装上次下载好的」+「顺手检查下载这次的」，新代码要再下一次启动才跑。
 *   代价是晚一次启动，换来的是**永远不会因为半新半旧的代码把插件弄死**。
 *
 * 为什么只认 Release / tag：
 *   跟 main 最新提交意味着任何一个推送都会被执行到本机，太野。默认只跟发版。
 *
 * 网络：直连 GitHub 优先，失败按 MIRRORS 依次重试（国内直连经常超时）。
 *
 * ── 2026-10-28 修的两件事 ────────────────────────────────────────────────
 * 1. **仓库地址格式**：以前把这个模块的 `repo` 直接拼进
 *    `https://api.github.com/repos/${repo}/...`，而调用方传的是 package.json 里
 *    `repository.url` 的整条网址（`https://github.com/phfb/ebbinghaus-memory`），
 *    于是请求变成 `api.github.com/repos/https://github.com/...` —— 每次都 404，
 *    自更新等于死的（网页那边「报告问题」链接却需要完整 URL，所以那份不能删）。
 *    现在一律先过 `normalizeRepoSlug()`，网址也认、`owner/repo` 也认，
 *    拼 URL 只用 `owner/repo`。
 * 2. **覆盖前留证据**：以前是把整个插件目录 cpSync 一份再全量覆盖，谁被改了说不清。
 *    现在逐个文件比字节：只有真的不一样的才覆盖，覆盖前把旧文件备份到
 *    `_update/backup/<时间戳>/`，并写 `report.json` 记下「换了哪些、新增哪些」。
 *    本机手改过的补丁因此随时能捞回来。
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** 直连失败时依次尝试的镜像（前缀式：mirror + 原始 URL）。 */
const MIRRORS = ['https://ghproxy.net/', 'https://gh-proxy.com/']

/** 不打进更新包的东西（本地运行时产生的，覆盖过去只会出事）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'logs', '_update'])

/** 这些目录里的代码会被宿主加载，语法必须过；其余（tools/scripts/test）只做 JSON 校验。 */
const LOADABLE_DIRS = ['src', 'lib', 'bin']
function isLoadablePath(rel) {
  const head = rel.split(/[\\/]/)[0]
  return LOADABLE_DIRS.includes(head)
}

/**
 * 把各种写法的仓库地址归一成 `owner/repo`。
 *
 * 认这些：
 *   phfb/ebbinghaus-memory
 *   https://github.com/phfb/ebbinghaus-memory
 *   git+https://github.com/phfb/ebbinghaus-memory.git
 *   git@github.com:phfb/ebbinghaus-memory.git
 *   https://github.com/phfb/ebbinghaus-memory/tree/main
 *
 * 认不出来返回 ''（调用方自己兜底，别拿半截字符串去拼 API）。
 */
export function normalizeRepoSlug(input) {
  let s = String(input ?? '').trim()
  if (s === '') return ''
  s = s.replace(/^git\+/i, '')
  s = s.replace(/^git@([^:]+):/i, 'https://$1/')
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, '')
  s = s.replace(/\.git$/i, '').replace(/\/+$/, '')
  const parts = s.split('/').filter((p) => p !== '')
  if (parts.length < 2) return ''
  return `${parts[0]}/${parts[1]}`
}

/** 版本号比较：只认 x.y.z，缺位当 0（'1.0' 和 '1.0.0' 必须算相等）。 */
export function compareVersion(a, b) {
  const p = (v) => {
    const parts = String(v || '')
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0)
    while (parts.length < 3) parts.push(0)
    return parts
  }
  const x = p(a)
  const y = p(b)
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  }
  return 0
}

/** 解一个 zip（只支持 stored / deflate，仓库包够用；zip64 不需要）。 */
export function unzip(buffer) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 0x10000 - 22); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip')
  const count = buffer.readUInt16LE(eocd + 10)
  let off = buffer.readUInt32LE(eocd + 16)
  const files = []
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 中央目录损坏')
    const method = buffer.readUInt16LE(off + 10)
    const compSize = buffer.readUInt32LE(off + 20)
    const nameLen = buffer.readUInt16LE(off + 28)
    const extraLen = buffer.readUInt16LE(off + 30)
    const commentLen = buffer.readUInt16LE(off + 32)
    const localOff = buffer.readUInt32LE(off + 42)
    const name = buffer.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    off += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (name.includes('..')) continue
    const lNameLen = buffer.readUInt16LE(localOff + 26)
    const lExtraLen = buffer.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = buffer.subarray(start, start + compSize)
    files.push({ name, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) })
  }
  return files
}

/** 直连优先、镜像兜底地取一个 URL。 */
async function fetchAny(urls, { ms = 30000, headers = {} } = {}) {
  const errors = []
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(ms),
        headers: { 'user-agent': 'dsh-plugin-self-update', ...headers },
      })
      if (!res.ok) {
        errors.push(`${url} → HTTP ${res.status}`)
        continue
      }
      return { res, url }
    } catch (err) {
      errors.push(`${url} → ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(errors.join(' ; '))
}

/** 原始 URL + 各镜像的候选列表。 */
function withMirrors(url) {
  return [url, ...MIRRORS.map((m) => m + url)]
}

/**
 * 这个 zip 里的相对路径归不归这条 mount 管。
 *
 * `from` 为空 = 整个仓库根；`only` 是白名单，比较的是「`from` 底下的第一段名字」：
 *   from: ''         only: ['src','package.json']      → src/a.mjs ✔ / docs/a.md ✘
 *   from: 'dsh-qq-bot' only: ['lib','package.json']    → dsh-qq-bot/lib/a.js ✔ / dsh-qq-bot/test/a.js ✘
 * 收窄是为了别把 .github / docs / test / tools 这些东西也糊到插件目录里，
 * 也免得上游包里那份旧文件悄悄盖掉本机手改过的同名文件。
 */
export function matchesMount(mount, rel) {
  if (mount.from === '') {
    if (Array.isArray(mount.only) && mount.only.length > 0) {
      return mount.only.includes(rel.split('/')[0])
    }
    return true
  }
  if (rel === mount.from) return true
  if (!rel.startsWith(`${mount.from}/`)) return false
  if (Array.isArray(mount.only) && mount.only.length > 0) {
    const inside = rel.slice(mount.from.length + 1)
    return mount.only.includes(inside.split('/')[0])
  }
  return true
}

/** 两个文件字节一样吗（读不动就当不一样，宁可多备份一次）。 */
function sameBytes(pathA, bytesB) {
  try {
    if (!existsSync(pathA)) return false
    return readFileSync(pathA).equals(bytesB)
  } catch {
    return false
  }
}

/**
 * 造一个更新器。
 *
 * @param {object} opts
 * @param {string} opts.repo       仓库地址：'phfb/x' 或 'https://github.com/phfb/x' 都行
 * @param {string} opts.localVersion 本地 package.json 的 version
 * @param {string} opts.dataDir    暂存区落在 <dataDir>/_update
 * @param {Array<{from:string,to:string,only?:string[]}>} opts.mounts
 *        zip 里 `<repo>-<sha>/<from>/**` → 本机 `<to>/**`（from 为 '' 表示整个仓库根，
 *        可再用 only 收窄到顶层某几个名字）
 * @param {(m:string)=>void} [opts.log]
 * @param {(m:string)=>void} [opts.warn]
 */
export function createUpdater({ repo, localVersion, dataDir, mounts, log = () => {}, warn = () => {} }) {
  const slug = normalizeRepoSlug(repo)
  const base = join(dataDir, '_update')
  const pendingDir = join(base, 'pending')
  const manifestPath = join(pendingDir, 'manifest.json')
  const statePath = join(base, 'state.json')

  const readJson = (p) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      return null
    }
  }
  const writeJson = (p, v) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8')
  }

  const requireSlug = () => {
    if (slug === '') throw new Error(`仓库地址不合法（要 owner/repo 或仓库 URL）：${String(repo)}`)
    return slug
  }

  /** 查最新版本：先 Releases，没有 Release 就退回 tags（发版不一定点 Release）。 */
  async function latestTag() {
    const owner = requireSlug()
    try {
      const { res } = await fetchAny(
        withMirrors(`https://api.github.com/repos/${owner}/releases/latest`),
        { ms: 15000, headers: { accept: 'application/vnd.github+json' } },
      )
      const body = await res.json()
      if (body && typeof body.tag_name === 'string' && body.tag_name !== '') {
        return { tag: body.tag_name, from: 'release' }
      }
    } catch {
      /* 没发 Release 时这里 404，正常的 */
    }
    const { res } = await fetchAny(
      withMirrors(`https://api.github.com/repos/${owner}/tags?per_page=20`),
      { ms: 15000, headers: { accept: 'application/vnd.github+json' } },
    )
    const list = await res.json()
    if (!Array.isArray(list)) throw new Error('tags 返回格式不对')
    const tags = list
      .map((t) => String(t?.name ?? ''))
      .filter((n) => /^v?\d+\.\d+\.\d+$/.test(n))
      .sort((a, b) => compareVersion(b, a))
    if (tags.length === 0) throw new Error(`仓库里还没有形如 v1.2.3 的 tag`)
    return { tag: tags[0], from: 'tag' }
  }

  /** 下载 zip → 拆到暂存区 → 逐文件校验。任何一步失败都不留半成品。 */
  async function stage(tag) {
    const owner = requireSlug()
    const zipUrl = `https://codeload.github.com/${owner}/zip/${encodeURIComponent(tag)}`
    const { res, url } = await fetchAny(withMirrors(zipUrl), { ms: 60000 })
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1024) throw new Error('下载到的包太小，可能不是 zip')
    const files = unzip(buf)
    if (files.length === 0) throw new Error('zip 里没有文件')

    // zip 顶层是 `<repo>-<ref>/`，全部按它剥掉
    const top = files[0].name.split('/')[0]
    const staged = join(pendingDir, 'files')
    rmSync(pendingDir, { recursive: true, force: true })
    mkdirSync(staged, { recursive: true })

    let written = 0
    for (const f of files) {
      const parts = f.name.split('/')
      parts.shift()
      const rel = parts.join('/')
      if (rel === '') continue
      if (SKIP_DIRS.has(parts[0])) continue
      const mountIndex = mounts.findIndex((m) => matchesMount(m, rel))
      if (mountIndex < 0) continue
      const mount = mounts[mountIndex]
      const inside = mount.from === '' ? rel : rel.slice(mount.from.length + 1)
      if (inside === '') continue
      const dest = join(staged, String(mountIndex), normalize(inside))
      if (!dest.startsWith(staged + sep)) continue
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, f.data)
      written += 1
    }
    if (written === 0) throw new Error(`包里没有匹配 mounts 的文件（顶层目录 ${top}）`)

    // 校验：JSON 能 parse，js/mjs 过一遍语法检查
    const bad = []
    for (const mount of mounts) {
      const root = join(staged, String(mounts.indexOf(mount)))
      if (!existsSync(root)) continue
      for (const file of walk(root)) {
        const rel = file.slice(root.length + 1)
        if (rel.endsWith('.json')) {
          try {
            JSON.parse(readFileSync(file, 'utf8'))
          } catch (err) {
            bad.push(`${mount.from}/${rel}: JSON 坏了（${err instanceof Error ? err.message : err}）`)
          }
        } else if ((rel.endsWith('.js') || rel.endsWith('.mjs')) && isLoadablePath(rel)) {
          const r = spawnSync(process.execPath, ['--check', file], {
            encoding: 'utf8',
            timeout: 20000,
            windowsHide: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          })
          if (r.status !== 0) bad.push(`${mount.from}/${rel}: 语法检查没过（${(r.stderr || '').trim().split('\n').pop()}）`)
        }
      }
    }
    if (bad.length > 0) {
      rmSync(pendingDir, { recursive: true, force: true })
      throw new Error(`新版本校验失败，已丢弃：${bad.slice(0, 3).join('; ')}`)
    }

    writeJson(manifestPath, {
      repo: owner,
      tag,
      version: String(tag).replace(/^v/i, ''),
      stagedAt: new Date().toISOString(),
      source: url,
      files: written,
      mounts: mounts.map((m) => ({ from: m.from, to: m.to, only: m.only ?? null })),
    })
    return { tag, files: written }
  }

  /**
   * 下一次启动时调用：装上次下载好的那份。
   *
   * 逐文件比字节 —— 一样的跳过，不一样的先备份再覆盖，最后写一份 report.json。
   * 本机手改过的地方因此永远有据可查、可回滚。
   */
  function applyPending() {
    const manifest = readJson(manifestPath)
    if (manifest === null) return null
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backupRoot = join(base, 'backup', stamp)
    const report = {
      tag: manifest.tag,
      repo: manifest.repo,
      installedAt: new Date().toISOString(),
      backupDir: backupRoot,
      replaced: [],
      added: [],
      kept: [],
    }
    try {
      for (const [i, mount] of mounts.entries()) {
        const root = join(pendingDir, 'files', String(i))
        if (!existsSync(root)) continue
        const targetRoot = normalize(mount.to)
        for (const file of walk(root)) {
          const rel = file.slice(root.length + 1)
          const dest = normalize(join(targetRoot, rel))
          if (dest !== targetRoot && !dest.startsWith(targetRoot + sep)) continue
          const next = readFileSync(file)
          if (sameBytes(dest, next)) {
            report.kept.push(dest)
            continue
          }
          mkdirSync(dirname(dest), { recursive: true })
          if (existsSync(dest)) {
            const backupPath = join(backupRoot, String(i), rel)
            try {
              mkdirSync(dirname(backupPath), { recursive: true })
              cpSync(dest, backupPath)
              report.replaced.push({ file: dest, backup: backupPath })
            } catch (err) {
              // 备份失败也要继续装，但必须留痕 —— 不然「悄悄改了本地文件」就查不到了
              report.replaced.push({
                file: dest,
                backup: '',
                error: err instanceof Error ? err.message : String(err),
              })
              warn(`备份 ${dest} 失败（继续装）：${err instanceof Error ? err.message : String(err)}`)
            }
            writeFileSync(dest, next)
          } else {
            writeFileSync(dest, next)
            report.added.push(dest)
          }
        }
      }
      try {
        writeJson(join(backupRoot, 'report.json'), report)
      } catch {
        /* 报告写不进去不影响已经装好的文件 */
      }
      writeJson(statePath, {
        installedTag: manifest.tag,
        installedAt: report.installedAt,
        files: manifest.files,
        replaced: report.replaced.length,
        added: report.added.length,
        kept: report.kept.length,
        backupDir: report.replaced.length > 0 ? backupRoot : '',
      })
      rmSync(pendingDir, { recursive: true, force: true })
      log(
        `已装 ${manifest.tag}：替换 ${report.replaced.length} / 新增 ${report.added.length} / 未变 ${report.kept.length}` +
          (report.replaced.length > 0 ? `（旧文件备份在 ${backupRoot}）` : ''),
      )
      return { ...manifest, report }
    } catch (err) {
      warn(`安装更新失败，保留暂存区下次再试：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /** 检查 + 下载 + 校验，全程不抛。 */
  async function checkAndStage() {
    try {
      const { tag, from } = await latestTag()
      if (compareVersion(tag, localVersion) <= 0) {
        // 成功一次就把上次的 lastError 抹掉：不然面板/state.json 里会一直挂着
        // 一条早就修好的 404，看着像「还是坏的」
        writeJson(statePath, { checkedAt: new Date().toISOString(), latestTag: tag })
        log(`已是最新（本地 ${localVersion} / 远端 ${tag}，来源 ${from}）`)
        return { ok: true, updated: false, tag }
      }
      // 已经下过同一个 tag 就别重复下
      const already = readJson(manifestPath)
      if (already && already.tag === tag) {
        writeJson(statePath, { checkedAt: new Date().toISOString(), latestTag: tag, stagedTag: tag })
        log(`已有 ${tag} 的暂存包，等下次启动安装`)
        return { ok: true, updated: false, staged: true, tag }
      }
      log(`发现新版本 ${tag}（来源 ${from}），开始下载…`)
      const staged = await stage(tag)
      writeJson(statePath, { checkedAt: new Date().toISOString(), latestTag: tag, stagedTag: staged.tag })
      log(`已下载并校验 ${staged.tag}（${staged.files} 个文件），下次启动生效`)
      return { ok: true, updated: true, staged: true, tag }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      writeJson(statePath, {
        ...(readJson(statePath) || {}),
        checkedAt: new Date().toISOString(),
        lastError: msg,
      })
      warn(`检查更新失败（不影响使用）：${msg}`)
      return { ok: false, error: msg }
    }
  }

  return {
    checkAndStage,
    applyPending,
    repo: slug,
    pending: () => readJson(manifestPath),
    state: () => readJson(statePath),
  }
}

/** 递归列出文件（不跟符号链接）。 */
function walk(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) out.push(p)
    }
  }
  return out
}

/** 版本号取自 package.json —— 免得两处各写一份。 */
export function readLocalVersion(packageJsonPath) {
  try {
    return String(JSON.parse(readFileSync(packageJsonPath, 'utf8')).version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}
