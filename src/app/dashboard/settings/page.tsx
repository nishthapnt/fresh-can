'use client'

import { useCallback, useEffect, useState } from 'react'
import TopBar from '@/components/layout/TopBar'
import ErrorBanner from '@/components/ErrorBanner'
import { fetchApiKeys, fetchKieCredits, fetchUploadPostInfo, type ApiKeyStatus, type UploadPostInfo } from '@/services/settingsService'
import ApiKeyCard from './ApiKeyCard'

export default function SettingsPage() {
  const [keys, setKeys] = useState<ApiKeyStatus[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [credits, setCredits] = useState<number | null>(null)
  const [uploadPostInfo, setUploadPostInfo] = useState<UploadPostInfo | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setKeys(await fetchApiKeys())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load settings')
    }
    setCredits(await fetchKieCredits())
    setUploadPostInfo(await fetchUploadPostInfo())
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    void load()
  }, [load])

  function handleChanged(next: ApiKeyStatus) {
    setKeys((prev) => prev?.map((k) => (k.provider === next.provider ? next : k)) ?? prev)
    if (next.provider === 'kie') void fetchKieCredits().then(setCredits)
    if (next.provider === 'upload_post') void fetchUploadPostInfo().then(setUploadPostInfo)
  }

  return (
    <div className="space-y-6">
      <TopBar
        title="Settings"
        description="Switch the API keys FreshCAN uses, for example to spend credits from another account."
        breadcrumbs={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Settings' }]}
      />

      <p className="text-sm text-muted-foreground">
        A new key is tested before it is saved. It applies to content you start afterwards — jobs already started keep
        the account they began with. Keys are stored encrypted and are never shown again.
      </p>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {!keys && !error && (
        <div className="grid gap-4 md:grid-cols-2" aria-busy="true" aria-label="Loading API keys">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-36 animate-pulse rounded-lg border border-border bg-surface" />
          ))}
        </div>
      )}

      {keys && keys.length === 0 && <p className="text-sm text-muted-foreground">No providers are available.</p>}

      {keys && keys.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {keys.map((k) => (
            <ApiKeyCard key={k.provider} status={k} credits={credits} uploadPostInfo={uploadPostInfo} onChanged={handleChanged} />
          ))}
        </div>
      )}
    </div>
  )
}
