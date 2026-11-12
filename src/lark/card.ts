/**
 * Lark interactive cards.
 *
 * Lark cannot edit a text message: streaming requires an interactive card and
 * the card-update API. A turn is therefore one card whose `markdown` element is
 * patched while the agent writes, and whose `action` element carries the same
 * approval buttons Telegram gets as an inline keyboard.
 *
 * Cards are plain JSON, so this module stays pure and testable.
 *
 * @module hulala-bot/lark/card
 */
import type { Keyboard } from '../channel.ts'

/** One card, as the open platform expects it. */
export interface Card {
  readonly config: { readonly wide_screen_mode: boolean; readonly update_multi: boolean }
  readonly header?: { readonly title: { readonly tag: 'plain_text'; readonly content: string } }
  readonly elements: readonly unknown[]
}

/**
 * Build one card.
 * @param text - `lark_md` content.
 * @param options - optional header and buttons.
 * @returns the card document.
 */
export function buildCard(text: string, options: { title?: string | undefined; buttons?: Keyboard | undefined } = {}): Card {
  const elements: unknown[] = [{ tag: 'markdown', content: text }]
  const buttons = options.buttons ?? []
  if (buttons.length > 0) {
    elements.push({
      tag: 'action',
      actions: buttons.flat().map(button => ({
        tag: 'button',
        text: { tag: 'plain_text', content: button.text },
        type: 'default',
        value: { data: button.data },
      })),
    })
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    ...(options.title === undefined ? {} : { header: { title: { tag: 'plain_text' as const, content: options.title } } }),
    elements,
  }
}

/**
 * Strip the mention placeholders Lark leaves in message text.
 *
 * In a group the bot only sees messages that mention it, and the mention arrives
 * as `@_user_1`, which would otherwise hide a leading `/command`.
 * @param text - message text from the event.
 * @returns text with mention tokens removed and surrounding space trimmed.
 */
export function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, '').replace(/[ \t]+/g, ' ').trim()
}
