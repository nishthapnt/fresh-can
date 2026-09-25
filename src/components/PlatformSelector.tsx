'use client'

import { Checkbox } from '@/components/ui/checkbox'
import type { PlatformType, PlatformConnectionMap } from '@/types/content'

const platforms: { id: PlatformType; label: string }[] = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'x', label: 'X / Twitter' },
]

// Exported so a stored platforms[] value can be validated against what's
// actually selectable today (see SocialApprovalCard.tsx) — a stale value
// from before the 'twitter' -> 'x' rename should never silently ride along
// on a retry with no checkbox to remove it.
export const PLATFORM_IDS: PlatformType[] = platforms.map((p) => p.id)

interface PlatformSelectorProps {
  selected: PlatformType[]
  onChange: (selected: PlatformType[]) => void
  disabled?: boolean
  // Omitted/null (fetch failed, or upload-post.com isn't configured at all)
  // renders exactly like before this existed — no warnings, nothing disabled.
  connectionStatus?: PlatformConnectionMap | null
}

export default function PlatformSelector({
  selected,
  onChange,
  disabled = false,
  connectionStatus,
}: PlatformSelectorProps) {
  const toggle = (platform: PlatformType) => {
    if (selected.includes(platform)) {
      onChange(selected.filter((p) => p !== platform))
    } else {
      onChange([...selected, platform])
    }
  }

  return (
    <div className="flex flex-wrap gap-4">
      {platforms.map(({ id, label }) => {
        const status = connectionStatus?.[id]
        // Not connected at all means posting here is a guaranteed failure —
        // same "don't let the user pick it" reasoning as the blog-unsupported
        // guard in SocialApprovalCard.tsx. A live-but-stale token
        // (reauthRequired) is only a warning — it might still work.
        const notConnected = status !== undefined && !status.connected
        return (
          <label
            key={id}
            className={`flex items-center gap-2 text-sm ${notConnected ? 'cursor-not-allowed text-gray-400' : 'cursor-pointer'}`}
          >
            <Checkbox
              checked={selected.includes(id)}
              onCheckedChange={() => toggle(id)}
              disabled={disabled || notConnected}
            />
            {label}
            {notConnected && <span className="text-xs font-medium text-red-500">Not connected</span>}
            {status?.connected && status.reauthRequired && (
              <span className="text-xs font-medium text-amber-600">⚠ Reconnect needed</span>
            )}
          </label>
        )
      })}
    </div>
  )
}
