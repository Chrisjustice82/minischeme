// netlify/functions/job-status.js
// Fast synchronous function. Returns the current state of a job from Blobs.
// Called by the browser on a 2s interval until status is 'complete' or 'error'.

// Defensive require so the whole function doesn't crash if @netlify/blobs
// failed to install. Returns a clean JSON error instead of 500-with-no-body.
let getStore;
let blobsLoadError = null;
try {
  ({ getStore } = require('@netlify/blobs'));
} catch (err) {
  blobsLoadError = err.message || String(err);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  if (blobsLoadError) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        error: '@netlify/blobs module failed to load: ' + blobsLoadError + '. Check that package.json is at the repo root and that Netlify ran npm install (connect a Git repo rather than drag-and-drop deploying).'
      })
    };
  }

  const jobId = event.queryStringParameters?.id;
  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'id query param required' }) };
  }

  try {
    const store = getStore({ name: 'minischeme-jobs', consistency: 'strong' });
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ status: 'pending', message: 'Waiting for job to start…' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(job)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', error: err.message || String(err) })
    };
  }
};
