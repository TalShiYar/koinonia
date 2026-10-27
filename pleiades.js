// ============================================================================
// P.L.E.I.A.D.E.S. — rede de sensores com reputação (fatia 1: TEMPO + REDE) · js/modules/OMEGA/pleiades.js · [2026-10-26]
//
// Analogia: uma feira de balanças. Três tipos de balança:
//   • TEMPO é balança conferida com o PESO-PADRÃO: cada aparelho mede seu desvio de relógio contra a hora do relay
//     (NTP simplificado) e os pares se conferem: "a hora de referência que você diz ter bate com a que eu medi?".
//   • RTT até o relay é balança conferida por SOMA: RTT(eu→par pelo relay) ≈ RTT(eu→relay) + RTT(par→relay). Quem
//     alega 5 ms enquanto o caminho real leva 300 ms é pego. (Só vale quando a conversa passa pelo relay.)
//   • CF (RTT até 1.1.1.1, do SubstrateBridge) é balança que ninguém mais vê: só se confere se é PLAUSÍVEL (faixa
//     realista, não travada). Reputação sobe e desce por canal; mentiroso pesa zero e aparece no painel.
// Cada aparelho é um vigia da internet visto de um ponto diferente. O que fica de fato PROVADO e o que é só
// PLAUSÍVEL está rotulado em resumo().
//
// Privacidade (padrão): só sai valor ARREDONDADO (10 ms). Nada de posição, emissores de rádio ou leituras brutas.
// Limites honestos: com 2 aparelhos só dá para saber que DISCORDAM (quem erra é o de pior histórico, não uma prova);
//   o teste de soma do RTT é grosseiro (pega mentira grossa, não fina); ids novos são grátis (peso por nível freia, não impede conluio).
// Depende só do Node da Koinonia (serve/request com check). Não toca o mundo das entidades; só entrega 4 sentidos (getContextAugment).
// ============================================================================
const q = (v, b) => Math.round(v / b) * b;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const PESO_NIVEL = [0.25, 1, 2, 3];
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const medPond = (v, w) => {
    const p = v.map((x, i) => [x, w[i]]).filter(e => e[1] > 0).sort((a, b) => a[0] - b[0]);
    const tot = p.reduce((s, e) => s + e[1], 0); if (!tot) return NaN;
    let acc = 0; for (const e of p) { acc += e[1]; if (acc >= tot / 2) return e[0]; } return p[p.length - 1][0];
};
export function horaDeRelay(url) { const u = new URL(String(url).replace(/^ws/, 'http')); return u.origin + '/hora' + u.pathname; }

export class PLEIADES {
    constructor(node, { horaUrl, relayAberto = () => true, fontes = {}, log = () => {}, cicloMs = 30000, buscar = globalThis.fetch } = {}) {
        this.buscar = buscar;
        this.versao = '1.0 (2026-10-26)';
        this.node = node; this.horaUrl = horaUrl; this.relayAberto = relayAberto; this.fontes = fontes; this.log = log;
        this.amostras = []; this.eu = null;
        this.mapa = new Map();                 // id -> {nome, via, tempo, rtt, cf, t}
        this.conf = 0.5;                        // EMA de acertos das verificações (0–1)
        this.suspeita = '';
        this._cf = new Map();
        this.c = { ciclos: 0, verificadas: 0, acertos: 0, falhas: 0, semBase: 0, naoVerificaveis: 0, erros: 0, ultimoErro: '' };
        this._ctx = { env_rede_rtt: 0, env_rede_relay_visto: 0, env_rede_relogio: 0, env_rede_confianca: 0.5, 'Ω_rede_rtt': 0, 'Ω_rede_relay_visto': 0, 'Ω_rede_relogio': 0, 'Ω_rede_confianca': 0.5 };
        this._serve();
        const t0 = setTimeout(() => this.ciclo().catch(e => this._erro(e)), 3000);
        const t = setInterval(() => this.ciclo().catch(e => this._erro(e)), cicloMs);
        for (const x of [t0, t]) if (x && x.unref) x.unref();
        this._timers = [t0, t];
    }
    parar() { for (const t of this._timers) { clearTimeout(t); clearInterval(t); } }
    _erro(e) { this.c.erros++; this.c.ultimoErro = String(e?.message || e).slice(0, 80); }

    // ---------------------------------------------------------------- o que ESTE aparelho oferece (só arredondado)
    _serve() {
        const base = () => { const e = this.eu; if (!e || Date.now() - e.t > 180000) throw new Error('sem-medida'); return e; };
        this.node.serve('sensor.tempo', () => { const e = base(); return { relogio: Date.now(), offset: q(e.offset, 10), u: q(e.u, 10) }; });
        this.node.serve('sensor.rtt', () => { const e = base(); return { min: q(e.rttMin, 10), med: q(e.rttMed, 10), relayUp: !!this.relayAberto() }; });
        if (this.fontes.cf) this.node.serve('sensor.cf', () => {
            const c = this.fontes.cf(); if (!c || !Number.isFinite(c.minMs)) throw new Error('sem-medida');
            return { min: q(c.minMs, 10), med: q(c.medMs, 10), spread: q(Math.max(0, c.spreadMs), 10) };
        });
    }

    // ---------------------------------------------------------------- medição própria: hora do relay (NTP simplificado)
    async medeHora() {
        if (!this.horaUrl || typeof this.buscar !== 'function') return;
        const rs = [];
        for (let i = 0; i < 3; i++) {
            const d0 = Date.now(), p0 = performance.now();
            try {
                const r = await this.buscar(this.horaUrl + '?n=' + ((Math.random() * 1e9) | 0), { cache: 'no-store' });
                const j = await r.json(); const rtt = performance.now() - p0, d1 = Date.now();
                if (typeof j.t === 'number' && isFinite(j.t)) rs.push({ off: j.t - (d0 + d1) / 2, u: rtt / 2, rtt, t: d1 });
            } catch (_) {}
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
    _conta(ok) { this.c.verificadas++; if (ok) this.c.acertos++; else this.c.falhas++; this.conf = 0.9 * this.conf + 0.1 * (ok ? 1 : 0); }

    async _sondaPar(id) {
        const n = this.node, p = n.peers.get(id), via = p?.rtc?.open ? 'direto' : 'relay';
        const reg = this.mapa.get(id) || { t: 0 }; reg.nome = p?.name || reg.nome || '?'; reg.via = via; reg.t = Date.now(); this.mapa.set(id, reg);
        if (this.mapa.size > 64) this.mapa.delete(this.mapa.keys().next().value);
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
            if (r2.result) reg.rtt = { min: r2.result.min, med: r2.result.med, relayUp: r2.result.relayUp, verificada: ver, ok: ib ? ib.ok : null, motivo: ib?.motivo, t: Date.now() };
            if (ib) this._conta(ib.ok); else this.c.naoVerificaveis++;
        }
        // CF (só plausível)
        if (p?.caps?.has('sensor.cf')) {
            let ic = null;
            const r3 = await n.request('sensor.cf', null, { peer: id, timeoutMs: 5000, check: res => { ic = this._checaCf(id, res); return ic.ok; } });
            if (r3.result) reg.cf = { min: r3.result.min, med: r3.result.med, spread: r3.result.spread, ok: ic ? ic.ok : null, motivo: ic?.motivo, t: Date.now() };
            if (ic) this._conta(ic.ok);
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

    // ---------------------------------------------------------------- consenso ponderado por nível + os 4 sentidos
    _peso(id, canal) {
        const r = this.mapa.get(id)?.[canal]; if (r && r.ok === false) return 0;     // pego mentindo neste canal: peso zero
        const L = this.node.ledger.read(id, 'sensor.' + canal);
        return L.restr || L.skill <= 0 ? PESO_NIVEL[0] : (PESO_NIVEL[L.tier] ?? PESO_NIVEL[0]);   // nível só conta com vantagem sobre o acaso
    }
    _recalcula() {
        const now = Date.now(), fresh = r => r && now - r.t < 150000;
        const v = [], w = [], up = [], wu = [];
        if (this.eu) { v.push(this.eu.rttMin); w.push(2); up.push(this.relayAberto() ? 1 : 0); wu.push(2); }
        for (const [id, reg] of this.mapa) if (fresh(reg.rtt) && Number.isFinite(reg.rtt.min)) {
            const pw = this._peso(id, 'rtt'); v.push(reg.rtt.min); w.push(pw);
            if (reg.via === 'relay') { up.push(1); wu.push(pw); }                    // chegou pelo relay: está de fato conectado a ele (provado)
            else if (typeof reg.rtt.relayUp === 'boolean') { up.push(reg.rtt.relayUp ? 1 : 0); wu.push(pw * 0.5); }   // via direta: só alegação
        }
        const m = medPond(v, w);
        const sw = wu.reduce((s, x) => s + x, 0);
        const c = this._ctx;
        c.env_rede_rtt = Number.isFinite(m) ? clamp(Math.log10(1 + m) / Math.log10(1 + 2000), 0, 1) : 0;
        c.env_rede_relay_visto = sw ? up.reduce((s, x, i) => s + x * wu[i], 0) / sw : 0;
        c.env_rede_relogio = this.eu ? clamp(Math.abs(this.eu.offset) / 1000, 0, 1) : 0;
        c.env_rede_confianca = this.conf;
        for (const k of ['rtt', 'relay_visto', 'relogio', 'confianca']) c['Ω_rede_' + k] = c['env_rede_' + k];
        // meu relógio / minha hora de referência suspeitos? (≥ 3 pares verificáveis discordando JUNTOS de mim, no mesmo sentido)
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
        L.push(`P.L.E.I.A.D.E.S. ${this.versao} — rede de sensores (tempo + rede)`);
        L.push(e ? `Eu: hora do relay ${e.offset >= 0 ? '+' : ''}${Math.round(e.offset)} ms (± ${Math.round(e.u)}), RTT até o relay mín ${Math.round(e.rttMin)} / med ${Math.round(e.rttMed)} ms${this.fontes.cf ? '' : ' (sem canal CF neste aparelho)'}` : 'Eu: sem medida da hora do relay ainda (precisa de /hora no relay; reenvie o worker.js)');
        if (this.suspeita) L.push('⚠ ' + this.suspeita);
        L.push(`Verificações: ${this.c.verificadas} (acertos ${this.c.acertos}, falhas ${this.c.falhas}) · não verificáveis ${this.c.naoVerificaveis} · confiança da rede ${(this.conf * 100).toFixed(0)}%`);
        const k = this._ctx; L.push(`Sentidos das entidades: rtt ${k.env_rede_rtt.toFixed(2)} · relay visto ${k.env_rede_relay_visto.toFixed(2)} · relógio ${k.env_rede_relogio.toFixed(2)} · confiança ${k.env_rede_confianca.toFixed(2)}`);
        if (!this.mapa.size) L.push('Vigias (pares): nenhum com sensores ainda. Com 3+ aparelhos o consenso vira maioria; com 2, só dá para ver quem discorda.');
        for (const [id, r] of this.mapa) {
            const nv = c => this.node.ledger.read(id, 'sensor.' + c).tier;
            const t = r.tempo ? (r.tempo.ok ? `✓ Δ${r.tempo.delta}±${r.tempo.tol} ms` : `✗ ${r.tempo.motivo || 'Δ' + r.tempo.delta + ' fora de ±' + r.tempo.tol}`) : '—';
            const rt = r.rtt ? (r.rtt.ok === null ? `? ${r.rtt.min} ms (direto: não dá para provar)` : r.rtt.ok ? `✓ ${r.rtt.min} ms` : `✗ ${r.rtt.motivo || r.rtt.min + ' ms não fecha com o caminho'}`) : '—';
            const cf = r.cf ? (r.cf.ok ? `plausível ${r.cf.min}/${r.cf.med}/${r.cf.spread}` : `✗ ${r.cf.motivo}`) : '—';
            L.push(`  ${r.nome} (${id.slice(0, 5)}, ${r.via}) tempo[N${nv('tempo')}] ${t} · rtt[N${nv('rtt')}] ${rt} · cf ${cf}`);
        }
        L.push('Provado = tempo e (pelo relay) rtt · Só plausível = cf · Mentiroso = peso 0 no consenso.');
        return L.join('\n');
    }
    getStats() { return { ...this.c, conf: this.conf, eu: this.eu, pares: this.mapa.size, suspeita: this.suspeita }; }
}
