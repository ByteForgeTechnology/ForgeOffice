/** IMAP modified UTF-7 mailbox name encoding (RFC 3501 §5.1.3). */

export function encodeMutf7(input: string): string {
  let out = '';
  let buffer: number[] = [];
  const flush = () => {
    if (!buffer.length) return;
    const bytes = Buffer.alloc(buffer.length * 2);
    buffer.forEach((c, i) => bytes.writeUInt16BE(c, i * 2));
    out += '&' + bytes.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
    buffer = [];
  };
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += code === 0x26 ? '&-' : input[i];
    } else {
      buffer.push(code);
    }
  }
  flush();
  return out;
}

export function decodeMutf7(input: string): string {
  return input.replace(/&([^-]*)-/g, (_, b64: string) => {
    if (b64 === '') return '&';
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes.readUInt16BE(i));
    return s;
  });
}
