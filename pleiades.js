// ============================================================================
// P.L.E.I.A.D.E.S. — rede de sensores com reputação · js/modules/OMEGA/pleiades.js · v1.1 [2026-10-27]
//   fatia 1: TEMPO + REDE · fatia 2: BATERIA + CAMPO MAGNÉTICO · gancho da A.D.U.A.N.A.
//
// Analogia: uma feira de balanças. Três tipos de balança:
//   • TEMPO é balança conferida com o PESO-PADRÃO: cada aparelho mede seu desvio de relógio contra a hora do relay
//     (NTP simplificado) e os pares se conferem: "a hora de referência que você diz ter bate com a que eu medi?".
//   • RTT até o relay é balança conferida por SOMA: RTT(eu→par pelo relay) ≈ RTT(eu→relay) + RTT(par→relay). Quem
//     alega 5 ms enquanto o caminho real leva 300 ms é pego. (Só vale quando a conversa passa pelo relay.)
//   • CF, BATERIA e CAMPO MAGNÉTICO são balanças que ninguém mais vê: só se confere se são PLAUSÍVEIS. É aqui que a
//     A.D.U.A.N.A. (as entidades) decide o que entra — ela aprende o ofício nas balanças conferíveis (onde há gabarito)
//     e só manda nas não conferíveis depois de provar que não barra honesto.
// Cada aparelho é um vigia visto de um ponto diferente. O que fica PROVADO e o que é só PLAUSÍVEL está rotulado em resumo().
//
// Privacidade (padrão): só sai valor ARREDONDADO — RTT 10 ms, bateria 10 %, perturbação magnética 0,1. Nunca sai
//   posição, direção da bússola, emissores de rádio ou leitura bruta. (A "bússola" daqui não é o norte: é o quanto o
//   campo magnético local foge da linha de base — ímãs, metal, eletrônicos perto.)
// Limites honestos: com 2 aparelhos só dá para saber que DISCORDAM; o teste de soma do RTT é grosseiro; ids novos são
//   grátis (peso por nível freia, não impede conluio).
//
// v1.1 (2026-10-27):
//   • CORREÇÃO: guardar fetch como método (this.buscar = fetch) e chamá-lo como this.buscar(...) lança
//     "Illegal invocation" no navegador (o fetch exige this = window). O Node não liga → o teste passava e o celular
//     ficava "sem medida da hora" para sempre, com o erro engolido. Agora: chamada com this correto + erro no painel.
//   • fatia 2: sensor.bat (nível 10 %, carregando) e sensor.mag (perturbação 0,1, só se a bússola estiver viva);
//     sentidos novos env_rede_bat / env_rede_mag (+ Ω_).
//   • agrega({sem, forca}) puro → a aduana compara o mundo SEM e COM cada leitura.
//   • teste de adulteração: localStorage.pleiadesMentir = '1' faz ESTE aparelho mentir (hora +5 s, RTT 5 ms, bateria 100 %).
// Depende só do Node da Koinonia (serve/request com check). Não toca o mundo das entidades; só entrega sentidos (getContextAugment).
// ============================================================================
const q = (v, b) => Math.round(v / b) * b;
const q1 = v => Math.round(v * 10) / 10;                 // passo 0,1 sem lixo de ponto flutuante
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const PESO_NIVEL = [0.25, 1, 2, 3];
const CANAIS_SENTIDO = ['rtt', 'bat', 'mag'];             // leituras de pares que MOVEM sentidos (são as que a aduana julga)
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const medPond = (v, w) => {
    const p = v.map((x, i) => [x, w[i]]).filter(e => e[1] > 0).sort((a, b) => a[0] - b[0]);
    const tot = p.reduce((s, e) => s + e[1], 0); if (!tot) return NaN;
    let acc = 0; for (const e of p) { acc += e[1]; if (acc >= tot / 2) return e[0]; } return p[p.length - 1][0];
};
const mente = () => { try { return globalThis.localStorage?.getItem('pleiadesMentir') === '1'; } catch (_) { return false; } };
export function horaDeRelay(url) { const u = new URL(String(url).replace(/^ws/, 'http')); return u.origin + '/hora' + u.pathname; }

export class PLEIADES {
    constructor(node, { horaUrl, relayAberto = () => true, fontes = {}, log = () => {}, cicloMs = 30000, buscar = (u, o) => globalThis.fetch(u, o), aduana = null } = {}) {
        this.buscar = buscar;                    // v1.1: arrow → o fetch roda com o this certo (ver cabeçalho)
        this.versao = '1.1 (2026-10-27)';
        this.node = node; this.horaUrl = horaUrl; this.relayAberto = relayAberto; this.fontes = fontes; this.log = log;
        this.aduana = aduana;                    // { enfileira(item) , veredito(id, canal) } — opcional
        this.amostras = []; this.eu = null;
        this.mapa = new Map();                 // id -> {nome, via, tempo, rtt, cf, bat, mag, t}
        this.conf = 0.5;                        // EMA de acertos das verificações (0–1)
        this.suspeita = '';
        this._cf = new Map(); this._batHist = new Map();
        this._bat = null;                       // minha bateria {nivel, carregando, t}
        this.c = { ciclos: 0, verificadas: 0, acertos: 0, falhas: 0, semBase: 0, naoVerificaveis: 0, horaFalhas: 0, horaErro: '', erros: 0, ultimoErro: '' };
        this._ctx = {};
        for (const k of ['rtt', 'relay_visto', 'relogio', 'confianca', 'bat', 'mag']) { const v = k === 'confianca' ? 0.5 : 0; this._ctx['env_rede_' + k] = v; this._ctx['Ω_rede_' + k] = v; }
        this._serve();
        this._lerBateria();
        const t0 = setTimeout(() => this.ciclo().catch(e => this._erro(e)), 3000);
        const t = setInterval(() => this.ciclo().catch(e => this._erro(e)), cicloMs);
        for (const x of [t0, t]) if (x && x.unref) x.unref();
        this._timers = [t0, t];
    }
    parar() { for (const t of this._timers) { clearTimeout(t); clearInterval(t); } }
    _erro(e) { this.c.erros++; this.c.ultimoErro = String(e?.message || e).slice(0, 80); }

    // ---------------------------------------------------------------- minha bateria (Battery API, quando existe)
    _lerBateria() {
        const nav = globalThis.navigator;
        if (!nav || typeof nav.getBattery !== 'function') return;
        nav.getBattery().then(b => {
            const up = () => { this._bat = { nivel: b.level, carregando: !!b.charging, t: Date.now() }; };
            up(); b.addEventListener?.('levelchange', up); b.addEventListener?.('chargingchange', up);
            this._serveBat();
        }).catch(() => {});
    }
    _magLocal() { const m = this.fontes.mag?.(); return (m && m.vivo && Number.isFinite(m.d)) ? m.d : NaN; }

    // ---------------------------------------------------------------- o que ESTE aparelho oferece (só arredondado)
    _serve() {
        const base = () => { const e = this.eu; if (!e || Date.now() - e.t > 180000) throw new Error('sem-medida'); return e; };
        this.node.serve('sensor.tempo', () => { const e = base(); return { relogio: Date.now(), offset: q(e.offset + (mente() ? 5000 : 0), 10), u: q(e.u, 10) }; });
        this.node.serve('sensor.rtt', () => { const e = base(); return mente() ? { min: 5, med: 5, relayUp: true } : { min: q(e.rttMin, 10), med: q(e.rttMed, 10), relayUp: !!this.relayAberto() }; });
        if (this.fontes.cf) this.node.serve('sensor.cf', () => {
            const c = this.fontes.cf(); if (!c || !Number.isFinite(c.minMs)) throw new Error('sem-medida');
            return { min: q(c.minMs, 10), med: q(c.medMs, 10), spread: q(Math.max(0, c.spreadMs), 10) };
        });
        if (this.fontes.mag) this.node.serve('sensor.mag', () => { const d = this._magLocal(); if (!Number.isFinite(d)) throw new Error('sem-medida'); return { d: q1(clamp(d, 0, 1)) }; });
    }
    _serveBat() {
        if (this.node.caps.has('sensor.bat')) return;
        this.node.serve('sensor.bat', () => { const b = this._bat; if (!b) throw new Error('sem-medida'); return mente() ? { nivel: 1, carregando: false } : { nivel: q1(b.nivel), carregando: b.carregando }; });
    }

    // ---------------------------------------------------------------- medição própria: hora do relay (NTP simplificado)
    async medeHora() {
        if (!this.horaUrl || typeof this.buscar !== 'function') return;
        const rs = [];
        for (let i = 0; i < 3; i++) {
            const d0 = Date.now(), p0 = performance.now();
            try {
                const r = await this.buscar(this.horaUrl + '?n=' + ((Math.random() * 1e9) | 0), { cache: 'no-store' });
                if (!r.ok) throw new Error('http ' + r.status);
                const j = await r.json(); const rtt = performance.now() - p0, d1 = Date.now();
                if (typeof j.t === 'number' && isFinite(j.t)) rs.push({ off: j.t - (d0 + d1) / 2, u: rtt / 2, rtt, t: d1 });
                else throw new Error('resposta sem t');
            } catch (e) { this.c.horaFalhas++; this.c.horaErro = String(e?.message || e).slice(0, 80); }
        }
        if (!rs.length) return;
        this.amostras.push(...rs); if (this.amostras.length > 12) this.amostras.splice(0, this.amostras.length - 12);
        const now = Date.now(), rec = this.amostras.filter(a => now - a.t < 300000);
        const best = rec.reduce((a, b) => (b.rtt < a.rtt ? b : a));                  // a amostra de menor RTT tem menor incerteza
        const rtts = rec.map(a => a.rtt).sort((a, b) => a - b);
        this.eu = { offset: best.off, u: best.u, rttMin: rtts[0], rttMed: rtts[rtts.length >> 1], t: now };
    }

    // ---------------------------------------------------------------- verificações (cada uma vira evidência no livro-razão da Koinonia, por canal)
    _checaTempo(res, a0) {
        const a1 = Date.now(), e = this.eu;
        if (!res || ![res.relogio, res.offset, res.u].every(Number.isFinite) || Math.abs(res.offset) > 1e12) return { ok: false, motivo: 'formato' };
        const rtt = a1 - a0, mid = (a0 + a1) / 2;
        const delta = (res.relogio + res.offset) - (mid + e.offset);            // hora de referência segundo o par − segundo eu
        const tol = Math.max(150, 3 * (e.u + res.u + rtt / 2));
        return { ok: Math.abs(delta) <= tol, delta: Math.round(delta), tol: Math.round(tol) };
    }
    _checaRtt(res, totalMs) {
        if (!res || ![res.min, res.med].every(Number.isFinite) || res.min < 0 || res.min > 5000 || res.med < res.min - 1) return { ok: false, motivo: 'formato' };
        if (res.relayUp === false) return { ok: false, motivo: 'diz estar sem relay, mas fala pelo relay' };
        const previsto = totalMs - this.eu.rttMin;                               // RTT(eu,par) ≈ RTT(eu,relay) + RTT(par,relay)
        const tol = Math.max(100, 0.6 * totalMs);
        return { ok: Math.abs(previsto - res.min) <= tol, previsto: Math.round(previsto), alegado: res.min, tol: Math.round(tol) };
    }
    _checaCf(id, res) {                                                          // só plausibilidade: ninguém mais vê esta balança
        if (!res || ![res.min, res.med, res.spread].every(Number.isFinite) || res.min <= 0 || res.min > res.med + 1 || res.med > 5000 || res.spread < 0 || res.spread > 5000) return { ok: false, motivo: 'implausível' };
        const k = res.min + '|' + res.med + '|' + res.spread, c = this._cf.get(id) || { k: '', n: 0 };
        c.n = (c.k === k) ? c.n + 1 : 0; c.k = k; this._cf.set(id, c);
        return c.n >= 12 ? { ok: false, motivo: 'travado (12 leituras idênticas)' } : { ok: true };
    }
    _checaBat(id, res) {                                                         // só plausível: faixa, passo de 10 %, sem salto impossível
        if (!res || !Number.isFinite(res.nivel) || res.nivel < 0 || res.nivel > 1 || Math.abs(res.nivel * 10 - Math.round(res.nivel * 10)) > 1e-6 || typeof res.carregando !== 'boolean') return { ok: false, motivo: 'implausível' };
        const h = this._batHist.get(id), t = Date.now(); this._batHist.set(id, { nivel: res.nivel, t });
        if (this._batHist.size > 64) this._batHist.delete(this._batHist.keys().next().value);
        if (h && !res.carregando && res.nivel - h.nivel > 0.15 && t - h.t < 600000) return { ok: false, motivo: 'subiu sem carregar' };
        if (h && Math.abs(res.nivel - h.nivel) > 0.35 && t - h.t < 120000) return { ok: false, motivo: 'salto impossível' };
        return { ok: true };
    }
    _checaMag(res) { return (res && Number.isFinite(res.d) && res.d >= 0 && res.d <= 1) ? { ok: true } : { ok: false, motivo: 'implausível' }; }
    _conta(ok) { this.c.verificadas++; if (ok) this.c.acertos++; else this.c.falhas++; this.conf = 0.9 * this.conf + 0.1 * (ok ? 1 : 0); }

    async _sondaPar(id) {
        const n = this.node, p = n.peers.get(id), via = p?.rtc?.open ? 'direto' : 'relay';
        const reg = this.mapa.get(id) || { t: 0 }; reg.nome = p?.name || reg.nome || '?'; reg.via = via; reg.t = Date.now(); this.mapa.set(id, reg);
        if (this.mapa.size > 64) this.mapa.delete(this.mapa.keys().next().value);
        const fila = (canal, verificavel, ok) => { try { this.aduana?.enfileira?.({ id, canal, nome: reg.nome, verificavel, ok }); } catch (_) {} };
        // TEMPO (provável por física)
        let ia = null; const a0 = Date.now();
        const r1 = await n.request('sensor.tempo', null, { peer: id, timeoutMs: 5000, check: res => { ia = this._checaTempo(res, a0); return ia.ok; } });
        reg.tempo = ia ? { ...ia, t: Date.now() } : { ok: false, motivo: r1.erro || 'sem-resposta', t: Date.now() };
        if (ia) this._conta(ia.ok);
        // RTT (provável por soma, só pelo relay)
        if (p?.caps?.has('sensor.rtt')) {
            let ib = null; const t0 = performance.now(), ver = via === 'relay';
            const o = { peer: id, timeoutMs: 5000 }; if (ver) o.check = res => { ib = this._checaRtt(res, performance.now() - t0); return ib.ok; };
            const r2 = await n.request('sensor.rtt', null, o);
            if (r2.result) { reg.rtt = { min: r2.result.min, med: r2.result.med, relayUp: r2.result.relayUp, verificada: ver, ok: ib ? ib.ok : null, motivo: ib?.motivo, t: Date.now() }; fila('rtt', ver, ib ? ib.ok : null); }
            if (ib) this._conta(ib.ok); else this.c.naoVerificaveis++;
        }
        // CF (só plausível)
        if (p?.caps?.has('sensor.cf')) {
            let ic = null;
            const r3 = await n.request('sensor.cf', null, { peer: id, timeoutMs: 5000, check: res => { ic = this._checaCf(id, res); return ic.ok; } });
            if (r3.result) reg.cf = { min: r3.result.min, med: r3.result.med, spread: r3.result.spread, ok: ic ? ic.ok : null, motivo: ic?.motivo, t: Date.now() };
            if (ic) this._conta(ic.ok);
        }
        // BATERIA e CAMPO MAGNÉTICO (fatia 2, só plausíveis → a aduana decide se entram)
        if (p?.caps?.has('sensor.bat')) {
            let id2 = null;
            const r4 = await n.request('sensor.bat', null, { peer: id, timeoutMs: 5000, check: res => { id2 = this._checaBat(id, res); return id2.ok; } });
            if (r4.result) { reg.bat = { nivel: r4.result.nivel, carregando: r4.result.carregando, ok: id2 ? id2.ok : null, motivo: id2?.motivo, t: Date.now() }; if (id2?.ok) fila('bat', false, null); }
        }
        if (p?.caps?.has('sensor.mag')) {
            let im = null;
            const r5 = await n.request('sensor.mag', null, { peer: id, timeoutMs: 5000, check: res => { im = this._checaMag(res); return im.ok; } });
            if (r5.result) { reg.mag = { d: r5.result.d, ok: im ? im.ok : null, motivo: im?.motivo, t: Date.now() }; if (im?.ok) fila('mag', false, null); }
        }
    }

    async ciclo() {
        this.c.ciclos++;
        await this.medeHora();
        if (!this.eu) { this.c.semBase++; this._recalcula(); return; }
        const ids = [...this.node.peers.entries()].filter(([, p]) => p.caps?.has('sensor.tempo')).map(([id]) => id).slice(0, 8);
        for (const id of ids) { try { await this._sondaPar(id); } catch (e) { this._erro(e); } }
        this._recalcula();
    }

    // ---------------------------------------------------------------- consenso ponderado por nível + os sentidos
    _pesoBase(id, canal) {
        const L = this.node.ledger.read(id, 'sensor.' + canal);
        return L.restr || L.skill <= 0 ? PESO_NIVEL[0] : (PESO_NIVEL[L.tier] ?? PESO_NIVEL[0]);   // nível só conta com vantagem sobre o acaso
    }
    _peso(id, canal) {
        const r = this.mapa.get(id)?.[canal]; if (r && r.ok === false) return 0;     // pego mentindo / implausível neste canal: peso zero
        const ad = this.aduana?.veredito?.(id, canal);
        if (ad && ad.vinculante && !ad.admitido) return 0;                            // a aduana (já com prova) barrou esta leitura
        return this._pesoBase(id, canal);
    }
    // Sentidos agregados, PUROS (não escrevem nada). sem = 'id|canal' fica de fora; forca = 'id|canal' entra com o peso de base
    // (ignora ✗ e aduana) — é assim que a aduana vê "o mundo sem esta leitura" e "o mundo se ela entrasse".
    agrega({ sem = null, forca = null } = {}) {
        const now = Date.now(), fresh = r => r && now - r.t < 150000;
        const w = (id, canal) => { const k = id + '|' + canal; return k === sem ? 0 : k === forca ? this._pesoBase(id, canal) : this._peso(id, canal); };
        const v = [], wv = [], up = [], wu = [], bv = [], wb = [], mv = [], wm = [];
        if (this.eu) { v.push(this.eu.rttMin); wv.push(2); up.push(this.relayAberto() ? 1 : 0); wu.push(2); }
        if (this._bat) { bv.push(q1(this._bat.nivel)); wb.push(2); }
        const ml = this._magLocal(); if (Number.isFinite(ml)) { mv.push(q1(ml)); wm.push(2); }
        for (const [id, reg] of this.mapa) {
            if (fresh(reg.rtt) && Number.isFinite(reg.rtt.min)) {
                const pw = w(id, 'rtt'); v.push(reg.rtt.min); wv.push(pw);
                if (reg.via === 'relay') { up.push(1); wu.push(pw); }                    // chegou pelo relay: está de fato conectado a ele (provado)
                else if (typeof reg.rtt.relayUp === 'boolean') { up.push(reg.rtt.relayUp ? 1 : 0); wu.push(pw * 0.5); }   // via direta: só alegação
            }
            if (fresh(reg.bat) && Number.isFinite(reg.bat.nivel)) { bv.push(reg.bat.nivel); wb.push(w(id, 'bat')); }
            if (fresh(reg.mag) && Number.isFinite(reg.mag.d)) { mv.push(reg.mag.d); wm.push(w(id, 'mag')); }
        }
        const m = medPond(v, wv), b = medPond(bv, wb), g = medPond(mv, wm);
        const sw = wu.reduce((s, x) => s + x, 0);
        const o = {
            rtt: Number.isFinite(m) ? clamp(Math.log10(1 + m) / Math.log10(1 + 2000), 0, 1) : 0,
            relay_visto: sw ? up.reduce((s, x, i) => s + x * wu[i], 0) / sw : 0,
            relogio: this.eu ? clamp(Math.abs(this.eu.offset) / 1000, 0, 1) : 0,
            confianca: this.conf,
            bat: Number.isFinite(b) ? clamp(b, 0, 1) : 0,
            mag: Number.isFinite(g) ? clamp(g, 0, 1) : 0
        };
        const ctx = {};
        for (const k in o) { ctx['env_rede_' + k] = o[k]; ctx['Ω_rede_' + k] = o[k]; }
        return ctx;
    }
    // "O mundo segundo esta leitura": os sentidos sem ela, trocando o do canal dela pelo que ELA afirma. É a pergunta da aduana:
    // "se eu acreditasse neste aparelho, minha lei continuaria valendo?". (A mediana ponderada sozinha quase nunca mexe com 2–3
    // aparelhos — o meu próprio valor pesa 2 —, então "com a leitura" não serve de pergunta; "segundo a leitura" serve.)
    mundoSegundo(id, canal) {
        const ctx = this.agrega({ sem: id + '|' + canal }), r = this.mapa.get(id), put = (k, v) => { ctx['env_rede_' + k] = v; ctx['Ω_rede_' + k] = v; };
        if (!r || !r[canal]) return ctx;
        if (canal === 'rtt' && Number.isFinite(r.rtt.min)) { put('rtt', clamp(Math.log10(1 + r.rtt.min) / Math.log10(1 + 2000), 0, 1)); put('relay_visto', r.via === 'relay' ? 1 : (r.rtt.relayUp === false ? 0 : 1)); }
        else if (canal === 'bat' && Number.isFinite(r.bat.nivel)) put('bat', clamp(r.bat.nivel, 0, 1));
        else if (canal === 'mag' && Number.isFinite(r.mag.d)) put('mag', clamp(r.mag.d, 0, 1));
        return ctx;
    }
    _recalcula() {
        Object.assign(this._ctx, this.agrega());
        // meu relógio / minha hora de referência suspeitos? (≥ 3 pares verificáveis discordando JUNTOS de mim, no mesmo sentido)
        const now = Date.now(), fresh = r => r && now - r.t < 150000;
        const ds = [...this.mapa.values()].filter(r => fresh(r.tempo) && Number.isFinite(r.tempo.delta)).map(r => r.tempo);
        const mm = med(ds.map(d => d.delta));
        this.suspeita = (ds.length >= 3 && Math.abs(mm) > 250 && ds.filter(d => Math.abs(d.delta) > d.tol && Math.sign(d.delta) === Math.sign(mm)).length / ds.length >= 0.7)
            ? 'A MAIORIA dos pares discorda de mim sobre a hora de referência: MEU relógio (ou minha medida) está errado.' : '';
    }
    getContextAugment() { return this._ctx; }

    // quantos pares veem o relay de pé / fora (só os que falam por canal direto contam: os demais, por definição, usam o relay)
    veRelay() {
        const now = Date.now(); let up = 0, down = 0;
        for (const reg of this.mapa.values()) if (reg.via === 'direto' && reg.rtt && now - reg.rtt.t < 120000 && typeof reg.rtt.relayUp === 'boolean') { if (reg.rtt.relayUp) up++; else down++; }
        return { up, down };
    }

    // ---------------------------------------------------------------- glass-box
    resumo() {
        const L = [], e = this.eu;
        L.push(`P.L.E.I.A.D.E.S. ${this.versao} — rede de sensores (tempo + rede + bateria + campo magnético)${mente() ? ' — ⚠ ESTE APARELHO ESTÁ MENTINDO DE PROPÓSITO (pleiadesMentir)' : ''}`);
        L.push(e ? `Eu: hora do relay ${e.offset >= 0 ? '+' : ''}${Math.round(e.offset)} ms (± ${Math.round(e.u)}), RTT até o relay mín ${Math.round(e.rttMin)} / med ${Math.round(e.rttMed)} ms${this.fontes.cf ? '' : ' (sem canal CF neste aparelho)'}`
                 : `Eu: sem medida da hora do relay ainda (${this.c.horaFalhas} tentativa(s) falharam${this.c.horaErro ? ': ' + this.c.horaErro : ''})`);
        L.push(`Minha bateria: ${this._bat ? Math.round(this._bat.nivel * 100) + ' %' + (this._bat.carregando ? ' (carregando)' : '') : 'indisponível neste navegador'} · meu campo magnético: ${Number.isFinite(this._magLocal()) ? q1(this._magLocal()) : 'bússola muda neste navegador'}`);
        if (this.suspeita) L.push('⚠ ' + this.suspeita);
        L.push(`Verificações: ${this.c.verificadas} (acertos ${this.c.acertos}, falhas ${this.c.falhas}) · não verificáveis ${this.c.naoVerificaveis} · confiança da rede ${(this.conf * 100).toFixed(0)}%`);
        const k = this._ctx; L.push(`Sentidos das entidades: rtt ${k.env_rede_rtt.toFixed(2)} · relay visto ${k.env_rede_relay_visto.toFixed(2)} · relógio ${k.env_rede_relogio.toFixed(2)} · confiança ${k.env_rede_confianca.toFixed(2)} · bateria ${k.env_rede_bat.toFixed(2)} · magnético ${k.env_rede_mag.toFixed(2)}`);
        if (!this.mapa.size) L.push('Vigias (pares): nenhum com sensores ainda. Com 3+ aparelhos o consenso vira maioria; com 2, só dá para ver quem discorda.');
        for (const [id, r] of this.mapa) {
            const nv = c => this.node.ledger.read(id, 'sensor.' + c).tier;
            const ad = c => { const v = this.aduana?.veredito?.(id, c); return v ? (v.admitido ? ' [aduana: entra]' : ` [aduana: barra${v.vinculante ? '' : ' (só sombra)'}]`) : ''; };
            const t = r.tempo ? (r.tempo.ok ? `✓ Δ${r.tempo.delta}±${r.tempo.tol} ms` : `✗ ${r.tempo.motivo || 'Δ' + r.tempo.delta + ' fora de ±' + r.tempo.tol}`) : '—';
            const rt = r.rtt ? (r.rtt.ok === null ? `? ${r.rtt.min} ms (direto: não dá para provar)` : r.rtt.ok ? `✓ ${r.rtt.min} ms` : `✗ ${r.rtt.motivo || r.rtt.min + ' ms não fecha com o caminho'}`) + ad('rtt') : '—';
            const cf = r.cf ? (r.cf.ok ? `plausível ${r.cf.min}/${r.cf.med}/${r.cf.spread}` : `✗ ${r.cf.motivo}`) : '—';
            const bt = r.bat ? (r.bat.ok ? `plausível ${Math.round(r.bat.nivel * 100)}%${r.bat.carregando ? '⚡' : ''}` : `✗ ${r.bat.motivo}`) + ad('bat') : '—';
            const mg = r.mag ? (r.mag.ok ? `plausível ${r.mag.d}` : `✗ ${r.mag.motivo}`) + ad('mag') : '—';
            L.push(`  ${r.nome} (${id.slice(0, 5)}, ${r.via}) tempo[N${nv('tempo')}] ${t} · rtt[N${nv('rtt')}] ${rt} · cf ${cf} · bateria ${bt} · magnético ${mg}`);
        }
        L.push('Provado = tempo e (pelo relay) rtt · Só plausível = cf, bateria, magnético, rtt direto · Mentiroso = peso 0 no consenso.');
        return L.join('\n');
    }
    getStats() { return { ...this.c, conf: this.conf, eu: this.eu, bat: this._bat, pares: this.mapa.size, suspeita: this.suspeita }; }
}
