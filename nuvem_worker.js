// nuvem_worker.js — N.U.V.E.M. 1.0.0 (2026-11-25) · Worker da Cloudflare do operador (PLANO GRÁTIS) + Durable Object "Laboratorio" (SQLite)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// O QUE FAZ: varre espaços de candidatos dos problemas da T.E.S.T.E.M.U.N.H.A. (SAT3, COR3, SUBCONJ, HP2D, GUIND<k>, ESCALA<k>) para as criaturas do
// Pytronicos. Devolve só o ÍNDICE do candidato que passou (a testemunha) ou até onde varreu. O celular CONFERE toda testemunha antes de usar
// (A PAREDE: nada atravessa sem verificador). Os verificadores abaixo são CÓPIA LITERAL de testemunha_np.js (mesma conta, bit a bit).
// O QUE NÃO É: computação genérica. Não executa código recebido, não busca URL, só as 6 famílias fixas, só números.
// RENDIMENTO NO PLANO GRÁTIS (criatividade dentro das regras publicadas):
//   · 1 requisição = 1 LOTE com muitas tarefas; os dados de um problema viajam 1 vez (ficam 24 h aqui; depois só o hash);
//   · BIBLIOTECA: testemunha achada e espaço esgotado ficam guardados → pedido repetido custa 0 de CPU;
//   · COBERTURA: varreduras de vários lotes no mesmo problema se somam (o "impossível" pode ser provado aos pedaços);
//   · o trabalho roda no Durable Object (CPU por requisição documentada em 30 s) — o cliente APRENDE o tamanho do lote (AIMD), nada presumido;
//   · aqui o relógio não anda durante CPU (regra da Cloudflare): o orçamento é em UNIDADES (candidatos verificados), nunca em ms.
// ROTAS: GET /saude (só o Worker) · GET /estado (contadores do dia, biblioteca) · POST /lote (o trabalho) · OPTIONS (CORS)
// CHAVE (opcional, recomendada): segredo NUVEM_CHAVE → toda chamada a /lote e /estado precisa do cabeçalho x-nuvem-chave igual.
// TETO DIÁRIO: LOTES_DIA (padrão 15 000) — acima disso responde 429 até 00:00 UTC (folga para os outros Workers da conta, que somam 100 000/dia).
// Publicar: ver PUBLICAR_NUVEM.md (npx wrangler deploy -c wrangler.nuvem.toml).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const VERSAO = '1.0.0';
const CFG = { LOTES_DIA: 15000, MAX_UNID_LOTE: 20_000_000, MAX_TAREFAS: 64, MAX_PROBS: 32, MAX_BYTES: 262144, ESPACO_MAX: 2 ** 30, TTL_PROB_MS: 24 * 3600e3 };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-nuvem-chave', 'cache-control': 'no-store' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...CORS } });

// ─────────────────────────── CÓPIA LITERAL de testemunha_np.js 1.6.0 (núcleo 1: famílias NP) — não editar à mão ───────────────────────────
const _cor = new Uint8Array(16);     // rascunho compartilhado (sem alocação na verificação)
const _grade = new Int32Array(33 * 33), _gradeRes = new Int8Array(33 * 33); let _geracao = 1;
const _px = new Int8Array(16), _py = new Int8Array(16);

function fnv1a(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); }

class Problema {
  constructor(familia, n, espaco, m, fonte, origemReal, assinaturaTexto) {
    this.familia = familia; this.n = n; this.espaco = espaco; this.m = m; this.fonte = fonte; this.origemReal = origemReal;
    this.hash = familia + ':' + fnv1a(assinaturaTexto);
  }
  get bits() { return Math.log2(this.espaco); }
}

class ProblemaSAT3 extends Problema {
  // lits: Int8Array(3m), literal = ±(1..n)
  constructor(n, lits, fonte) { super('SAT3', n, 2 ** n, lits.length / 3, fonte, false, n + '|' + Array.from(lits).join(',')); this.lits = lits; }
  verificar(idx) {
    const L = this.lits;
    for (let c = 0; c < L.length; c += 3) {
      let ok = false;
      for (let j = 0; j < 3; j++) { const l = L[c + j], v = (l > 0 ? l : -l) - 1, bit = (idx >>> v) & 1; if ((l > 0) === (bit === 1)) { ok = true; break; } }
      if (!ok) return false;
    }
    return true;
  }
  static aleatorio(n, alfa, fonte, rnd = Math.random) {
    const m = Math.round(alfa * n), lits = new Int8Array(3 * m);
    for (let c = 0; c < m; c++) {
      let a = 1 + Math.floor(rnd() * n), b, d;
      do { b = 1 + Math.floor(rnd() * n); } while (b === a);
      do { d = 1 + Math.floor(rnd() * n); } while (d === a || d === b);
      lits[3 * c] = rnd() < .5 ? a : -a; lits[3 * c + 1] = rnd() < .5 ? b : -b; lits[3 * c + 2] = rnd() < .5 ? d : -d;
    }
    return new ProblemaSAT3(n, lits, fonte);
  }
}

class ProblemaCor3 extends Problema {
  // arestas: Uint8Array(2E) de índices 0..n-1
  constructor(n, arestas, rotulos, fonte) { super('COR3', n, 3 ** n, arestas.length / 2 + n, fonte, true, n + '|' + Array.from(arestas).join(',')); this.arestas = arestas; this.rotulos = rotulos; }
  verificar(idx) {
    let x = idx; for (let i = 0; i < this.n; i++) { _cor[i] = x % 3; x = (x - _cor[i]) / 3; }
    const A = this.arestas; for (let k = 0; k < A.length; k += 2) if (_cor[A[k]] === _cor[A[k + 1]]) return false;
    return true;
  }
}

class ProblemaSubconjunto extends Problema {
  // valores: Float64Array(k) inteiros exatos (< 2^53); alvo inteiro (ou não-inteiro → nenhuma soma bate)
  constructor(valores, alvo, tipo, rotulos, fonte) { super('SUBCONJ', valores.length, 2 ** valores.length, valores.length, fonte, true, tipo + '|' + alvo + '|' + Array.from(valores).join(',')); this.valores = valores; this.alvo = alvo; this.tipo = tipo; this.rotulos = rotulos; }
  verificar(idx) { let s = 0; const V = this.valores; for (let i = 0; i < V.length; i++) if ((idx >>> i) & 1) s += V[i]; return s === this.alvo; }
}

class ProblemaHP extends Problema {
  // hp: Uint8Array(n), 1 = H. Candidato: n−2 movimentos relativos (0 esquerda, 1 reto, 2 direita) em base 3.
  constructor(hp, meta, rotulo, fonte) { super('HP2D', hp.length, 3 ** (hp.length - 2), hp.length, fonte, true, meta + '|' + Array.from(hp).join('')); this.hp = hp; this.meta = meta; this.rotulo = rotulo; }
  verificar(idx) {
    const n = this.hp.length, W = 33, O = 16;
    if (++_geracao > 2e9) { _grade.fill(0); _geracao = 1; }
    const g = _geracao; let x = 0, y = 0, dir = 0, rest = idx;
    _px[0] = 0; _py[0] = 0; _grade[O * W + O] = g; _gradeRes[O * W + O] = 0;
    x = 1; _px[1] = 1; _py[1] = 0; _grade[O * W + O + 1] = g; _gradeRes[O * W + O + 1] = 1;
    for (let i = 2; i < n; i++) {
      const mv = rest % 3; rest = (rest - mv) / 3;
      dir = (dir + (mv === 0 ? 1 : (mv === 1 ? 0 : 3))) & 3;
      x += dir === 0 ? 1 : (dir === 2 ? -1 : 0); y += dir === 1 ? 1 : (dir === 3 ? -1 : 0);
      const c = (y + O) * W + (x + O);
      if (_grade[c] === g) return false;                     // não auto-evitante
      _grade[c] = g; _gradeRes[c] = i; _px[i] = x; _py[i] = y;
    }
    let contatos = 0;
    for (let i = 0; i < n; i++) {
      if (!this.hp[i]) continue;
      const cx = _px[i] + O, cy = _py[i] + O;
      for (let d = 0; d < 4; d++) {
        const nx = cx + (d === 0 ? 1 : (d === 2 ? -1 : 0)), ny = cy + (d === 1 ? 1 : (d === 3 ? -1 : 0)), c = ny * W + nx;
        if (_grade[c] === g) { const j = _gradeRes[c]; if (j > i + 1 && this.hp[j]) contatos++; }
      }
    }
    return contatos >= this.meta;
  }
  // cota superior de contatos H–H (rede quadrada é bipartida: só paridades opostas; cada H interno tem ≤ 2 vizinhos livres)
  static cota(hp) { let par = 0, impar = 0; const n = hp.length; for (let i = 0; i < n; i++) if (hp[i]) { const livres = (i === 0 || i === n - 1) ? 3 : 2; if (i % 2) impar += livres; else par += livres; } return Math.min(par, impar); }
}

class ProblemaCorK extends Problema {
  constructor(n, k, arestas, proibidos, rotulos, fonte, usarDominio = false) {
    // [R1b] domínio: cores permitidas de cada nó (base mista); sem domínio, k^n como antes
    const dom = []; let esp = 1;
    for (let i = 0; i < n; i++) { const d = []; for (let c = 0; c < k; c++) if (!usarDominio || !((proibidos[i] >>> c) & 1)) d.push(c); dom.push(Uint8Array.from(d)); esp *= d.length; }
    super('GUIND' + k, n, esp, arestas.length / 2 + n, fonte, /WIKIDATA/.test(fonte), k + '|' + Array.from(arestas).join(',') + '|' + Array.from(proibidos).join(','));
    this.k = k; this.arestas = arestas; this.proibidos = proibidos; this.rotulos = rotulos; this.dom = dom; this.usaDominio = !!usarDominio;
  }
  decodificar(idx, out) { let x = idx; for (let i = 0; i < this.n; i++) { const D = this.dom[i], b = D.length, r = x % b; out[i] = D[r]; x = (x - r) / b; } return out; }
  verificar(idx) {
    this.decodificar(idx, _cor);
    for (let i = 0; i < this.n; i++) if ((this.proibidos[i] >>> _cor[i]) & 1) return false;
    const A = this.arestas; for (let j = 0; j < A.length; j += 2) if (_cor[A[j]] === _cor[A[j + 1]]) return false;
    return true;
  }
}

const _carga = new Float64Array(8);

/** Peça da escala: ≤ 7 módulos, cada um só com as fases que ainda cabem; verificação O(n + k). */
class ProblemaEscala extends Problema {
  constructor(custos, k, dom, cargaFora, teto, nomes, fonte) {
    let esp = 1; for (const d of dom) esp *= d.length;
    super('ESCALA' + k, custos.length, esp, custos.length + k, fonte, true, k + '|' + teto + '|' + Array.from(custos).join(',') + '|' + Array.from(cargaFora).join(',') + '|' + dom.map(d => Array.from(d).join('')).join('/'));
    this.custos = custos; this.k = k; this.dom = dom; this.cargaFora = cargaFora; this.teto = teto; this.rotulos = nomes;
  }
  decodificar(idx, out) { let x = idx; for (let i = 0; i < this.n; i++) { const D = this.dom[i], b = D.length, r = x % b; out[i] = D[r]; x = (x - r) / b; } return out; }
  verificar(idx) {
    this.decodificar(idx, _cor);
    for (let p = 0; p < this.k; p++) _carga[p] = this.cargaFora[p];
    for (let i = 0; i < this.n; i++) _carga[_cor[i]] += this.custos[i];
    for (let p = 0; p < this.k; p++) if (_carga[p] > this.teto) return false;
    return true;
  }
}

// ─────────────────────────── fim da cópia literal ───────────────────────────

// dados (JSON) → problema. Só as 6 famílias; tamanhos travados (os rascunhos _cor/_px têm 16 posições).
function montar(fam, d) {
  if (!d || typeof d !== 'object') throw new Error('dados');
  const nums = (a, max) => { if (!Array.isArray(a) || a.length > max || a.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('vetor'); return a; };
  if (fam === 'SAT3') { const n = d.n | 0; if (n < 1 || n > 30) throw new Error('n'); return new ProblemaSAT3(n, Int8Array.from(nums(d.lits, 3 * 400)), 'NUVEM'); }
  if (fam === 'COR3') { const n = d.n | 0; if (n < 1 || n > 16) throw new Error('n'); return new ProblemaCor3(n, Uint8Array.from(nums(d.arestas, 2 * 120)), null, 'NUVEM'); }
  if (fam === 'SUBCONJ') { const v = nums(d.valores, 30); return new ProblemaSubconjunto(Float64Array.from(v), Number(d.alvo), String(d.tipo || ''), null, 'NUVEM'); }
  if (fam === 'HP2D') { const hp = nums(d.hp, 16); if (hp.length < 3) throw new Error('n'); return new ProblemaHP(Uint8Array.from(hp), d.meta | 0, '', 'NUVEM'); }
  let m = /^GUIND(\d)$/.exec(fam);
  if (m) { const n = d.n | 0, k = +m[1]; if (n < 1 || n > 16 || k < 2 || k > 8) throw new Error('n'); return new ProblemaCorK(n, k, Uint8Array.from(nums(d.arestas, 2 * 120)), Uint8Array.from(nums(d.proibidos, 16)), null, String(d.fonte || 'NUVEM'), !!d.dominio); }
  m = /^ESCALA(\d)$/.exec(fam);
  if (m) { const k = +m[1], c = nums(d.custos, 16); if (k < 2 || k > 8) throw new Error('k'); return new ProblemaEscala(Float64Array.from(c), k, (d.dom || []).map(x => Uint8Array.from(nums(x, 8))), Float64Array.from(nums(d.cargaFora, 8)), Number(d.teto), null, 'NUVEM'); }
  throw new Error('familia');
}
const mdc = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
const hojeUTC = () => new Date().toISOString().slice(0, 10);

// ═════════════════════════════════ Durable Object: o laboratório (um só, nome 'lab') ═════════════════════════════════
export class Laboratorio {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.st = ctx.storage; this.cache = new Map(); }
  async _dia() { const k = 'd:' + hojeUTC(); return { k, v: (await this.st.get(k)) || { lotes: 0, tarefas: 0, testados: 0, achados: 0, bib: 0, falta: 0, recusados: 0 } }; }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/estado') {
      const { v } = await this._dia(); const tot = (await this.st.get('tot')) || { lotes: 0, testados: 0, achados: 0, esgotados: 0 };
      return json({ ok: true, modulo: 'N.U.V.E.M.', versao: VERSAO, hoje: hojeUTC(), dia: v, total: tot, tetoLotesDia: CFG.LOTES_DIA, maxUnidLote: CFG.MAX_UNID_LOTE, chave: !!this.env.NUVEM_CHAVE });
    }
    if (url.pathname !== '/lote' || req.method !== 'POST') return json({ ok: false, erro: 'rota' }, 404);
    const dia = await this._dia();
    if (dia.v.lotes >= CFG.LOTES_DIA) { dia.v.recusados++; await this.st.put(dia.k, dia.v); return json({ ok: false, erro: 'cota_diaria', dia: dia.v }, 429); }
    let corpo; try { const t = await req.text(); if (t.length > CFG.MAX_BYTES) return json({ ok: false, erro: 'grande' }, 413); corpo = JSON.parse(t); } catch (_) { return json({ ok: false, erro: 'json' }, 400); }
    if (!corpo || corpo.v !== 1 || !Array.isArray(corpo.tarefas) || corpo.tarefas.length > CFG.MAX_TAREFAS) return json({ ok: false, erro: 'formato' }, 400);
    const probs = corpo.probs && typeof corpo.probs === 'object' ? corpo.probs : {};
    if (Object.keys(probs).length > CFG.MAX_PROBS) return json({ ok: false, erro: 'probs' }, 400);
    const agora = Date.now(), tot = (await this.st.get('tot')) || { lotes: 0, testados: 0, achados: 0, esgotados: 0 };
    // 1) problemas novos: monta, confere o hash (o mesmo do celular) e guarda os DADOS por 24 h
    for (const [h, p] of Object.entries(probs)) {
      try { const P = montar(p.fam, p.d); if (P.hash !== h || P.espaco > CFG.ESPACO_MAX) continue; this.cache.set(h, P); await this.st.put('p:' + h, { fam: p.fam, d: p.d, t: agora }); } catch (_) {}
    }
    // 2) tarefas: orçamento total em UNIDADES (candidatos verificados), dividido na ordem
    let orc = Math.max(0, Math.min(CFG.MAX_UNID_LOTE, Number(corpo.unid) || 0));
    const R = [];
    for (const t of corpo.tarefas) {
      const h = String(t.h || '');
      const r = { id: t.id, h, achou: -1, ate: t.ini | 0, testados: 0 };
      const w = await this.st.get('w:' + h);
      if (w != null) { r.achou = w; r.bib = 'testemunha'; dia.v.bib++; R.push(r); continue; }          // biblioteca: 0 de CPU
      if (await this.st.get('x:' + h)) { r.ate = -1; r.esgotado = true; r.bib = 'esgotado'; dia.v.bib++; R.push(r); continue; }
      let P = this.cache.get(h);
      if (!P) { const g = await this.st.get('p:' + h); if (g && agora - g.t < CFG.TTL_PROB_MS) { try { P = montar(g.fam, g.d); if (P.hash === h) this.cache.set(h, P); else P = null; } catch (_) { P = null; } } }
      if (!P) { r.falta = true; dia.v.falta++; R.push(r); continue; }                                   // o cliente reenvia os dados
      const E = P.espaco, off = Number(t.off) % E, passo = Number(t.passo) || 1, ini = Math.max(0, Math.min(E, Number(t.ini) || 0));
      const fim = Math.min(E, ini + Math.max(0, Math.min(orc, Number(t.unid) || 0)));
      let tt = ini;
      for (; tt < fim; tt++) { const i = (off + tt * passo) % E; if (P.verificar(i)) { r.achou = i; break; } }
      r.testados = (r.achou >= 0 ? tt + 1 : tt) - ini; r.ate = r.achou >= 0 ? tt + 1 : tt; orc -= r.testados;
      dia.v.testados += r.testados; tot.testados += r.testados;
      if (r.achou >= 0) { await this.st.put('w:' + h, r.achou); dia.v.achados++; tot.achados++; }
      else {   // cobertura contígua desde 0 nesta permutação → esgotado quando chega ao fim
        const ck = 'c:' + h + ':' + off + ':' + passo, cob = (await this.st.get(ck)) || 0;
        if (ini <= cob && r.ate > cob) { await this.st.put(ck, r.ate); if (r.ate >= E && mdc(passo, E) === 1) { await this.st.put('x:' + h, agora); r.esgotado = true; tot.esgotados++; } }   // passo coprimo = a permutação cobre tudo
      }
      R.push(r);
    }
    dia.v.lotes++; dia.v.tarefas += corpo.tarefas.length; tot.lotes++;
    await this.st.put(dia.k, dia.v); await this.st.put('tot', tot);
    if (!(await this.st.getAlarm())) await this.st.setAlarm(agora + 6 * 3600e3);
    return json({ ok: true, v: 1, r: R, sobra: orc, dia: { lotes: dia.v.lotes, teto: CFG.LOTES_DIA } });
  }
  // faxina 4×/dia: dados de problema com mais de 24 h saem (testemunhas e esgotados ficam: são a biblioteca)
  async alarm() {
    const lim = Date.now() - CFG.TTL_PROB_MS; let apagados = 0;
    const L = await this.st.list({ prefix: 'p:', limit: 1000 });
    for (const [k, g] of L) if (!g || g.t < lim) { await this.st.delete(k); apagados++; }
    const D = await this.st.list({ prefix: 'd:', limit: 100 }); const hoje = 'd:' + hojeUTC(), ks = [...D.keys()].filter(k => k < hoje).sort();
    for (const k of ks.slice(0, Math.max(0, ks.length - 30))) await this.st.delete(k);   // guarda 30 dias de contadores
    this.cache.clear();
    await this.st.setAlarm(Date.now() + 6 * 3600e3);
  }
}

// ═════════════════════════════════ Worker (porta de entrada): CORS, chave, encaminha ao laboratório ═════════════════════════════════
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/saude') return json({ ok: true, modulo: 'N.U.V.E.M.', versao: VERSAO });
    if (url.pathname !== '/estado' && url.pathname !== '/lote') return json({ ok: false, erro: 'rota fora da lista fixa' }, 404);
    if (env.NUVEM_CHAVE && req.headers.get('x-nuvem-chave') !== env.NUVEM_CHAVE) return json({ ok: false, erro: 'chave' }, 401);
    if (!env.LAB) return json({ ok: false, erro: 'sem o Durable Object LAB (confira o wrangler.nuvem.toml)' }, 503);
    const stub = env.LAB.get(env.LAB.idFromName('lab'));
    try { return await stub.fetch(new Request('https://lab' + url.pathname, { method: req.method, body: req.method === 'POST' ? await req.text() : undefined })); }
    catch (e) { return json({ ok: false, erro: 'lab: ' + String((e && e.message) || e).slice(0, 120) }, 503); }
  }
};
