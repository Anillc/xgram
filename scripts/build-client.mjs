import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildClient } from 'cordis-webui-react/build'

const root = process.cwd()
const dist = resolve(root, 'dist')
await mkdir(dist, { recursive: true })

for (const entry of await readdir(join(root, 'src'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const client = join(root, 'src', entry.name, 'client')
  if (!existsSync(join(client, 'index.tsx'))) continue
  const temporary = join(client, 'dist')
  const outDir = join(dist, entry.name)
  await rm(temporary, { recursive: true, force: true })
  await rm(outDir, { recursive: true, force: true })
  try {
    await buildClient({ root: client, entry: 'index.tsx', outDir: 'dist' })
    await rename(temporary, outDir)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
