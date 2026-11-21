import { createHash } from 'node:crypto'

/**
 * 贴纸在包内的身份：按内容取。
 *
 * 以前是导入顺序的位置序号（`001`、`002`…）。重新导入时只要有一条新增、删除或在这次
 * 导入里失败（`continue` 跳过），后面所有贴纸的序号都会前移：同一个 id 指向另一张图，
 * 同一张图换成一个新 id。Telegram 用 id 当 document 的键，于是客户端「最近使用」里同
 * 一张图会出现两格，点其中一格发出去的却是另一张。按内容取 id 就不会随导入顺序漂移；
 * 清单里有 QQ 给的 MD5 时直接用（和 QQ 侧的内容键一致），没有就现算一个。
 */
export function stickerContentId(md5: string | undefined, data: Uint8Array): string {
  const named = md5?.trim().toLowerCase()
  if (named && /^[0-9a-f]{32}$/.test(named)) return named
  return createHash('sha256').update(data).digest('hex').slice(0, 32)
}
