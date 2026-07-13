/**
 * CYNTH.IA — Worker Proxy v5.1 (Groq principal + DeepSeek fallback)
 *
 * Route principale POST / — cascade :
 *   1. Groq      (llama-3.3-70b synthèse / llama-3.1-8b collecte — provider principal)
 *   2. DeepSeek  (deepseek-chat / DeepSeek-V3 — fallback)
 *   3. Fallback local (réponses contextuelles codées — le service ne tombe jamais)
 *
 * Autres routes (inchangées) :
 *   POST /ft-search        → proxy France Travail
 *   POST /create-checkout  → crée une session Stripe Checkout
 *   GET  /verify-session   → vérifie un paiement Stripe
 *
 * Secrets à configurer (wrangler secret put <NOM>) :
 *   GROQ_API_KEY        — clé API Groq (provider principal — console.groq.com)
 *   DEEPSEEK_API_KEY    — clé API DeepSeek (fallback — platform.deepseek.com)
 *   FT_CLIENT_ID        — Client ID France Travail (optionnel)
 *   FT_CLIENT_SECRET    — Client Secret France Travail (optionnel)
 *   STRIPE_SECRET_KEY   — sk_live_xxx (optionnel, mode production)
 *   STRIPE_PRICE_ID     — price_xxx (optionnel, mode production)
 */

/* ── Origines autorisées ─────────────────────────────────────────────────── */
const ALLOWED_ORIGINS = [
  'https://fazprod12-max.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

/* ── URLs des API partenaires ────────────────────────────────────────────── */
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const DEEPSEEK_URL   = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat'; // équivalent DeepSeek-V3

const FT_TOKEN_URL    = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const FT_SEARCH_URL   = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search';
const STRIPE_CHECKOUT = 'https://api.stripe.com/v1/checkout/sessions';

/* ── Cache token France Travail ──────────────────────────────────────────── */
let _ftToken = null;
let _ftTokenExpiry = 0;

/* ═══════════════════════════════════════════════════════════════════════════
   HANDLER PRINCIPAL
═══════════════════════════════════════════════════════════════════════════ */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (!corsHeaders['Access-Control-Allow-Origin']) {
      return jsonResp({ error: { message: 'Origin not allowed' } }, 403, corsHeaders);
    }

    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
      if (path === '' || path === '/') {
        return await handleChat(request, env, corsHeaders);
      }
      if (path === '/ft-search') {
        return await handleFranceTravail(request, env, corsHeaders);
      }
      if (path === '/create-checkout') {
        return await handleStripeCreate(request, env, corsHeaders);
      }
      if (path === '/verify-session') {
        return await handleStripeVerify(request, env, url, corsHeaders);
      }
      return jsonResp({ error: { message: 'Not found' } }, 404, corsHeaders);
    } catch (err) {
      console.error('Worker unhandled error:', err);
      return jsonResp({ error: { message: 'Internal server error', detail: err.message } }, 500, corsHeaders);
    }
  }
};

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTE 1 — CHAT : GROQ PRINCIPAL → DEEPSEEK FALLBACK → LOCAL
═══════════════════════════════════════════════════════════════════════════ */
async function handleChat(request, env, corsHeaders) {
  if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405, corsHeaders);

  let payload;
  try { payload = await request.json(); }
  catch { return jsonResp({ error: 'Invalid JSON' }, 400, corsHeaders); }

  // Flags internes front → worker (retirés avant l'envoi aux APIs)
  const isSynthesis = payload.isSynthesis === true;
  delete payload.isSynthesis;
  delete payload.model; // le Worker choisit toujours le modèle

  const messages = payload.messages;
  if (!messages || !Array.isArray(messages)) {
    return jsonResp({ error: 'messages array required' }, 400, corsHeaders);
  }

  // Paramètres recommandés (cahier des charges) — le front peut les surcharger
  const max_tokens  = clampInt(payload.max_tokens, 50, 4000) ?? (isSynthesis ? 650 : 450);
  const temperature = clampNum(payload.temperature, 0, 2)    ?? (isSynthesis ? 0.55 : 0.72);
  const top_p       = clampNum(payload.top_p, 0, 1)          ?? 0.92;

  const errors = [];

  // ─── 1. GROQ (provider principal) ─────────────────────────────────────
  if (env.GROQ_API_KEY) {
    try {
      // 70b réservé à la synthèse (quota RPM), 8b ultra-rapide pour la collecte
      const model = isSynthesis ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';

      const resp = await fetchWithTimeout(GROQ_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, max_tokens, temperature, top_p }),
      }, 30000);

      if (resp.ok) {
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          return jsonResp({
            choices: [{ message: { content, role: 'assistant' } }],
            provider: 'groq',
            model,
          }, 200, corsHeaders);
        }
      }

      const errText = await resp.text();
      errors.push(`Groq ${resp.status}: ${errText.substring(0, 200)}`);
      console.warn('Groq failed:', resp.status);
    } catch (e) {
      errors.push('Groq timeout/error: ' + e.message);
      console.warn('Groq exception:', e.message);
    }
  } else {
    errors.push('Groq: GROQ_API_KEY not set');
  }

  // ─── 2. DEEPSEEK (fallback) ───────────────────────────────────────────
  if (env.DEEPSEEK_API_KEY) {
    try {
      const resp = await fetchWithTimeout(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages,
          max_tokens,
          temperature,
          top_p,
        }),
      }, 45000);

      if (resp.ok) {
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          return jsonResp({
            choices: [{ message: { content, role: 'assistant' } }],
            provider: 'deepseek',
            model: DEEPSEEK_MODEL,
          }, 200, corsHeaders);
        }
      }

      const errText = await resp.text();
      errors.push(`DeepSeek ${resp.status}: ${errText.substring(0, 200)}`);
      console.warn('DeepSeek failed:', resp.status, errText.substring(0, 200));
    } catch (e) {
      errors.push('DeepSeek timeout/error: ' + e.message);
      console.warn('DeepSeek exception:', e.message);
    }
  } else {
    errors.push('DeepSeek: DEEPSEEK_API_KEY not set');
  }

  // ─── 3. FALLBACK LOCAL ─────────────────────────────────────────────────
  console.warn('All providers failed. Errors:', errors);
  const fallbackContent = getFallbackReply(messages);
  return jsonResp({
    choices: [{ message: { content: fallbackContent, role: 'assistant' } }],
    provider: 'fallback',
    _errors: errors,
    _note: 'Tous les providers ont échoué — réponse locale',
  }, 200, corsHeaders);
}

/* ─── Fallback local contextuel ──────────────────────────────────────────── */
/**
 * Génère une réponse contextuelle à partir des 3 derniers messages utilisateur.
 * Ordre de priorité : état émotionnel → famille → valeurs → financier → aspiration.
 */
function getFallbackReply(messages) {
  const userMsgs = messages.filter(m => m.role === 'user');
  const recentContext = userMsgs.slice(-3).map(m => m.content).join(' ').toLowerCase();
  const count = userMsgs.length;

  if (recentContext.includes('burnout') || recentContext.includes('épuisé') || recentContext.includes("plus l'énergie")) {
    return "Ce que vous décrivez ressemble à un signal fort que quelque chose doit changer. Avant d'envisager la suite, qu'est-ce qui vous donnerait l'envie de vous lever le matin avec enthousiasme ?";
  }
  if (recentContext.includes('peur') || recentContext.includes('angoisse') || recentContext.includes('bloqué')) {
    return "Je comprends que cela puisse faire peur. C'est une réaction très humaine face à un changement. Pouvez-vous me dire ce qui vous semble le plus difficile à surmonter en ce moment ?";
  }
  if (recentContext.includes('famille') || recentContext.includes('enfant') || recentContext.includes('conjoint')) {
    return "Je comprends que votre famille soit au cœur de vos préoccupations. Comment vos proches vous voient-ils dans cette réflexion ? Sont-ils présents dans cette démarche ?";
  }
  if (recentContext.includes('sens') || recentContext.includes('alignement') || recentContext.includes('utile') || recentContext.includes('impact')) {
    return "Je perçois que le sens occupe une place centrale pour vous. Quand vous pensez à un moment de votre vie où vous vous êtes senti vraiment utile, qu'est-ce que vous faisiez ?";
  }
  if (recentContext.includes('financier') || recentContext.includes('argent') || recentContext.includes('salaire') || recentContext.includes('crédit')) {
    return "La question financière est réelle et légitime. Pour avancer sereinement, quel serait, selon vous, le minimum dont vous auriez besoin pour vous sentir en sécurité le temps d'une transition ?";
  }
  if (recentContext.includes('passion') || recentContext.includes('envie') || recentContext.includes('rêve') || recentContext.includes("j'aimerais")) {
    return "Ce que vous décrivez là, c'est une piste précieuse. Qu'est-ce qui vous a jusqu'à présent retenu de l'explorer davantage ?";
  }

  if (count <= 2) {
    return "Je vous écoute pleinement. Pour mieux vous accompagner, pourriez-vous me décrire ce qui vous a amené à vous questionner sur votre parcours professionnel aujourd'hui ?";
  } else if (count <= 5) {
    return "Merci de partager cela avec moi. Parmi tout ce que vous venez de me dire, qu'est-ce qui vous tient le plus à cœur ?";
  } else if (count <= 10) {
    return "Je vois se dessiner ce qui compte vraiment pour vous. Qu'est-ce qui, dans vos expériences passées, vous a procuré le plus de fierté personnelle ?";
  } else {
    return "Nous avons exploré beaucoup de choses ensemble. Si vous deviez retenir une seule certitude de notre échange jusqu'ici, quelle serait-elle ?";
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTE 2 — FRANCE TRAVAIL (offres d'emploi)
═══════════════════════════════════════════════════════════════════════════ */
async function handleFranceTravail(request, env, corsHeaders) {
  if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405, corsHeaders);
  if (!env.FT_CLIENT_ID || !env.FT_CLIENT_SECRET) {
    return jsonResp({ resultats: [], total: 0, _note: 'FT_CLIENT_ID/SECRET not configured' }, 200, corsHeaders);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResp({ error: 'Invalid JSON' }, 400, corsHeaders); }

  const motsCles = (body.motsCles || '').trim().substring(0, 100);
  const range = body.range || '0-4';

  const token = await getFtToken(env);
  if (!token) {
    return jsonResp({ resultats: [], total: 0, _note: 'FT auth failed' }, 200, corsHeaders);
  }

  const searchParams = new URLSearchParams({ motsCles, range, sort: 1 });

  const resp = await fetchWithTimeout(
    `${FT_SEARCH_URL}?${searchParams.toString()}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    },
    10000
  );

  if (resp.status === 204) return jsonResp({ resultats: [], total: 0 }, 200, corsHeaders);
  if (!resp.ok) {
    console.warn('France Travail API error:', resp.status);
    return jsonResp({ resultats: [], total: 0, _note: 'FT API error ' + resp.status }, 200, corsHeaders);
  }

  const data = await resp.json();
  return jsonResp(data, 200, corsHeaders);
}

async function getFtToken(env) {
  const now = Date.now();
  if (_ftToken && now < _ftTokenExpiry) return _ftToken;

  try {
    const resp = await fetchWithTimeout(FT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.FT_CLIENT_ID,
        client_secret: env.FT_CLIENT_SECRET,
        scope: 'api_offresdemploiv2 o2dsoffre',
      }).toString(),
    }, 8000);

    if (!resp.ok) { console.warn('FT token error:', resp.status); return null; }
    const data = await resp.json();
    _ftToken = data.access_token;
    _ftTokenExpiry = now + (data.expires_in - 60) * 1000;
    return _ftToken;
  } catch (e) {
    console.warn('FT token fetch error:', e.message);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTE 3 — STRIPE : CRÉER UNE SESSION CHECKOUT
═══════════════════════════════════════════════════════════════════════════ */
async function handleStripeCreate(request, env, corsHeaders) {
  if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405, corsHeaders);
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
    return jsonResp({ error: 'Stripe not configured' }, 500, corsHeaders);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResp({ error: 'Invalid JSON' }, 400, corsHeaders); }

  const successUrl = body.success_url;
  const cancelUrl  = body.cancel_url;
  if (!successUrl || !cancelUrl) {
    return jsonResp({ error: 'success_url and cancel_url are required' }, 400, corsHeaders);
  }

  const allowedDomains = ALLOWED_ORIGINS.map(o => o.replace('https://', '').replace('http://', ''));
  const successDomain = new URL(successUrl).hostname;
  if (!allowedDomains.some(d => successDomain === d || successDomain.endsWith('.' + d))) {
    return jsonResp({ error: 'Invalid success_url domain' }, 400, corsHeaders);
  }

  const params = new URLSearchParams({
    'mode': 'payment',
    'line_items[0][price]': env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    'success_url': successUrl,
    'cancel_url': cancelUrl,
    'payment_method_types[0]': 'card',
    'locale': 'fr',
  });

  const resp = await fetchWithTimeout(STRIPE_CHECKOUT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  }, 15000);

  const data = await resp.json();
  if (!resp.ok) {
    console.warn('Stripe create error:', data.error?.message);
    return jsonResp({ error: data.error?.message || 'Stripe error' }, resp.status, corsHeaders);
  }

  return jsonResp({ url: data.url, sessionId: data.id }, 200, corsHeaders);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTE 4 — STRIPE : VÉRIFIER UN PAIEMENT
═══════════════════════════════════════════════════════════════════════════ */
async function handleStripeVerify(request, env, url, corsHeaders) {
  if (request.method !== 'GET') return jsonResp({ error: 'Method not allowed' }, 405, corsHeaders);
  if (!env.STRIPE_SECRET_KEY) return jsonResp({ error: 'Stripe not configured' }, 500, corsHeaders);

  const sessionId = url.searchParams.get('id');
  if (!sessionId || !sessionId.startsWith('cs_')) {
    return jsonResp({ error: 'Invalid session ID' }, 400, corsHeaders);
  }

  const resp = await fetchWithTimeout(
    `${STRIPE_CHECKOUT}/${encodeURIComponent(sessionId)}`,
    { headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` } },
    10000
  );

  const data = await resp.json();
  if (!resp.ok) {
    return jsonResp({ error: data.error?.message || 'Stripe error' }, resp.status, corsHeaders);
  }

  const paid = data.payment_status === 'paid';
  return jsonResp({ paid, status: data.payment_status }, 200, corsHeaders);
}

/* ═══════════════════════════════════════════════════════════════════════════
   UTILITAIRES
═══════════════════════════════════════════════════════════════════════════ */
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function clampInt(v, min, max) {
  const n = parseInt(v);
  if (isNaN(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function clampNum(v, min, max) {
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function jsonResp(data, status, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
