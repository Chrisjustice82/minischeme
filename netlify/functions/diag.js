// netlify/functions/diag.js
// Diagnostic endpoint. GET /.netlify/functions/diag to see what's working.
// Reports which env vars are set and whether Upstash Redis is reachable.

const { upstashConfigured, upstashPing } = require('./_shared.js');

exports.handler = async () => {
  const envChecks = {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    REPLICATE_API_TOKEN: !!process.env.REPLICATE_API_TOKEN,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    IMAGE_ENGINE: process.env.IMAGE_ENGINE || '(not set, defaults to gemini)'
  };

  let upstashReachable = false;
  let upstashError = null;
  if (upstashConfigured()) {
    try {
      const pong = await upstashPing();
      upstashReachable = pong === 'PONG';
      if (!upstashReachable) upstashError = 'Ping did not return PONG, got: ' + JSON.stringify(pong);
    } catch (err) {
      upstashError = err.message || String(err);
    }
  }

  const hasAnyImageEngine = envChecks.GEMINI_API_KEY || envChecks.REPLICATE_API_TOKEN || envChecks.OPENAI_API_KEY;

  let hint;
  if (!envChecks.UPSTASH_REDIS_REST_URL || !envChecks.UPSTASH_REDIS_REST_TOKEN) {
    hint = 'Upstash env vars not set. Create a free Redis DB at upstash.com, then copy UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from the database dashboard into your Netlify environment variables, then redeploy.';
  } else if (!upstashReachable) {
    hint = 'Upstash env vars set but not reachable: ' + upstashError;
  } else if (!envChecks.ANTHROPIC_API_KEY) {
    hint = 'ANTHROPIC_API_KEY is not set. Add it in Site settings → Environment variables, then redeploy.';
  } else if (!hasAnyImageEngine) {
    hint = 'No image engine API keys set. Add at least one of GEMINI_API_KEY, REPLICATE_API_TOKEN, or OPENAI_API_KEY.';
  } else {
    hint = 'Everything looks good. Try generating schemes.';
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: upstashReachable && envChecks.ANTHROPIC_API_KEY && hasAnyImageEngine,
      nodeVersion: process.version,
      upstash: {
        configured: upstashConfigured(),
        reachable: upstashReachable,
        error: upstashError
      },
      env: envChecks,
      hint
    }, null, 2)
  };
};
