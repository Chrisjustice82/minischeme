// netlify/functions/diag.js
// Diagnostic endpoint. GET /.netlify/functions/diag to see what's working.
// Useful when things fail silently - tells you if @netlify/blobs is installed,
// which API keys are set, and whether Blobs can actually be reached.

let blobsOk = false;
let blobsLoadError = null;
let getStore;
try {
  ({ getStore } = require('@netlify/blobs'));
  blobsOk = true;
} catch (err) {
  blobsLoadError = err.message || String(err);
}

exports.handler = async () => {
  const envChecks = {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    REPLICATE_API_TOKEN: !!process.env.REPLICATE_API_TOKEN,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    IMAGE_ENGINE: process.env.IMAGE_ENGINE || '(not set, defaults to gemini)'
  };

  let blobsReachable = false;
  let blobsReachError = null;
  if (blobsOk) {
    try {
      const store = getStore({ name: 'minischeme-jobs', consistency: 'strong' });
      // Try a read — doesn't matter if key exists, we just want to confirm the
      // store is wired up correctly and not throwing.
      await store.get('__diag_probe__', { type: 'json' });
      blobsReachable = true;
    } catch (err) {
      blobsReachError = err.message || String(err);
    }
  }

  const nodeVersion = process.version;
  const hasSharedModule = (() => {
    try { require('./_shared.js'); return true; } catch (e) { return 'ERROR: ' + e.message; }
  })();

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: blobsOk && blobsReachable && envChecks.ANTHROPIC_API_KEY,
      nodeVersion,
      blobs: {
        moduleLoaded: blobsOk,
        moduleLoadError: blobsLoadError,
        reachable: blobsReachable,
        reachError: blobsReachError
      },
      sharedModule: hasSharedModule,
      env: envChecks,
      hint: !blobsOk
        ? 'The @netlify/blobs package did not install. Deploy from a connected Git repo (not drag-and-drop) so that npm install runs. Verify package.json is at the repo root.'
        : !blobsReachable
          ? 'Blobs module loaded but store is unreachable. Check your Netlify account has Blobs enabled.'
          : !envChecks.ANTHROPIC_API_KEY
            ? 'ANTHROPIC_API_KEY is not set. Add it in Site settings → Environment variables, then redeploy.'
            : 'Everything looks good.'
    }, null, 2)
  };
};
