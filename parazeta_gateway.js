// parazeta_gateway.js v5 — Worker da Cloudflare do operador: Polymarket das Parazetas (11/11/2026) + a nuvem do N.E.R.E.U.S. (12/11/2026)
//                          + [v3 13/11/2026] os dados humanos do P.R.O.T.Á.G.O.R.A.S. (choices13k e as revisões do Anki)
//                          + [v4 13/11/2026] uma PESSOA inteira do Anki por pedido (o arquivo dela na base, ≤ 4 MB)
//                          + [v5 22/11/2026] o RADAR da Cloudflare para o A.L.E.X.A.N.D.R.I.A.: as 2 rotas que ele já chamava e não existiam
//                            aqui (/radar/http e /radar/trending → respondiam 404 "rota fora da lista fixa") e o "porquê com nome" da internet
//                            (interrupções com a CAUSA, anomalias de tráfego, vazamentos e sequestros de rota BGP).
// ═══════════════════════════════════════════════════════════════════════════
// Para que serve: a Polymarket (gamma-api) não manda o cabeçalho CORS, então o navegador do celular não pode lê-la.
// O Worker lê do lado do servidor (onde CORS não existe) e devolve com o cabeçalho.
// O que NÃO é: proxy aberto. Nenhuma URL vem do pedido: só as 2 rotas fixas abaixo, só GET, e só os parâmetros da lista branca.
//   · /polymarket/markets?active=…&closed=…&order=…&ascending=…&limit=≤50  — mercados ativos (preço = probabilidade da multidão)
//   · /polymarket/markets/<id numérico>                                     — um mercado (para ver se resolveu: o banquete)
//   · /binance/oi?symbol=BTCUSDT                                             — [v2] contratos em aberto agora (Binance Futuros)
//   · /binance/oihist|lsr|taker?symbol=BTCUSDT&period=5m&limit=≤500           — [v2] histórico de 5 min: contratos, razão de contas
//                                                                               compradas/vendidas, razão comprador/vendedor agressor
//   · /humano/c13k                                                           — [v3] choices13k (CSV do GitHub; cache de 1 dia na borda)
//   · /humano/anki/splits                                                    — [v3] configurações da base anki-revlogs-10k (Hugging Face)
//   · /humano/anki/rows?config=…&split=…&offset=…&length=≤100                 — [v3] 100 revisões a partir de offset (datasets-server)
//   · /humano/anki/pessoa?u=1…10000                                          — [v4] o parquet de UMA pessoa (revlogs/user_id=u/data.parquet),
//     todas as revisões desde o 1º dia; acima de 4 MB responde 413 (o jogo sorteia outra). Cache de 1 dia na borda.
//     A base do Anki exige aceitar os termos no Hugging Face: o token (só leitura) mora no SEGREDO HF_TOKEN deste Worker,
//     nunca na página. Sem o segredo, as rotas do Anki respondem 503 dizendo o que falta.
//   · /radar/http?loc=BR                                                     — [v5] tráfego HTTP por hora do país (14 dias): a sala "pulso no trânsito"
//   · /radar/trending                                                        — [v5] domínios em alta (top 20)
//   · /radar/interrupcoes?dias=1…7                                           — [v5] interrupções anotadas pela Cloudflare: países, redes (ASN),
//                                                                               início/fim e a CAUSA (cabo cortado, energia, governo, clima…)
//   · /radar/anomalias?dias=1…7                                              — [v5] quedas de tráfego detectadas automaticamente (país ou rede)
//   · /radar/bgp/vazamentos?dias=1…7  e  /radar/bgp/sequestros?dias=1…7       — [v5] rotas anunciadas errado (vazamento) ou tomadas (sequestro,
//                                                                               só confiança alta ≥ 8)
//     O Radar exige um token de API (gratuito; permissão "Account → Radar → Read"). Ele mora no SEGREDO CF_RADAR_TOKEN deste Worker,
//     nunca na página. Sem o segredo, as rotas /radar respondem 503 dizendo o que falta. Cache de 10 min na borda (1 h para /http).
//   · /  ou  /estado                                                         — saúde do Worker
// Mesmo estilo do cern-gateway. Dados públicos, sem chave, sem cookies.
//
// Como criar: Workers & Pages → Create → Create Worker → nome: parazeta-gateway → Deploy
//             → Edit code → apague tudo, cole este arquivo → Deploy.
// URL esperada pelo Pytronicos: https://parazeta-gateway.caio-marciahelena.workers.dev
// (outro nome? no console: localStorage.PZ_POLY_WORKER = 'https://SEU-NOME.caio-marciahelena.workers.dev')
// ═══════════════════════════════════════════════════════════════════════════
const ALVO = 'https://gamma-api.polymarket.com';
const BINANCE = 'https://fapi.binance.com';
const BN_ROTAS = {   // [v2] caminho fixo por rota; a URL de destino nunca vem do pedido
  '/binance/oi': '/fapi/v1/openInterest',
  '/binance/oihist': '/futures/data/openInterestHist',
  '/binance/lsr': '/futures/data/globalLongShortAccountRatio',
  '/binance/taker': '/futures/data/takerlongshortRatio'
};
const BN_PARAMS = {
  symbol: v => /^[A-Z]{2,12}USDT$/.test(v),
  period: v => ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'].includes(v),
  limit: v => /^\d{1,3}$/.test(v) && +v >= 1 && +v <= 500
};
// [v3] P.R.O.T.Á.G.O.R.A.S.: URLs fixas (nada vem do pedido além dos parâmetros da lista branca)
const C13K = ['https://raw.githubusercontent.com/jcpeterson/choices13k/main/c13k_selections.csv', 'https://raw.githubusercontent.com/jcpeterson/choices13k/master/c13k_selections.csv'];
const HF_DS = 'open-spaced-repetition/anki-revlogs-10k', HF_API = 'https://datasets-server.huggingface.co';
const HF_PESSOA_MAX = 4 * 1024 * 1024;   // [v4] celular: pessoa grande demais fica de fora (média da base ≈ 1,6 MB)
const HF_PARAMS = { config: v => /^[\w.\-]{1,48}$/.test(v), split: v => /^[\w.\-]{1,24}$/.test(v), offset: v => /^\d{1,12}$/.test(v), length: v => /^\d{1,3}$/.test(v) && +v >= 1 && +v <= 100 };
// [v5] RADAR: caminho fixo por rota; o único parâmetro aceito é o da lista branca de cada uma (a URL de destino nunca vem do pedido)
const RADAR = 'https://api.cloudflare.com/client/v4/radar';
const RADAR_PAISES = /^[A-Z]{2}$/;
const _dias = v => /^[1-7]$/.test(v);
const RADAR_ROTAS = {
  '/radar/http': { p: { loc: v => RADAR_PAISES.test(v) }, obrig: ['loc'], ttl: 3600, url: q => '/http/timeseries?location=' + q.loc + '&dateRange=14d&aggInterval=1h&name=serie_0&format=json' },
  '/radar/trending': { p: {}, obrig: [], ttl: 3600, url: () => '/ranking/top?rankingType=TRENDING_RISE&limit=20&name=top_0&format=json' },
  '/radar/interrupcoes': { p: { dias: _dias }, obrig: [], ttl: 600, url: q => '/annotations/outages?dateRange=' + (q.dias || '7') + 'd&limit=200&format=json' },
  '/radar/anomalias': { p: { dias: _dias }, obrig: [], ttl: 600, url: q => '/traffic_anomalies?dateRange=' + (q.dias || '7') + 'd&limit=200&format=json' },
  '/radar/bgp/vazamentos': { p: { dias: _dias }, obrig: [], ttl: 600, url: q => '/bgp/leaks/events?dateRange=' + (q.dias || '7') + 'd&per_page=100&format=json' },
  '/radar/bgp/sequestros': { p: { dias: _dias }, obrig: [], ttl: 600, url: q => '/bgp/hijacks/events?dateRange=' + (q.dias || '7') + 'd&per_page=100&minConfidence=8&format=json' }
};
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' };
const UA = { 'User-Agent': 'pytronicos-parazeta/1.0 (leitura de dados públicos)', 'Accept': 'application/json' };
const PARAMS = {
  active: v => v === 'true' || v === 'false',
  closed: v => v === 'true' || v === 'false',
  ascending: v => v === 'true' || v === 'false',
  order: v => /^[A-Za-z0-9_]{1,24}$/.test(v),
  limit: v => /^\d{1,2}$/.test(v) && +v >= 1 && +v <= 50
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET') return new Response('só GET', { status: 405, headers: CORS });
    const u = new URL(req.url);
    if (u.pathname === '/' || u.pathname === '/estado') {
      return new Response(JSON.stringify({ v: 5, rotas: ['/polymarket/markets', '/polymarket/markets/<id>', ...Object.keys(BN_ROTAS), '/humano/c13k', '/humano/anki/splits', '/humano/anki/rows', '/humano/anki/pessoa', ...Object.keys(RADAR_ROTAS)], hfToken: !!(env && env.HF_TOKEN), radarToken: !!(env && env.CF_RADAR_TOKEN) }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (RADAR_ROTAS[u.pathname]) {   // [v5] o Radar da Cloudflare, com o token do segredo
      const R = RADAR_ROTAS[u.pathname], q = {};
      for (const [k, v] of u.searchParams) { if (!R.p[k] || !R.p[k](v)) return new Response('parâmetro fora da lista branca: ' + k, { status: 400, headers: CORS }); q[k] = v; }
      for (const k of R.obrig) if (!q[k]) return new Response('falta ' + k, { status: 400, headers: CORS });
      if (!env || !env.CF_RADAR_TOKEN) return new Response('falta o segredo CF_RADAR_TOKEN no Worker (token de API da Cloudflare com a permissão Account → Radar → Read)', { status: 503, headers: CORS });
      const o = await fetch(RADAR + R.url(q), { method: 'GET', headers: { ...UA, Authorization: 'Bearer ' + env.CF_RADAR_TOKEN }, cf: { cacheTtl: R.ttl, cacheEverything: true } });
      if (!o.ok) return new Response('o Radar respondeu ' + o.status + (o.status === 401 || o.status === 403 ? ' (token inválido ou sem a permissão Radar)' : ''), { status: 502, headers: CORS });
      return new Response(o.body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + Math.min(R.ttl, 600) } });
    }
    if (u.pathname === '/humano/c13k') {   // [v3] choices13k: tenta main e master; cache de 1 dia na borda
      for (const alvo of C13K) {
        const o = await fetch(alvo, { method: 'GET', headers: { 'User-Agent': UA['User-Agent'] }, cf: { cacheTtl: 86400, cacheEverything: true } });
        if (o.ok) return new Response(o.body, { status: 200, headers: { ...CORS, 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
      }
      return new Response('o GitHub não entregou o choices13k', { status: 502, headers: CORS });
    }
    if (u.pathname === '/humano/anki/pessoa') {   // [v4] uma pessoa inteira: o arquivo dela, com o token do segredo
      if (!env || !env.HF_TOKEN) return new Response('falta o segredo HF_TOKEN no Worker', { status: 503, headers: CORS });
      const id = u.searchParams.get('u');
      if ([...u.searchParams.keys()].length !== 1 || !/^\d{1,5}$/.test(id || '') || +id < 1 || +id > 10000) return new Response('use só u=1…10000', { status: 400, headers: CORS });
      const o = await fetch('https://huggingface.co/datasets/' + HF_DS + '/resolve/main/revlogs/user_id=' + (+id) + '/data.parquet', { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA['User-Agent'], Authorization: 'Bearer ' + env.HF_TOKEN } });
      if (!o.ok) return new Response('o Hugging Face respondeu ' + o.status + (o.status === 401 || o.status === 403 ? ' (token inválido ou termos da base não aceitos)' : ''), { status: o.status === 404 ? 404 : 502, headers: CORS });
      const n = +(o.headers.get('content-length') || 0);
      if (n > HF_PESSOA_MAX) { try { await o.body.cancel(); } catch (_) {} return new Response(JSON.stringify({ grande: n }), { status: 413, headers: { ...CORS, 'Content-Type': 'application/json' } }); }
      const H = { ...CORS, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' };
      if (n > 0) return new Response(o.body, { status: 200, headers: H });
      const b = await o.arrayBuffer();   // sem content-length: mede depois de ler
      if (b.byteLength > HF_PESSOA_MAX) return new Response(JSON.stringify({ grande: b.byteLength }), { status: 413, headers: { ...CORS, 'Content-Type': 'application/json' } });
      return new Response(b, { status: 200, headers: H });
    }
    if (u.pathname === '/humano/anki/splits' || u.pathname === '/humano/anki/rows') {   // [v3] Anki pelo datasets-server, com o token do segredo
      if (!env || !env.HF_TOKEN) return new Response('falta o segredo HF_TOKEN no Worker (Settings → Variables and Secrets) e o aceite dos termos de ' + HF_DS + ' no Hugging Face', { status: 503, headers: CORS });
      const q = new URLSearchParams(); q.set('dataset', HF_DS);
      if (u.pathname === '/humano/anki/rows') {
        for (const [k, v] of u.searchParams) { if (!HF_PARAMS[k] || !HF_PARAMS[k](v)) return new Response('parâmetro fora da lista branca: ' + k, { status: 400, headers: CORS }); q.set(k, v); }
        for (const k of ['config', 'split', 'offset', 'length']) if (!q.get(k)) return new Response('falta ' + k, { status: 400, headers: CORS });
      } else if ([...u.searchParams.keys()].length) return new Response('splits não aceita parâmetros', { status: 400, headers: CORS });
      const alvo = HF_API + (u.pathname.endsWith('/rows') ? '/rows?' : '/splits?') + q.toString();
      const o = await fetch(alvo, { method: 'GET', headers: { ...UA, Authorization: 'Bearer ' + env.HF_TOKEN } });
      if (!o.ok) return new Response('o Hugging Face respondeu ' + o.status + (o.status === 401 || o.status === 403 ? ' (token inválido ou termos da base não aceitos)' : ''), { status: 502, headers: CORS });
      return new Response(o.body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (BN_ROTAS[u.pathname]) {   // [v2] a nuvem do N.E.R.E.U.S.
      const q = new URLSearchParams();
      for (const [k, v] of u.searchParams) {
        if (!BN_PARAMS[k] || !BN_PARAMS[k](v)) return new Response('parâmetro fora da lista branca: ' + k, { status: 400, headers: CORS });
        q.set(k, v);
      }
      if (!q.get('symbol')) return new Response('falta symbol', { status: 400, headers: CORS });
      if (u.pathname !== '/binance/oi' && !q.get('period')) return new Response('falta period', { status: 400, headers: CORS });
      if (u.pathname === '/binance/oi') { q.delete('period'); q.delete('limit'); }
      const o = await fetch(BINANCE + BN_ROTAS[u.pathname] + '?' + q.toString(), { method: 'GET', headers: UA, cf: { cacheTtl: 20, cacheEverything: true } });
      if (!o.ok) return new Response('a Binance respondeu ' + o.status + (o.status === 451 || o.status === 403 ? ' (região bloqueada para este ponto da Cloudflare)' : ''), { status: 502, headers: CORS });
      return new Response(o.body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    let alvo = null;
    if (u.pathname === '/polymarket/markets') {
      const q = new URLSearchParams();
      for (const [k, v] of u.searchParams) {
        if (!PARAMS[k] || !PARAMS[k](v)) return new Response('parâmetro fora da lista branca: ' + k, { status: 400, headers: CORS });
        q.set(k, v);
      }
      alvo = ALVO + '/markets' + (q.toString() ? '?' + q.toString() : '');
    } else {
      const m = u.pathname.match(/^\/polymarket\/markets\/(\d{1,12})$/);
      if (m) alvo = ALVO + '/markets/' + m[1];
    }
    if (!alvo) return new Response('rota fora da lista fixa', { status: 404, headers: CORS });
    const o = await fetch(alvo, { method: 'GET', headers: UA });
    if (!o.ok) return new Response('a Polymarket respondeu ' + o.status, { status: 502, headers: CORS });
    return new Response(o.body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
};
