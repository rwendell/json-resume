import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

export async function getPdfPageCount(filePath) {
  const bytes = await readFile(filePath);
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return pdf.getPageCount();
}
