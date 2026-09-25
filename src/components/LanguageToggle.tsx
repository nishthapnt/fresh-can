'use client'

// Shared by the job detail page's draft editor (one card per language) and
// the social approval page (one social_posts row per language) — same
// "pill row, hidden for single-language jobs" pattern in both places.

const LANG_ORDER: Record<string, number> = { EN: 0, FR: 1 }
export const LANG_LABELS: Record<string, string> = { EN: 'English', FR: 'Français' }

export default function LanguageToggle({
  languages,
  selected,
  onSelect,
  disabled,
}: {
  languages: string[]
  selected: string
  onSelect: (lang: string) => void
  disabled?: boolean
}) {
  if (languages.length <= 1) return null
  const sorted = [...languages].sort((a, b) => (LANG_ORDER[a] ?? 99) - (LANG_ORDER[b] ?? 99))

  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="text-xs text-gray-400">Language</span>
      <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
        {sorted.map((lang) => (
          <button
            key={lang}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(lang)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              selected === lang
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {LANG_LABELS[lang] ?? lang}
          </button>
        ))}
      </div>
    </div>
  )
}
