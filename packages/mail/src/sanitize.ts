import sanitizeHtml from 'sanitize-html';

export interface SanitizeOptions {
  /** cid → data: URL for inline images. */
  inlineImages?: Record<string, string>;
  allowRemoteImages?: boolean;
  /** Images under this URL prefix (our own signature images) are never blocked. */
  trustedImagePrefix?: string;
}

const REMOTE = /^(https?:)?\/\//i;

/**
 * Make email HTML safe to render in a sandboxed iframe: no scripts, forms,
 * event handlers or CSS url()s; remote images are blocked unless allowed
 * (they are read receipts / trackers in practice).
 */
export function sanitizeEmailHtml(html: string, opts: SanitizeOptions = {}): { html: string; blockedImages: number } {
  let blockedImages = 0;
  const out = sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img', 'font', 'center', 'span', 'div', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup', 'caption', 'hr', 'u', 's', 'sup', 'sub', 'small', 'big',
    ],
    allowedAttributes: {
      '*': ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'title', 'class'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'data-blocked-src'],
      font: ['face', 'size', 'color'],
      table: ['border', 'cellpadding', 'cellspacing', 'width', 'bgcolor'],
      td: ['colspan', 'rowspan', 'width', 'nowrap'],
      th: ['colspan', 'rowspan', 'width'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data', 'cid'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowedStyles: {
      '*': {
        // Allow ordinary presentation, never url()/expression().
        '*': [/^(?!.*(url\s*\(|expression\s*\(|javascript:)).*$/i],
      },
    },
    transformTags: {
      a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }),
      img: (tag, attribs) => {
        const src = attribs.src ?? '';
        if (src.toLowerCase().startsWith('cid:')) {
          const data = opts.inlineImages?.[src.slice(4).replace(/^<|>$/g, '')];
          return { tagName: 'img', attribs: { ...attribs, src: data ?? '' } };
        }
        if (REMOTE.test(src) && !opts.allowRemoteImages && !(opts.trustedImagePrefix && src.startsWith(opts.trustedImagePrefix))) {
          blockedImages++;
          const { src: _s, ...rest } = attribs;
          return { tagName: 'img', attribs: { ...rest, 'data-blocked-src': src } };
        }
        return { tagName: 'img', attribs };
      },
    },
  });
  return { html: out, blockedImages };
}
