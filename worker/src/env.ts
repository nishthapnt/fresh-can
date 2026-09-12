// Loads the SAME .env.local the Next.js app uses — no duplicated secrets.
// Root .env.local is one directory up from worker/.
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workerDir = fileURLToPath(new URL('.', import.meta.url))
config({ path: resolve(workerDir, '../../.env.local') })

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export const env = {
  get SUPABASE_URL() {
    return required('NEXT_PUBLIC_SUPABASE_URL')
  },
  get SUPABASE_SERVICE_ROLE_KEY() {
    return required('SUPABASE_SERVICE_ROLE_KEY')
  },
  get OPENAI_API_KEY() {
    return required('OPENAI_API_KEY')
  },
  get KIE_API_KEY() {
    return required('KIE_API_KEY')
  },
  // Video-only providers (M0 of the video migration)
  get ELEVENLABS_API_KEY() {
    return required('ELEVENLABS_API_KEY')
  },
  get ASSEMBLYAI_API_KEY() {
    return required('ASSEMBLYAI_API_KEY')
  },
  get UPLOAD_POST_API_KEY() {
    return required('UPLOAD_POST_API_KEY')
  },
}
