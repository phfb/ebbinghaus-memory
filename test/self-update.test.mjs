/**
 * 自更新模块的测试（2026-10-28 补的 —— 出事时这里全空着，所以 bug 一路发版发出去）
 *
 * 钉住三件真出过问题的事：
 *   1. 仓库地址格式：package.json 里的 `repository.url` 是整条网址，
 *      直接拼进 api.github.com/repos/${repo} 会拼成 repos/https://github.com/... → 404。
 *   2. mounts 的 only 白名单：只覆盖该覆盖的目录。
 *   3. 覆盖前要备份、要留报告；内容一样的文件不许重复覆盖（本机改过的补丁要能捞回来）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareVersion, createUpdater, matchesMount, normalizeRepoSlug } from '../src/host/self-update.mjs'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('normalizeRepoSlug：package.json 里那条会 404 的地址要归成 owner/repo', () => {
  const cases = [
    ['git+https://github.com/phfb/ebbinghaus-memory.git', 'phfb/ebbinghaus-memory'],
    ['https://github.com/phfb/ebbinghaus-memory', 'phfb/ebbinghaus-memory'],
    ['https://github.com/phfb/ebbinghaus-memory/', 'phfb/ebbinghaus-memory'],
    ['https://github.com/phfb/ebbinghaus-memory/tree/main', 'phfb/ebbinghaus-memory'],
    ['git@github.com:phfb/ebbinghaus-memory.git', 'phfb/ebbinghaus-memory'],
    ['phfb/ebbinghaus-memory', 'phfb/ebbinghaus-memory'],
    ['  phfb/ebbinghaus-memory  ', 'phfb/ebbinghaus-memory'],
  ]
  for (const [input, want] of cases) {
    assert.equal(normalizeRepoSlug(input), want, `normalizeRepoSlug(${JSON.stringify(input)})`)
  }
})

test('normalizeRepoSlug：认不出来的返回空串，别拼半截地址', () => {
  for (const bad of ['', '   ', 'nonsense', 'https://github.com/', null, undefined]) {
    assert.equal(normalizeRepoSlug(bad), '')
  }
})

test('normalizeRepoSlug：真实 package.json 也能归出 slug', () => {
  const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url
  assert.equal(normalizeRepoSlug(raw), 'phfb/ebbinghaus-memory')
})

test('拼出来的 API 地址里不许出现第二个 https://', () => {
  // 这就是 404 的形态：repos/https://github.com/...
  const updater = createUpdater({
    repo: 'https://github.com/phfb/ebbinghaus-memory',
    localVersion: '0.0.1',
    dataDir: mkdtempSync(join(tmpdir(), 'ebbinghaus-slug-')),
    mounts: [{ from: '', to: 'x' }],
  })
  assert.equal(updater.repo, 'phfb/ebbinghaus-memory')
  assert.equal(updater.repo.includes('://'), false)
})

test('compareVersion 只比前三段数字', () => {
  assert.equal(compareVersion('v1.0.1', '1.0.1'), 0)
  assert.equal(compareVersion('v1.0.2', '1.0.1'), 1)
  assert.equal(compareVersion('v1.0.0', '1.0.1'), -1)
  assert.equal(compareVersion('1.0', '1.0.0'), 0)
})

test('matchesMount：only 白名单只放行顶层那几样', () => {
  const mount = { from: '', to: 'x', only: ['src', 'package.json'] }
  assert.equal(matchesMount(mount, 'src/a.mjs'), true)
  assert.equal(matchesMount(mount, 'src/host/index.mjs'), true)
  assert.equal(matchesMount(mount, 'package.json'), true)
  assert.equal(matchesMount(mount, 'docs/a.md'), false)
  assert.equal(matchesMount(mount, '.github/workflows/ci.yml'), false)
  assert.equal(matchesMount({ from: '', to: 'x' }, 'docs/a.md'), true)
  assert.equal(matchesMount({ from: 'dsh-qq-bot', to: 'y' }, 'dsh-qq-bot/lib/index.js'), true)
  assert.equal(matchesMount({ from: 'dsh-qq-bot', to: 'y' }, 'dsh-alive/lib/index.js'), false)
})

test('matchesMount：子目录 mount 也能用 only 收窄（不在白名单里的整段跳过）', () => {
  const mount = { from: 'dsh-qq-bot', to: 'y', only: ['lib', 'package.json'] }
  assert.equal(matchesMount(mount, 'dsh-qq-bot/lib/index.js'), true)
  assert.equal(matchesMount(mount, 'dsh-qq-bot/package.json'), true)
  assert.equal(matchesMount(mount, 'dsh-qq-bot/test/policy.test.mjs'), false)
  assert.equal(matchesMount(mount, 'dsh-qq-bot/.gitignore'), false)
  assert.equal(matchesMount(mount, 'dsh-alive/lib/index.js'), false)
})

test('applyPending：一样的跳过、不一样的先备份再覆盖、缺的补上', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ebbinghaus-apply-'))
  const target = join(dataDir, 'installed')
  mkdirSync(join(target, 'src'), { recursive: true })
  writeFileSync(join(target, 'src', 'same.mjs'), 'same\n')
  writeFileSync(join(target, 'src', 'patched.mjs'), 'local patch\n')

  const staged = join(dataDir, '_update', 'pending', 'files', '0', 'src')
  mkdirSync(staged, { recursive: true })
  writeFileSync(join(staged, 'same.mjs'), 'same\n')
  writeFileSync(join(staged, 'patched.mjs'), 'upstream v1.0.2\n')
  writeFileSync(join(staged, 'new.mjs'), 'brand new\n')
  writeFileSync(
    join(dataDir, '_update', 'pending', 'manifest.json'),
    JSON.stringify({ repo: 'phfb/ebbinghaus-memory', tag: 'v1.0.2', files: 3, mounts: [{ from: '', to: target }] }),
  )

  const logs = []
  const updater = createUpdater({
    repo: 'https://github.com/phfb/ebbinghaus-memory',
    localVersion: '1.0.1',
    dataDir,
    mounts: [{ from: '', to: target }],
    log: (m) => logs.push(m),
    warn: (m) => logs.push(`WARN ${m}`),
  })

  const applied = updater.applyPending()
  assert.notEqual(applied, null)
  assert.equal(applied.tag, 'v1.0.2')

  // 一样的没动
  assert.equal(readFileSync(join(target, 'src', 'same.mjs'), 'utf8'), 'same\n')
  // 不一样的被换掉了，但旧内容在备份里
  assert.equal(readFileSync(join(target, 'src', 'patched.mjs'), 'utf8'), 'upstream v1.0.2\n')
  const replaced = applied.report.replaced.find((r) => r.file.endsWith('patched.mjs'))
  assert.ok(replaced, '被覆盖的文件没进 replaced 报告')
  assert.equal(readFileSync(replaced.backup, 'utf8'), 'local patch\n', '备份里应是覆盖前的旧内容')
  // 缺的补上
  assert.equal(readFileSync(join(target, 'src', 'new.mjs'), 'utf8'), 'brand new\n')
  assert.deepEqual(applied.report.kept.map((f) => f.split(/[\\/]/).pop()), ['same.mjs'])

  // 报告与状态都要落盘，暂存区要清掉
  assert.ok(existsSync(join(applied.report.backupDir, 'report.json')))
  assert.equal(updater.pending(), null)
  const state = updater.state()
  assert.equal(state.installedTag, 'v1.0.2')
  assert.equal(state.replaced, 1)
  assert.equal(state.added, 1)
  assert.equal(logs.some((m) => m.includes('替换 1')), true, '日志里要说清换了几个')
})

test('applyPending：没有暂存包时什么都不做', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ebbinghaus-none-'))
  const updater = createUpdater({
    repo: 'phfb/ebbinghaus-memory',
    localVersion: '1.0.1',
    dataDir,
    mounts: [{ from: '', to: join(dataDir, 'installed') }],
  })
  assert.equal(updater.applyPending(), null)
})
