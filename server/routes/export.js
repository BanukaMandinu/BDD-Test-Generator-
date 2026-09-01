const express = require('express');
const { loadRun } = require('../lib/store');
const { toFeatureText, slugify } = require('../lib/gherkin');
const { buildWorkbook, buildTraceabilityWorkbook } = require('../lib/excel');

const router = express.Router();

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function getRunOr404(req, res) {
  const run = loadRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'run not found' });
    return null;
  }
  return run;
}

// Gherkin .feature file — drops straight into a Cucumber test repo.
router.get('/runs/:id/export', (req, res) => {
  const run = getRunOr404(req, res);
  if (!run) return;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(run.featureTitle)}.feature"`);
  res.send(toFeatureText(run));
});

// The lossless share format: everything a colleague needs to keep reviewing —
// requirements, coverage ticks, test types, outlines and Examples.
router.get('/runs/:id/export.json', (req, res) => {
  const run = loadRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });

  const share = {
    shareFormat: 'bdd-test-generator/run',
    shareVersion: 1,
    exportedAt: new Date().toISOString(),
    featureTitle: run.featureTitle,
    featureDescription: run.featureDescription,
    selectedTypes: run.selectedTypes || [],
    requirements: run.requirements,
    scenarios: run.scenarios.map((s) => ({
      title: s.title,
      testType: s.testType,
      included: s.included !== false,
      isOutline: Boolean(s.isOutline),
      examples: s.examples || null,
      coversRequirementIds: s.coversRequirementIds || [],
      steps: (s.steps || []).map((st) => ({
        keyword: st.keyword,
        text: st.text,
        included: st.included !== false,
        dataTable: st.dataTable || null,
      })),
    })),
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(run.featureTitle)}.testrun.json"`);
  res.send(JSON.stringify(share, null, 2));
});

// Full workbook: Summary + Test Cases (team column layout) + Traceability.
router.get('/runs/:id/export.xlsx', async (req, res, next) => {
  try {
    const run = getRunOr404(req, res);
    if (!run) return;

    const buffer = await buildWorkbook(run);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${slugify(run.featureTitle)}-test-cases.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

// Traceability matrix alone — the artifact an auditor usually asks for.
router.get('/runs/:id/traceability.xlsx', async (req, res, next) => {
  try {
    const run = getRunOr404(req, res);
    if (!run) return;

    const buffer = await buildTraceabilityWorkbook(run);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${slugify(run.featureTitle)}-traceability.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
