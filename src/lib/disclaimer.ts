/** Fixed disclaimer appended to every social caption (never AI-generated). */
export const AI_DISCLAIMER_EN =
  'AI-generated visuals for marketing purposes only. Details may contain inaccuracies.'
export const AI_DISCLAIMER_FR =
  "Visuels générés par IA à des fins marketing uniquement. Certains détails peuvent contenir des inexactitudes."

export function aiDisclaimer(language?: string | null): string {
  return language?.toUpperCase() === 'FR' ? AI_DISCLAIMER_FR : AI_DISCLAIMER_EN
}
