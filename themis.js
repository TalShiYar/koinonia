// ============================================================================
// T.H.E.M.I.S. — Tribunal de Honra, Especialidade, Mérito e Isonomia Social
// js/modules/OMEGA/themis.js — [2026-10-25]
//
// O que é (a sociedade do PDF "WebSocket → sociedade de agentes", dentro do Pytronicos):
//   cada entidade é um cidadão com IDENTIDADE estável (o id), um CURRÍCULO de capacidades
//   POR CONTEXTO (nunca uma nota única), um HISTÓRICO que perde validade, e uma ESCADA
//   de confiança (nível 0 "calibração" → 3 "mestre"). Falhar NÃO é cancelamento: reduz o
//   raio de ação (restrição temporária) e o caminho de volta é só evidência nova.
//
// Analogia: é um boletim escolar com notas POR MATÉRIA, em que acertar a questão que a
//   turma inteira acerta vale pouco e errar essa mesma questão vale muito; as notas
//   esmaecem com o tempo; quem dá "aval" a um colega assume parte do risco; e o professor
//   (a rede) sorteia quem responde a próxima pergunta por mérito + folga + rodízio,
//   deixando sempre uma cadeira para o aluno novo.
//
// Onde nascem as evidências (só fontes que o MUNDO ou um PAR verifica sozinho — Glass-Box):
//   S1  observar()    — cada avaliação falsificável (filtro de Popper do HTML): a hipótese
//                       da entidade vale (true) ou não vale (false) contra os dados do mundo.
//   S2  testemunhar() — experimento mental entre vizinhas: quem propôs REAVALIA a mesma
//                       expressão e confere a resposta da outra (verificador automático).
//
// Contexto (domínio) = a família de variáveis que a proposição cita (var_net_* → rede,
//   var_mkt_* → mercado, var_lab_fis_* → física...). Proposição sem variável do mundo
//   (matemática pura) NÃO gera evidência: era a porta de entrada do farm de tautologias.
//
// Anti-farm (o "custo de enganar" do PDF):
//   • dificuldade: acerto numa proposição que a população toda acerta pesa ~0,05; erro
//     nela pesa 1 (taxa-base POPULACIONAL da proposição, lida ANTES de contar a atual);
//   • repetição: a mesma proposição pela mesma entidade pesa 8/n depois da 8ª avaliação;
//   • orçamento de aval: cada avalista tem 3 vereditos plenos por época (600 ticks), os
//     seguintes diluem; o mesmo par (avalista→alvo) pesa 1/√n; avalista com aval que deu
//     errado perde credibilidade (custo para recomendar — risco compartilhado);
//   • nascer não herda reputação (Sybil de graça não rende nada).
//
// Big-O (N = entidades vivas, k = chaves da proposição ≤ ~24, D = 18 domínios, K = 12):
//   observar()         O(k) amortizado (m ≤ 3 domínios por proposição; exp() só a cada ≥64 ticks)
//   testemunhar()      O(k)          escolherParceiro()  O(C), C ≤ 24 candidatas (bairro)
//   calibrando()       O(D)          procurar(d, k)      O(K log K) — independe de N
//   peso()/nivel()     O(1)          tick()              O(8·D) — varredura circular de 8 regs
//   memória: registros = entidades vivas (GC por época) · taxa-base ≤ 12 000 proposições
//            · pares ≤ vereditos da época · eventos ≤ 40.
//   "Descoberta O(log N)" do PDF: aqui, num processo só, um índice bounded por domínio
//   (top-K) responde sem varrer N; a DHT distribuída só valeria com vários processos.
//
// v1.1 (2026-10-26): JUSTIÇA = regressão frente ao PRÓPRIO passado (linha de base lenta por domínio), não frente à população (com ~10 entidades a "chance" é ruído);
//   CAMINHO DE VOLTA = 5 acertos em proposições DIFÍCEIS no domínio (ou recuperar a própria linha de base, ou a evidência esmaecer); funil do S2 no painel.
// v1.2 (2026-10-27): cada cidadã guarda as ≤ 6 proposições que mais testou no domínio 'externo' (texto + placar de verdade);
//   melhorProposicao(id) devolve a "lei" mais firme dela — é o que a A.D.U.A.N.A. usa como MOTIVO para barrar ou deixar entrar.
// Autônomo: sem flag para ligar. Ablação (só para provar o efeito): window.themisOff = true.
// Não mexe em energia, reprodução nem recompensas — mede, roteia experimentos mentais e
// expõe API (peso/procurar/especialidade) para outros módulos (ex.: consultor do PLUTUS).
// ============================================================================

const NOMES = [
    'sentidos', 'rede', 'mercado', 'fisica', 'geologia', 'astronomia', 'terra', 'ecologia',
    'modelagem', 'quimica', 'estatistica', 'substrato', 'cultura', 'estrutura', 'fenomenos',
    'anima', 'aritmetica', 'externo'
];
const D = NOMES.length;                       // 18
const D_IDX = new Map(NOMES.map((n, i) => [n, i]));

const META_VIDA = 4000;      // ticks: meia-vida da evidência ("confiança com validade")
const N1 = 6, N2 = 18, N3 = 45;   // evidência (ponderada) p/ nível 1, 2, 3
const REP_TETO = 8;          // avaliações plenas por (entidade, proposição)
const POP_TETO = 12000;      // proposições com taxa-base guardada (eviction em lote)
const TOPK = 12;             // índice de descoberta por domínio
const EPOCA = 600;           // ticks: orçamento de aval e pares
const AVAL_VALE = 800;       // ticks: validade de um aval
const S2_BASE = 0.6;         // testemunho par-a-par é mais ruidoso que o mundo
const MAX_CAND = 24;         // teto de candidatas por sorteio
// v1.1 (2026-10-26) — justiça relativa ao PASSADO DE SI MESMA + caminho de volta por PROVA (decisões do AGI)
const PROVA_N = 5;           // volta da restrição = N acertos em proposições DIFÍCEIS no domínio (população acerta ≤ 50%, ≥ 3 avaliações)
const BASE_T = 12000;        // ticks: constante de tempo da linha de base própria (o "passado" de cada entidade por domínio)
const REGRESSAO = 0.12;      // restringe se o limite inferior cair tanto abaixo da PRÓPRIA linha de base
const VOLTA_FOLGA = 0.03;    // também volta se o limite inferior chegar a esta folga da própria linha de base
const FAST_VIDA = 800;       // ticks: meia-vida do desempenho RECENTE (o que se compara com o próprio passado)
const BASE_IDADE = 2000;     // ticks mínimos de linha de base antes de poder restringir (sem passado não há regressão)

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const DOM_EXT = 17;          // 'externo'
const PROP_MAX = 6;          // proposições guardadas por cidadã no domínio externo
// Proposição em símbolos legíveis (o mesmo dicionário do HTML); sem dicionário, as chaves cruas.
function textoExpr(keys) {
    const D0 = (typeof window !== 'undefined' && window.fullSymbolDictionary) || null;
    return keys.map(k => (D0 && typeof D0[k] === 'string') ? D0[k] : k).join(' ').slice(0, 160);
}

// Chave de expressão → índice de domínio (-1 = não é variável do mundo).
function classificaChave(k) {
    if (typeof k !== 'string') return -1;
    if (k.startsWith('var_net_') || k.startsWith('var_gate_')) return 1;
    if (k.startsWith('var_mkt_')) return 2;
    if (k.startsWith('var_lab_')) {
        switch (k.slice(8, 11)) {
            case 'fis': return 3; case 'geo': return 4; case 'ast': return 5; case 'ter': return 6;
            case 'eco': return 7; case 'mod': return 8; case 'qui': return 9; case 'est': return 10;
        }
        return -1;
    }
    if (k.startsWith('var_test_')) return 16;
    if (k.startsWith('var_anima_')) return 15;
    if (k.startsWith('phen_')) return 14;
    if (k.startsWith('env_ponte_') || k.startsWith('env_rede_')) return 17;   // mundo EXTERNO real (Bifrost/Pleiades)
    if (k.startsWith('env_')) {
        if (k.startsWith('env_meme') || k.startsWith('env_noosphere') || k.startsWith('env_legado')) return 12;
        if (k.startsWith('env_cause') || k.startsWith('env_eigen') || k.startsWith('env_topos') || k.startsWith('env_pop')) return 13;
        return 11;
    }
    if (k.startsWith('var_')) return 0;   // var_energy, var_neighbor*, var_marker*... = sentidos imediatos
    return -1;
}

export class THEMIS_Engine {
    constructor() {
        this.versao = '1.2 (2026-10-27)';
        // --- tempo
        this._t = 0;
        this._epoca = 0;
        this._k = Math.LN2 / META_VIDA;       // decaimento por tick
        this._kf = Math.LN2 / FAST_VIDA;      // decaimento do desempenho recente
        this._kc = Math.LN2 / 600;            // decaimento da carga de uso (rodízio)
        // --- registros por entidade (identidade + currículo + histórico) — escopo POR ENTIDADE
        this._regs = new Map();               // id -> rec
        this._lista = [];                     // recs, p/ varredura circular (swap-remove)
        this._cursor = 0;
        // --- escopo GLOBAL
        this._popExpr = new Map();            // exprString -> [acertos, total] (entidades distintas, ≤ REP_TETO cada)
        this._gE = new Float64Array(D * 2);   // base do domínio: [d*2]=acertos, [d*2+1]=erros (com validade)
        this._gT = new Float64Array(D);       // último tick de cada base
        this._ch = new Float64Array(D).fill(0.5);   // "chance" por domínio (cache; atualiza a cada 16 ticks)
        this._topo = [];                      // índice de descoberta: D listas de {id, lb, n}
        for (let d = 0; d < D; d++) this._topo.push([]);
        this._pares = new Map();              // "avalista|alvo" -> n (zera a cada época)
        // --- memos e buffers reutilizados (sem alocação no caminho quente)
        this._memo = new Map();               // chave -> domínio
        this._buf = new Int32Array(D);
        this._vis = new Int32Array(D);
        this._stamp = 0;
        this._ix = new Int32Array(MAX_CAND);
        this._sc = new Float64Array(MAX_CAND);
        this._L = { ea: 0, eb: 0, n: 0, mean: 0.5, lb: 0, chance: 0.5, skill: 0, tier: 0, restr: false };
        // --- auditoria preditiva (a reputação prevê acerto além da dificuldade da proposição?)
        this._bM = 0; this._bB = 0; this._bC = 0;
        // --- contadores e eventos (glass-box)
        this._c = {
            obs1: 0, obs2: 0, escolhas: 0, semDominio: 0, porTier: [0, 0, 0, 0],
            restricoes: 0, recuperacoes: 0, restrTicks: 0, restrFim: 0, especialidades: 0, gcRemovidos: 0, erros: 0, ultimoErro: ''
        };
        this._eventos = [];
        this._ext = new Map();                       // chave externa -> [acertos, usos]: o que as entidades TENTAM usar do mundo real (≤ 64 chaves)
        this._f = { recusado: 0, aceito: 0, respondido: 0, julgado: 0 };   // funil do S2 (proposta → aceita → respondida → julgada)
        // --- interface
        this._ui = null;
        this._aberto = false;
        this._timer = null;
    }

    // ------------------------------------------------------------------ núcleo
    _domsDe(keys) {
        if (!keys || !keys.length) return 0;
        let m = 0;
        const st = ++this._stamp;
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            let d = this._memo.get(k);
            if (d === undefined) {
                d = classificaChave(k);
                if (this._memo.size >= 4096) this._memo.clear();
                this._memo.set(k, d);
            }
            if (d >= 0 && this._vis[d] !== st) { this._vis[d] = st; this._buf[m++] = d; }
        }
        return m;
    }

    _rec(id, criar) {
        let r = this._regs.get(id);
        if (r === undefined && criar) {
            r = {
                id, ix: this._lista.length, cel: new Float64Array(D * 4),   // por domínio: [acertos, erros, último tick, restrito]
                nObs: 0, nServ: 0, carga: 0, tCarga: this._t,
                ca: 2, cb: 2,                  // credibilidade como AVALISTA (Beta 2,2)
                bl: new Float64Array(D * 4),   // linha de base própria por domínio: [limite inferior médio, tick da última atualização, tick do início, tick em que restringiu]
                rc: new Float64Array(D * 3),   // desempenho RECENTE por domínio: [acertos, erros, último tick] com meia-vida curta
                pv: new Uint8Array(D),         // prova de volta: acertos difíceis desde a restrição
                epW: -1, nW: 0,                // orçamento de aval da época
                av: null,                      // anel de avais RECEBIDOS: por domínio [id1,t1,id2,t2]
                esp: -1, tNasc: this._t,
                pr: null                       // v1.2: proposições do domínio externo [{d, s, k, h, n, t}] (≤ PROP_MAX)
            };
            this._regs.set(id, r);
            this._lista.push(r);
        }
        return r;
    }

    _chanceAtualiza() {
        for (let d = 0; d < D; d++) {
            const dt = this._t > this._gT[d] ? this._t - this._gT[d] : 0;
            const f = dt ? Math.exp(-dt * this._k) : 1;
            const a = 1 + this._gE[d * 2] * f, b = 1 + this._gE[d * 2 + 1] * f;
            this._ch[d] = a / (a + b);
        }
    }

    _gAdd(d, hit, w) {
        const dt = this._t - this._gT[d];
        if (dt >= 64) {
            const f = Math.exp(-dt * this._k);
            this._gE[d * 2] *= f; this._gE[d * 2 + 1] *= f; this._gT[d] = this._t;
        }
        if (hit) this._gE[d * 2] += w; else this._gE[d * 2 + 1] += w;
    }

    // Leitura (sem escrever) de uma célula (entidade × domínio) → objeto reutilizado this._L.
    _ler(rec, d) {
        const c = rec.cel, o = d * 4, L = this._L;
        const dt = this._t > c[o + 2] ? this._t - c[o + 2] : 0;
        const f = dt ? Math.exp(-dt * this._k) : 1;
        const restr = c[o + 3] === 1;
        const ea = c[o] * f;
        const eb = c[o + 1] * (restr ? f * f : f);        // em restrição o erro antigo some 2× mais rápido (caminho de volta)
        const A = 1 + ea, B = 1 + eb, S = A + B;
        const mean = A / S;
        const lb = mean - Math.sqrt(A * B / (S * S * (S + 1)));   // média − 1 erro-padrão (mesma régua do btc_meuLiq)
        const n = ea + eb;
        const chance = this._ch[d];
        const skill = lb - chance;
        let tier = 0;
        if (!restr) {
            if (n >= N1) tier = 1;
            if (n >= N2 && skill >= 0.05) tier = 2;
            if (n >= N3 && skill >= 0.15) tier = 3;
        }
        L.ea = ea; L.eb = eb; L.n = n; L.mean = mean; L.lb = lb; L.chance = chance; L.skill = skill; L.tier = tier; L.restr = restr;
        return L;
    }

    _escrever(rec, d, hit, w, dura) {
        const c = rec.cel, o = d * 4;
        const dt = this._t - c[o + 2];
        if (dt >= 64) {                                   // validade: aplica o esquecimento acumulado
            const f = Math.exp(-dt * this._k);
            c[o] *= f; c[o + 1] *= (c[o + 3] === 1 ? f * f : f);
            c[o + 2] = this._t;
        }
        if (hit) c[o] += w; else c[o + 1] += w;
        { const r = rec.rc, q = d * 3, dr = this._t - r[q + 2]; if (dr > 0) { const f = Math.exp(-dr * this._kf); r[q] *= f; r[q + 1] *= f; } r[q + 2] = this._t; if (hit) r[q] += w; else r[q + 1] += w; }
        rec.nObs++;
        // v1.1: restrição = REGRESSÃO frente ao próprio passado; volta = PROVA (N acertos difíceis), linha de base recuperada ou evidência que esmaece
        if (c[o + 3] === 1) {
            if (hit && dura && rec.pv[d] < 255) rec.pv[d]++;
            if (hit) { const L = this._ler(rec, d); if (this._voltou(rec, d, L)) this._recupera(rec, d); }
        } else if (!hit && c[o + 1] > N2 * 0.3) {
            const L = this._ler(rec, d);
            if (L.n >= N2) { const R = this._regrediu(rec, d, L); if (R) this._restringe(rec, d, R); }
        }
    }

    // desempenho RECENTE (meia-vida curta): {n, lb}; é isto que se compara com o próprio passado
    _recente(rec, d) {
        const r = rec.rc, q = d * 3, f = this._t > r[q + 2] ? Math.exp(-(this._t - r[q + 2]) * this._kf) : 1;
        const ea = r[q] * f, eb = r[q + 1] * f, A = 1 + ea, B = 1 + eb, S = A + B;
        const se = Math.sqrt(A * B / (S * S * (S + 1)));
        return { n: ea + eb, mean: A / S, lb: A / S - se, ub: A / S + se };
    }
    _regrediu(rec, d, L) {
        const b = rec.bl, o = d * 4;
        if (!(b[o] > 0) || (this._t - b[o + 2]) < BASE_IDADE) return false;
        const R = this._recente(rec, d);
        // conservador (justiça): o LIMITE SUPERIOR do desempenho recente precisa estar abaixo do passado próprio por REGRESSAO; ruído de amostra pequena não restringe
        return (R.n >= N1 && R.ub < b[o] - REGRESSAO) ? R : null;
    }
    _voltou(rec, d, L) {
        const b = rec.bl, o = d * 4;
        if (rec.pv[d] >= PROVA_N || L.n < N1) return true;
        if (!(b[o] > 0)) return false;
        const R = this._recente(rec, d);
        return R.n >= N1 && R.mean >= b[o] - VOLTA_FOLGA;
    }

    _restringe(rec, d, R) {
        rec.cel[d * 4 + 3] = 1;
        rec.pv[d] = 0; rec.bl[d * 4 + 3] = this._t;
        this._c.restricoes++;
        this._log('restricao', rec.id, d, `regressão em ${NOMES[d]} (desempenho recente ≤ ${R.ub.toFixed(2)} vs. o próprio passado ${rec.bl[d * 4].toFixed(2)}); volta ao nível 0; sai com ${PROVA_N} acertos difíceis`);
    }

    _recupera(rec, d) {
        const o = d * 4;
        rec.cel[o + 3] = 0;
        if (rec.bl[o + 3] > 0) { this._c.restrTicks += this._t - rec.bl[o + 3]; this._c.restrFim++; }
        rec.pv[d] = 0; rec.bl[o + 3] = 0;
        this._c.recuperacoes++;
        this._log('recuperacao', rec.id, d, `restrição em ${NOMES[d]} encerrada`);
    }

    _log(tipo, id, d, txt) {
        this._eventos.push({ t: this._t, tipo, id, dom: d >= 0 ? NOMES[d] : '', txt });
        if (this._eventos.length > 40) this._eventos.shift();
    }

    _topoAtualiza(d, id, lb, n) {
        const T = this._topo[d];
        let ix = -1, imin = 0, vmin = 9;
        for (let i = 0; i < T.length; i++) {
            if (T[i].id === id) { ix = i; break; }
            if (T[i].lb < vmin) { vmin = T[i].lb; imin = i; }
        }
        if (ix >= 0) { T[ix].lb = lb; T[ix].n = n; return; }
        if (T.length < TOPK) { T.push({ id, lb, n }); return; }
        if (lb > vmin) T[imin] = { id, lb, n };
    }

    _topoRetira(d, id) {
        const T = this._topo[d];
        for (let i = 0; i < T.length; i++) if (T[i].id === id) { T.splice(i, 1); return; }
    }

    // Revisão completa de um registro: restrição por esquecimento, índice de descoberta, especialidade.
    _varre(rec) {
        const c = rec.cel;
        let melhor = -1, mLb = -9;
        for (let d = 0; d < D; d++) {
            const o = d * 4;
            if (c[o] + c[o + 1] < 0.5) { if (c[o + 3] === 1) c[o + 3] = 0; this._topoRetira(d, rec.id); continue; }
            const L = this._ler(rec, d);
            if (L.restr && this._voltou(rec, d, L)) { this._recupera(rec, d); continue; }
            if (!L.restr && L.n >= N1) {                                      // linha de base própria: média lenta do próprio limite inferior (congelada em restrição)
                const b = rec.bl;
                if (b[o] === 0) { b[o] = L.lb; b[o + 1] = this._t; b[o + 2] = this._t; }
                else { const dtb = this._t - b[o + 1]; if (dtb > 0) { b[o] += (1 - Math.exp(-dtb / BASE_T)) * (L.lb - b[o]); b[o + 1] = this._t; } }
            }
            if (L.tier >= 1) {
                this._topoAtualiza(d, rec.id, L.lb, L.n);
                if (L.tier >= 2 && L.lb > mLb) { mLb = L.lb; melhor = d; }
            } else {
                this._topoRetira(d, rec.id);
            }
        }
        if (melhor !== rec.esp) {
            if (melhor >= 0) {
                this._c.especialidades++;
                this._log('especialidade', rec.id, melhor, `especialidade agora: ${NOMES[melhor]} (limite inferior ${mLb.toFixed(2)})`);
            }
            rec.esp = melhor;
        }
    }

    // ------------------------------------------------------------ S1: o mundo verifica
    // exprString/keys: a proposição; hit: valeu neste tick; nEval: quantas vezes ESTA entidade já a avaliou.
    observar(ent, exprString, keys, hit, nEval) {
        if (typeof window !== 'undefined' && window.themisOff === true) return;
        const m = this._domsDe(keys);
        if (m === 0) return;                                           // sem variável do mundo = sem evidência
        if (this._vis[17] === this._stamp) {                           // a proposição usa sentidos do mundo externo: registrar o interesse
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i]; if (this._memo.get(k) !== 17) continue;
                let e = this._ext.get(k);
                if (!e) { if (this._ext.size >= 64) continue; e = [0, 0]; this._ext.set(k, e); }
                e[1]++; if (hit) e[0]++;
            }
        }
        const rec = this._rec(ent.id, true);
        if (this._vis[DOM_EXT] === this._stamp) this._guardaProp(rec, DOM_EXT, exprString, keys, hit);
        const pop = this._popExpr.get(exprString);
        const pe = pop ? (pop[0] + 1) / (pop[1] + 2) : 0.5;            // taxa-base da população NESTA proposição (antes desta obs.)
        const dif = hit ? clamp(1.5 * (1 - pe), 0.05, 1) : clamp(1.5 * pe, 0.10, 1);
        const rep = nEval > REP_TETO ? REP_TETO / nEval : 1;
        const w = dif * rep / m;
        const dura = hit && rep === 1 && !!pop && pop[1] >= 3 && pe <= 0.5;   // prova de volta: acerto numa proposição que a população NÃO acerta fácil
        const contaPop = nEval <= REP_TETO;
        this._c.obs1++;
        // auditoria: 1 em cada 4 observações compara "previsão com currículo" × "previsão só pela dificuldade"
        if ((this._c.obs1 & 3) === 0) {
            const L = this._ler(rec, this._buf[0]);
            if (L.n >= N1) {
                const pb = clamp(pe, 0.02, 0.98), pm = clamp(pe + (L.mean - L.chance), 0.02, 0.98), y = hit ? 1 : 0;
                this._bM = this._bM * 0.999 + w * (pm - y) * (pm - y);
                this._bB = this._bB * 0.999 + w * (pb - y) * (pb - y);
                this._bC++;
            }
        }
        for (let i = 0; i < m; i++) {
            const d = this._buf[i];
            if (rec.av !== null) this._avalia(rec, d, hit, w);
            this._escrever(rec, d, hit, w, dura);
            if (contaPop) this._gAdd(d, hit, w);
        }
        if (contaPop) {
            if (pop) { pop[1]++; if (hit) pop[0]++; }
            else {
                if (this._popExpr.size >= POP_TETO) {                  // eviction em lote (Map preserva ordem de inserção)
                    let k = 0;
                    for (const key of this._popExpr.keys()) { this._popExpr.delete(key); if (++k >= 2000) break; }
                }
                this._popExpr.set(exprString, [hit ? 1 : 0, 1]);
            }
        }
        if ((rec.nObs & 15) === 0) this._varre(rec);
    }

    // v1.2: placar de verdade de cada proposição (no domínio externo). O(PROP_MAX).
    _guardaProp(rec, d, s, keys, hit) {
        let P = rec.pr; if (P === null) P = rec.pr = [];
        for (let i = 0; i < P.length; i++) {
            const p = P[i];
            if (p.d === d && p.s === s) { p.n++; if (hit) p.h++; p.t = this._t; if (p.n > 400) { p.n *= 0.5; p.h *= 0.5; } return; }
        }
        const it = { d, s, k: keys.slice(0, 32), h: hit ? 1 : 0, n: 1, t: this._t };
        if (P.length < PROP_MAX) { P.push(it); return; }
        let iv = 0;
        for (let i = 1; i < P.length; i++) if (P[i].n < P[iv].n || (P[i].n === P[iv].n && P[i].t < P[iv].t)) iv = i;
        P[iv] = it;                                                     // sai a de menos evidência
    }

    // A "lei" mais firme da cidadã no domínio: a proposição cuja taxa de verdade mais se afasta do acaso (limite de 1 erro-padrão).
    // Precisa de ≥ 8 testes e de ter sido testada nos últimos 3000 ticks. Devolve null se nenhuma é firme.
    melhorProposicao(id, dominio = 'externo') {
        const d = this._dIdx(dominio), rec = this._regs.get(id);
        if (d === undefined || !rec || !rec.pr) return null;
        let best = null, bs = 0.15;
        for (const p of rec.pr) {
            if (p.d !== d || p.n < 8 || this._t - p.t > 3000) continue;
            const A = 1 + p.h, B = 1 + p.n - p.h, S = A + B, m = A / S, se = Math.sqrt(A * B / (S * S * (S + 1)));
            const sc = Math.abs(m - 0.5) - se;
            if (sc > bs) { bs = sc; best = { expr: p.s, keys: p.k, verdade: m > 0.5, taxa: +m.toFixed(3), n: Math.round(p.n), texto: textoExpr(p.k) }; }
        }
        return best;
    }

    // O alvo acertou/errou no domínio: quem deu aval a ele assume o resultado (risco compartilhado).
    _avalia(recAlvo, d, hit, w) {
        const av = recAlvo.av, o = d * 4;
        for (let s = 0; s < 2; s++) {
            const id = av[o + s * 2];
            if (!id || this._t - av[o + s * 2 + 1] > AVAL_VALE) continue;
            const ra = this._regs.get(id);
            if (!ra) continue;
            if (hit) ra.ca += 0.5 * w; else ra.cb += 1.0 * w;           // aval furado dói mais do que aval certo ajuda
            if (ra.ca + ra.cb > 60) { ra.ca *= 0.9; ra.cb *= 0.9; }
        }
    }

    // ---------------------------------------------------- S2: um par verifica (testemunho)
    testemunhar(wit, targetId, keys, correct) {
        if (typeof window !== 'undefined' && window.themisOff === true) return;
        this._f.julgado++;
        const m = this._domsDe(keys);
        if (m === 0 || wit.id === targetId) return;
        const rw = this._rec(wit.id, true);
        const rt = this._rec(targetId, true);
        if (rw.epW !== this._epoca) { rw.epW = this._epoca; rw.nW = 0; }
        rw.nW++;
        const orc = 3 / (rw.nW > 3 ? rw.nW : 3);                       // orçamento de aval: 3 plenos por época, depois diluído
        const pk = wit.id + '|' + targetId;
        const np = (this._pares.get(pk) || 0) + 1;
        this._pares.set(pk, np);
        let cred = 0.4 + 0.6 * (rw.ca / (rw.ca + rw.cb));              // avalista que errou avais pesa menos (piso 0,4)
        for (let i = 0; i < m; i++) if (rw.cel[this._buf[i] * 4 + 3] === 1) { cred *= 0.5; break; }   // em restrição: "recomendações valem menos por um tempo"
        const w = S2_BASE * orc * cred / Math.sqrt(np) / m;
        this._c.obs2++;
        for (let i = 0; i < m; i++) {
            const d = this._buf[i];
            this._escrever(rt, d, correct, w, false);
            this._gAdd(d, correct, w);
            if (correct) this._daAval(rt, d, wit.id);
        }
        if ((rt.nObs & 15) === 0) this._varre(rt);
    }

    _daAval(recAlvo, d, avalistaId) {
        if (recAlvo.av === null) recAlvo.av = new Float64Array(D * 4);
        const av = recAlvo.av, o = d * 4;
        if (av[o] === avalistaId) { av[o + 1] = this._t; return; }
        if (av[o + 2] === avalistaId) { av[o + 3] = this._t; return; }
        const s = av[o + 1] <= av[o + 3] ? 0 : 1;                      // troca o aval mais antigo
        av[o + s * 2] = avalistaId; av[o + s * 2 + 1] = this._t;
    }

    // ------------------------------------------- roteamento: mérito + folga + rodízio
    // cands: vizinhas já aprovadas pela confiança PESSOAL de quem propõe (o "bairro"). Devolve a escolhida ou null.
    escolherParceiro(prop, cands, keys) {
        if (typeof window !== 'undefined' && window.themisOff === true) return null;
        if (!cands || cands.length === 0) return null;
        const m = this._domsDe(keys);
        const len = cands.length;
        const n = len < MAX_CAND ? len : MAX_CAND;
        const off = len > MAX_CAND ? (Math.random() * len) | 0 : 0;
        const sc = this._sc;
        let tot = 0;
        for (let i = 0; i < n; i++) {
            const ix = (off + i) % len;
            this._ix[i] = ix;
            const e = cands[ix];
            const rec = this._regs.get(e.id);
            let mer = 0.5, tier = 0;
            if (m > 0 && rec) {
                let s = 0, tmax = 0;
                for (let j = 0; j < m; j++) {
                    const L = this._ler(rec, this._buf[j]);
                    s += (L.n >= N1 && !L.restr) ? clamp(0.5 + 2.5 * L.skill, 0, 1) : 0.5;   // sem prova = neutro, não punido
                    if (L.tier > tmax) tmax = L.tier;
                }
                mer = s / m; tier = tmax;
            }
            let carga = 0;
            if (rec) { const dtc = this._t - rec.tCarga; carga = dtc > 0 ? rec.carga * Math.exp(-dtc * this._kc) : rec.carga; }
            const rot = 1 / (1 + carga * 0.5);                          // rodízio: quanto mais serviu há pouco, menos sobra
            const livre = e.currentProblemToSolve ? 0 : 1;              // disponibilidade
            let s = livre ? (0.5 * mer + 0.2 + 0.3 * rot + (tier === 0 ? 0.25 : 0)) : 0.02;   // +0,25 = cadeira do novato ("sem fama, com chance")
            if (livre && typeof e.energy === 'number' && e.energy < 15) s *= 0.5;
            sc[i] = s; tot += s;
        }
        let r = Math.random() * tot, pick = n - 1;
        for (let i = 0; i < n; i++) { r -= sc[i]; if (r <= 0) { pick = i; break; } }
        const alvo = cands[this._ix[pick]];
        // contabilidade (glass-box): nível da escolhida no domínio da tarefa
        const ra = this._rec(alvo.id, true);
        const dtc = this._t - ra.tCarga;
        ra.carga = (dtc > 0 ? ra.carga * Math.exp(-dtc * this._kc) : ra.carga) + 1;
        ra.tCarga = this._t;
        ra.nServ++;
        let tr = 0;
        if (m > 0) for (let j = 0; j < m; j++) { const L = this._ler(ra, this._buf[j]); if (L.tier > tr) tr = L.tier; }
        this._c.escolhas++;
        if (m > 0) this._c.porTier[tr]++; else this._c.semDominio++;   // sem variável do mundo: só folga + rodízio
        return alvo;
    }

    // "Sem fama, mas com chance": vizinha sem nível ≥ 1 em NENHUM domínio entra no sorteio mesmo sem confiança pessoal prévia.
    calibrando(id) {
        if (typeof window !== 'undefined' && window.themisOff === true) return false;
        const rec = this._regs.get(id);
        if (!rec) return true;
        const c = rec.cel;
        for (let d = 0; d < D; d++) {
            if (c[d * 4] + c[d * 4 + 1] < 0.5) continue;
            if (this._ler(rec, d).tier >= 1) return false;
        }
        return true;
    }

    // ------------------------------------------------------------------ API pública
    // Funil do S2: o HTML avisa cada etapa (aceito / recusado por ocupação / respondido); "julgado" conta aqui mesmo.
    funil(etapa) { if (this._f[etapa] !== undefined) this._f[etapa]++; }
    _dIdx(dominio) { return typeof dominio === 'number' ? dominio : D_IDX.get(dominio); }

    // Peso de confiança [0..1] da entidade neste domínio. critico=true: "nenhuma tarefa crítica a quem não provou competência".
    peso(id, dominio, critico = false) {
        const d = this._dIdx(dominio);
        const rec = this._regs.get(id);
        if (d === undefined || !rec) return critico ? 0 : 0.5;
        const L = this._ler(rec, d);
        if (L.restr) return critico ? 0 : 0.25;
        if (critico && L.tier < 2) return 0;
        if (L.n < N1) return 0.5;
        return clamp(0.5 + 2.5 * L.skill, 0.05, 1);
    }

    nivel(id, dominio) {
        const d = this._dIdx(dominio);
        const rec = this._regs.get(id);
        if (d === undefined || !rec) return 0;
        return this._ler(rec, d).tier;
    }

    especialidade(id) {
        const rec = this._regs.get(id);
        if (!rec) return null;
        let b1 = -1, v1 = -9, v2 = -9;
        for (let d = 0; d < D; d++) {
            if (rec.cel[d * 4] + rec.cel[d * 4 + 1] < 0.5) continue;
            const L = this._ler(rec, d);
            if (L.tier < 1) continue;
            if (L.lb > v1) { v2 = v1; v1 = L.lb; b1 = d; } else if (L.lb > v2) v2 = L.lb;
        }
        if (b1 < 0) return null;
        const L = this._ler(rec, b1);
        return { dominio: NOMES[b1], nivel: L.tier, limiteInferior: +L.lb.toFixed(3), vantagem: +L.skill.toFixed(3), dominancia: v2 > -9 ? +(v1 - v2).toFixed(3) : null };
    }

    // Descoberta sem varrer a população: as k melhores do domínio (índice bounded).
    procurar(dominio, k = 3) {
        const d = this._dIdx(dominio);
        if (d === undefined) return [];
        const out = [];
        for (const it of this._topo[d]) {
            const rec = this._regs.get(it.id);
            if (!rec) continue;
            const L = this._ler(rec, d);
            if (L.tier < 1) continue;
            out.push({ id: it.id, limiteInferior: +L.lb.toFixed(3), nivel: L.tier, evidencia: +L.n.toFixed(1) });
        }
        out.sort((a, b) => b.limiteInferior - a.limiteInferior);
        return out.slice(0, k);
    }

    removeEntity(id) {
        const r = this._regs.get(id);
        if (!r) return;
        const lista = this._lista, ult = lista.pop();
        if (ult !== r) { lista[r.ix] = ult; ult.ix = r.ix; }
        this._regs.delete(id);
        for (let d = 0; d < D; d++) this._topoRetira(d, id);
        if (this._cursor >= lista.length) this._cursor = 0;
    }

    _gc() {
        const w = (typeof window !== 'undefined') ? window.world : null;
        const vivos = w && w.allEntities;
        if (!vivos || typeof vivos.has !== 'function') return;
        let rem = 0;
        for (let i = this._lista.length - 1; i >= 0; i--) {
            const r = this._lista[i];
            if (!vivos.has(r.id)) { this.removeEntity(r.id); rem++; }
        }
        this._c.gcRemovidos += rem;
    }

    _resetar() {
        this._regs.clear(); this._lista.length = 0; this._cursor = 0;
        this._popExpr.clear(); this._pares.clear();
        this._gE.fill(0); this._gT.fill(0); this._ch.fill(0.5);
        for (let d = 0; d < D; d++) this._topo[d].length = 0;
        this._bM = 0; this._bB = 0; this._bC = 0;
        this._eventos.length = 0;
        this._epoca = 0;
    }

    tick(f) {
        if (typeof f !== 'number') return;
        try {
            if (f + 2000 < this._t) this._resetar();                     // frameCount voltou: nova simulação
            this._t = f;
            const ep = (f / EPOCA) | 0;
            if (ep !== this._epoca) { this._epoca = ep; this._pares.clear(); this._gc(); }
            if ((f & 15) === 0) this._chanceAtualiza();
            const n = this._lista.length;
            for (let i = 0; i < 8 && n > 0; i++) {
                if (this._cursor >= this._lista.length) this._cursor = 0;
                this._varre(this._lista[this._cursor++]);
            }
            if (typeof document !== 'undefined') {
                if (!this._ui && f >= 5) this._montaPainel();
                else if (this._ui && !this._ui.ancorado && (f % 120) === 0) this._ancora();
            }
        } catch (e) {
            this._c.erros++; this._c.ultimoErro = String(e && e.message).slice(0, 120);
        }
    }

    // ------------------------------------------------------------- Glass-Box
    getDiagnostics() { return this.getStats(); }

    getStats() {
        const regs = this._lista, N = regs.length;
        // histograma de níveis e Gini do uso em amostra (≤ 300 registros a partir de um ponto rotativo)
        const amostra = N < 300 ? N : 300;
        const ini = N > 300 ? (this._t % N) : 0;
        const h = [0, 0, 0, 0];
        let restritos = 0, restrIdade = 0, restrN = 0;
        const us = [];
        for (let i = 0; i < amostra; i++) {
            const rec = regs[(ini + i) % N];
            let tmax = 0, restr = false;
            for (let d = 0; d < D; d++) {
                if (rec.cel[d * 4] + rec.cel[d * 4 + 1] < 0.5) continue;
                const L = this._ler(rec, d);
                if (L.tier > tmax) tmax = L.tier;
                if (L.restr) { restr = true; restrN++; restrIdade += this._t - rec.bl[d * 4 + 3]; }
            }
            h[tmax]++; if (restr) restritos++;
            us.push(rec.nServ);
        }
        us.sort((a, b) => a - b);
        let soma = 0, acum = 0;
        for (let i = 0; i < us.length; i++) { soma += us[i]; acum += (i + 1) * us[i]; }
        const gini = (us.length > 1 && soma > 0) ? (2 * acum) / (us.length * soma) - (us.length + 1) / us.length : null;
        const esc = this._c.escolhas - this._c.semDominio;
        return {
            versao: this.versao, tick: this._t, registros: N, amostra,
            evidencia: { mundo: this._c.obs1, testemunho: this._c.obs2, proposicoesNaBase: this._popExpr.size },
            niveis: h, restritos,
            restricaoVigente: { celulas: restrN, idadeMediaTicks: restrN ? Math.round(restrIdade / restrN) : null },
            tempoMedioRestricaoEncerradaTicks: this._c.restrFim ? Math.round(this._c.restrTicks / this._c.restrFim) : null,
            externo: [...this._ext].map(([chave, e]) => ({ chave, usos: e[1], acerto: e[0] / e[1] })).sort((a, b) => b.usos - a.usos).slice(0, 8),
            funil: { propostos: this._c.escolhas, aceitos: this._f.aceito, recusadosOcupada: this._f.recusado, respondidos: this._f.respondido, julgados: this._f.julgado },
            brierSkill: (this._bB > 0 && this._bC >= 30) ? +(1 - this._bM / this._bB).toFixed(3) : null,
            brierN: this._bC,
            roteamento: {
                escolhas: this._c.escolhas, comDominio: esc, porNivel: this._c.porTier.slice(),
                pctCalibrando: esc ? +(100 * this._c.porTier[0] / esc).toFixed(1) : null,
                giniUso: gini === null ? null : +gini.toFixed(3)
            },
            restricoes: this._c.restricoes, recuperacoes: this._c.recuperacoes, especialidades: this._c.especialidades,
            gcRemovidos: this._c.gcRemovidos, erros: this._c.erros, ultimoErro: this._c.ultimoErro,
            chance: NOMES.map((n, d) => [n, +this._ch[d].toFixed(3)]),
            topo: NOMES.map((n, d) => [n, this._topo[d].length]),
            eventos: this._eventos.slice(-12)
        };
    }

    explicar(id) {
        const rec = this._regs.get(id);
        if (!rec) return `Ent ${id}: sem registro (nunca gerou evidência verificável).`;
        const out = [];
        const esp = this.especialidade(id);
        out.push(`Ent ${id} — ${rec.nObs} observações, serviu ${rec.nServ} experimento(s) mental(is).`);
        out.push(esp ? `Especialidade: ${esp.dominio} (nível ${esp.nivel}, limite inferior ${esp.limiteInferior}, vantagem sobre a chance ${esp.vantagem}${esp.dominancia !== null ? ', folga p/ 2º domínio ' + esp.dominancia : ''}).`
                     : 'Ainda sem especialidade: nenhum domínio passou do nível 0 (calibração).');
        for (let d = 0; d < D; d++) {
            if (rec.cel[d * 4] + rec.cel[d * 4 + 1] < 0.5) continue;
            const L = this._ler(rec, d);
            out.push(`  ${NOMES[d]}: evidência ${L.n.toFixed(1)}, taxa ${L.mean.toFixed(2)} (limite inferior ${L.lb.toFixed(2)}) vs chance ${L.chance.toFixed(2)} → vantagem ${L.skill.toFixed(2)}, nível ${L.tier}${L.restr ? `, EM RESTRIÇÃO há ${this._t - rec.bl[d * 4 + 3]} ticks (prova ${rec.pv[d]}/${PROVA_N} acertos difíceis; passado próprio ${rec.bl[d * 4].toFixed(2)})` : (rec.bl[d * 4] > 0 ? `, passado próprio ${rec.bl[d * 4].toFixed(2)}` : '')}`);
        }
        out.push(`Como avalista: credibilidade ${(rec.ca / (rec.ca + rec.cb)).toFixed(2)} (avais que deram certo × errado).`);
        return out.join('\n');
    }

    // ------------------------------------------------------------- painel (auto-injeta, sem tocar o HTML)
    _montaPainel() {
        const css = (el, o) => { for (const k in o) el.style[k] = o[k]; };
        const btn = document.createElement('button');
        btn.id = 'themis-btn'; btn.textContent = '⚖️ Themis';
        css(btn, { font: '12px monospace', padding: '4px 8px', margin: '4px', background: '#1d2b3a', color: '#cfe3ff', border: '1px solid #3b5878', borderRadius: '6px', cursor: 'pointer' });
        const box = document.createElement('div');
        box.id = 'themis-box';
        css(box, { display: 'none', position: 'fixed', left: '8px', bottom: '48px', width: 'min(94vw, 440px)', maxHeight: '68vh', overflow: 'auto', zIndex: '99998', background: 'rgba(12,18,26,0.96)', color: '#cfe3ff', border: '1px solid #3b5878', borderRadius: '8px', padding: '8px', font: '11px/1.35 monospace' });
        const pre = document.createElement('pre');
        css(pre, { margin: '0 0 6px 0', whiteSpace: 'pre-wrap' });
        const inp = document.createElement('input');
        inp.type = 'number'; inp.placeholder = 'ID da entidade';
        css(inp, { font: '11px monospace', width: '110px', marginRight: '6px' });
        const go = document.createElement('button');
        go.textContent = 'Explicar';
        css(go, { font: '11px monospace' });
        const sai = document.createElement('pre');
        css(sai, { margin: '6px 0 0 0', whiteSpace: 'pre-wrap', color: '#9fd6a8' });
        go.onclick = () => { sai.textContent = this.explicar(Number(inp.value)); };
        box.append(pre, inp, go, sai);
        btn.onclick = () => {
            this._aberto = !this._aberto;
            box.style.display = this._aberto ? 'block' : 'none';
            if (this._aberto) { this._pinta(); this._timer = setInterval(() => { if (this._aberto) this._pinta(); }, 2000); }
            else if (this._timer) { clearInterval(this._timer); this._timer = null; }
        };
        document.body.appendChild(box);
        this._ui = { btn, box, pre, ancorado: false, tentativas: 0 };
        this._ancora();
    }

    // Procura o botão do Athena/Harpocrates e se encaixa logo abaixo; sem achar, fica fixo no canto.
    _ancora() {
        const u = this._ui;
        if (!u || u.ancorado) return;
        u.tentativas++;
        const bs = document.querySelectorAll('button');
        let ref = null;
        for (let i = 0; i < bs.length; i++) {
            const b = bs[i];
            if (b === u.btn) continue;
            if (/harpocrates|athena/i.test((b.textContent || '').replace(/\./g, ''))) ref = b;
        }
        if (ref && ref.parentNode) {
            ref.insertAdjacentElement('afterend', u.btn);
            u.ancorado = true;
        } else if (!u.btn.isConnected) {
            u.btn.style.position = 'fixed'; u.btn.style.left = '8px'; u.btn.style.bottom = '8px'; u.btn.style.zIndex = '99998';
            document.body.appendChild(u.btn);
        }
        if (u.tentativas >= 12) u.ancorado = true;                       // desiste de procurar (fica onde está)
    }

    _pinta() {
        if (!this._ui) return;
        const s = this.getStats();
        const L = [];
        L.push(`T.H.E.M.I.S. ${s.versao} — tick ${s.tick} — ${s.registros} cidadãs registradas`);
        L.push(`Evidência: mundo ${s.evidencia.mundo} · testemunho ${s.evidencia.testemunho} · base de dificuldade ${s.evidencia.proposicoesNaBase} proposições`);
        L.push(`Níveis (amostra ${s.amostra}): N0 ${s.niveis[0]} · N1 ${s.niveis[1]} · N2 ${s.niveis[2]} · N3 ${s.niveis[3]} · em restrição ${s.restritos}`);
        L.push(s.brierSkill === null
            ? `PROVA: ainda sem amostra (precisa de ≥30 previsões; tem ${s.brierN})`
            : `PROVA (Brier skill): ${s.brierSkill} em ${s.brierN} previsões — ${s.brierSkill > 0 ? 'o currículo prevê acerto ALÉM da dificuldade da proposição' : 'o currículo ainda NÃO prevê melhor que a dificuldade sozinha'}`);
        const r = s.roteamento;
        L.push(`Experimentos mentais roteados: ${r.escolhas} · para nível 0/1/2/3: ${r.porNivel.join('/')} · alvos sem prova no domínio ${r.pctCalibrando ?? '-'}% (de ${r.comDominio} com domínio) · Gini do uso ${r.giniUso ?? '-'} (0 = todas servem igual)`);
        L.push(`Interesse no mundo externo (o que as entidades tentam usar): ${s.externo.length ? s.externo.map(e => `${e.chave} ${e.usos}× (${Math.round(e.acerto * 100)}% úteis)`).join(' · ') : 'nada ainda'}`);
        L.push(`Funil S2: propostos ${s.funil.propostos} → aceitos ${s.funil.aceitos} (recusados por ocupação ${s.funil.recusadosOcupada}) → respondidos ${s.funil.respondidos} → julgados ${s.funil.julgados}`);
        L.push(`Restrições vigentes ${s.restricaoVigente.celulas} (há ${s.restricaoVigente.idadeMediaTicks ?? '-'} ticks em média) · encerradas levaram ${s.tempoMedioRestricaoEncerradaTicks ?? '-'} ticks`);
        L.push(`Restrições ${s.restricoes} · recuperações ${s.recuperacoes} · especialidades ${s.especialidades} · coletadas pelo GC ${s.gcRemovidos} · erros ${s.erros}${s.ultimoErro ? ' (' + s.ultimoErro + ')' : ''}`);
        L.push('— Domínio: chance da população · melhor da vizinhança —');
        for (let d = 0; d < D; d++) {
            const top = this.procurar(d, 1)[0];
            L.push(`${NOMES[d].padEnd(11)} chance ${this._ch[d].toFixed(2)}  ${top ? '#' + top.id + ' lim.inf. ' + top.limiteInferior + ' N' + top.nivel : '—'}`);
        }
        L.push('— Eventos recentes —');
        for (const e of s.eventos.slice(-8)) L.push(`t${e.t} #${e.id} ${e.tipo}: ${e.txt}`);
        this._ui.pre.textContent = L.join('\n');
    }
}
