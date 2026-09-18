'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  PlusCircle,
  Library,
  Share2,
  LogOut,
  X,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface SidebarProps {
  mobileOpen?: boolean
  onClose?: () => void
}

const navItems = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    exact: true,
  },
  {
    href: '/dashboard/new',
    label: 'New Content',
    icon: PlusCircle,
    exact: false,
  },
  {
    href: '/dashboard/library',
    label: 'Library',
    icon: Library,
    exact: false,
  },
  {
    href: '/dashboard/posted',
    label: 'Posted',
    icon: Share2,
    exact: false,
  },
]

type KieCreditsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; remaining: number }

export default function Sidebar({ mobileOpen = false, onClose }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [kieCredits, setKieCredits] = useState<KieCreditsState>({ status: 'loading' })

  const isActive = (href: string, exact: boolean) =>
    exact ? pathname === href : pathname.startsWith(href)

  useEffect(() => {
    let cancelled = false

    async function loadCredits() {
      try {
        const res = await fetch('/api/kie/credits')
        const body = await res.json()
        if (!res.ok || typeof body.remaining !== 'number') throw new Error(body.error ?? 'Unknown error')
        if (!cancelled) setKieCredits({ status: 'ready', remaining: body.remaining })
      } catch {
        if (!cancelled) setKieCredits({ status: 'error' })
      }
    }

    loadCredits()
    const interval = setInterval(loadCredits, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 md:hidden',
          mobileOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sidebar panel */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-gray-200 bg-white',
          'transition-transform duration-300 ease-in-out',
          // Mobile: slide in/out
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          // Desktop: always visible
          'md:translate-x-0',
        )}
      >
        {/* Brand */}
        <div className="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-200 px-4">
          <div className="min-w-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://jbrktjnscnzmhwupojiu.supabase.co/storage/v1/object/public/assets/freshcan-logo-white.jpeg"
              alt="Fresh-CAN"
              className="h-9 w-auto max-w-[140px] rounded-md object-contain"
            />
            <p className="mt-0.5 pl-0.5 text-[10px] text-gray-400">Content Studio</p>
          </div>
          {/* Close button — mobile only */}
          <button
            onClick={onClose}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 md:hidden"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Menu
          </p>
          {navItems.map(({ href, label, icon: Icon, exact }) => {
            const active = isActive(href, exact)
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={cn(
                  'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                  active
                    ? 'bg-green-600 text-white shadow-sm'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                )}
              >
                <Icon
                  className={cn(
                    'h-4 w-4 flex-shrink-0 transition-transform group-hover:scale-110',
                    active ? 'text-white' : 'text-gray-400 group-hover:text-gray-600',
                  )}
                />
                {label}
              </Link>
            )
          })}

          {/* KIE credits — live balance only; KIE.ai's API has no "total" concept */}
          <div className="mt-3 flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-2.5">
            <Zap className="h-4 w-4 flex-shrink-0 text-amber-500" />
            {kieCredits.status === 'loading' && (
              <div className="h-3.5 w-24 animate-pulse rounded bg-gray-200" />
            )}
            {kieCredits.status === 'error' && (
              <p className="text-xs text-gray-400">KIE credits unavailable</p>
            )}
            {kieCredits.status === 'ready' && (
              <p className="text-xs font-medium text-gray-600">
                <span className="font-semibold text-gray-900">
                  {kieCredits.remaining.toLocaleString()}
                </span>{' '}
                KIE credits
              </p>
            )}
          </div>
        </nav>

        {/* Footer */}
        <div className="flex-shrink-0 space-y-2 border-t border-gray-200 p-4">
          <button
            onClick={handleLogout}
            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-gray-600 transition-all hover:bg-gray-100 hover:text-gray-900"
          >
            <LogOut className="h-4 w-4 flex-shrink-0 text-gray-400 group-hover:text-gray-600" />
            Log out
          </button>
          <div className="rounded-lg bg-green-50 px-3 py-2.5">
            <p className="text-xs font-semibold text-green-700">Fresh-CAN Brand</p>
            <p className="mt-0.5 text-[10px] text-green-600">AI Content Automation v1.0</p>
          </div>
        </div>
      </aside>
    </>
  )
}