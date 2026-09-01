const express = require('express');
const { extractDocument } = require('../lib/docExtract');
const audit = require('../lib/audit');

const router = express.Router();

// Extracts text from an uploaded product-info document (txt/md/pdf/docx) so
// the client can fold it into the "extra instructions" context before
// generating. Mirrors the {content, filename} shape server/routes/import.js
// already uses — content is base64 here since PDF/DOCX are binary.
router.post('/product-info', async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const filename = String(req.body?.filename ?? '').slice(0, 260);

  if (!content) {
    return res.status(400).json({ error: 'No file content was received.' });
  }

  try {
    const { text, warnings } = await extractDocument({ content, filename });
    audit.record('product-info-upload', { detail: `${filename || 'a file'}, ${text.length} chars extracted` });
    res.json({ text, warnings, filename });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
