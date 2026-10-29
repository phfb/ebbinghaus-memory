/**
 * 自动备份镜像 —— 把「她的全部」同步一份到另一个目录，并附带一键恢复程序。
 *
 * 纯函数区：**不碰 fs**。这里只回答三个问题：
 *   1. 要复制哪些东西（`planMirror`）
 *   2. 镜像目录安不安全（`isSafeMirrorDir`）
 *   3. 恢复程序长什么样（`renderRestoreCmd` / `renderRestorePs1`）
 * 真正读写文件的是 `src/host/index.mjs`（`runMirrorNow`）。
 *
 * 镜像里放什么（用户 2026-10-26 定的口径：「所有完整的记忆、设置、人格提示词，
 * 除了必要的运行代码组件」）：
 *
 *   <镜像目录>\
 *     mirror-manifest.json     ← 清单：源路径、条数、每个文件的大小和时间
 *     恢复记忆.cmd              ← 双击这个（终端里问一句 y/N）
 *     _restore-memory.ps1      ← .cmd 的实际实现
 *     library\                 ← 三分区 jsonl + meta + settings + dedup-state + _archive
 *     dsh\                     ← AGENT.md / prompt-inject.md / profiles\*\cordis.patch.yml
 *     extra\                   ← 用户手填的额外路径（其它插件的数据目录之类）
 *
 * 不放：node_modules、插件源码、exe —— 那些重装一份就行，备份它们只会让镜像变胖。
 */

import path from 'node:path'

/** 清单格式版本。改了 incompatible 的字段就 +1。 */
export const MIRROR_VERSION = 1

export const MANIFEST_FILE = 'mirror-manifest.json'
export const RESTORE_CMD = '恢复记忆.cmd'
export const RESTORE_PS1 = '_restore-memory.ps1'

/** 记忆库里要镜像的文件（相对 dataDir）。 */
export const LIBRARY_FILES = Object.freeze([
  'short.jsonl',
  'long.jsonl',
  'permanent.jsonl',
  'meta.json',
  'settings.json',
  'dedup-state.json',
])

/** 记忆库里要整目录镜像的子目录（相对 dataDir）。 */
export const LIBRARY_DIRS = Object.freeze(['_archive'])

/**
 * 镜像时跳过的目录名 —— 这些是「运行代码组件」，不是数据。
 * 放它们进去只会让镜像变胖变慢，换台机器重装一份更干净。
 */
export const EXCLUDE_DIR_NAMES = Object.freeze([
  'node_modules',
  '__pycache__',
  '.git',
  '.svn',
  '.venv',
]);

/**
 * 这个名字要不要跳过。目录名和文件名共用一套判断。
 * @param {string} name
 * @returns {boolean}
 */
export function shouldSkipName(name) {
  const n = String(name ?? '');
  if (n === '') return false;
  if (EXCLUDE_DIR_NAMES.includes(n)) return true;
  if (n === 'Thumbs.db' || n === 'desktop.ini') return true;
  if (/\.pyc$/i.test(n)) return true;
  if (/\.tmp$/i.test(n)) return true;
  if (/\.bak[-.]/i.test(n)) return true;
  if (/\.bak$/i.test(n)) return true;
  return false;
}

/** DSH 家目录里要镜像的文件（相对 dshHome）。 */
export const DSH_FILES = Object.freeze(['AGENT.md', 'prompt-inject.md'])

/**
 * 镜像目录安全检查。
 *
 * 三条禁令，都是为了「别把自己吃掉」：
 *   - 空路径 / 相对路径 → 拒绝（相对路径会跟着 cwd 跑，备份到哪儿说不清）
 *   - 镜像目录 == 记忆库目录 → 拒绝
 *   - 两个目录互相嵌套 → 拒绝（复制时会递归复制自己，几秒钟撑爆磁盘）
 *
 * @param {string} mirrorDir
 * @param {string} dataDir
 * @returns {{ok: boolean, reason: string}}
 */
export function isSafeMirrorDir(mirrorDir, dataDir) {
  const m = String(mirrorDir ?? '').trim()
  const d = String(dataDir ?? '').trim()
  if (m === '') return { ok: false, reason: '镜像目录没填' }
  if (!path.isAbsolute(m) && !/^[A-Za-z]:[\\/]/.test(m) && !m.startsWith('\\\\')) {
    return { ok: false, reason: '镜像目录必须是绝对路径（比如 D:\\Backups\\memory）' }
  }
  if (d === '') return { ok: false, reason: '记忆库目录为空，没法比' }
  const mn = path.resolve(m).toLowerCase().replace(/[\\/]+$/, '')
  const dn = path.resolve(d).toLowerCase().replace(/[\\/]+$/, '')
  if (mn === dn) return { ok: false, reason: '镜像目录不能就是记忆库目录' }
  if (mn.startsWith(dn + path.sep) || mn.startsWith(dn + '/')) {
    return { ok: false, reason: '镜像目录不能放在记忆库目录里面' }
  }
  if (dn.startsWith(mn + path.sep) || dn.startsWith(mn + '/')) {
    return { ok: false, reason: '记忆库目录不能放在镜像目录里面' }
  }
  return { ok: true, reason: '' }
}

/**
 * 把「额外路径」那几行拆开。一行一个；支持 `#` 开头的注释行。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseExtraPaths(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('#'))
}

/**
 * 规划镜像要复制什么。
 *
 * `items` 里每一行是一次复制：`src`（原绝对路径）→ `rel`（镜像里的相对路径）。
 * 存在性由调用方判断（core 不碰 fs），不存在的跳过。
 *
 * @param {{dataDir: string, dshHome?: string, extraPaths?: string}} opts
 * @returns {{items: Array<{src: string, rel: string, kind: 'library'|'dsh'|'extra'}>,
 *            warnings: string[]}}
 */
export function planMirror(opts) {
  const dataDir = String(opts?.dataDir ?? '')
  const dshHome = String(opts?.dshHome ?? '')
  const warnings = []
  /** @type {Array<{src:string, rel:string, kind:'library'|'dsh'|'extra'}>} */
  const items = []

  if (dataDir === '') {
    warnings.push('记忆库目录为空，什么都不会备份')
    return { items, warnings }
  }

  for (const name of LIBRARY_FILES) {
    items.push({ src: path.join(dataDir, name), rel: path.posix.join('library', name), kind: 'library' })
  }
  for (const name of LIBRARY_DIRS) {
    items.push({ src: path.join(dataDir, name), rel: path.posix.join('library', name), kind: 'library' })
  }

  if (dshHome !== '') {
    for (const name of DSH_FILES) {
      items.push({ src: path.join(dshHome, name), rel: path.posix.join('dsh', name), kind: 'dsh' })
    }
  } else {
    warnings.push('没找到 DSH 家目录，人格提示词（AGENT.md / prompt-inject.md）这次不会进镜像')
  }

  const extras = Array.isArray(opts?.extraPaths) ? opts.extraPaths : parseExtraPaths(opts?.extraPaths)
  extras.forEach((p, i) => {
    const abs = String(p ?? '').trim()
    if (abs === '') return
    if (!path.isAbsolute(abs) && !/^[A-Za-z]:[\\/]/.test(abs)) {
      warnings.push(`额外路径不是绝对路径，已跳过：${abs}`)
      return
    }
    const base = path.basename(abs)
    items.push({
      src: abs,
      // 加上序号前缀：两个不同目录里都有 config.json 时不至于互相覆盖
      rel: path.posix.join('extra', `${String(i + 1).padStart(2, '0')}-${base}`),
      kind: 'extra',
    })
  })

  return { items, warnings }
}

/**
 * 造 manifest。host 复制完文件之后调，`files` 由 host 填（它才知道 size / mtime）。
 *
 * @param {{createdAt: number, dataDir: string, dshHome: string,
 *          counts: {short:number, long:number, permanent:number},
 *          pluginVersion: string,
 *          files: Array<{rel:string, src:string, size:number, mtime:number, kind:string}>=}} opts
 */
export function buildManifest(opts) {
  const counts = opts?.counts ?? { short: 0, long: 0, permanent: 0 }
  const total = (Number(counts.short) || 0) + (Number(counts.long) || 0) + (Number(counts.permanent) || 0)
  return {
    kind: 'ebbinghaus-mirror',
    version: MIRROR_VERSION,
    createdAt: new Date(Number(opts?.createdAt) || Date.now()).toISOString(),
    pluginVersion: String(opts?.pluginVersion ?? ''),
    /** 恢复时优先往这些路径写回；换机了就靠下面的搜索兜底 */
    source: {
      dataDir: String(opts?.dataDir ?? ''),
      dshHome: String(opts?.dshHome ?? ''),
    },
    counts: { short: Number(counts.short) || 0, long: Number(counts.long) || 0, permanent: Number(counts.permanent) || 0 },
    total,
    files: (Array.isArray(opts?.files) ? opts.files : []).map((f) => ({
      rel: String(f.rel),
      src: String(f.src),
      kind: String(f.kind),
      size: Number(f.size) || 0,
      mtime: Number(f.mtime) || 0,
    })),
    restore: { cmd: RESTORE_CMD, ps1: RESTORE_PS1 },
  }
}

/** 恢复程序入口（双击这个）。BOM 由 host 写入时加上 —— 没 BOM 的话 cmd 里中文全乱。 */
export function renderRestoreCmd() {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'set "HERE=%~dp0"',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%_restore-memory.ps1"',
    'echo.',
    'pause',
    'endlocal',
    '',
  ].join('\r\n')
}

/**
 * 恢复程序本体。
 *
 * 干五件事：读清单 → 找到这台机器上的目标位置 → 问一句 → 先把当前库备份 → 按清单写回。
 * 关键约束：**任何一步不确定就停下问人**，绝不猜着覆盖。
 */
export function renderRestorePs1() {
  return String.raw`<#
  ebbinghaus-memory 一键恢复
  ---------------------------
  这个文件是插件在同步镜像时顺手写进来的，别手改 —— 下次同步会被覆盖。

  它做五件事：
    1. 读同目录的 mirror-manifest.json
    2. 找到这台机器上「记忆库应该恢复到哪里」（文件里记的路径不存在就自己搜）
    3. 问一句「确认恢复?」
    4. 先把当前库整份备份到 _backup-before-restore-<时间戳>\
    5. 按清单把 library\ / dsh\ / extra\ 里的文件写回去
#>

# 可选参数：-Target <目录> 直接指定恢复目标（双击时不用管它；换机 / 测试用得上）
param([string]$Target = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$HERE = Split-Path -Parent $PSCommandPath
$manifestPath = Join-Path $HERE 'mirror-manifest.json'

function Say($t) { Write-Host $t }
function Bad($t) { Write-Host $t -ForegroundColor Red }
function Good($t) { Write-Host $t -ForegroundColor Green }
function Warn2($t) { Write-Host $t -ForegroundColor Yellow }

if (-not (Test-Path $manifestPath)) {
  Bad "找不到 mirror-manifest.json —— 这个目录不是插件生成的镜像目录。"
  exit 1
}

$mf = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $mf -or $mf.kind -ne 'ebbinghaus-mirror') {
  Bad "manifest 格式不对（不是 ebbinghaus-mirror），不敢动。"
  exit 1
}

Say ''
Say '================ ebbinghaus-memory 记忆恢复 ================'
Say ("备份时间   : " + $mf.createdAt)
Say ("插件版本   : " + $mf.pluginVersion)
Say ("记忆条数   : 短期 " + $mf.counts.short + " · 长期 " + $mf.counts.long + " · 永久 " + $mf.counts.permanent + "（共 " + $mf.total + " 条）")
Say ("原始库目录 : " + $mf.source.dataDir)
Say ''

# ── 第一步：找目标位置 ──────────────────────────────────────────────
function Test-LooksLikeLib($d) {
  if ([string]::IsNullOrWhiteSpace($d)) { return $false }
  if (-not (Test-Path $d)) { return $false }
  foreach ($f in @('meta.json', 'short.jsonl', 'permanent.jsonl')) {
    if (Test-Path (Join-Path $d $f)) { return $true }
  }
  return $false
}

function Find-Candidates {
  $out = @()
  # 1) 清单里记的原始路径
  if ($mf.source.dataDir) { $out += [string]$mf.source.dataDir }
  # 2) 常见位置
  if ($env:DSH_HOME) { $out += (Join-Path $env:DSH_HOME 'ebbinghaus-memory') }
  if ($env:USERPROFILE) {
    $out += (Join-Path $env:USERPROFILE '.dsh\ebbinghaus-memory')
    $out += (Join-Path $env:USERPROFILE '.dsh-qq-bot\ebbinghaus-memory')
  }
  # 3) DSH 的 profile 里那个 junction / 目录
  foreach ($root in @(
      (Join-Path $env:APPDATA 'dsh'),
      (Join-Path $env:USERPROFILE 'dsh-home'),
      (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\dsh-home')
    )) {
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path $root)) { continue }
    $profiles = Join-Path $root 'profiles'
    if (-not (Test-Path $profiles)) { continue }
    Get-ChildItem $profiles -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $nm = Join-Path $_.FullName 'node_modules\ebbinghaus-memory'
      if (Test-Path $nm) {
        $item = Get-Item $nm -Force -ErrorAction SilentlyContinue
        if ($item -and $item.Target) { $out += [string]($item.Target | Select-Object -First 1) } else { $out += $nm }
      }
      $out += (Join-Path $_.FullName 'ebbinghaus-memory')
    }
  }
  # 4) DSH_HOME 里直接就是库（清单里 dataDir 为空时的兜底）
  $out | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
}

$destDir = $null
# ① 命令行给了 -Target 就用它（换机 / 测试时想落到别处）
if (-not [string]::IsNullOrWhiteSpace($Target)) {
  $destDir = $Target
}
# ② 否则找本机已经在用的库
if ([string]::IsNullOrWhiteSpace($destDir)) {
  foreach ($c in (Find-Candidates)) {
    if (Test-LooksLikeLib $c) { $destDir = $c; break }
  }
}
# ③ 本机一个库都没有（全新机器）→ 用清单里记的位置，一会儿建出来
if ([string]::IsNullOrWhiteSpace($destDir) -and $mf.source.dataDir) {
  $destDir = [string]$mf.source.dataDir
}

if ([string]::IsNullOrWhiteSpace($destDir)) {
  Warn2 '没能自动找到这台机器上的记忆库目录。'
  $destDir = Read-Host '    请直接粘贴一个目录（不存在会自动创建；留空=放弃）'
  if ([string]::IsNullOrWhiteSpace($destDir)) { Bad '放弃恢复。什么都没改。'; exit 1 }
}

Say ("恢复到     : " + $destDir)
if (Test-Path $destDir) {
  $old = @()
  foreach ($f in @('short.jsonl', 'long.jsonl', 'permanent.jsonl')) {
    $p = Join-Path $destDir $f
    if (Test-Path $p) { $old += ((Get-Content $p -Encoding UTF8 | Where-Object { $_.Trim() -ne '' }).Count) }
  }
  Say ("当前库里已有: " + (($old -join ' / ') + " 条（短/长/永久）"))
} else {
  Say '当前库里已有: 目录还不存在（全新恢复）'
}
Say ''
Warn2 '恢复会用备份**覆盖**上面这个库。恢复前会自动把当前库备份一份，但你还是先确认一眼。'
Say ''
$ans = Read-Host '确认执行记忆恢复? (y/N)'
if ($ans -notmatch '^(y|Y|yes|YES)$') {
  Say '已取消，什么都没改。'
  exit 0
}

# ── 第二步：先把当前库备份一份 ────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$preBackup = $null
if (Test-Path $destDir) {
  $preBackup = Join-Path $destDir ("_backup-before-restore-" + $stamp)
  try {
    New-Item -ItemType Directory -Path $preBackup -Force | Out-Null
    foreach ($f in @('short.jsonl', 'long.jsonl', 'permanent.jsonl', 'meta.json', 'settings.json', 'dedup-state.json')) {
      $p = Join-Path $destDir $f
      if (Test-Path $p) { Copy-Item $p (Join-Path $preBackup $f) -Force }
    }
    $arch = Join-Path $destDir '_archive'
    if (Test-Path $arch) { Copy-Item $arch (Join-Path $preBackup '_archive') -Recurse -Force }
    Good ("已把当前库备份到: " + $preBackup)
  } catch {
    Bad ("备份当前库失败，为安全起见中止：" + $_.Exception.Message)
    exit 1
  }
}

# ── 第三步：按清单写回 ────────────────────────────────────────────
$okCount = 0
$failCount = 0
foreach ($f in $mf.files) {
  $srcRel = [string]$f.rel
  $src = Join-Path $HERE ($srcRel -replace '/', '\')
  if (-not (Test-Path $src)) { continue }
  if ($f.kind -eq 'library') {
    $dest = Join-Path $destDir (Split-Path -Leaf $srcRel)
  } else {
    $dest = [string]$f.src
    if ([string]::IsNullOrWhiteSpace($dest)) { continue }
  }
  try {
    $destDir = Split-Path -Parent $dest
    if ($destDir -and -not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    if (Test-Path $src -PathType Container) {
      # 目录：把**内容**合并进 dest。
      # 别写成 Copy-Item $src $dest -Recurse —— dest 已存在时它会在里面再套一层同名目录，
      # 恢复两次就变成 _archive\_archive\_archive（2026-10-26 实测踩过）。
      if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
      Get-ChildItem -LiteralPath $src -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force
      }
    } else {
      Copy-Item -LiteralPath $src -Destination $dest -Force
    }
    $okCount += 1
  } catch {
    $failCount += 1
    Warn2 ("写回失败: " + $dest + " → " + $_.Exception.Message)
  }
}

Say ''
if ($failCount -eq 0) {
  Good ("恢复完成：写回 " + $okCount + " 项")
} else {
  Warn2 ("恢复完成：成功 " + $okCount + " 项，失败 " + $failCount + " 项")
}
if ($preBackup) { Say ("恢复前的旧库还在: " + $preBackup) }
Say ''
Warn2 '建议现在重启 DSH（插件内存里还是旧库，重启后才会读这份恢复出来的）。'
Say ''
`
}

/**
 * 恢复程序里那行的版本号用得上：manifest 的 pluginVersion。
 * 这里只是把「不认识的 manifest 版本」挡在外面，避免将来改结构时恢复程序读错字段。
 */
export function isReadableManifest(mf) {
  if (mf === null || typeof mf !== 'object') return false
  if (mf.kind !== 'ebbinghaus-mirror') return false
  const v = Number(mf.version)
  return Number.isFinite(v) && v >= 1 && v <= MIRROR_VERSION
}
