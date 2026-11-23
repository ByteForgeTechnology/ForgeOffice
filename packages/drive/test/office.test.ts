import { describe, expect, it } from 'vitest';
import { blankDocument, officeDocumentType, officeKey, signOfficeJwt, verifyOfficeJwt } from '../src';

/** File names in a zip's central directory. */
function zipEntries(buf: Buffer) {
  const names: string[] = [];
  for (let i = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), at = buf.readUInt32LE(i + 16), n = buf.readUInt16LE(i + 10); n > 0; n--) {
    const len = buf.readUInt16LE(at + 28);
    names.push(buf.toString('utf8', at + 46, at + 46 + len));
    at += 46 + len + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return names;
}

describe('Euro-Office helpers', () => {
  it('blank documents are real Office files', () => {
    expect(zipEntries(blankDocument('docx'))).toEqual(expect.arrayContaining(['[Content_Types].xml', 'word/document.xml']));
    expect(zipEntries(blankDocument('xlsx'))).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml']));
    expect(zipEntries(blankDocument('pptx'))).toEqual(expect.arrayContaining(['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/slides/slide1.xml']));
  });

  it('document types, keys and tokens', () => {
    expect([officeDocumentType('a.DOCX'), officeDocumentType('b.ods'), officeDocumentType('c.pptx'), officeDocumentType('d.pdf'), officeDocumentType('e.zip')]).toEqual(['word', 'cell', 'slide', 'pdf', null]);
    expect(officeKey('3f2a…-x/y')).toBe('3f2a-xy');
    const t = signOfficeJwt('s'.repeat(32), { status: 2 });
    expect(verifyOfficeJwt(' s'.repeat(16), t)).toBeNull();
    expect(verifyOfficeJwt('s'.repeat(32), t)).toMatchObject({ status: 2 });
    expect(verifyOfficeJwt('s'.repeat(32), signOfficeJwt('s'.repeat(32), { status: 2 }, -10))).toBeNull();
  });
});
