/**
 * Attach the current editor file and/or selection as prompt context for /v1/chat/completions.
 */
import path from 'node:path'

export function buildEditorContext({ currentFile, selection, workspaceRoot } = {}) {
  const hasFile = typeof currentFile === 'string' && currentFile.length > 0
  const relativePath = hasFile
    ? workspaceRoot
      ? path.relative(workspaceRoot, currentFile).replaceAll('\\', '/')
      : currentFile.replaceAll('\\', '/')
    : null
  const sel = typeof selection === 'string' && selection.length > 0 ? selection : ''
  const parts = []
  if (hasFile) parts.push(`Current editor file: ${relativePath}`)
  if (sel) parts.push(`Selected text:\n${sel}`)
  return {
    currentFile: hasFile ? currentFile : null,
    relativePath,
    selection: sel,
    hasSelection: sel.length > 0,
    text: parts.join('\n\n'),
  }
}

/** Messages array that the agent / client will POST to /v1/chat/completions. */
export function buildChatMessages({ userPrompt, editorContext, history = [] } = {}) {
  const sections = []
  if (editorContext?.text) sections.push(editorContext.text)
  sections.push(String(userPrompt ?? ''))
  return [...history, { role: 'user', content: sections.filter((s) => s.length > 0).join('\n\n') }]
}
