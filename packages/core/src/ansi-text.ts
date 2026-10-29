// What a CLI wrote for a terminal, as plain text: its colours and cursor moves (CSI sequences) out.
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}
