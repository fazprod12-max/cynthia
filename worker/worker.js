/**
 * CYNTH.IA — Worker Proxy Multi-Provider v3.0 (Gratuit / Zéro coût)
 *
 * Route principale POST / — cascade multi-provider :
 *   1. Groq  (8b phases 1-3, 70b synthèse uniquement)
 *   2. Hugging Face  (Mistral-7B-Instruct via endpoint OpenAI-compatible)
 *   3. OpenRouter  (Gemma-2-9B-IT gratuit)
 *   4. Fallback local (réponses contextuelles codées)
 *
 * Autres routes :
 *   POST /ft-search        → proxy France Travail
 *   POST /create-checkout  → crée une session Stripe Checkout
 *   GET  /verify-session   → vérifie un paiement Stripe
 *
 * Secrets à configurer (wrangler secret put <NOM>) :
 *   GROQ_API_KEY        — clé API Groq (obligatoire)
 *   HF_API_KEY          — clé API Hugging Face (gratuit sur hf.co/settings/tokens)
 *   OPENROUTER_API_KEY  — clé API OpenRouter (gratuit sur openrouter.ai/keys)
 *   FT_CLIENT_ID        — Client ID France Travail
 *   FT_CLIENT_SECRET    — Client Secret France Travail
 *   STRIPE_SECRET_KEY   — sk_live_xxx
 *   STRIPE_PRICE_ID     — price_xxx
 */

/* ── Origines autorisées ─────────────────────────────────────────────────── */
const ALLOWED_ORIGINS = [
  'https://fazprod12-max.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

/* ── URLs des API partenaires ────────────────────────────────────────────── */
const GROQ_URL         = 'https://api.groq.com/openai/v1/chat/completions';
const FT_TOKEN_URL     = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const FT_SEARCH_URL    = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search';
const STRIPE_CHECKOUT  = 'https://api.stripe.com/v1/checkout/sessions';

// Hugging Face — endpoint OpenAI-compatible (plus fiable que l'ancien endpoint text-generation)
const HF_URL = 'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.3/v1/chat/completions';
const HF_MODEL = 'mistralai/Mistral-7B-Instruct-v0.3';

// OpenRouter — Gemma-2-9B-IT (gratuit, aucun crédit requis)
const OR_URL   = 'https://openrouter.ai/api/v1/chat/completions';
const OR_MODEL = 'google/gemma-2-9b-it:free';

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

    /* ── CORS headers ──────────────────────────────────────────────────── */
    const corsHeaders = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
      corsHeaders['Access-Control-Allow-Origin'] = origin;
    }

    /* ── Preflight ─────────────────────────────────────────────────────── */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    /* ── Blocage des origines inconnues ────────────────────────────────── */
    if (!corsHeaders['Access-Control-Allow-Origin']) {
      return jsonResp({ error: { message: 'Origin not allowed' } }, 403, corsHeaders);
    }

    /* ── Routage ───────────────────────────────────────────────────────── */
    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
      if (path === '' || path === '/') {
        return await handleMultiProvider(request, env, corsHeaders);
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
   ROUTE 1 — PROXY MULTI-PROVIDER (remplace l'ancien proxy Groq simple)
═══════════════════════════════════════════════════════════════════════════ */
async function handleMultiProvider(request, env, corsHeaders) {
  if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405, corsHeaders);

  let payload;
  try { payload = await request.json(); }
  catch { return jsonResp({ error: 'Invalid JSON' }, 400, corsHeaders); }

  // Extraire le flag isSynthesis (ajouté par le front-end) et le retirer du payload
  const isSynthesis = payload.isSynthesis === true;
  delete payload.isSynthesis;

  const messages = payload.messages;
  if (!messages || !Array.isArray(messages)) {
    return jsonResp({ error: 'messages array required' }, 400, corsHeaders);
  }

  const errors = [];

  // ─── 1. GROQ ───────────────────────────────────────────────────────────
  if (env.GROQ_API_KEY) {
    try {
      // Sélection du modèle selon le type de requête
      // Synthèse : llama-3.3-70b (1 seul appel 70b par session)
      // Phases 1-3 : llama-3.1-8b (quota TPD plus élevé → ~33 utilisateurs/jour)
      const model = isSynthesis ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';

      const groqBody = {
        ...payload,           // reprend max_tokens, temperature, top_p du front
        model,               // override le modèle
        messages,
      };
      delete groqBody.model; // sera réinjecté après
      groqBody.model = model;

      const resp = await fetchWithTimeout(GROQ_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...payload, model, messages }),
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

      // Groq répond mais avec un statut d'erreur
      const errText = await resp.text();
      errors.push(`Groq ${resp.status}: ${errText.substring(0, 200)}`);
      console.warn('Groq failed:', resp.status, errText.substring(0, 200));
    } catch (e) {
      errors.push('Groq timeout/error: ' + e.message);
      console.warn('Groq exception:', e.message);
    }
  } else {
    errors.push('Groq: GROQ_API_KEY not set');
  }

  // ─── 2. HUGGING FACE ───────────────────────────────────────────────────
  if (env.HF_API_KEY) {
    try {
      const resp = await fetchWithTimeout(HF_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.HF_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: HF_MODEL,
          messages,
          max_tokens: payload.max_tokens || 420,
          temperature: payload.temperature || 0.7,
        }),
      }, 30000);

      if (resp.ok) {
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const enhanced = enhanceReply(content, messages);
          return jsonResp({
            choices: [{ message: { content: enhanced, role: 'assistant' } }],
            provider: 'huggingface',
            model: HF_MODEL,
          }, 200, corsHeaders);
        }
      }

      const errText = await resp.text();
      errors.push(`HuggingFace ${resp.status}: ${errText.substring(0, 200)}`);
      console.warn('HuggingFace failed:', resp.status);
    } catch (e) {
      errors.push('HuggingFace timeout/error: ' + e.message);
      console.warn('HuggingFace exception:', e.message);
    }
  } else {
    errors.push('HuggingFace: HF_API_KEY not set');
  }

  // ─── 3. OPENROUTER ─────────────────────────────────────────────────────
  if (env.OPENROUTER_API_KEY) {
    try {
      const resp = await fetchWithTimeout(OR_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://fazprod12-max.github.io/cynthia/',
          'X-Title': 'CYNTH.IA',
        },
        body: JSON.stringify({
          model: OR_MODEL,
          messages,
          max_tokens: payload.max_tokens || 420,
          temperature: payload.temperature || 0.7,
        }),
      }, 30000);

      if (resp.ok) {
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const enhanced = enhanceReply(content, messages);
          return jsonResp({
            choices: [{ message: { content: enhanced, role: 'assistant' } }],
            provider: 'openrouter',
            model: OR_MODEL,
          }, 200, corsHeaders);
        }
      }

      const errText = await resp.text();
      errors.push(`OpenRouter ${resp.status}: ${errText.substring(0, 200)}`);
      console.warn('OpenRouter failed:', resp.status);
    } catch (e) {
      errors.push('OpenRouter timeout/error: ' + e.message);
      console.warn('OpenRouter exception:', e.message);
    }
  } else {
    errors.push('OpenRouter: OPENROUTER_API_KEY not set');
  }

  // ─── 4. FALLBACK LOCAL ─────────────────────────────────────────────────
  console.warn('All providers failed. Errors:', errors);
  const fallbackContent = getFallbackReply(messages);
  return jsonResp({
    choices: [{ message: { content: fallbackContent, role: 'assistant' } }],
    provider: 'fallback',
    _errors: errors,
    _note: 'Tous les providers ont échoué — réponse locale',
  }, 200, corsHeaders);
}

/* ─── Compensations pour modèles secondaires (HF, OpenRouter) ───────────── */
/**
 * Si la réponse du modèle secondaire est trop courte ou manque d'empathie/question,
 * on la complète légèrement pour maintenir la qualité de l'expérience.
 */
function enhanceReply(reply, messages) {
  if (!reply) return '';
  let enhanced = reply.trim();

  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
  const emotion = detectEmotion(lastUserMsg);

  // Si émotion forte détectée et l'IA n'a pas exprimé d'empathie
  if (emotion !== 'neutre') {
    const hasEmpathy = /comprend|entend|ressent|normal|humain|difficile|courage/i.test(enhanced);
    if (!hasEmpathy) {
      enhanced = 'Je comprends ce que vous ressentez. ' + enhanced;
    }
  }

  // Si aucune question posée, en ajouter une ouverte contextuelle
  if (!enhanced.includes('?')) {
    if (emotion === 'peur') {
      enhanced += ' Qu\'est-ce qui vous semblerait rassurant pour commencer ?';
    } else if (emotion === 'doute') {
      enhanced += ' Qu\'est-ce qui vous paraît le plus incertain, pour vous, en ce moment ?';
    } else {
      enhanced += " Qu'en pensez-vous ?";
    }
  }

  return enhanced;
}

function detectEmotion(text) {
  const t = text.toLowerCase();
  const patterns = {
    peur:      ['peur', 'angoisse', 'inquiet', 'stressé', 'panique', 'crainte', 'bloqué'],
    tristesse: ['triste', 'déçu', 'découragé', 'abattu', 'mélancolique', 'burnout'],
    colere:    ['colère', 'énervé', 'frustré', 'injuste', 'révolté', 'marre'],
    doute:     ['doute', 'hésite', 'incertain', 'pas sûr', 'peut-être', 'je ne sais pas'],
  };
  for (const [emotion, words] of Object.entries(patterns)) {
    if (words.some(w => t.includes(w))) return emotion;
  }
  return 'neutre';
}

/* ─── Fallback local amélioré ────────────────────────────────────────────── */
/**
 * Génère une réponse contextuelle à partir des 3 derniers messages utilisateur.
 * Beaucoup plus pertinent que les anciennes réponses génériques fixes.
 */
function getFallbackReply(messages) {
  const userMsgs = messages.filter(m => m.role === 'user');
  const recentContext = userMsgs.slice(-3).map(m => m.content).join(' ').toLowerCase();
  const count = userMsgs.length;

  // Détection de thèmes prioritaires dans les derniers messages
  // Ordre : état émotionnel → famille → valeurs → financier → aspiration
  if (recentContext.includes('burnout') || recentContext.includes('épuisé') || recentContext.includes('plus l\'énergie')) {
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
  if (recentContext.includes('passion') || recentContext.includes('envie') || recentContext.includes('rêve') || recentContext.includes('j\'aimerais')) {
    return "Ce que vous décrivez là, c'est une piste précieuse. Qu'est-ce qui vous a jusqu'à présent retenu de l'explorer davantage ?";
  }

  // Réponses adaptées selon la phase de la conversation
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

function jsonResp(data, status, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
