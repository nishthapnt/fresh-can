import { toast } from '@/components/ui/toast'

// The HTML `download` attribute is ignored for cross-origin URLs (our media
// lives on Supabase Storage), so the browser just navigates/plays the file.
// Fetching it and saving the blob is what actually triggers a download.
export async function downloadFile(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blobUrl = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
  } catch {
    toast.error('Download failed', 'Could not fetch the file. Try again in a moment.')
  }
}
