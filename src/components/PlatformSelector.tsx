'use client'

import { Checkbox } from '@/components/ui/checkbox'
import type { PlatformType } from '@/types/content'

const platforms: { id: PlatformType; label: string }[] = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'twitter', label: 'X / Twitter' },
]

interface PlatformSelectorProps {
  selected: PlatformType[]
  onChange: (selected: PlatformType[]) => void
  disabled?: boolean
}

export default function PlatformSelector({
  selected,
  onChange,
  disabled = false,
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
      {platforms.map(({ id, label }) => (
        <label
          key={id}
          className="flex cursor-pointer items-center gap-2 text-sm"
        >
          <Checkbox
            checked={selected.includes(id)}
            onCheckedChange={() => toggle(id)}
            disabled={disabled}
          />
          {label}
        </label>
      ))}
    </div>
  )
}
