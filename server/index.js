require('dotenv').config();
const path = require('path');
const express = require('express');

const generateRoutes = require('./routes/generate');
const runsRoutes = require('./routes/runs');
const exportRoutes = require('./routes/export');
const importRoutes = require('./routes/import');
const productInfoRoutes = require('./routes/productInfo');
const recordRoutes = require('./routes/record');

const app = express();
const PORT = process.env.PORT || 4173;

// A base64-encoded 2MB upload (docExtract.js's own cap) runs to ~2.7MB of JSON
// body, which would crowd the 4mb ceiling every other route uses — this
// path-scoped parser (registered first, so it wins for matching requests)
// gives the product-info upload its own headroom without raising the shared
// limit for every route that doesn't need it.
app.use('/api/product-info', express.json({ limit: '3.5mb' }));

// Roomy enough for the 2 MB import cap plus JSON overhead; the import route
// enforces the real limit and rejects anything larger with a clear message.
app.use(express.json({ limit: '4mb' }));
app.use('/api', generateRoutes);
app.use('/api', runsRoutes);
app.use('/api', exportRoutes);
app.use('/api', importRoutes);
app.use('/api', productInfoRoutes);
app.use('/api', recordRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Centralized error handler — never leak stack traces to the client.
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Bound to loopback only, matching this app's documented design (no auth,
// meant for one operator on their own machine) — without an explicit host,
// Node listens on every network interface, so anyone else on the same LAN
// could otherwise reach every route directly, including /record/start (opens
// a real browser using this machine's saved sign-in) and /generate.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`BDD Test Generator running at http://localhost:${PORT}`);
});
