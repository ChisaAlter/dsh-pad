/**
 * Bridge from the root-scoped dock to the conversation composer. A tiny
 * session-scoped entry inside the composer publishes its `inputActions`
 * here; the dock uses the most recently mounted one. Before any session
 * exists (the new-conversation hero) there is no such entry, so the text is
 * typed into the visible composer editor instead and left for the user to send.
 */
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'

const mounted: InputActions[] = []

/** What happened to the text. */
export type FillResult = 'sent' | 'filled' | 'unavailable'

export const composer = {
  attach(actions: InputActions): () => void {
    mounted.push(actions)
    return () => {
      const index = mounted.lastIndexOf(actions)
      if (index >= 0) mounted.splice(index, 1)
    }
  },

  /**
   * Put text into the composer.
   * @param text - the draft.
   * @param submit - send it right away when a session composer is mounted.
   * @returns what happened.
   */
  fill(text: string, submit: boolean): FillResult {
    const actions = mounted[mounted.length - 1]
    if (actions !== undefined) {
      actions.setDraft(text)
      if (submit) {
        actions.submit()
        return 'sent'
      }
      focusEditor(findEditor())
      return 'filled'
    }
    const editor = findEditor()
    if (editor === undefined) return 'unavailable'
    focusEditor(editor)
    document.execCommand('selectAll', false)
    document.execCommand('insertText', false, text)
    return 'filled'
  },

  /**
   * Insert text at the caret, keeping anything the user already typed.
   * @param text - the prompt to add.
   * @returns what happened.
   */
  insert(text: string): FillResult {
    const actions = mounted[mounted.length - 1]
    if (actions !== undefined) {
      try {
        const span = actions.captureInsertion()
        if (!actions.insertText(text, span)) return 'unavailable'
      } catch {
        return 'unavailable'
      }
      focusEditor(findEditor())
      return 'filled'
    }
    const editor = findEditor()
    if (editor === undefined) return 'unavailable'
    // Focusing a dock button must not turn insertion into append. Keep a
    // selection that still belongs to the editor; fall back to its end only
    // when no usable caret exists.
    const selection = window.getSelection()
    const range = selection !== null && selection.rangeCount > 0 && editor.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.getRangeAt(0).cloneRange() : undefined
    editor.focus()
    if (selection !== null && range !== undefined) {
      selection.removeAllRanges()
      selection.addRange(range)
    } else {
      focusEditor(editor)
    }
    document.execCommand('insertText', false, text)
    return 'filled'
  },
}

/** The visible composer editor outside the dock. */
function findEditor(): HTMLElement | undefined {
  const visible = (el: HTMLElement): boolean => el.closest('.dshpad-root') === null && el.getClientRects().length > 0
  return [...document.querySelectorAll<HTMLElement>('[data-composer-input][contenteditable="true"]')].find(visible)
    ?? [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')].find(visible)
}

function focusEditor(editor: HTMLElement | undefined): void {
  if (editor === undefined) return
  editor.focus()
  const selection = window.getSelection()
  if (selection !== null) {
    selection.selectAllChildren(editor)
    selection.collapseToEnd()
  }
}
