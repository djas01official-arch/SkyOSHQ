import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export const PDF_MIME_TYPE = 'application/pdf';
export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface DocumentTextParser {
  readonly mimeType: string;
  readonly name: string;
  readonly version: string;
  extractText(bytes: Uint8Array): Promise<string>;
}

export class UnsupportedDocumentParserError extends Error {}

/**
 * Parser output normalization is part of the recorded parser version. It keeps
 * extraction deterministic across operating systems without changing binaries.
 */
export function normalizeExtractedText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class PdfDocumentTextParser implements DocumentTextParser {
  readonly mimeType = PDF_MIME_TYPE;
  readonly name = 'pdf-parse';
  readonly version = '2.4.5-skyos.1';

  async extractText(bytes: Uint8Array): Promise<string> {
    const parser = new PDFParse({ data: bytes });

    try {
      const result = await parser.getText();
      return normalizeExtractedText(result.text);
    } finally {
      await parser.destroy();
    }
  }
}

export class DocxDocumentTextParser implements DocumentTextParser {
  readonly mimeType = DOCX_MIME_TYPE;
  readonly name = 'mammoth';
  readonly version = '1.12.0-skyos.1';

  async extractText(bytes: Uint8Array): Promise<string> {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return normalizeExtractedText(result.value);
  }
}

export class DocumentParserRegistry {
  readonly #parsers: readonly DocumentTextParser[];

  constructor(parsers: readonly DocumentTextParser[]) {
    this.#parsers = [...parsers];
  }

  getCurrent(mimeType: string): DocumentTextParser {
    const parser = this.#parsers.find((candidate) => candidate.mimeType === mimeType);
    if (!parser) {
      throw new UnsupportedDocumentParserError('This attachment type cannot be processed.');
    }
    return parser;
  }

  getVersion(mimeType: string, name: string, version: string): DocumentTextParser {
    const parser = this.#parsers.find(
      (candidate) =>
        candidate.mimeType === mimeType && candidate.name === name && candidate.version === version,
    );
    if (!parser) {
      throw new UnsupportedDocumentParserError(
        'The parser version recorded by this job is no longer available.',
      );
    }
    return parser;
  }
}

export function createDefaultDocumentParserRegistry(): DocumentParserRegistry {
  return new DocumentParserRegistry([new PdfDocumentTextParser(), new DocxDocumentTextParser()]);
}
