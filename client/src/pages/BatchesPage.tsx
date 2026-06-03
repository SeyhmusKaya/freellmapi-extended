import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

type RequestCounts = { total: number; completed: number; failed: number }
type Batch = {
  id: string
  object: 'batch'
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'
  request_counts: RequestCounts
  priority: 'low' | 'normal' | 'high'
  metadata: Record<string, unknown> | null
  callback_url: string | null
  callback_status: string | null
  callback_attempts: number
  created_at: string
  started_at: string | null
  finished_at: string | null
}
type BatchList = { data: Batch[]; next_cursor: string | null }

const STATUS_BADGE: Record<Batch['status'], string> = {
  queued: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  processing: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  completed: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
  failed: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  cancelled: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
}

function elapsed(from: string, to: string | null): string {
  const start = new Date(from + 'Z').getTime()
  const end = to ? new Date(to + 'Z').getTime() : Date.now()
  const s = Math.max(0, Math.floor((end - start) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function ProgressBar({ counts }: { counts: RequestCounts }) {
  const done = counts.completed + counts.failed
  const pct = counts.total ? Math.round((done / counts.total) * 100) : 0
  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-muted-foreground mb-1">
        <span>
          {counts.completed} ok · {counts.failed} fail
        </span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 rounded bg-muted overflow-hidden">
        <div className="h-full bg-foreground/70" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function BatchesPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('')

  const { data, isLoading, isFetching, refetch } = useQuery<BatchList>({
    queryKey: ['batches', statusFilter],
    queryFn: () =>
      apiFetch(`/api/batches${statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ''}`),
    refetchInterval: 5000,
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/batches/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['batches'] }),
  })

  const batches = data?.data ?? []
  const selected = batches.find((b) => b.id === selectedId) ?? null

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Batches</h1>
          <p className="text-sm text-muted-foreground">
            Async batch jobs. 5s polling, auto-refresh.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-sm border rounded px-2 py-1.5 bg-background"
          >
            <option value="">All status</option>
            <option value="queued">Queued</option>
            <option value="processing">Processing</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button
            onClick={() => refetch()}
            className="text-sm px-3 py-1.5 rounded border hover:bg-muted"
          >
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : batches.length === 0 ? (
        <p className="text-sm text-muted-foreground">No batches yet.</p>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">ID</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Progress</th>
                <th className="px-3 py-2 font-medium">Priority</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Elapsed</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const source =
                  (b.metadata?.source as string | undefined) ??
                  (b.metadata?.tag as string | undefined) ??
                  '—'
                const canCancel = b.status === 'queued' || b.status === 'processing'
                return (
                  <tr key={b.id} className="border-t hover:bg-muted/30 cursor-pointer" onClick={() => setSelectedId(b.id)}>
                    <td className="px-3 py-2 font-mono text-xs">{b.id.slice(0, 16)}…</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block text-xs px-2 py-0.5 rounded ${STATUS_BADGE[b.status]}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 w-48"><ProgressBar counts={b.request_counts} /></td>
                    <td className="px-3 py-2 text-xs">{b.priority}</td>
                    <td className="px-3 py-2 text-xs">{source}</td>
                    <td className="px-3 py-2 text-xs">{new Date(b.created_at + 'Z').toLocaleString()}</td>
                    <td className="px-3 py-2 text-xs">{elapsed(b.created_at, b.finished_at)}</td>
                    <td className="px-3 py-2 text-xs">
                      <button
                        disabled={!canCancel || cancelMutation.isPending}
                        className="px-2 py-1 rounded border text-xs hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm(`Cancel batch ${b.id}?`)) cancelMutation.mutate(b.id)
                        }}
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && <BatchDetail batch={selected} onClose={() => setSelectedId(null)} />}
    </div>
  )
}

function BatchDetail({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const [results, setResults] = useState<string>('')
  const [loading, setLoading] = useState(false)

  async function loadResults() {
    setLoading(true)
    try {
      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const res = await fetch(`${base}/api/batches/${batch.id}/results`)
      const text = await res.text()
      if (!res.ok) {
        // Error responses are JSON, not NDJSON — surface the message instead
        // of dumping the raw error body into the results viewer.
        let msg = `HTTP ${res.status}`
        try { msg = JSON.parse(text).error?.message ?? msg } catch { /* keep msg */ }
        setResults(`Error loading results: ${msg}`)
        return
      }
      setResults(text)
    } catch (e: any) {
      setResults(`Error loading results: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  function downloadResults() {
    const blob = new Blob([results || ''], { type: 'application/x-ndjson' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${batch.id}.jsonl`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background border rounded shadow-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold">Batch detail</h2>
            <p className="font-mono text-xs text-muted-foreground break-all">{batch.id}</p>
          </div>
          <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">✕</button>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 mt-4 text-sm">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <span className={`inline-block text-xs px-2 py-0.5 rounded ${STATUS_BADGE[batch.status]}`}>{batch.status}</span>
          </dd>
          <dt className="text-muted-foreground">Counts</dt>
          <dd>
            {batch.request_counts.completed}/{batch.request_counts.total} ok · {batch.request_counts.failed} fail
          </dd>
          <dt className="text-muted-foreground">Priority</dt>
          <dd>{batch.priority}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="text-xs">{new Date(batch.created_at + 'Z').toLocaleString()}</dd>
          {batch.finished_at && (
            <>
              <dt className="text-muted-foreground">Finished</dt>
              <dd className="text-xs">{new Date(batch.finished_at + 'Z').toLocaleString()}</dd>
            </>
          )}
          {batch.callback_url && (
            <>
              <dt className="text-muted-foreground">Callback</dt>
              <dd className="font-mono text-xs break-all">{batch.callback_url}</dd>
              <dt className="text-muted-foreground">Callback delivery</dt>
              <dd className="text-xs">
                {batch.callback_status
                  ? `${batch.callback_status}${batch.callback_attempts ? ` (${batch.callback_attempts} attempt${batch.callback_attempts > 1 ? 's' : ''})` : ''}`
                  : 'pending'}
              </dd>
            </>
          )}
          {batch.metadata && (
            <>
              <dt className="text-muted-foreground">Metadata</dt>
              <dd className="font-mono text-xs">{JSON.stringify(batch.metadata)}</dd>
            </>
          )}
        </dl>

        <div className="mt-5 flex gap-2">
          <button onClick={loadResults} className="text-sm px-3 py-1.5 rounded border hover:bg-muted">
            {loading ? 'Loading…' : 'Load results'}
          </button>
          {results && (
            <button onClick={downloadResults} className="text-sm px-3 py-1.5 rounded border hover:bg-muted">
              Download JSONL
            </button>
          )}
        </div>
        {results && (
          <pre className="mt-3 p-3 bg-muted/50 rounded text-xs overflow-x-auto max-h-80">
            {results.split('\n').slice(0, 100).join('\n')}
            {results.split('\n').length > 100 ? '\n…(truncated)' : ''}
          </pre>
        )}
      </div>
    </div>
  )
}
