// URL normalization shared by both discovery paths (the agentic crawl in
// claudeCli.js and the deterministic one in crawler.js), so a page counts as
// "the same page" identically regardless of which one found it.

// Resolves a possibly-relative URL against a base and enforces same-origin —
// an off-site link slipping through would send someone else's site to the
// model (or the fast crawler's browser). Returns null when it doesn't qualify.
function resolveSameOrigin(rawUrl, baseUrl, origin) {
  let absolute;
  try {
    absolute = new URL(String(rawUrl ?? ''), baseUrl).toString();
  } catch {
    return null;
  }
  if (origin && !absolute.startsWith(origin)) return null;
  return absolute;
}

// A dedupe key for one page. "#/active" is a distinct route in a hash-routed
// SPA and must stay distinct; "#contact" is just an anchor within one page and
// should collapse into it. Trailing "/" and "/index.html" are equivalent.
//
// Order matters here: the hash must be stripped BEFORE the trailing-slash
// normalization, not after. "site.com/#contact" doesn't end in "/" as a raw
// string (the hash is in the way), so stripping in the other order leaves it
// as "site.com/" while the bare homepage normalizes to "site.com" — two keys
// for one page.
function dedupeKey(absoluteUrl) {
  const isHashRoute = /#\/./.test(absoluteUrl);
  const withoutHash = isHashRoute ? absoluteUrl : absoluteUrl.replace(/#.*$/, '');
  return withoutHash.replace(/\/(index\.html?)?$/i, '');
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Non-page assets a crawler shouldn't treat as an explorable "page" — a
// resume PDF, a downloadable image, a stylesheet linked directly. Checked
// against the path only (query strings/hashes don't change what a browser
// does when it navigates there).
const NON_PAGE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'zip', 'rar', '7z',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp',
  'mp4', 'mp3', 'wav', 'mov', 'avi', 'webm',
  'css', 'js', 'json', 'xml', 'txt', 'woff', 'woff2', 'ttf', 'eot',
]);

function looksLikePage(absoluteUrl) {
  try {
    const pathname = new URL(absoluteUrl).pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    return !match || !NON_PAGE_EXTENSIONS.has(match[1].toLowerCase());
  } catch {
    return false;
  }
}

module.exports = { resolveSameOrigin, dedupeKey, originOf, looksLikePage };
