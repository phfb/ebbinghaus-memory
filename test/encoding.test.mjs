/**
 * 编码守卫：src/ 下任何文件都不许出现「UTF-8 被当 GBK 读过一轮」留下的乱码。
 *
 * 为什么值得单独一条测试：2026-10-28 那天 dsh-qq-bot 的 lib/client.js 整份坏过一次
 * ——某个工具按 GBK 解码后原样写回，69 行中文变成「姝ｅ湪璇诲彇」这种。文件照样能跑、
 * 测试照样全绿，只有人肉打开面板才看得出来。这类事故靠单元测试抓不到逻辑，只能扫字节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** UTF-8 → GBK → UTF-8 之后才会出现的典型字；再加上两个替换字符。 */
const MOJIBAKE = /[\uFFFD锟]|锛|鈥|銆|鏄|涓|鍚|鐨|浣|绉|鎺|姝|寮|閰|璺|娴|鍣|缁|璇|鍦|鏂|鏃|鏈|瀹|鎵|鐩|褰|杩|妫|瑕|鏋|鍙|閭|杈|瀛|瑁|姘|鎬|浠|濂|鍜|鍐|瀹|鏄|閿|纭|璁|鍐/

const EXT = /\.(mjs|js|cjs|json|md|yml|ps1|cmd|vbs)$/

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (EXT.test(e.name)) out.push(p)
  }
  return out
}

test('src/ 与 tools/ 下没有 GBK 乱码', () => {
  const dirs = ['src', 'tools', 'test'].map((d) => join(root, d)).filter((d) => {
    try {
      readdirSync(d)
      return true
    } catch {
      return false
    }
  })
  const bad = []
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      // 这条测试自己写了乱码字面量，跳过它
      if (file.endsWith('encoding.test.mjs')) continue
      const text = readFileSync(file, 'utf8')
      text.split(/\r?\n/).forEach((line, i) => {
        if (MOJIBAKE.test(line)) bad.push(`${relative(root, file)}:${i + 1}  ${line.trim().slice(0, 60)}`)
      })
    }
  }
  assert.deepEqual(bad.slice(0, 8), [], `发现 ${bad.length} 行乱码（UTF-8 被当 GBK 读过一轮）`)
})

test('文本文件都不带 UTF-16 痕迹（.mjs 里出现 \\u0000 基本就是写坏了）', () => {
  const bad = []
  for (const file of walk(join(root, 'src'))) {
    const buf = readFileSync(file)
    if (buf.includes(0)) bad.push(relative(root, file))
  }
  assert.deepEqual(bad, [], '这些文件里有 NUL 字节，八成被别的编码写过')
})
