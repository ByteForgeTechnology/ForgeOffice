import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';

/**
 * Rich-text extensions shared by the mail composer and the signature
 * designer, so formatting made in one (colours, sizes, alignment, tables,
 * images) survives in the other.
 */
export function richTextExtensions(placeholder: string, opts: { resizableImages?: boolean } = {}) {
  return [
    StarterKit.configure({ link: { openOnClick: false, autolink: true, isAllowedUri: (url, ctx) => /^\{\{\w+\}\}$/.test(url) || ctx.defaultValidate(url) } }),
    Placeholder.configure({ placeholder }),
    TextStyleKit.configure({ backgroundColor: false, lineHeight: false }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Image.configure({ inline: true, allowBase64: false, resize: opts.resizableImages ? { enabled: true, alwaysPreserveAspectRatio: true, minWidth: 16 } : false }),
    TableKit.configure({ table: { resizable: false, HTMLAttributes: { cellpadding: '0', cellspacing: '0', border: '0' } } }),
  ];
}
