'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  Sparkles,
  FolderOpen,
  Megaphone,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  X,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { LOGO_SRC } from '@/lib/brand'

interface SidebarProps {
  mobileOpen?: boolean
  onClose?: () => void
  /** Desktop only: icon-only rail. The mobile drawer is always full width. */
  collapsed?: boolean
  onToggleCollapse?: () => void
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
    icon: Sparkles,
    exact: false,
  },
  {
    href: '/dashboard/library',
    label: 'Library',
    icon: FolderOpen,
    exact: false,
  },
  {
    href: '/dashboard/posted',
    label: 'Posted',
    icon: Megaphone,
    exact: false,
  },
  {
    href: '/dashboard/settings',
    label: 'Settings',
    icon: Settings,
    exact: false,
  },
]

type KieCreditsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; remaining: number }

export default function Sidebar({ mobileOpen = false, onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
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
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-background',
          'transition-[transform,width] duration-300 ease-in-out',
          collapsed ? 'md:w-16' : 'md:w-64',
          // Mobile: slide in/out
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          // Desktop: always visible
          'md:translate-x-0',
        )}
      >
        {/* Collapse handle — a tall tab (logo height) straddling the right edge, the edge that actually moves */}
        <button
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="group/handle absolute left-full top-0 z-10 hidden h-16 w-6 items-center justify-start outline-none md:flex"
        >
          <span className="flex h-14 w-4 items-center justify-center rounded-r-md border border-l-0 border-border bg-background text-muted-foreground shadow-sm transition-colors group-hover/handle:border-primary/40 group-hover/handle:text-foreground group-focus-visible/handle:ring-2 group-focus-visible/handle:ring-primary">
            {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
          </span>
        </button>

        {/* Brand */}
        <div className={cn('flex h-16 flex-shrink-0 items-center justify-between border-b border-border px-4', collapsed && 'md:justify-center md:px-0')}>
          {collapsed && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/freshcan-logo-favicon.png" alt="Fresh-CAN" className="hidden h-9 w-9 object-contain md:block" />
          )}
          <div className={cn('min-w-0', collapsed && 'md:hidden')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={LOGO_SRC}
              alt="Fresh-CAN"
              className="h-7 w-auto max-w-[180px] object-contain"
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
        <nav className={cn('flex-1 space-y-0.5 overflow-y-auto px-3 py-4', collapsed && 'md:px-2')}>
          <p className={cn('mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-gray-400', collapsed && 'md:hidden')}>
            Menu
          </p>
          {navItems.map(({ href, label, icon: Icon, exact }) => {
            const active = isActive(href, exact)
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                title={collapsed ? label : undefined}
                aria-label={label}
                className={cn(
                  'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all',
                  collapsed && 'md:justify-center md:gap-0 md:px-0',
                  active
                    ? 'bg-primary-subtle font-semibold text-primary'
                    : 'text-muted-foreground hover:bg-surface hover:text-foreground',
                )}
              >
                <Icon
                  className={cn(
                    'h-4 w-4 flex-shrink-0',
                    active ? 'text-primary' : 'text-gray-400 group-hover:text-foreground',
                  )}
                />
                <span className={cn(collapsed && 'md:hidden')}>{label}</span>
              </Link>
            )
          })}

          {/* KIE credits — live balance only; KIE.ai's API has no "total" concept */}
          <div
            className={cn(
              'mt-3 flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5',
              collapsed && 'md:justify-center md:gap-0 md:px-0',
            )}
            title={
              collapsed && kieCredits.status === 'ready'
                ? `${kieCredits.remaining.toLocaleString()} KIE credits`
                : undefined
            }
          >
            <Zap className="h-4 w-4 flex-shrink-0 text-amber-500" />
            <div className={cn('contents', collapsed && 'md:hidden')}>
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
          </div>
        </nav>

        {/* Footer */}
        <div className={cn('flex-shrink-0 space-y-2 border-t border-border p-4', collapsed && 'md:p-2')}>
          <button
            onClick={handleLogout}
            aria-label="Log out"
            title={collapsed ? 'Log out' : undefined}
            className={cn(
              'group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface hover:text-foreground',
              collapsed && 'md:justify-center md:gap-0 md:px-0',
            )}
          >
            <LogOut className="h-4 w-4 flex-shrink-0 text-gray-400 group-hover:text-gray-600" />
            <span className={cn(collapsed && 'md:hidden')}>Log out</span>
          </button>
          <div className={cn('rounded-lg bg-primary-subtle px-3 py-2.5', collapsed && 'md:hidden')}>
            <p className="text-xs font-semibold text-primary">Fresh-CAN Brand</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">AI Content Automation v1.0</p>
          </div>
        </div>
      </aside>
    </>
  )
}