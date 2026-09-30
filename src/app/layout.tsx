import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'
import GlobalProgressBar from '../components/GlobalProgressBar'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans', display: 'swap' })

export const metadata: Metadata = {
  title: 'Fresh-CAN Content Studio',
  description: 'AI-powered content automation dashboard for Fresh-CAN',
  icons: {
    icon: '/freshcan-logo-favicon.png',
    shortcut: '/freshcan-logo-favicon.png',
    apple: '/apple-touch-icon.png',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${geist.variable} h-full antialiased`}>
      <body className="h-full bg-surface font-sans">
        <GlobalProgressBar />
        {children}
      </body>
    </html>
  )
}
