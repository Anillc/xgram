import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

// 用动态 import 取 URL，避免 tsc 对 `.ts` 扩展名的静态检查（`allowImportingTsExtensions` 没开）。
// 这样 `node --test src/local-stickers` 无需构建、无需额外依赖就能跑。
const moduleUrl = new URL('./sticker-id.ts', import.meta.url).href

async function contentId(): Promise<(md5: string | undefined, data: Uint8Array) => string> {
  const loaded = await import(moduleUrl) as { stickerContentId: (md5: string | undefined, data: Uint8Array) => string }
  return loaded.stickerContentId
}

const picture = (seed: string) => new TextEncoder().encode(`fake-png-bytes:${seed}`)

test('the sticker id follows the bytes, not the position in the pack', async () => {
  const stickerContentId = await contentId()
  const data = picture('first')

  // 同一个文件无论在第 1 位还是第 22 位导入，id 都一样：位置序号会让整包重排，
  // 于是同一个 id 指向另一张图（点击发错）而同一张图换新 id（最近使用里出现两格）。
  const first = stickerContentId(undefined, data)
  const reimported = stickerContentId(undefined, data)
  assert.equal(first, reimported)
  assert.match(first, /^[0-9a-f]{32}$/)

  assert.notEqual(stickerContentId(undefined, picture('second')), first)
})

test('the id a pack keeps after a failed import does not shift', async () => {
  const stickerContentId = await contentId()
  const items = [picture('a'), picture('b'), picture('c')]

  const complete = items.map((data) => stickerContentId(undefined, data))
  // 「b」这次导入失败：位置序号方案会让「c」从 003 变成 002，内容 id 不会动。
  const afterFailure = [items[0], items[2]].map((data) => stickerContentId(undefined, data))
  assert.deepEqual(afterFailure, [complete[0], complete[2]])
})

test("QQ's MD5 wins when the manifest carries it", async () => {
  const stickerContentId = await contentId()
  const md5 = '6D08089772D24F738EB24FE80271208A'
  const id = stickerContentId(md5, picture('ignored'))
  assert.equal(id, md5.toLowerCase())
  // 没有（或不是合法 md5）时按字节现算 sha256。
  assert.equal(
    stickerContentId('not-a-digest', picture('x')),
    createHash('sha256').update(picture('x')).digest('hex').slice(0, 32),
  )
})
