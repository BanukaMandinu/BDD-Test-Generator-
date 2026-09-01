// Extracts plain text from an uploaded product-info document, so it can be
// folded into the same extraContext blob as the "extra instructions" field.
// Mirrors the {content, filename} shape server/routes/import.js already uses
// for the "import a shared run" feature — content here is base64, since PDF
// and DOCX are binary formats.

const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');

const MAX_DECODED_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 6000;

function extensionOf(filename) {
  const match = String(filename ?? '').match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

// Strips control characters a PDF/DOCX extractor can leave behind (form feeds,
// null bytes) without touching normal whitespace.
function cleanText(text) {
  return String(text ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text) {
  if (text.length <= MAX_EXTRACTED_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_EXTRACTED_CHARS), truncated: true };
}

async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    // Default pageJoiner ('\n-- page_number of total_number --') would leak
    // into the AI context as if it were part of the document's own text.
    const result = await parser.getText({ pageJoiner: '\n' });
    return result.text;
  } finally {
    await parser.destroy?.();
  }
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  // mammoth reports non-fatal issues (an unsupported style, an odd embedded
  // object) as "messages" rather than throwing — surface anything that isn't
  // just informational.
  const warnings = (result.messages || [])
    .filter((m) => m.type !== 'info')
    .map((m) => m.message);
  return { text: result.value, warnings };
}

// Returns { text, warnings }. Never throws for a recognized-but-unreadable
// file (a scanned PDF with no text layer, a corrupt DOCX) — an empty
// extraction with a warning is more useful than a failed upload.
async function extractDocument({ content, filename }) {
  const b64 = String(content ?? '');
  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    throw new Error('That file could not be read.');
  }
  if (buffer.length > MAX_DECODED_BYTES) {
    throw new Error(`That file is too large (limit ${MAX_DECODED_BYTES / (1024 * 1024)} MB).`);
  }
  if (!buffer.length) {
    throw new Error('That file was empty.');
  }

  const ext = extensionOf(filename);
  const warnings = [];
  let rawText;

  try {
    if (ext === 'pdf') {
      rawText = await extractPdf(buffer);
    } else if (ext === 'docx') {
      const result = await extractDocx(buffer);
      rawText = result.text;
      warnings.push(...result.warnings);
    } else if (ext === 'txt' || ext === 'md') {
      rawText = buffer.toString('utf8');
    } else {
      throw new Error(`Unsupported file type ".${ext || '?'}" — use .txt, .md, .pdf, or .docx.`);
    }
  } catch (err) {
    if (err.message.startsWith('Unsupported file type')) throw err;
    throw new Error(`Could not read that ${ext.toUpperCase()} file: ${err.message}`);
  }

  const cleaned = cleanText(rawText);
  if (!cleaned) {
    warnings.push('No text could be extracted — the file may be a scanned image with no text layer, or empty.');
  }

  const { text, truncated } = truncate(cleaned);
  if (truncated) {
    warnings.push(`The extracted text was long and was cut to the first ${MAX_EXTRACTED_CHARS.toLocaleString()} characters.`);
  }

  return { text, warnings };
}

module.exports = { extractDocument, MAX_DECODED_BYTES };
