// netlify/functions/scheme-background.js
// Background function (15 min budget). Generates 3 schemes with Claude, then
// renders all 3 images in parallel. Writes status updates to Upstash Redis
// so the frontend can poll for progress.

const {
  anthropicStream,
  renderWithEngine,
  upstashConfigured,
  jobSet,
  jobGet,
  jobUpdate
} = require('./_shared.js');

const SYSTEM = `You are a Warhammer/tabletop miniature painting expert generating paint scheme recommendations.

You will receive a photo of an unpainted (usually grey plastic or primed) miniature and a short natural-language brief from the hobbyist. Your job is to return THREE DISTINCT colour schemes that would suit the model.

CRITICAL OUTPUT RULES:
- Respond with ONLY valid JSON, no prose, no markdown fences, no preamble.
- JSON shape:
{
  "model_description": "1 sentence describing what you see",
  "schemes": [
    {
      "name": "Short evocative name (2-4 words)",
      "concept": "1-2 sentence mood/theme",
      "palette": [
        {"part": "cloak", "hex": "#8B1A1A", "note": "deep crimson"}
      ],
      "recipe": [
        {
          "part": "Armour plates",
          "base": "Retributor Armour",
          "shade": "Reikland Fleshshade",
          "layer": "Liberator Gold (optional)",
          "edge_highlight": "Stormhost Silver"
        }
      ],
      "edit_prompt": "Tight prompt for an image-to-image model describing exactly how to repaint this specific miniature. Mention the model's visible parts by position, specify colours in plain English plus hex. Emphasise: keep pose, sculpt detail, and base unchanged; apply painted appearance with visible shading in recesses and crisp edge highlights; matte finish like tabletop miniature painting. 80-150 words."
    }
  ]
}

SCHEME DIVERSITY: the 3 schemes should feel genuinely different - e.g. a classic/expected scheme, a cool-toned alternative, and a bolder/unusual one.

PAINT NAMES: use real Citadel (GW) paint names. If the hobbyist mentions Vallejo, use Vallejo Model Color / Game Color names instead.

Palette should cover 4-7 main visible parts. Recipe should have one entry per major part. Always return exactly 3 schemes.`;

async function renderSchemeWithResult(jobId, idx, scheme, engine, imageBase64, imageMediaType) {
  try {
    const out = await renderWithEngine(engine, {
      imageBase64,
      imageMediaType,
      prompt: scheme.edit_prompt
    });

    // Read current job, patch this scheme, write back.
    const current = await jobGet(jobId);
    if (!current) return;
    const schemes = current.schemes.slice();
    schemes[idx] = { ...schemes[idx], image: `data:${out.mediaType};base64,${out.base64}`, imageLoading: false };
    await jobSet(jobId, { ...current, schemes, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`[scheme-background] render ${idx} failed:`, err.message);
    const current = await jobGet(jobId);
    if (!current) return;
    const schemes = current.schemes.slice();
    schemes[idx] = { ...schemes[idx], imageError: err.message || String(err), imageLoading: false };
    await jobSet(jobId, { ...current, schemes, updatedAt: new Date().toISOString() });
  }
}

exports.handler = async (event) => {
  console.log('[scheme-background] invoked');

  if (!upstashConfigured()) {
    console.error('[scheme-background] Upstash env vars not set');
    return { statusCode: 500 };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('[scheme-background] bad JSON body', e);
    return { statusCode: 400 };
  }

  const { jobId, imageBase64, imageMediaType, brief, engine } = body;
  if (!jobId || !imageBase64 || !imageMediaType) {
    console.error('[scheme-background] missing fields');
    return { statusCode: 400 };
  }

  console.log('[scheme-background] jobId', jobId, 'engine', engine, 'imgLen', imageBase64.length);

  try {
    await jobSet(jobId, {
      status: 'generating_schemes',
      message: 'Analysing your miniature and generating 3 schemes…',
      schemes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    console.log('[scheme-background] initial status written to Upstash');
  } catch (err) {
    console.error('[scheme-background] could not write to Upstash:', err.message);
    return { statusCode: 500 };
  }

  try {
    const userBrief = (brief || '').trim() || 'No specific brief - suggest three strong, interesting schemes suited to this model.';

    console.log('[scheme-background] calling Anthropic…');
    const schemeText = await anthropicStream({
      model: 'claude-sonnet-4-6',
      max_tokens: 3500,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
          { type: 'text', text: `Brief from hobbyist:\n${userBrief}\n\nReturn JSON only.` }
        ]
      }]
    });

    console.log('[scheme-background] Anthropic returned', schemeText.length, 'chars');
    const cleaned = schemeText.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('[scheme-background] Claude returned non-JSON', cleaned.slice(0, 300));
      await jobUpdate(jobId, { status: 'error', error: 'Claude returned non-JSON: ' + cleaned.slice(0, 500) });
      return { statusCode: 200 };
    }

    if (!parsed.schemes || !Array.isArray(parsed.schemes) || parsed.schemes.length === 0) {
      await jobUpdate(jobId, { status: 'error', error: 'No schemes in Claude response' });
      return { statusCode: 200 };
    }

    console.log('[scheme-background] got', parsed.schemes.length, 'schemes, starting image renders');

    const initialSchemes = parsed.schemes.map(s => ({ ...s, image: null, imageLoading: true, imageError: null }));
    const chosenEngine = (engine || process.env.IMAGE_ENGINE || 'gemini').toLowerCase();

    await jobUpdate(jobId, {
      status: 'rendering_images',
      message: `Painting ${initialSchemes.length} previews with ${chosenEngine}…`,
      model_description: parsed.model_description || '',
      schemes: initialSchemes
    });

    await Promise.all(initialSchemes.map((scheme, idx) =>
      renderSchemeWithResult(jobId, idx, scheme, chosenEngine, imageBase64, imageMediaType)
    ));

    console.log('[scheme-background] all renders complete');

    const final = await jobGet(jobId);
    const allFailed = final.schemes.every(s => s.imageError);
    await jobUpdate(jobId, {
      status: allFailed ? 'error' : 'complete',
      message: allFailed ? 'All image renders failed' : 'Done',
      error: allFailed ? final.schemes.map(s => s.imageError).filter(Boolean).join(' | ') : null
    });

    console.log('[scheme-background] job', jobId, 'marked', allFailed ? 'error' : 'complete');
    return { statusCode: 200 };
  } catch (err) {
    console.error('[scheme-background] handler error', err);
    try {
      await jobUpdate(jobId, { status: 'error', error: err.message || String(err) });
    } catch (e2) {
      console.error('[scheme-background] could not even write error', e2);
    }
    return { statusCode: 200 };
  }
};
