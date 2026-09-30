import type { KeyboardEvent } from 'react'

/** Props that make a non-button element (a clickable card/preview) keyboard-operable. */
export function clickableProps(onActivate: () => void, label: string) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': label,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      // Ignore keys pressed on nested controls (links/buttons inside the card).
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onActivate()
      }
    },
  }
}

export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2'
