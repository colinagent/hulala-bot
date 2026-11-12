/**
 * Markdown image links in an agent reply.
 *
 * The session model has no image output: an agent that produces a picture
 * writes a file and references it the way the deliverable prompt asks —
 * `![caption](<path/to/image.png>)`. A chat surface can turn that into a real
 * attachment, but only the surface knows how, so this module just finds the
 * links and removes them from the text.
 *
 * @module hulala-bot/render/images
 */
import { extname } from 'node:path'

/** One referenced file. */
export interface ImageLink {
  /** Path as written, possibly relative to the session directory. */
  readonly path: string
  /** Alt text, used as the attachment caption. */
  readonly alt: string
}

/** `![alt](<path with spaces>)` or `![alt](path)`. */
const IMAGE = /!\[([^\]]*)\]\(\s*<?([^)>]+?)>?\s*\)/g

/**
 * Strip image links out of one reply and collect their targets.
 *
 * The link stays as its alt text so a sentence that referred to the picture
 * still reads, and a failed send leaves no broken path in the message.
 * @param text - final assistant Markdown.
 * @returns the text without image links, and the links in order.
 */
export function takeImageLinks(text: string): { text: string; links: ImageLink[] } {
  const links: ImageLink[] = []
  const stripped = text.replace(IMAGE, (_match: string, alt: string, target: string) => {
    links.push({ alt: alt.trim(), path: target.trim() })
    return alt.trim()
  })
  return { text: stripped.replace(/[ \t]+\n/g, '\n').trim(), links }
}

/**
 * Image MIME type from a file name.
 * @param path - file path or name.
 * @returns the MIME type, or undefined for anything a chat photo cannot carry.
 */
export function mediaTypeOf(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return undefined
  }
}
