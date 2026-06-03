import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'

type TimeRange = '24h' | '7d' | '30d'

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function Stat({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'

export default function AnalyticsPage() {
  const [range, setRange] = useState<TimeRange>('7d')
  const queryClient = useQueryClient()

  const resetMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ deleted: number }>('/api/analytics/reset', {
        method: 'POST',
        body: JSON.stringify({ range: '24h' }),
      }),
    onSuccess: (data) => {
      // refetch every analytics panel
      queryClient.invalidateQueries({ queryKey: ['analytics'] })
      window.alert(`${data.deleted} kayıt silindi (son 24 saat).`)
    },
    onError: (err: unknown) => {
      window.alert(`Sıfırlama başarısız: ${err instanceof Error ? err.message : 'bilinmeyen hata'}`)
    },
  })

  const handleReset = () => {
    if (
      window.confirm(
        'Son 24 saatteki TÜM analitik kayıtları (istekler, token, maliyet) kalıcı olarak silinecek. Devam edilsin mi?',
      )
    ) {
      resetMutation.mutate()
    }
  }

  const { data: summary } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<any>(`/api/analytics/summary?range=${range}`),
  })

  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/by-platform?range=${range}`),
  })

  const { data: timeline = [] } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/timeline?range=${range}`),
  })

  const { data: byModel = [] } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/by-model?range=${range}`),
  })

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/errors?range=${range}`),
  })

  const { data: errorDist } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () => apiFetch<{ byCategory: any[]; byPlatform: any[]; detailed: any[] }>(`/api/analytics/error-distribution?range=${range}`),
  })

  const { data: byKey = [] } = useQuery({
    queryKey: ['analytics', 'by-key', range],
    queryFn: () => apiFetch<Array<{
      clientKeyId: number | null
      name: string
      totalRequests: number
      successCount: number
      errorCount: number
      cascadeCount: number
      totalInputTokens: number
      totalOutputTokens: number
      avgLatencyMs: number
      imagesGenerated: number
      costUsd: number
    }>>(`/api/analytics/by-key?range=${range}`),
  })

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Request volume, latency, token usage, and failures."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex gap-1 rounded-md border p-0.5">
              {(['24h', '7d', '30d'] as TimeRange[]).map(r => (
                <Button
                  key={r}
                  variant={range === r ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={() => setRange(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
            <Button
              variant="outline"
              size="xs"
              className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
              onClick={handleReset}
              disabled={resetMutation.isPending}
            >
              {resetMutation.isPending ? 'Sıfırlanıyor…' : 'Reset 24h'}
            </Button>
          </div>
        }
      />

      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Requests" value={summary?.totalRequests ?? 0} />
          <Stat label="Success rate" value={`${summary?.successRate ?? 0}%`} />
          <Stat label="Input tokens" value={formatTokens(summary?.totalInputTokens)} />
          <Stat label="Output tokens" value={formatTokens(summary?.totalOutputTokens)} />
          <Stat label="Avg latency" value={`${summary?.avgLatencyMs ?? 0} ms`} />
          <Stat label="Est. savings" value={`$${summary?.estimatedCostSavings ?? '0.00'}`} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Cascade retries" value={summary?.cascadeRetries ?? 0} className="text-amber-600" />
          <Stat label="Images" value={summary?.imagesGenerated ?? 0} />
          <Stat label="Embeddings" value={summary?.embeddingsGenerated ?? 0} />
          <Stat label="TTS calls" value={summary?.ttsGenerated ?? 0} />
          <Stat label="STT calls" value={summary?.sttTranscribed ?? 0} />
          <Stat label="Reranks" value={summary?.reranksPerformed ?? 0} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title="Requests by provider">
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="requests" fill={primaryFill} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="Avg latency by provider">
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="avgLatencyMs" name="Latency (ms)" fill="var(--muted-foreground)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Requests over time">
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name="Success" stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name="Failures" stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel title="Per-model breakdown">
              {byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No data yet</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Model</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Success</TableHead>
                        <TableHead className="text-right">Latency</TableHead>
                        <TableHead className="text-right">In / calls</TableHead>
                        <TableHead className="text-right pr-4">Out / neurons</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byModel.map((m: any, i: number) => {
                        const mod = (m.modality ?? 'text') as string;
                        const isImage = mod === 'image_gen' || mod === 'image_edit' || mod === 'image_inpaint';
                        const isCallBased = mod === 'embedding' || mod === 'audio_tts' || mod === 'audio_stt' || mod === 'rerank';
                        const badgeClass =
                          isImage ? 'bg-purple-100 text-purple-900 dark:bg-purple-950 dark:text-purple-200' :
                          mod === 'embedding' ? 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200' :
                          mod === 'audio_tts' ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' :
                          mod === 'audio_stt' ? 'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200' :
                          mod === 'rerank' ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200' :
                          'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200';
                        const badgeLabel =
                          mod === 'image_gen' ? 'image' :
                          mod === 'image_edit' ? 'img-edit' :
                          mod === 'image_inpaint' ? 'inpaint' :
                          mod === 'audio_tts' ? 'tts' :
                          mod === 'audio_stt' ? 'stt' :
                          mod;
                        return (
                          <TableRow key={i}>
                            <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{m.platform}</TableCell>
                            <TableCell className="text-xs">
                              <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${badgeClass}`}>
                                {badgeLabel}
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                            <TableCell className="text-right tabular-nums">{m.successRate}%</TableCell>
                            <TableCell className="text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {isImage || isCallBased ? (m.successCount ?? 0) : formatTokens(m.totalInputTokens)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums pr-4">
                              {isImage ? `${formatTokens(m.totalOutputTokens)} n` :
                                isCallBased ? '—' :
                                formatTokens(m.totalOutputTokens)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Errors by provider">
            {!errorDist?.byPlatform?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">No errors</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" fill="var(--destructive)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title="Recent errors">
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No errors</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Provider</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead className="text-right pr-4">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.slice(0, 20).map((e: any) => (
                      <TableRow key={e.id}>
                        <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">{e.error}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          {new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </div>

        <Panel title="Usage by API Key">
          {byKey.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">No data in this range.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Success</TableHead>
                    <TableHead className="text-right">Errors</TableHead>
                    <TableHead className="text-right">Cascade</TableHead>
                    <TableHead className="text-right">Tokens (in→out)</TableHead>
                    <TableHead className="text-right">Images</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Avg Latency</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byKey.map((k) => {
                    const errRate = k.totalRequests
                      ? Math.round((k.errorCount / k.totalRequests) * 100)
                      : 0
                    return (
                      <TableRow key={`${k.clientKeyId ?? 'none'}`}>
                        <TableCell>
                          <span className="text-sm font-medium">{k.name}</span>
                          {k.clientKeyId === null && (
                            <span className="ml-2 text-[10px] text-muted-foreground">
                              (legacy traffic)
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {k.totalRequests.toLocaleString('en-US')}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-emerald-600">
                          {k.successCount.toLocaleString('en-US')}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <span className={errRate > 10 ? 'text-rose-500' : 'text-muted-foreground'}>
                            {k.errorCount.toLocaleString('en-US')}
                            {k.errorCount > 0 && (
                              <span className="ml-1 text-[10px]">({errRate}%)</span>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs text-amber-600">
                          {k.cascadeCount ? k.cascadeCount.toLocaleString('en-US') : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {formatTokens(k.totalInputTokens)} → {formatTokens(k.totalOutputTokens)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {k.imagesGenerated || '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {k.costUsd ? `$${k.costUsd.toFixed(2)}` : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                          {k.avgLatencyMs ? `${Math.round(k.avgLatencyMs / 100) / 10}s` : '—'}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
