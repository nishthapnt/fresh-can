'use client'

import { useCallback, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'

interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive = red confirm button (stopping work / losing progress). */
  destructive?: boolean
}

/**
 * In-app replacement for window.confirm. Usage:
 *
 *   const { confirm, confirmDialog } = useConfirm()
 *   if (!(await confirm({ title: '…', confirmLabel: 'Stop' }))) return
 *   …render {confirmDialog} once in the component's JSX
 *
 * Resolves true on confirm, false on Cancel / Escape / outside click.
 */
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok)
    resolver.current = null
    setOpts(null)
  }, [])

  const confirm = useCallback((options: ConfirmOptions) => {
    // A second confirm() while one is open cancels the first.
    resolver.current?.(false)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
      setOpts(options)
    })
  }, [])

  const confirmDialog = (
    <Dialog open={opts !== null} onOpenChange={(v) => { if (!v) settle(false) }}>
      <DialogContent className="sm:max-w-sm">
        {opts && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${opts.destructive ? 'bg-red-100' : 'bg-primary-subtle'}`}>
                <AlertTriangle className={`h-5 w-5 ${opts.destructive ? 'text-red-600' : 'text-primary'}`} />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">{opts.title}</h2>
                {opts.description && <p className="mt-1 text-sm text-muted-foreground">{opts.description}</p>}
              </div>
            </div>
            <div className="flex gap-2">
              {/* autoFocus on Cancel: these actions are hard to undo, so Enter must not confirm by accident. */}
              <Button variant="outline" className="flex-1" autoFocus onClick={() => settle(false)}>
                {opts.cancelLabel ?? 'Cancel'}
              </Button>
              <Button
                className={`flex-1 text-white ${opts.destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:bg-primary-hover'}`}
                onClick={() => settle(true)}
              >
                {opts.confirmLabel ?? 'Confirm'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )

  return { confirm, confirmDialog }
}
