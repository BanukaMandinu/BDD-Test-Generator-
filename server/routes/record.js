const express = require('express');
const recorder = require('../lib/recorder');
const audit = require('../lib/audit');

const router = express.Router();

// Starts a headed, user-driven recording session. Returns immediately (unlike
// /discover and /generate) because the session itself is open-ended — the
// human decides when it ends, not the server.
router.post('/record/start', async (req, res) => {
  const raw = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const useSession = req.body?.useSession === true;

  let url;
  try {
    url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol');
  } catch {
    return res.status(400).json({ error: 'Please give a full http(s) URL to record against.' });
  }

  try {
    const result = await recorder.start({ url: url.toString(), useSession });
    audit.record('record-start', { detail: `recording started at ${url.origin}` });
    res.json(result);
  } catch (err) {
    console.error('record start failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Polled by the client every ~1.5s while a session is open — cheap resource
// read, not a stream, since only a status count/list changes between polls.
router.get('/record/:id/status', (req, res) => {
  const result = recorder.status(req.params.id);
  if (!result) return res.status(404).json({ error: 'That recording session was lost — probably a server restart. Start again.' });
  res.json(result);
});

router.post('/record/:id/stop', async (req, res) => {
  const result = await recorder.stop(req.params.id);
  if (!result) return res.status(404).json({ error: 'That recording session was lost — probably a server restart. Start again.' });
  audit.record('record-stop', { detail: `${result.flows.length} flow(s) recorded` });
  res.json(result);
});

// Lets the UI show what was actually recorded in one saved flow, on demand —
// the status poll only ever sends counts, to keep that endpoint cheap.
router.get('/record/:id/flows/:flowId', (req, res) => {
  const flow = recorder.getFlow(req.params.id, req.params.flowId);
  if (!flow) return res.status(404).json({ error: 'That test was not found — it may have been discarded, or the session was lost.' });
  res.json(flow);
});

// Same idea, but for the flow still being recorded — lets a user who's lost
// track of what they've clicked so far check, without hitting "Save test" first.
router.get('/record/:id/current', (req, res) => {
  const flow = recorder.getCurrentFlow(req.params.id);
  if (!flow) return res.status(404).json({ error: 'That recording session was lost — probably a server restart. Start again.' });
  res.json(flow);
});

router.delete('/record/:id/flows/:flowId', (req, res) => {
  const result = recorder.discardFlow(req.params.id, req.params.flowId);
  if (!result) return res.status(404).json({ error: 'That recording session was lost — probably a server restart. Start again.' });
  res.json(result);
});

module.exports = router;
