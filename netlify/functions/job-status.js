// netlify/functions/job-status.js
// Fast synchronous function. Returns the current state of a job from Upstash.
// Called by the browser on a 2s interval until status is 'complete' or 'error'.

const { upstashConfigured, jobGet } = require('./_shared.js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  if (!upstashConfigured()) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        error: 'Upstash env vars not set. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Site settings → Environment variables, then redeploy.'
      })
    };
  }

  const jobId = event.queryStringParameters?.id;
  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'id query param required' }) };
  }

  try {
    const job = await jobGet(jobId);
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
