'use client'

import { useSyncExternalStore } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// Tiny module-level toast store — `toast.success('…')` works from anywhere
// (event handlers, services) without a provider; <Toaster /> is mounted once
// in DashboardLayout. No dependency added on purpose (CLAUDE.md: no new UI
// libraries without asking).

type ToastVariant = 'success' | 'error' | 'info'
interface ToastItem { id: number; message: string; description?: string; variant: ToastVariant }

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id)
  emit()
}

function push(variant: ToastVariant, message: string, description?: string) {
  const id = nextId++
  items = [...items, { id, message, description, variant }].slice(-4)
  emit()
  // Errors stay a bit longer so they can actually be read.
  setTimeout(() => dismiss(id), variant === 'error' ? 7000 : 4000)
}

export const toast = {
  success: (message: string, description?: string) => push('success', message, description),
  error: (message: string, description?: string) => push('error', message, description),
  info: (message: string, description?: string) => push('info', message, description),
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
const getSnapshot = () => items
// Must be a stable reference: useSyncExternalStore compares snapshots with
// Object.is, so a fresh `[]` per call re-renders in an infinite loop.
const EMPTY: ToastItem[] = []
const getServerSnapshot = () => EMPTY

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info }
const TONES: Record<ToastVariant, string> = {
  success: 'text-success',
  error: 'text-destructive',
  info: 'text-info',
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[100] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:items-end"
    >
      {list.map((t) => {
        const Icon = ICONS[t.variant]
        return (
          <div
            key={t.id}
            role={t.variant === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-border bg-background p-3 shadow-md animate-in fade-in-0 slide-in-from-bottom-2"
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONES[t.variant])} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{t.message}</p>
              {t.description && <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="rounded p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
