// One-time helper: uploads a local reference image to the public
// `brand-assets` Supabase Storage bucket and prints its public URL, to
// paste into src/server/pipeline/prompts/brand/<brand>.ts. Not part of the
// running app — see assets/<brand>/README.md for the full setup.
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { createServiceClient } from '../src/server/pipeline/db'

const BUCKET = 'brand-assets'

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: npm run upload-brand-asset -- <path-to-image>')
    process.exit(1)
  }

  const ext = extname(filePath).toLowerCase()
  const contentType = CONTENT_TYPES[ext]
  if (!contentType) {
    console.error(`Unsupported file extension "${ext}" — expected one of: ${Object.keys(CONTENT_TYPES).join(', ')}`)
    process.exit(1)
  }

  const bytes = await readFile(filePath)
  const objectPath = basename(filePath)
  const client = createServiceClient()

  const { error } = await client.storage.from(BUCKET).upload(objectPath, bytes, { contentType, upsert: true })
  if (error) {
    console.error(`Upload failed: ${error.message}`)
    console.error(`(If this says the bucket doesn't exist, create a PUBLIC bucket named "${BUCKET}" in the Supabase dashboard first — see assets/fresh-can/README.md.)`)
    process.exit(1)
  }

  const { data } = client.storage.from(BUCKET).getPublicUrl(objectPath)
  console.log(`Uploaded. Public URL:\n${data.publicUrl}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
