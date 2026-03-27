export function formatPlainText(text: string): string {
  let output = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[$1]')
  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  output = output.replace(/\*\*\*(.+?)\*\*\*/g, '$1')
  output = output.replace(/\*\*(.+?)\*\*/g, '$1')
  output = output.replace(/\*(.+?)\*/g, '$1')
  output = output.replace(/__(.+?)__/g, '$1')
  output = output.replace(/_(.+?)_/g, '$1')
  output = output.replace(/^#{1,6}\s+/gm, '')
  output = output.replace(/\n{3,}/g, '\n\n')
  return output.trim()
}

export function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text]
  }

  const segments: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      segments.push(remaining)
      break
    }

    let breakAt = remaining.lastIndexOf('\n', maxLength)
    if (breakAt <= 0) {
      breakAt = maxLength
    }

    segments.push(remaining.slice(0, breakAt))
    remaining = remaining.slice(breakAt).replace(/^\n+/, '')
  }

  return segments
}
