// Runs before first paint, so a chosen theme never flashes the other one.
//
// Deliberately its own file rather than an inline <script>: the page's CSP is
// script-src 'self' with no 'unsafe-inline', and adding a hash that has to be
// recomputed by hand on every edit is a worse trade than one extra request for
// six lines. main.js cannot do this job because it is a module, and modules
// defer until after the document has been painted.
try {
  var stored = localStorage.getItem('receipt-recon-theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
} catch (err) {
  // Storage blocked by policy. The system preference still applies.
}
