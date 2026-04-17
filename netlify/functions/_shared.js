// netlify/functions/_shared.js
// Common helpers: HTTP with timeout, Anthropic streaming, image engine adapters.
// Used by scheme-background.js.

const https = require('https');

// ---------- HTTP ----------

function httpsJson({ method, hostname, path, headers, body, timeoutMs = 110_000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method, hostname, path, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) {}
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} from ${hostname}: ${text.slice(0, 500)}`));
        }
        resolve({ status: res.statusCode, text, json: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Request to ${hostname} timed out after ${timeoutMs}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

function httpsGetBinary(url, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGetBinary(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode >= 400) return reject(new Error(`GET ${url} -> ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
  });
}

// ---------- Anthropic (streaming) ----------

function anthropicStream(payload, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ ...payload, stream: true }));
    const req = https.request({
      method: 'POST',
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 400) {
        let errBuf = '';
        res.on('data', (c) => (errBuf += c));
        res.on('end', () => {
          let msg = errBuf;
          try { msg = JSON.parse(errBuf).error?.message || errBuf; } catch (_) {}
          reject(new Error(`Anthropic HTTP ${res.statusCode}: ${msg.slice(0, 400)}`));
        });
        return;
      }
      let buf = '';
      let textOut = '';
      let errored = null;
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          const json = dataLine.slice(6).trim();
          if (!json || json === '[DONE]') continue;
          try {
            const evt = JSON.parse(json);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              textOut += evt.delta.text;
            } else if (evt.type === 'error') {
              errored = evt.error?.message || JSON.stringify(evt);
            }
          } catch (_) {}
        }
      });
      res.on('end', () => errored ? reject(new Error('Anthropic stream error: ' + errored)) : resolve(textOut));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Anthropic timed out after ${timeoutMs}ms`)));
    req.write(body);
    req.end();
  });
}

// ---------- Image engines ----------

async function renderGemini({ imageBase64, imageMediaType, prompt }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: imageMediaType, data: imageBase64 } }
      ]
    }],
    generationConfig: { responseModalities: ['IMAGE'] }
  });
  const res = await httpsJson({
    method: 'POST',
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
    timeoutMs: 120_000
  });
  const parts = res.json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData || p.inline_data);
  const data = img?.inlineData?.data || img?.inline_data?.data;
  const mediaType = img?.inlineData?.mimeType || img?.inline_data?.mime_type || 'image/png';
  if (!data) throw new Error('Gemini returned no image: ' + JSON.stringify(res.json).slice(0, 400));
  return { base64: data, mediaType };
}

async function renderReplicate({ imageBase64, imageMediaType, prompt }) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN not set');
  const dataUri = `data:${imageMediaType};base64,${imageBase64}`;
  const createBody = JSON.stringify({
    input: { prompt, input_image: dataUri, output_format: 'png', safety_tolerance: 2 }
  });
  const create = await httpsJson({
    method: 'POST',
    hostname: 'api.replicate.com',
    path: '/v1/models/black-forest-labs/flux-kontext-pro/predictions',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(createBody),
      'Prefer': 'wait=60'
    },
    body: createBody,
    timeoutMs: 90_000
  });
  let prediction = create.json;
  const deadline = Date.now() + 180_000;
  while (prediction?.status && !['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
    if (Date.now() > deadline) throw new Error('Replicate timeout after 3 min');
    await new Promise(r => setTimeout(r, 2000));
    const poll = await httpsJson({
      method: 'GET',
      hostname: 'api.replicate.com',
      path: `/v1/predictions/${prediction.id}`,
      headers: { 'Authorization': 'Bearer ' + token },
      timeoutMs: 30_000
    });
    prediction = poll.json;
  }
  if (prediction.status !== 'succeeded') {
    throw new Error('Replicate failed: ' + (prediction.error || prediction.status));
  }
  const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!outputUrl) throw new Error('Replicate returned no output URL');
  const buf = await httpsGetBinary(outputUrl);
  return { base64: buf.toString('base64'), mediaType: 'image/png' };
}

async function renderOpenAI({ imageBase64, imageMediaType, prompt }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const boundary = '----MiniScheme' + Math.random().toString(36).slice(2);
  const parts = [];
  function addField(name, value) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  function addFile(name, filename, contentType, buffer) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
    parts.push(buffer);
    parts.push(Buffer.from('\r\n'));
  }
  addField('model', 'gpt-image-1');
  addField('prompt', prompt);
  addField('size', '1024x1536');
  addField('n', '1');
  const ext = imageMediaType.split('/')[1] || 'png';
  addFile('image', `mini.${ext}`, imageMediaType, Buffer.from(imageBase64, 'base64'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const res = await httpsJson({
    method: 'POST',
    hostname: 'api.openai.com',
    path: '/v1/images/edits',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length
    },
    body,
    timeoutMs: 180_000
  });
  const b64 = res.json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image: ' + JSON.stringify(res.json).slice(0, 400));
  return { base64: b64, mediaType: 'image/png' };
}

const ENGINES = { gemini: renderGemini, replicate: renderReplicate, openai: renderOpenAI };

async function renderWithEngine(engineName, { imageBase64, imageMediaType, prompt }) {
  const adapter = ENGINES[engineName];
  if (!adapter) throw new Error(`Unknown engine "${engineName}". Options: ${Object.keys(ENGINES).join(', ')}`);
  const fullPrompt = `Repaint this tabletop miniature to look like a finished painted model with water-based acrylics. IMPORTANT: Keep the exact pose, sculpt, silhouette, and base shape. Do not add or remove any parts. Apply painted appearance with smooth base colours, visible shading pooling in the recesses, and crisp edge highlights on raised details. Matte finish. Preserve fine details like filigree, feathers, chainmail, and text.\n\nColour scheme:\n${prompt}`;
  return adapter({ imageBase64, imageMediaType, prompt: fullPrompt });
}

// ---------- Upstash Redis (HTTP REST API) ----------
//
// We store job state as a JSON blob under a single key per job, with a TTL
// of 1 hour so Upstash stays tidy without needing manual cleanup.
//
// Env vars required:
//   UPSTASH_REDIS_REST_URL   e.g. https://apt-kid-12345.upstash.io
//   UPSTASH_REDIS_REST_TOKEN the REST API token from Upstash dashboard

const JOB_TTL_SECONDS = 60 * 60; // 1 hour

function upstashConfigured() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function upstashCommand(args, timeoutMs = 15_000) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Upstash env vars not set (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN)');

  // Upstash REST accepts a JSON array of command + args as the POST body
  const body = Buffer.from(JSON.stringify(args));
  const parsed = new URL(url);
  const res = await httpsJson({
    method: 'POST',
    hostname: parsed.hostname,
    path: parsed.pathname === '/' ? '/' : parsed.pathname,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Content-Length': body.length
    },
    body,
    timeoutMs
  });
  if (res.json && res.json.error) throw new Error('Upstash error: ' + res.json.error);
  return res.json?.result;
}

async function jobSet(jobId, value) {
  // SET <key> <value> EX <ttl>
  return upstashCommand(['SET', `job:${jobId}`, JSON.stringify(value), 'EX', String(JOB_TTL_SECONDS)]);
}

async function jobGet(jobId) {
  const raw = await upstashCommand(['GET', `job:${jobId}`]);
  if (raw === null || raw === undefined) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error('Stored job is not valid JSON: ' + String(raw).slice(0, 200));
  }
}

async function jobUpdate(jobId, patch) {
  const current = (await jobGet(jobId)) || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await jobSet(jobId, next);
  return next;
}

async function upstashPing() {
  return upstashCommand(['PING']);
}

module.exports = {
  anthropicStream,
  renderWithEngine,
  upstashConfigured,
  upstashPing,
  jobSet,
  jobGet,
  jobUpdate
};
