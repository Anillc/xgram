import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from 'cordis'
import type {
  IMMediaSource, IMSticker, IMStickerAsset, IMStickerPack, IMStickerPackPage,
  IMStickerPackSummary, IMStickerProvider, IMStickerSendPlan,
  StickerPageQuery, StickerProviderContext,
} from '@mtproto-relay/bridge'

const execFileAsync = promisify(execFile)
const PROVIDER_ID = 'local-stickers'

interface ImageMeta {
  mimeType: string
  format: 'static' | 'animated' | 'video'
  width?: number
  height?: number
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'video/webm': 'webm',
}

function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? 'bin'
}

function imageMeta(input: Buffer, name = ''): ImageMeta {
  if (input.length >= 24
    && input[0] === 0x89 && input[1] === 0x50 && input[2] === 0x4e && input[3] === 0x47) {
    return { mimeType: 'image/png', format: 'static', width: input.readUInt32BE(16), height: input.readUInt32BE(20) }
  }
  if (input.length >= 10
    && (input.subarray(0, 6).toString('ascii') === 'GIF87a'
      || input.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { mimeType: 'image/gif', format: 'animated', width: input.readUInt16LE(6), height: input.readUInt16LE(8) }
  }
  if (input.length >= 12
    && input.subarray(0, 4).toString('ascii') === 'RIFF'
    && input.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = input.subarray(12, 16).toString('ascii')
    if (chunk === 'VP8X' && input.length >= 30) {
      return { mimeType: 'image/webp', format: 'static', width: input.readUIntLE(24, 3) + 1, height: input.readUIntLE(27, 3) + 1 }
    }
    if (chunk === 'VP8 ' && input.length >= 30) {
      return { mimeType: 'image/webp', format: 'static', width: input.readUInt16LE(26) & 0x3fff, height: input.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L' && input.length >= 25) {
      const bits = input.readUInt32LE(21)
      return { mimeType: 'image/webp', format: 'static', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return { mimeType: 'image/webp', format: 'static' }
  }
  if (input.length >= 4 && input[0] === 0xff && input[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < input.length) {
      if (input[offset] !== 0xff) { offset++; continue }
      const marker = input[offset + 1]
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const length = input.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > input.length) break
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { mimeType: 'image/jpeg', format: 'static', height: input.readUInt16BE(offset + 5), width: input.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
    return { mimeType: 'image/jpeg', format: 'static' }
  }
  if (input.length >= 12 && input.subarray(0, 4).toString('ascii') === 'RIFF'
    && input.subarray(8, 12).toString('ascii') === 'WEBM') {
    return { mimeType: 'video/webm', format: 'video' }
  }
  const ext = name.toLowerCase().split('.').pop()
  if (ext === 'gif') return { mimeType: 'image/gif', format: 'animated' }
  if (ext === 'jpg' || ext === 'jpeg') return { mimeType: 'image/jpeg', format: 'static' }
  if (ext === 'webp') return { mimeType: 'image/webp', format: 'static' }
  if (ext === 'png') return { mimeType: 'image/png', format: 'static' }
  if (ext === 'webm') return { mimeType: 'video/webm', format: 'video' }
  return { mimeType: 'application/octet-stream', format: 'static' }
}

interface QaItem {
  MD5?: string
  fileName?: string
  addTime?: number
  thumbName?: string
}

interface QaPath {
  Name?: string
  storePath?: string
  coverName?: string
}

interface ManifestSticker {
  id: string
  file: string
  mimeType: string
  format: 'static' | 'animated' | 'video'
  size: number
  width?: number
  height?: number
  thumb?: string
  thumbMimeType?: string
  thumbSize?: number
  thumbWidth?: number
  thumbHeight?: number
}

interface ManifestPack {
  packId: string
  title: string
  version: number
  cover?: string
  stickers: ManifestSticker[]
}

function safeSegment(value: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error(`invalid QA path segment: ${value}`)
  }
  return value
}

async function walk(dir: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...await walk(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

function inside(base: string, path: string): string {
  const target = resolve(base, path)
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`archive path escapes its root: ${path}`)
  return target
}

function packIdFor(value: string): string {
  return `qa-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`
}

async function extract(zip: string, destination: string): Promise<void> {
  const { stdout } = await execFileAsync('unzip', ['-Z1', zip], { maxBuffer: 16 * 1024 * 1024 })
  for (const entry of stdout.split('\n').filter(Boolean)) {
    if (entry.startsWith('/') || entry.startsWith('\\') || entry.split(/[\\/]/).includes('..')) {
      throw new Error(`unsafe zip entry: ${entry}`)
    }
  }
  await execFileAsync('unzip', ['-q', zip, '-d', destination], { maxBuffer: 16 * 1024 * 1024 })
}

async function buildPack(base: string, value: QaPath, staging: string): Promise<ManifestPack | undefined> {
  const storePath = value.storePath ?? '.'
  const sourceDir = storePath === '.' ? base : inside(base, safeSegment(storePath))
  const identity = storePath === '.' ? (value.Name?.trim() || base.split(sep).pop() || 'imported') : storePath
  let items: QaItem[]
  try {
    const info = JSON.parse(await readFile(join(sourceDir, 'info.json'), 'utf8')) as { items?: QaItem[] }
    items = Array.isArray(info.items) ? info.items : []
  } catch {
    return
  }

  const packId = packIdFor(identity)
  const title = value.Name?.trim() || identity
  const stagingPack = join(staging, packId)
  await mkdir(stagingPack, { recursive: true })

  const stickers: ManifestSticker[] = []
  let cover: string | undefined
  let version = 1
  for (const item of items) {
    const fileName = item.fileName || item.MD5
    if (!fileName) continue
    try {
      const source = inside(sourceDir, fileName)
      const info = await stat(source)
      if (!info.isFile()) continue
      const data = await readFile(source)
      const meta = imageMeta(data, fileName)
      if (meta.mimeType === 'application/octet-stream') continue
      const id = String(stickers.length + 1).padStart(3, '0')
      const output = `${id}.${extensionFor(meta.mimeType)}`
      await copyFile(source, join(stagingPack, output))

      let thumb: Pick<ManifestSticker, 'thumb' | 'thumbMimeType' | 'thumbSize' | 'thumbWidth' | 'thumbHeight'> = {}
      if (item.thumbName) {
        try {
          const thumbSource = inside(sourceDir, item.thumbName)
          const thumbData = await readFile(thumbSource)
          const thumbMeta = imageMeta(thumbData, item.thumbName)
          if (thumbMeta.mimeType !== 'application/octet-stream') {
            const thumbOutput = `${id}-thumb.${extensionFor(thumbMeta.mimeType)}`
            await copyFile(thumbSource, join(stagingPack, thumbOutput))
            thumb = {
              thumb: thumbOutput,
              thumbMimeType: thumbMeta.mimeType,
              thumbSize: thumbData.length,
              thumbWidth: thumbMeta.width,
              thumbHeight: thumbMeta.height,
            }
          }
        } catch {
          // Ignore broken optional thumbnails.
        }
      }

      stickers.push({
        id,
        file: output,
        mimeType: meta.mimeType,
        format: meta.format,
        size: data.length,
        width: meta.width,
        height: meta.height,
        ...thumb,
      })
      if (value.coverName === fileName) cover = output
      version = Math.max(version, Number.isFinite(item.addTime) ? item.addTime! : 1)
    } catch {
      continue
    }
  }
  if (!stickers.length) {
    await rm(stagingPack, { recursive: true, force: true })
    return
  }
  cover ??= stickers[0].file
  const pack: ManifestPack = { packId, title, version, cover, stickers }
  await writeFile(join(stagingPack, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`)
  return pack
}

async function importQaZip(zip: string, root: string): Promise<ManifestPack[]> {
  const info = await stat(zip)
  if (!info.isFile()) throw new Error('not a file')
  await mkdir(root, { recursive: true })
  const temp = await mkdtemp(join(tmpdir(), 'qa-sticker-'))
  const staging = join(root, `.import-${randomUUID()}`)
  try {
    await extract(zip, temp)
    const files = await walk(temp)
    const setJson = files.find((file) => file.endsWith(`${sep}set.json`))
    const packs: ManifestPack[] = []
    await mkdir(staging, { recursive: true })
    if (setJson) {
      const base = dirname(setJson)
      const set = JSON.parse(await readFile(setJson, 'utf8')) as { paths?: QaPath[] }
      const seen = new Set<string>()
      for (const value of Array.isArray(set.paths) ? set.paths : []) {
        const pack = await buildPack(base, value, staging)
        if (!pack || seen.has(pack.packId)) continue
        seen.add(pack.packId)
        packs.push(pack)
      }
    } else {
      const infoJson = files.find((file) => file.endsWith(`${sep}info.json`))
      if (!infoJson) throw new Error('set.json or info.json not found in archive')
      const pack = await buildPack(dirname(infoJson), { storePath: '.' }, staging)
      if (pack) packs.push(pack)
    }
    if (!packs.length) throw new Error('no valid sticker packs found in archive')

    for (const pack of packs) {
      const source = join(staging, pack.packId)
      const target = join(root, pack.packId)
      await rm(target, { recursive: true, force: true })
      await rename(source, target)
    }
    return packs
  } finally {
    await rm(temp, { recursive: true, force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

async function readPack(root: string, packId: string): Promise<ManifestPack | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(root, packId, 'pack.json'), 'utf8')) as ManifestPack
    if (!raw || raw.packId !== packId || !Array.isArray(raw.stickers)) return
    return raw
  } catch {
    return
  }
}

function fileSource(root: string, relative: string, size: number): IMMediaSource {
  const path = resolve(root, relative)
  if (path !== root && !path.startsWith(root + sep)) throw new Error('invalid sticker path')
  return {
    size,
    stream: (options = {}) => readRange(path, 0, size, options.signal),
    streamRange: ({ offset = 0, limit, signal }) => readRange(path, offset, limit, signal),
  }
}

async function* readRange(path: string, offset: number, limit: number | undefined, signal?: AbortSignal) {
  if (limit === 0) return
  const size = (await stat(path)).size
  const start = Math.max(0, Math.min(Math.trunc(offset), size))
  const end = limit === undefined ? size - 1 : Math.min(start + Math.max(0, Math.trunc(limit)) - 1, size - 1)
  if (end < start) return
  const stream = createReadStream(path, { start, end, signal })
  for await (const chunk of stream) yield chunk as Uint8Array
}

class LocalStickerProvider implements IMStickerProvider {
  readonly capabilities = { sessionScoped: false } as const

  constructor(private readonly root: string) {}

  async listPacks(_context: StickerProviderContext, query: StickerPageQuery = {}): Promise<IMStickerPackPage> {
    const packs: IMStickerPackSummary[] = []
    try {
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const pack = await readPack(this.root, entry.name)
        if (!pack) continue
        packs.push({
          providerId: PROVIDER_ID,
          packId: pack.packId,
          title: pack.title,
          shortName: pack.packId,
          count: pack.stickers.length,
          version: pack.version,
          cover: pack.cover ? { providerId: PROVIDER_ID, stickerId: `${pack.packId}.${pack.stickers.find((item) => item.file === pack.cover)?.id ?? pack.stickers[0].id}` } : undefined,
        })
      }
    } catch {
      return { packs: [] }
    }
    packs.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN') || left.packId.localeCompare(right.packId))
    const offset = query.cursor ? Math.max(0, Number.parseInt(query.cursor, 10) || 0) : 0
    const limit = Math.max(1, Math.min(query.limit ?? 100, 200))
    return { packs: packs.slice(offset, offset + limit), nextCursor: offset + limit < packs.length ? String(offset + limit) : undefined }
  }

  async getPack(_context: StickerProviderContext, packId: string): Promise<IMStickerPack | null> {
    const pack = await readPack(this.root, packId)
    return pack ? this.mapPack(pack) : null
  }

  async getSticker(_context: StickerProviderContext, stickerId: string): Promise<IMSticker | null> {
    const separator = stickerId.indexOf('.')
    if (separator < 1) return
    const pack = await readPack(this.root, stickerId.slice(0, separator))
    const sticker = pack?.stickers.find((item) => item.id === stickerId.slice(separator + 1))
    return sticker && pack ? this.mapSticker(pack, sticker) : null
  }

  async openAsset(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset> {
    const locator = sticker.locator as { file?: string } | undefined
    if (!locator?.file) throw new Error('local sticker has no file locator')
    const info = await stat(resolve(this.root, locator.file))
    return {
      source: fileSource(this.root, locator.file, info.size),
      mimeType: sticker.mimeType,
      size: info.size,
      width: sticker.width,
      height: sticker.height,
    }
  }

  async openThumbnail(_context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerAsset | null> {
    const locator = sticker.thumbnail?.locator as { file?: string } | undefined
    if (!locator?.file || !sticker.thumbnail) return null
    const info = await stat(resolve(this.root, locator.file))
    return {
      source: fileSource(this.root, locator.file, info.size),
      mimeType: sticker.thumbnail.mimeType,
      size: info.size,
      width: sticker.thumbnail.width,
      height: sticker.thumbnail.height,
    }
  }

  async prepareSend(context: StickerProviderContext, sticker: IMSticker): Promise<IMStickerSendPlan> {
    const asset = await this.openAsset(context, sticker)
    return {
      type: 'upload',
      providerId: PROVIDER_ID,
      stickerId: sticker.stickerId,
      packId: sticker.packId,
      format: sticker.format,
      mimeType: sticker.mimeType,
      emoji: sticker.emoji,
      width: sticker.width,
      height: sticker.height,
      source: asset.source,
    }
  }

  private mapPack(pack: ManifestPack): IMStickerPack {
    const stickers = pack.stickers.map((sticker) => this.mapSticker(pack, sticker))
    return {
      providerId: PROVIDER_ID,
      packId: pack.packId,
      title: pack.title,
      shortName: pack.packId,
      count: stickers.length,
      version: pack.version,
      cover: stickers[0] && { providerId: PROVIDER_ID, stickerId: stickers[0].stickerId },
      stickers,
    }
  }

  private mapSticker(pack: ManifestPack, sticker: ManifestSticker): IMSticker {
    return {
      providerId: PROVIDER_ID,
      packId: pack.packId,
      stickerId: `${pack.packId}.${sticker.id}`,
      title: pack.title,
      format: sticker.format,
      mimeType: sticker.mimeType,
      size: sticker.size,
      width: sticker.width,
      height: sticker.height,
      version: pack.version,
      locator: { file: join(pack.packId, sticker.file) },
      thumbnail: sticker.thumb && {
        mimeType: sticker.thumbMimeType ?? 'image/png',
        size: sticker.thumbSize ?? 0,
        width: sticker.thumbWidth ?? sticker.width ?? 0,
        height: sticker.thumbHeight ?? sticker.height ?? 0,
        locator: { file: join(pack.packId, sticker.thumb) },
      },
    }
  }
}

export const name = 'local-stickers'
export const inject = ['imSticker', 'server', 'webui']

export interface Config {
  root?: string
}

export function apply(ctx: Context, config: Config = {}) {
  const root = resolve(config.root ?? 'data/local-stickers')
  const provider = new LocalStickerProvider(root)
  const imSticker = (ctx as any).imSticker
  ctx.effect(() => imSticker.register(provider, PROVIDER_ID), 'local-stickers.register')

  const webui = fileURLToPath(new URL('../../dist/local-stickers/manifest.json', import.meta.url))
  if (existsSync(webui)) {
    ;(ctx as any).webui.addEntry({
      baseUrl: import.meta.url,
      client: 'local-stickers',
      manifest: webui,
      pages: [{ path: '/sticker-import', title: 'Sticker import', icon: '✦', group: 'Workspace' }],
      routes: ['/sticker-import'],
    }, {})
  } else {
    ctx.logger('local-stickers').warn('WebUI build not found: %s', webui)
  }

  ctx.server.post('/sticker-import/upload', async (req: any, res: any) => {
    let temp: string | undefined
    try {
      if (!req.body) throw new Error('missing zip file')
      temp = await mkdtemp(join(tmpdir(), 'qa-upload-'))
      const zip = join(temp, 'upload.zip')
      await pipeline(Readable.fromWeb(req.body), createWriteStream(zip))
      const packs = await importQaZip(zip, root)
      imSticker.touch(PROVIDER_ID)
      ctx.logger('local-stickers').info('imported %d sticker pack(s)', packs.length)
      res.json({ packs: packs.map((pack) => ({ packId: pack.packId, title: pack.title, count: pack.stickers.length })) })
    } catch (error) {
      ctx.logger('local-stickers').warn('import failed: %s', String(error))
      res.status = 400
      res.json({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true })
    }
  })
}
