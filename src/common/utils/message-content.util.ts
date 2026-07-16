/**
 * Normalize LangChain message content to plain text.
 *
 * With the OpenAI Responses API (used for reasoning models), message content
 * arrives as an array of content blocks (e.g. `[{ type: 'text', text: '…' }]`)
 * instead of a plain string. Persisting or sending such values without
 * normalization produces `[object Object]` history entries and JSON replies.
 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>
          if (typeof b.text === 'string') return b.text
        }
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  if (content == null) return ''
  return typeof content === 'object' ? JSON.stringify(content) : String(content)
}
