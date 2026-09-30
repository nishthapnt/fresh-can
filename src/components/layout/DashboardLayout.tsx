'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation'
import { Menu } from 'lucide-react'
import Sidebar from './Sidebar'
import { Toaster } from '@/components/ui/toast'
import VideoToast from '@/components/VideoToast'
import type { VideoNotification } from '@/components/VideoToast'
import { supabase } from '@/lib/supabase'
import { LOGO_SRC } from '@/lib/brand'

const COLLAPSED_KEY = 'sidebar-collapsed'
const COLLAPSED_EVENT = 'sidebar-collapsed-change'

function subscribeCollapsed(cb: () => void) {
  window.addEventListener('storage', cb)
  window.addEventListener(COLLAPSED_EVENT, cb)
  return () => {
    window.removeEventListener('storage', cb)
    window.removeEventListener(COLLAPSED_EVENT, cb)
  }
}

function getCollapsed() {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [notification, setNotification] = useState<VideoNotification | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Desktop-only collapse, remembered per browser. useSyncExternalStore keeps
  // the server render (expanded) and first client render identical, then
  // switches to the stored value without a hydration mismatch.
  const collapsed = useSyncExternalStore(subscribeCollapsed, getCollapsed, () => false)

  const toggleCollapsed = () => {
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '0' : '1') } catch { /* storage unavailable */ }
    window.dispatchEvent(new Event(COLLAPSED_EVENT))
  }

  useEffect(() => {
    const channel = supabase
      .channel('video-complete-global')
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'generated_content',
          filter: 'content_type=eq.video',
        },
        async (payload) => {
          const row = payload.new as {
            id: string
            job_id: string
            file_url: string | null
            output_data: Record<string, unknown> | null
          }

          if (!row.file_url) return

          const { data: job } = await supabase
            .from('content_jobs')
            .select('topic, category, language')
            .eq('id', row.job_id)
            .single()

          const duration = (row.output_data as Record<string, unknown> | null)?.duration_sec
          const subtitle = job
            ? `${job.category} | ${job.language}${duration ? ` | ${duration}s` : ''}`
            : 'Video generated successfully'

          setNotification({
            title:   `Video ready! 🎉 ${job?.topic ?? 'New video'}`,
            subtitle,
            job_id:  row.job_id,
          })
        },
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  const isOnLibrary = pathname === '/dashboard/library'

  return (
    <div className="min-h-screen bg-gray-50">

      {/* ── Mobile top header (hidden on md+) ──────────────────────── */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-gray-200 bg-white px-4 md:hidden">
        <button
          onClick={() => setSidebarOpen(true)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 active:bg-gray-100"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={LOGO_SRC}
          alt="Fresh-CAN"
          className="h-6 w-auto max-w-[150px] object-contain"
        />
      </header>

      {/* Sidebar — desktop fixed, mobile overlay */}
      <Sidebar mobileOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} collapsed={collapsed} onToggleCollapse={toggleCollapsed} />

      {/* Main content */}
      <main className={`transition-[padding] duration-300 ${collapsed ? 'md:pl-16' : 'md:pl-64'}`}>
        <div className="p-4 sm:p-6 md:p-8">{children}</div>
      </main>

      <Toaster />

      {notification && !isOnLibrary && (
        <VideoToast
          notification={notification}
          onDismiss={() => setNotification(null)}
        />
      )}
    </div>
  )
}
