/**
 * Playground panels for the non-chat / non-image-edit modalities:
 * image generation, text-to-speech, speech-to-text, embeddings, rerank.
 *
 * Each panel is self-contained: it fetches the unified key, posts to the
 * matching /v1/* endpoint and renders the result. Styling matches the rest
 * of the dashboard — rounded card surfaces, teal accent, caption + value
 * typography.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

function useApiKey() {
  const { data } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })
  return data?.apiKey
}

function apiBase() {
  return import.meta.env.BASE_URL.replace(/\/$/, '')
}

function authHeaders(key?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) h['Authorization'] = `Bearer ${key}`
  return h
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(file)
  })
}

function PanelShell({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
      </div>
      {children}
    </div>
  )
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {msg}
    </div>
  )
}

function RoutedBadge({ via }: { via?: string }) {
  if (!via) return null
  return (
    <span className="text-[11px] text-muted-foreground tabular-nums">
      served by <span className="font-mono text-foreground">{via}</span>
    </span>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Image generation — POST /v1/images/generations
// ──────────────────────────────────────────────────────────────────────
export function ImageGenPanel() {
  const key = useApiKey()
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [via, setVia] = useState<string>()

  async function run() {
    if (!prompt.trim() || loading) return
    setLoading(true); setError(''); setImages([]); setVia(undefined)
    try {
      const res = await fetch(`${apiBase()}/v1/images/generations`, {
        method: 'POST', headers: authHeaders(key),
        body: JSON.stringify({ prompt: prompt.trim(), n: 1, response_format: 'b64_json' }),
      })
      setVia(res.headers.get('X-Routed-Via') ?? undefined)
      const data = await res.json()
      if (!res.ok) { setError(data.error?.message ?? `HTTP ${res.status}`); return }
      const imgs = (data.data ?? [])
        .map((d: any) => d.b64_json ? `data:image/png;base64,${d.b64_json}` : d.url)
        .filter(Boolean)
      if (imgs.length === 0) { setError('No image returned'); return }
      setImages(imgs)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <PanelShell title="Image generation" hint="POST /v1/images/generations — text-to-image via the router.">
      <div className="space-y-2">
        <Label className="text-xs">Prompt</Label>
        <textarea
          value={prompt} onChange={e => setPrompt(e.target.value)}
          placeholder="A teal-roofed cabin by a calm lake at dawn…"
          rows={3}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={run} disabled={loading || !prompt.trim()} size="sm">
          {loading ? 'Generating…' : 'Generate'}
        </Button>
        <RoutedBadge via={via} />
      </div>
      {error && <ErrorBox msg={error} />}
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {images.map((src, i) => (
            <img key={i} src={src} alt="" className="rounded-md border w-full" />
          ))}
        </div>
      )}
    </PanelShell>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Text-to-speech — POST /v1/audio/speech (binary audio response)
// ──────────────────────────────────────────────────────────────────────
const TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']

export function TtsPanel() {
  const key = useApiKey()
  const [text, setText] = useState('')
  const [voice, setVoice] = useState('alloy')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [audioUrl, setAudioUrl] = useState<string>()
  const [via, setVia] = useState<string>()

  async function run() {
    if (!text.trim() || loading) return
    setLoading(true); setError(''); setAudioUrl(undefined); setVia(undefined)
    try {
      const res = await fetch(`${apiBase()}/v1/audio/speech`, {
        method: 'POST', headers: authHeaders(key),
        body: JSON.stringify({ input: text.trim(), voice }),
      })
      setVia(res.headers.get('X-Routed-Via') ?? undefined)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error?.message ?? `HTTP ${res.status}`); return
      }
      const blob = await res.blob()
      setAudioUrl(URL.createObjectURL(blob))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <PanelShell title="Text-to-speech" hint="POST /v1/audio/speech — Cloudflare MeloTTS (en/es/fr/zh/ja/ko; no Turkish).">
      <div className="space-y-2">
        <Label className="text-xs">Text</Label>
        <textarea
          value={text} onChange={e => setText(e.target.value)}
          placeholder="Hello, this is a routed speech synthesis test."
          rows={3}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Label className="text-xs">Voice</Label>
        <select
          value={voice} onChange={e => setVoice(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-xs"
        >
          {TTS_VOICES.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={run} disabled={loading || !text.trim()} size="sm">
          {loading ? 'Synthesising…' : 'Synthesise'}
        </Button>
        <RoutedBadge via={via} />
      </div>
      {error && <ErrorBox msg={error} />}
      {audioUrl && <audio controls src={audioUrl} className="w-full" />}
    </PanelShell>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Speech-to-text — POST /v1/audio/transcriptions (JSON, data-url audio)
// ──────────────────────────────────────────────────────────────────────
export function SttPanel() {
  const key = useApiKey()
  const [fileName, setFileName] = useState('')
  const [dataUrl, setDataUrl] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useState<string>()
  const [via, setVia] = useState<string>()

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFileName(f.name); setText(undefined); setError('')
    try { setDataUrl(await fileToDataUrl(f)) }
    catch { setError('Could not read file') }
  }

  async function run() {
    if (!dataUrl || loading) return
    setLoading(true); setError(''); setText(undefined); setVia(undefined)
    try {
      const res = await fetch(`${apiBase()}/v1/audio/transcriptions`, {
        method: 'POST', headers: authHeaders(key),
        body: JSON.stringify({ audio: dataUrl }),
      })
      setVia(res.headers.get('X-Routed-Via') ?? undefined)
      const data = await res.json()
      if (!res.ok) { setError(data.error?.message ?? `HTTP ${res.status}`); return }
      setText(data.text ?? JSON.stringify(data))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <PanelShell title="Speech-to-text" hint="POST /v1/audio/transcriptions — Cloudflare Whisper. Upload an audio file.">
      <div className="space-y-2">
        <Label className="text-xs">Audio file</Label>
        <input
          type="file" accept="audio/*" onChange={onFile}
          className="block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-teal-700 file:px-3 file:py-1.5 file:text-white"
        />
        {fileName && <p className="text-[11px] text-muted-foreground">{fileName}</p>}
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={run} disabled={loading || !dataUrl} size="sm">
          {loading ? 'Transcribing…' : 'Transcribe'}
        </Button>
        <RoutedBadge via={via} />
      </div>
      {error && <ErrorBox msg={error} />}
      {text != null && (
        <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap">{text}</div>
      )}
    </PanelShell>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Embeddings — POST /v1/embeddings
// ──────────────────────────────────────────────────────────────────────
export function EmbeddingPanel() {
  const key = useApiKey()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ dims: number; preview: number[]; model: string } | null>(null)

  async function run() {
    if (!input.trim() || loading) return
    setLoading(true); setError(''); setResult(null)
    try {
      const res = await fetch(`${apiBase()}/v1/embeddings`, {
        method: 'POST', headers: authHeaders(key),
        body: JSON.stringify({ input: input.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error?.message ?? `HTTP ${res.status}`); return }
      const vec: number[] = data.data?.[0]?.embedding ?? []
      if (vec.length === 0) { setError('No embedding returned'); return }
      setResult({ dims: vec.length, preview: vec.slice(0, 8), model: data.model ?? '?' })
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <PanelShell title="Embeddings" hint="POST /v1/embeddings — vectorise text through the router.">
      <div className="space-y-2">
        <Label className="text-xs">Text</Label>
        <textarea
          value={input} onChange={e => setInput(e.target.value)}
          placeholder="The quick brown fox…"
          rows={3}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
        />
      </div>
      <Button onClick={run} disabled={loading || !input.trim()} size="sm">
        {loading ? 'Embedding…' : 'Embed'}
      </Button>
      {error && <ErrorBox msg={error} />}
      {result && (
        <div className="rounded-md border bg-muted/50 px-3 py-2 space-y-1">
          <div className="flex gap-4 text-xs">
            <span className="text-muted-foreground">Model <span className="font-mono text-foreground">{result.model}</span></span>
            <span className="text-muted-foreground">Dimensions <span className="font-mono text-foreground">{result.dims}</span></span>
          </div>
          <div className="font-mono text-[11px] text-muted-foreground break-all">
            [{result.preview.map(n => n.toFixed(4)).join(', ')}, …]
          </div>
        </div>
      )}
    </PanelShell>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Rerank — POST /v1/rerank
// ──────────────────────────────────────────────────────────────────────
export function RerankPanel() {
  const key = useApiKey()
  const [query, setQuery] = useState('')
  const [docs, setDocs] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<{ doc: string; score: number }[] | null>(null)

  async function run() {
    const documents = docs.split('\n').map(d => d.trim()).filter(Boolean)
    if (!query.trim() || documents.length === 0 || loading) return
    setLoading(true); setError(''); setResults(null)
    try {
      const res = await fetch(`${apiBase()}/v1/rerank`, {
        method: 'POST', headers: authHeaders(key),
        body: JSON.stringify({ query: query.trim(), documents }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error?.message ?? `HTTP ${res.status}`); return }
      const ranked = (data.results ?? [])
        .map((r: any) => ({ doc: documents[r.index] ?? `#${r.index}`, score: r.relevance_score ?? 0 }))
      if (ranked.length === 0) { setError('No results returned'); return }
      setResults(ranked)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <PanelShell title="Rerank" hint="POST /v1/rerank — Cohere reranking. One document per line.">
      <div className="space-y-2">
        <Label className="text-xs">Query</Label>
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          placeholder="What is the capital of France?"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs">Documents (one per line)</Label>
        <textarea
          value={docs} onChange={e => setDocs(e.target.value)}
          placeholder={'Paris is the capital of France.\nBerlin is the capital of Germany.\nThe Eiffel Tower is in Paris.'}
          rows={4}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
        />
      </div>
      <Button onClick={run} disabled={loading || !query.trim() || !docs.trim()} size="sm">
        {loading ? 'Reranking…' : 'Rerank'}
      </Button>
      {error && <ErrorBox msg={error} />}
      {results && (
        <div className="space-y-1.5">
          {results.map((r, i) => (
            <div key={i} className="flex items-center gap-3 rounded-md border bg-muted/50 px-3 py-2">
              <span className="text-xs font-mono text-muted-foreground w-5">#{i + 1}</span>
              <span className="flex-1 text-sm truncate">{r.doc}</span>
              <span className="text-xs font-mono tabular-nums text-teal-700 dark:text-teal-400">
                {r.score.toFixed(4)}
              </span>
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  )
}
