import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

type Row = {
  platform: string
  model: string
  status: 'ok' | 'fail'
  httpCode: number
  error: string
}
type UpstreamProvider = {
  platform: string
  note: string
  newModels: string[]
  goneModels: string[]
  upstreamCount?: number
  catalogCount?: number
}
type StatusData = {
  generatedAt: string | null
  ok: number
  fail: number
  total: number
  results: Row[]
  upstream?: { generatedAt: string; providers: UpstreamProvider[] }
}

export default function ModelStatusPage() {
  const { data, isLoading, refetch, isFetching } = useQuery<StatusData>({
    queryKey: ['model-status'],
    queryFn: () => apiFetch('/api/model-status'),
    refetchInterval: 60_000,
  })

  const d = data ?? { generatedAt: null, ok: 0, fail: 0, total: 0, results: [] }
  const fails = d.results.filter((r) => r.status === 'fail')
  const oks = d.results.filter((r) => r.status === 'ok')
  // Derive the headline counts from results[] — the single source of truth.
  // The probe also writes top-level ok/fail/total, but if that file is ever
  // partially written the header and the section lists must not disagree.
  const total = d.results.length
  const okCount = oks.length
  const failCount = fails.length
  const up = d.upstream
  const totalNew = up ? up.providers.reduce((s, p) => s + p.newModels.length, 0) : 0
  const totalGone = up ? up.providers.reduce((s, p) => s + p.goneModels.length, 0) : 0

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Model Status</h1>
          <p className="text-sm text-muted-foreground">
            Auto-tested once a day. Last run:{' '}
            {d.generatedAt ? new Date(d.generatedAt).toLocaleString() : 'never'}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="text-sm px-3 py-1.5 rounded border hover:bg-muted transition-colors"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="flex gap-4">
        <div className="rounded border px-4 py-3">
          <div className="text-2xl font-semibold">{total}</div>
          <div className="text-xs text-muted-foreground">Models tested</div>
        </div>
        <div className="rounded border px-4 py-3">
          <div className="text-2xl font-semibold text-green-600">{okCount}</div>
          <div className="text-xs text-muted-foreground">Working</div>
        </div>
        <div className="rounded border px-4 py-3">
          <div className="text-2xl font-semibold text-red-600">{failCount}</div>
          <div className="text-xs text-muted-foreground">Broken</div>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {fails.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-red-600">Broken models ({fails.length})</h2>
          <div className="rounded border divide-y">
            {fails.map((r) => (
              <div key={r.platform + r.model} className="px-4 py-2 text-sm flex items-start gap-3">
                <span className="inline-block size-2 mt-1.5 rounded-full bg-red-500 shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium">
                    {r.platform} · {r.model}{' '}
                    <span className="text-muted-foreground">HTTP {r.httpCode}</span>
                  </div>
                  {r.error && (
                    <div className="text-xs text-muted-foreground break-words">{r.error}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-green-600">Working models ({oks.length})</h2>
        <div className="rounded border divide-y">
          {oks.map((r) => (
            <div key={r.platform + r.model} className="px-4 py-2 text-sm flex items-center gap-3">
              <span className="inline-block size-2 rounded-full bg-green-500 shrink-0" />
              <span className="font-medium">{r.platform}</span>
              <span className="text-muted-foreground">·</span>
              <span className="truncate">{r.model}</span>
            </div>
          ))}
          {oks.length === 0 && !isLoading && (
            <div className="px-4 py-3 text-sm text-muted-foreground">No data.</div>
          )}
        </div>
      </div>

      {up && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">
            Upstream scan{' '}
            <span className="text-muted-foreground font-normal">
              ({new Date(up.generatedAt).toLocaleString()}) · new {totalNew} · gone {totalGone}
            </span>
          </h2>
          <div className="rounded border divide-y">
            {up.providers.map((p) => (
              <div key={p.platform} className="px-4 py-3 text-sm space-y-1">
                <div className="font-medium flex items-center gap-2">
                  {p.platform}
                  {p.note && <span className="text-xs text-muted-foreground">({p.note})</span>}
                  {!p.note && (
                    <span className="text-xs text-muted-foreground">
                      upstream {p.upstreamCount} · catalog {p.catalogCount}
                    </span>
                  )}
                </div>
                {p.newModels.length > 0 && (
                  <div className="text-xs">
                    <span className="text-blue-600 font-medium">New ({p.newModels.length}):</span>{' '}
                    <span className="text-muted-foreground break-words">
                      {p.newModels.join(', ')}
                    </span>
                  </div>
                )}
                {p.goneModels.length > 0 && (
                  <div className="text-xs">
                    <span className="text-amber-600 font-medium">
                      Gone ({p.goneModels.length}):
                    </span>{' '}
                    <span className="text-muted-foreground break-words">
                      {p.goneModels.join(', ')}
                    </span>
                  </div>
                )}
                {p.newModels.length === 0 && p.goneModels.length === 0 && !p.note && (
                  <div className="text-xs text-muted-foreground">No changes.</div>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            "New" = present at the provider, missing from our catalog (can be added).
            "Gone" = in our catalog, missing at the provider. Scanned once a day.
          </p>
        </div>
      )}
    </div>
  )
}
