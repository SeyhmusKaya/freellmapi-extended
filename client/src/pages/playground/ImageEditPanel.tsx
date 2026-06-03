import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'

type Mode = 'inpaint' | 'outpaint'
type OutDir = 'left' | 'right' | 'top' | 'bottom' | 'all'

interface ResultBlock {
  b64: string
  latency: number
  routedVia?: { platform?: string; model?: string }
}

const MAX_DIM = 768
const DEFAULT_BRUSH = 32

/**
 * ImageEditPanel — inpainting + outpainting playground.
 *
 * Inpainting flow:
 *   1. Upload source image → drawn on imageCanvas
 *   2. User paints mask on overlay maskCanvas (black = edit region)
 *   3. Submit: data URLs for image + mask → POST /v1/images/edits
 *
 * Outpainting flow:
 *   1. Upload source image
 *   2. Select direction (left/right/up/down/all) + pixels (16-512)
 *   3. Submit: POST /v1/images/outpaint (server composites canvas + auto-mask)
 *
 * Both flows route through Cloudflare SD 1.5 inpainting on the backend.
 */
export default function ImageEditPanel() {
  const imageCanvasRef = useRef<HTMLCanvasElement>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const lastPosRef = useRef<{ x: number; y: number } | null>(null)

  const [mode, setMode] = useState<Mode>('inpaint')
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH)
  const [direction, setDirection] = useState<OutDir>('right')
  const [pixels, setPixels] = useState(128) // server schema min=32, max=512
  const [strength, setStrength] = useState(0.8)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ResultBlock | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  // Reset mask when source or mode changes
  useEffect(() => {
    if (!imageDims) return
    const mc = maskCanvasRef.current
    if (!mc) return
    const ctx = mc.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, mc.width, mc.height)
  }, [imageDataUrl, mode, imageDims])

  function handleUpload(file: File) {
    setError(null)
    setResult(null)
    const reader = new FileReader()
    reader.onload = () => {
      const url = reader.result as string
      const img = new Image()
      img.onload = () => {
        // Scale to fit MAX_DIM while preserving aspect ratio
        let w = img.width
        let h = img.height
        const scale = Math.min(1, MAX_DIM / Math.max(w, h))
        w = Math.round(w * scale)
        h = Math.round(h * scale)
        setImageDims({ w, h })
        setImageDataUrl(url)
        requestAnimationFrame(() => {
          const ic = imageCanvasRef.current
          if (!ic) return
          ic.width = w
          ic.height = h
          const ctx = ic.getContext('2d')
          if (!ctx) return
          ctx.drawImage(img, 0, 0, w, h)
          const mc = maskCanvasRef.current
          if (mc) {
            mc.width = w
            mc.height = h
            const mctx = mc.getContext('2d')
            mctx?.clearRect(0, 0, w, h)
          }
        })
      }
      img.src = url
    }
    reader.readAsDataURL(file)
  }

  function canvasPos(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = maskCanvasRef.current!
    const rect = c.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * c.width,
      y: ((e.clientY - rect.top) / rect.height) * c.height,
    }
  }

  function paintAt(x: number, y: number) {
    const c = maskCanvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = 'rgba(220, 38, 38, 0.55)' // visual overlay
    ctx.beginPath()
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2)
    ctx.fill()
    if (lastPosRef.current) {
      ctx.strokeStyle = 'rgba(220, 38, 38, 0.55)'
      ctx.lineWidth = brushSize
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y)
      ctx.lineTo(x, y)
      ctx.stroke()
    }
    lastPosRef.current = { x, y }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (mode !== 'inpaint' || !imageDataUrl) return
    drawingRef.current = true
    lastPosRef.current = null
    const { x, y } = canvasPos(e)
    paintAt(x, y)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return
    const { x, y } = canvasPos(e)
    paintAt(x, y)
  }
  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = false
    lastPosRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
  }

  function clearMask() {
    const c = maskCanvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    ctx?.clearRect(0, 0, c.width, c.height)
  }

  /** Build a clean black-on-white mask data URL from the painted overlay. */
  function buildMaskDataUrl(): string | null {
    const overlay = maskCanvasRef.current
    if (!overlay) return null
    const w = overlay.width
    const h = overlay.height
    const tmp = document.createElement('canvas')
    tmp.width = w
    tmp.height = h
    const tctx = tmp.getContext('2d')!
    // White background, black where painted
    tctx.fillStyle = '#ffffff'
    tctx.fillRect(0, 0, w, h)
    const src = overlay.getContext('2d')!.getImageData(0, 0, w, h)
    const dst = tctx.getImageData(0, 0, w, h)
    for (let i = 0; i < src.data.length; i += 4) {
      const alpha = src.data[i + 3]
      if (alpha > 16) {
        dst.data[i] = 0
        dst.data[i + 1] = 0
        dst.data[i + 2] = 0
        dst.data[i + 3] = 255
      }
    }
    tctx.putImageData(dst, 0, 0)
    return tmp.toDataURL('image/png')
  }

  /** Re-encode the displayed image canvas back to a data URL (post-scaling). */
  function getImageDataUrl(): string | null {
    const ic = imageCanvasRef.current
    if (!ic) return null
    return ic.toDataURL('image/png')
  }

  async function handleSubmit() {
    if (!imageDataUrl) {
      setError('Upload an image first.')
      return
    }
    if (!prompt.trim()) {
      setError('Prompt required.')
      return
    }
    setError(null)
    setResult(null)
    setLoading(true)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`
      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const img = getImageDataUrl()!
      const start = Date.now()

      let endpoint = ''
      const body: any = { prompt, image: img }

      if (mode === 'inpaint') {
        endpoint = '/v1/images/edits'
        const mask = buildMaskDataUrl()
        if (!mask) {
          setError('Could not read mask.')
          setLoading(false)
          return
        }
        body.mask = mask
        body.strength = strength
        body.response_format = 'b64_json'
      } else {
        endpoint = '/v1/images/outpaint'
        body.direction = direction
        body.pixels = pixels
        body.response_format = 'b64_json'
      }

      const res = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      const latency = Date.now() - start
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        setError(err.error?.message ?? `HTTP ${res.status}`)
        return
      }
      const data = await res.json()
      const b64 = data.data?.[0]?.b64_json
      if (!b64) {
        setError('No image returned.')
        return
      }
      setResult({
        b64,
        latency,
        routedVia: data._routed_via,
      })
    } catch (e: any) {
      setError(e?.message ?? 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  function downloadResult() {
    if (!result) return
    const a = document.createElement('a')
    a.href = `data:image/png;base64,${result.b64}`
    a.download = `i2i-${Date.now()}.png`
    a.click()
  }

  return (
    <div className="flex flex-col h-full">
      {/* Mode header — gradient teal */}
      <div className="rounded-lg overflow-hidden border bg-card">
        <div className="bg-gradient-to-r from-teal-700 to-teal-600 px-5 py-3 flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-teal-100/90">Image edit</div>
            <div className="text-base font-semibold text-white">
              {mode === 'inpaint' ? 'Inpainting (paint mask)' : 'Outpainting (extend canvas)'}
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant={mode === 'inpaint' ? 'default' : 'outline'}
              size="sm"
              className={mode === 'inpaint' ? 'bg-white text-teal-800 hover:bg-teal-50' : 'bg-teal-700/40 text-white border-teal-200/40 hover:bg-teal-700/60'}
              onClick={() => setMode('inpaint')}
            >
              Inpaint
            </Button>
            <Button
              variant={mode === 'outpaint' ? 'default' : 'outline'}
              size="sm"
              className={mode === 'outpaint' ? 'bg-white text-teal-800 hover:bg-teal-50' : 'bg-teal-700/40 text-white border-teal-200/40 hover:bg-teal-700/60'}
              onClick={() => setMode('outpaint')}
            >
              Outpaint
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-0">
          {/* Canvas panel */}
          <div className="p-5 border-r min-h-[420px] flex flex-col">
            {!imageDataUrl ? (
              <label className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-muted-foreground/30 rounded-lg cursor-pointer hover:bg-muted/30 transition-colors">
                <div className="text-sm font-medium">Click to upload image</div>
                <div className="text-xs text-muted-foreground mt-1">PNG / JPG, scaled to {MAX_DIM}px max edge</div>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) handleUpload(f)
                  }}
                />
              </label>
            ) : (
              <>
                <div className="relative inline-block mx-auto rounded-lg overflow-hidden border bg-muted/30">
                  <canvas
                    ref={imageCanvasRef}
                    className="block max-w-full h-auto"
                    style={{ touchAction: 'none' }}
                  />
                  <canvas
                    ref={maskCanvasRef}
                    className={`absolute inset-0 ${mode === 'inpaint' ? 'cursor-crosshair' : 'pointer-events-none opacity-0'}`}
                    style={{ touchAction: 'none', width: '100%', height: '100%' }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                  />
                </div>
                <div className="flex items-center gap-3 mt-4 flex-wrap">
                  <label className="text-xs">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={e => {
                        const f = e.target.files?.[0]
                        if (f) handleUpload(f)
                      }}
                    />
                    <span className="cursor-pointer underline text-muted-foreground hover:text-foreground">Change image</span>
                  </label>
                  {mode === 'inpaint' && (
                    <>
                      <div className="flex items-center gap-2">
                        <Label className="text-xs">Brush</Label>
                        <input
                          type="range"
                          min={4}
                          max={120}
                          value={brushSize}
                          onChange={e => setBrushSize(parseInt(e.target.value))}
                          className="w-32 accent-teal-600"
                        />
                        <span className="text-xs tabular-nums w-7">{brushSize}</span>
                      </div>
                      <Button variant="outline" size="sm" onClick={clearMask}>
                        Clear mask
                      </Button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Controls panel */}
          <div className="p-5 space-y-4 flex flex-col">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Prompt</Label>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder={mode === 'inpaint' ? 'Describe what to fill the masked region with…' : 'Describe what to extend the scene with…'}
                rows={4}
                className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
              />
            </div>

            {mode === 'inpaint' && (
              <div className="space-y-1.5">
                <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Strength</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={strength}
                    onChange={e => setStrength(parseFloat(e.target.value))}
                    className="flex-1 accent-teal-600"
                  />
                  <span className="text-xs tabular-nums w-10">{strength.toFixed(2)}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">0.3 = subtle edit · 1.0 = full replace</p>
              </div>
            )}

            {mode === 'outpaint' && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Direction</Label>
                  <Select value={direction} onValueChange={(v) => setDirection(v as OutDir)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="left">← Left</SelectItem>
                      <SelectItem value="right">Right →</SelectItem>
                      <SelectItem value="top">↑ Top</SelectItem>
                      <SelectItem value="bottom">↓ Bottom</SelectItem>
                      <SelectItem value="all">All sides</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Pixels</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={32}
                      max={512}
                      step={16}
                      value={pixels}
                      onChange={e => setPixels(parseInt(e.target.value))}
                      className="flex-1 accent-teal-600"
                    />
                    <span className="text-xs tabular-nums w-10">{pixels}</span>
                  </div>
                </div>
              </>
            )}

            {error && (
              <div className="rounded-md border border-red-300/60 bg-red-50/60 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}

            <div className="mt-auto pt-2 space-y-2">
              <Button
                onClick={handleSubmit}
                disabled={loading || !imageDataUrl || !prompt.trim()}
                className="w-full bg-teal-700 hover:bg-teal-800 text-white"
              >
                {loading ? 'Generating…' : mode === 'inpaint' ? 'Run inpaint' : 'Run outpaint'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Result */}
      {(loading || result) && (
        <div className="mt-4 rounded-lg border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b flex items-center justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Result</div>
              <div className="text-sm font-semibold">
                {loading ? 'Generating…' : (
                  <>
                    {result?.routedVia?.platform && <span>{result.routedVia.platform}</span>}
                    {result?.routedVia?.model && <span className="text-muted-foreground"> · <span className="font-mono text-xs">{result.routedVia.model}</span></span>}
                    {result?.latency != null && <span className="text-muted-foreground"> · {result.latency} ms</span>}
                  </>
                )}
              </div>
            </div>
            {result && (
              <Button variant="outline" size="sm" onClick={downloadResult}>
                Download PNG
              </Button>
            )}
          </div>
          <div className="p-5 flex justify-center bg-muted/30 min-h-[200px] items-center">
            {loading ? (
              <div className="flex gap-1">
                <span className="size-2 rounded-full bg-teal-600/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="size-2 rounded-full bg-teal-600/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="size-2 rounded-full bg-teal-600/60 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            ) : result ? (
              <img
                src={`data:image/png;base64,${result.b64}`}
                alt="result"
                className="max-w-full h-auto rounded-md shadow-sm"
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
