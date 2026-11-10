// Every balanced {...} in a text, including one inside prose. Strings and escapes are skipped so a
// brace in a test body does not end the object early.
export function jsonObjects(text: string): string[] {
  const found: string[] = []
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue
    let depth = 0
    let quoted = false
    let escaped = false
    for (let at = start; at < text.length; at++) {
      const char = text[at]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        found.push(text.slice(start, at + 1))
        start = at
        break
      }
    }
  }
  return found
}
