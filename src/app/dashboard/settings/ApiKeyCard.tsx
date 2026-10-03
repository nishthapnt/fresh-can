'use client'

import { useState } from 'react'
import { Eye, EyeOff, KeyRound, Loader2, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { toast } from '@/components/ui/toast'
import { resetApiKey, saveApiKey, type ApiKeyStatus, type UploadPostInfo } from '@/services/settingsService'

interface Props {
  status: ApiKeyStatus
  /** KIE only: live balance of the active account (null = unavailable). */
  credits?: number | null
  /** upload_post only: plan / profile limit / connected platforms of the active account. */
  uploadPostInfo?: UploadPostInfo | null
  onChanged: (next: ApiKeyStatus) => void
}

export default function ApiKeyCard({ status, credits, uploadPostInfo, onChanged }: Props) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [profile, setProfile] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const needsProfile = status.provider === 'upload_post'
  const inputId = `key-${status.provider}`

  function close() {
    setEditing(false)
    setValue('')
    setProfile('')
    setReveal(false)
    setError(null)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setBusy('save')
    setError(null)
    try {
      const next = await saveApiKey(status.provider, value, needsProfile ? profile : undefined)
      onChanged(next)
      toast.success(`${status.label} key saved`, 'New content will use this account.')
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key')
    } finally {
      setBusy(null)
    }
  }

  async function handleReset() {
    const ok = await confirm({
      title: `Reset ${status.label} to the default key?`,
      description: 'New content will use the default environment key. Jobs already started keep the account they started with.',
      confirmLabel: 'Reset to default',
      destructive: true,
    })
    if (!ok) return
    setBusy('reset')
    try {
      onChanged(await resetApiKey(status.provider))
      toast.success(`${status.label} reset to default`)
    } catch (err) {
      toast.error('Could not reset', err instanceof Error ? err.message : undefined)
    } finally {
      setBusy(null)
    }
  }

  const isCustom = status.source === 'custom'

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
            {status.label}
          </CardTitle>
          <Badge variant={isCustom ? 'default' : 'secondary'}>{isCustom ? 'Custom' : 'Default'}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isCustom ? (
          <div className="space-y-0.5">
            <p className="font-mono text-sm text-foreground" aria-label={`Key ending in ${status.last4}`}>
              ••••••••{status.last4}
            </p>
            {status.profile && <p className="text-xs text-muted-foreground">Profile: {status.profile}</p>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {status.defaultConfigured ? 'Using default environment key' : 'No default key is configured'}
          </p>
        )}

        {status.provider === 'kie' && typeof credits === 'number' && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Zap className="h-3.5 w-3.5 text-amber-500" aria-hidden />
            {credits.toLocaleString()} credits remaining on this account
          </p>
        )}

        {status.provider === 'upload_post' && uploadPostInfo && (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {(uploadPostInfo.plan || uploadPostInfo.profileLimit !== null) && (
              <p>
                {uploadPostInfo.plan && <>Plan: <span className="capitalize">{uploadPostInfo.plan}</span></>}
                {uploadPostInfo.plan && uploadPostInfo.profileLimit !== null && ' · '}
                {uploadPostInfo.profileLimit !== null &&
                  `${uploadPostInfo.profileCount} of ${uploadPostInfo.profileLimit} profiles`}
              </p>
            )}
            {uploadPostInfo.connectedPlatforms && (
              <p>
                {uploadPostInfo.connectedPlatforms.length > 0
                  ? `Connected: ${uploadPostInfo.connectedPlatforms.join(', ')}`
                  : 'No social accounts connected on this profile'}
              </p>
            )}
          </div>
        )}

        {editing ? (
          <form onSubmit={handleSave} className="space-y-3" autoComplete="off">
            <div className="space-y-1.5">
              <label htmlFor={inputId} className="text-xs font-medium text-foreground">
                New {status.label} API key
              </label>
              <div className="flex gap-2">
                <Input
                  id={inputId}
                  type={reveal ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste key"
                  aria-invalid={!!error}
                  aria-describedby={error ? `${inputId}-error` : undefined}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setReveal((r) => !r)}
                  aria-label={reveal ? 'Hide key' : 'Show key'}
                >
                  {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            {needsProfile && (
              <div className="space-y-1.5">
                <label htmlFor={`${inputId}-profile`} className="text-xs font-medium text-foreground">
                  upload-post.com profile for this key
                </label>
                <Input
                  id={`${inputId}-profile`}
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Profile name"
                />
              </div>
            )}
            {error && (
              <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy !== null || !value.trim() || (needsProfile && !profile.trim())}>
                {busy === 'save' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Test &amp; Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={close} disabled={busy === 'save'}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy !== null}>
              Change key
            </Button>
            {isCustom && (
              <Button size="sm" variant="ghost" onClick={handleReset} disabled={busy !== null}>
                {busy === 'reset' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Reset to default
              </Button>
            )}
          </div>
        )}
      </CardContent>
      {confirmDialog}
    </Card>
  )
}
