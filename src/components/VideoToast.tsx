'use client'

import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { CheckCircle2, X, Library } from 'lucide-react'

export interface VideoNotification {
  title: string
  subtitle: string
  job_id: string
}

interface VideoToastProps {
  notification: VideoNotification
  onDismiss: () => void
}

export default function VideoToast({ notification, onDismiss }: VideoToastProps) {
  const router = useRouter()

  const handleViewLibrary = () => {
    router.push('/dashboard/library')
    onDismiss()
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-80 overflow-hidden rounded-2xl border border-green-200 bg-white shadow-2xl">
      {/* Green accent bar */}
      <div className="h-1 w-full bg-gradient-to-r from-green-400 to-emerald-500" />

      <div className="flex items-start gap-3 p-4 pb-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-100">
          <CheckCircle2 className="h-5 w-5 text-green-600" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug text-gray-900">
            {notification.title}
          </p>
          <p className="mt-0.5 text-xs leading-snug text-gray-500">
            {notification.subtitle}
          </p>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="px-4 pb-4">
        <Button
          size="sm"
          className="w-full bg-primary hover:bg-primary-hover"
          onClick={handleViewLibrary}
        >
          <Library className="mr-2 h-4 w-4" />
          View in Library →
        </Button>
      </div>
    </div>
  )
}
