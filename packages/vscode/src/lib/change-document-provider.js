/**
 * 「改动前」的虚拟文档：VS Code 原生 diff（vscode.diff）左边一侧要一个可读取的 URI，
 * 内容只存在内存里，不落盘、也不污染工作区。
 */
import * as vscode from 'vscode'

export const CHANGE_SCHEME = 'valimart-harness-change'

export class ChangeDocumentProvider {
  constructor() {
    this.contents = new Map()
    this.stamp = 0
  }

  /** 每次预览用一个新 URI，避免 VS Code 复用旧内容。 */
  makeUri(relPath) {
    this.stamp++
    return vscode.Uri.from({
      scheme: CHANGE_SCHEME,
      path: `/${String(relPath ?? '').replace(/^\/+/, '')}`,
      query: String(this.stamp),
    })
  }

  set(uri, text) {
    this.contents.set(uri.toString(), String(text ?? ''))
    return uri
  }

  forget(uri) {
    this.contents.delete(uri.toString())
  }

  /** 预览关掉后清掉内容，别一直占内存。 */
  prune(keep = 40) {
    while (this.contents.size > keep) {
      const oldest = this.contents.keys().next().value
      this.contents.delete(oldest)
    }
  }

  provideTextDocumentContent(uri) {
    return this.contents.get(uri.toString()) ?? ''
  }

  register() {
    return vscode.workspace.registerTextDocumentContentProvider(CHANGE_SCHEME, this)
  }
}
