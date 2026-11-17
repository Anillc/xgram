import { useState } from 'react'
import type { FormEvent } from 'react'
import type { ClientModule, PageProps } from 'cordis-webui-react/client'
import { PageHeader } from 'cordis-webui-react/components'

interface UploadResult {
  ok: boolean
  data: { error?: string, packs?: Array<{ title: string, count: number }> }
}

function upload(file: File, onProgress: (fraction: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/sticker-import/upload')
    request.setRequestHeader('content-type', 'application/zip')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    request.upload.onload = () => onProgress(1)
    request.onload = () => {
      let data: UploadResult['data'] = {}
      try {
        data = JSON.parse(request.responseText)
      } catch {
        // Non-JSON errors still surface through the HTTP status.
      }
      resolve({ ok: request.status >= 200 && request.status < 300, data })
    }
    request.onerror = () => reject(new Error('upload failed'))
    request.onabort = () => reject(new Error('upload aborted'))
    request.send(file)
  })
}

function ImportPage(_props: PageProps) {
  const [file, setFile] = useState<File>()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number>()
  const [result, setResult] = useState<string>()
  const [error, setError] = useState<string>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setProgress(0)
    setError(undefined)
    setResult(undefined)
    try {
      const response = await upload(file, setProgress)
      if (!response.ok) throw new Error(response.data.error || 'upload failed')
      setResult(`Imported ${response.data.packs?.length ?? 0} pack(s). Open Sticker collections to assign them to an account.`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
      setProgress(undefined)
    }
  }

  return (
    <>
      <PageHeader
        title="Import local stickers"
        description="Upload a QA panel 本地表情包 archive. Imported packs are available to every account and can be assigned from Sticker collections."
      />
      <section className="panel">
        <form onSubmit={submit} className="toolbar">
          <label className="field grow">
            <span>QA sticker archive</span>
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(event) => setFile(event.currentTarget.files?.[0])}
            />
          </label>
          <button className="button" type="submit" disabled={!file || busy}>
            {busy ? 'Importing…' : 'Upload'}
          </button>
        </form>
        {progress !== undefined ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem' }}>
            <progress aria-label="Upload progress" max={1} value={progress} style={{ flex: 1 }} />
            <span>{progress < 1 ? `${Math.round(progress * 100)}%` : 'Processing…'}</span>
          </div>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {result ? (
          <p>
            {result} <a href="/sticker-packs">Sticker collections</a>
          </p>
        ) : null}
      </section>
    </>
  )
}

export default {
  pages: [{
    path: '/sticker-import',
    title: 'Sticker import',
    icon: '✦',
    group: 'Workspace',
    component: ImportPage,
  }],
} satisfies ClientModule
