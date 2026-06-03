import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/page-header'

interface ClientKey {
  id: number
  name: string
  key_prefix: string
  enabled: number
  created_at: string
  last_used_at: string | null
}

interface CreatedClientKey extends ClientKey {
  key: string
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  return d.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
}

export default function ApiKeysPage() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [createdKey, setCreatedKey] = useState<CreatedClientKey | null>(null)
  const [copied, setCopied] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [revealed, setRevealed] = useState<Record<number, string>>({})
  const [revealError, setRevealError] = useState<Record<number, string>>({})

  const { data, isLoading } = useQuery<ClientKey[]>({
    queryKey: ['client-keys'],
    queryFn: () => apiFetch('/api/client-keys'),
  })

  const createKey = useMutation({
    mutationFn: (n: string) =>
      apiFetch<CreatedClientKey>('/api/client-keys', {
        method: 'POST',
        body: JSON.stringify({ name: n }),
      }),
    onSuccess: (row) => {
      setCreatedKey(row)
      setName('')
      queryClient.invalidateQueries({ queryKey: ['client-keys'] })
    },
  })

  const patchKey = useMutation({
    mutationFn: (vars: { id: number; patch: { name?: string; enabled?: boolean } }) =>
      apiFetch(`/api/client-keys/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify(vars.patch),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['client-keys'] }),
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) =>
      fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/client-keys/${id}`, {
        method: 'DELETE',
      }).then((r) => {
        if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`)
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['client-keys'] }),
  })

  function copyToClipboard(value: string) {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function toggleReveal(id: number) {
    if (revealed[id]) {
      setRevealed((s) => {
        const { [id]: _, ...rest } = s
        return rest
      })
      return
    }
    setRevealError((s) => {
      const { [id]: _, ...rest } = s
      return rest
    })
    try {
      const res = await apiFetch<{ id: number; key: string }>(`/api/client-keys/${id}/reveal`)
      setRevealed((s) => ({ ...s, [id]: res.key }))
      // auto-hide after 60s so an unattended panel doesn't leak the key
      setTimeout(() => {
        setRevealed((s) => {
          if (s[id] !== res.key) return s
          const { [id]: _, ...rest } = s
          return rest
        })
      }, 60000)
    } catch (err) {
      setRevealError((s) => ({ ...s, [id]: (err as Error).message }))
    }
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="Create one named key per project — the analytics page shows how much each project is burning."
      />

      {/* Create new key */}
      <div className="rounded-xl border bg-card p-5 mb-6 shadow-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim() || createKey.isPending) return
            createKey.mutate(name.trim())
          }}
          className="flex items-end gap-3 flex-wrap"
        >
          <div className="flex-1 min-w-[240px]">
            <Label htmlFor="new-key-name" className="text-xs uppercase tracking-wider text-muted-foreground">
              New Key Name
            </Label>
            <Input
              id="new-key-name"
              placeholder="e.g. Cline, EmlakCopilot, MCP"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5"
              maxLength={80}
            />
          </div>
          <Button type="submit" disabled={!name.trim() || createKey.isPending}>
            {createKey.isPending ? 'Creating…' : 'Create'}
          </Button>
        </form>
        {createKey.isError && (
          <p className="text-sm text-rose-500 mt-3">
            {(createKey.error as Error).message}
          </p>
        )}
      </div>

      {/* Plain key reveal — shown ONCE after creation */}
      {createdKey && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-5 mb-6 shadow-sm">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h3 className="text-sm font-semibold">Key "{createdKey.name}" created</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Copy this key now — it will not be shown again.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreatedKey(null)}
              aria-label="Close"
            >
              ✕
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs bg-background border rounded px-3 py-2 break-all">
              {createdKey.key}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => copyToClipboard(createdKey.key)}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </Button>
          </div>
        </div>
      )}

      {/* List */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b bg-muted/30 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
            Existing Keys
          </span>
          <span className="text-xs text-muted-foreground">
            {data?.length ?? 0} keys
          </span>
        </div>
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : !data || data.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No keys yet.</div>
        ) : (
          <ul className="divide-y">
            {data.map((row) => {
              const isGeneral = row.id === 1
              const isEnabled = row.enabled === 1
              const isRenaming = renamingId === row.id
              return (
                <li
                  key={row.id}
                  className="px-5 py-4 hover:bg-muted/20 transition-colors"
                >
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex-1 min-w-[200px]">
                      {isRenaming ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            className="h-8 text-sm"
                            autoFocus
                            maxLength={80}
                          />
                          <Button
                            size="sm"
                            onClick={() => {
                              if (!renameValue.trim()) return
                              patchKey.mutate(
                                { id: row.id, patch: { name: renameValue.trim() } },
                                { onSuccess: () => setRenamingId(null) },
                              )
                            }}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRenamingId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{row.name}</span>
                          {isGeneral && (
                            <Badge variant="secondary" className="text-[10px]">
                              Default (protected)
                            </Badge>
                          )}
                          {!isEnabled && (
                            <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-600">
                              disabled
                            </Badge>
                          )}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 mt-1">
                        <code className="text-[11px] font-mono text-muted-foreground break-all">
                          {revealed[row.id] ?? `${row.key_prefix}••••••••••••••••`}
                        </code>
                        <button
                          type="button"
                          onClick={() => toggleReveal(row.id)}
                          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                          aria-label={revealed[row.id] ? 'Hide key' : 'Show key'}
                          title={revealed[row.id] ? 'Hide key' : 'Show key'}
                        >
                          {revealed[row.id] ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                          )}
                        </button>
                        {revealed[row.id] && (
                          <button
                            type="button"
                            onClick={() => copyToClipboard(revealed[row.id]!)}
                            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0 px-1.5"
                          >
                            Copy
                          </button>
                        )}
                      </div>
                      {revealError[row.id] && (
                        <p className="text-[11px] text-amber-600 mt-1">{revealError[row.id]}</p>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground min-w-[120px]">
                      <div>
                        <span className="text-muted-foreground/60">created</span>{' '}
                        <span className="text-foreground/80">{formatDate(row.created_at)}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground/60">last used</span>{' '}
                        <span className="text-foreground/80">{formatDate(row.last_used_at)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {!isRenaming && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setRenamingId(row.id)
                            setRenameValue(row.name)
                          }}
                        >
                          Rename
                        </Button>
                      )}
                      {!isGeneral && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            patchKey.mutate({ id: row.id, patch: { enabled: !isEnabled } })
                          }
                        >
                          {isEnabled ? 'Disable' : 'Enable'}
                        </Button>
                      )}
                      {!isGeneral && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-rose-500 hover:text-rose-600"
                          onClick={() => {
                            if (confirm(`Delete key "${row.name}"? This cannot be undone.`)) {
                              deleteKey.mutate(row.id)
                            }
                          }}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
