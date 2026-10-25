// ============================================================================
// KOINONIA — um socket de sociedade (v0.1)
// WebSocket é a linha telefônica. Koinonia é a linha + lista telefônica + currículo + histórico de quem atende:
//   identidade assinada · capacidades declaradas · reputação POR capacidade (com validade) · descoberta sem varrer a rede
//   · calibração de novatos · restrição com caminho de volta · mérito + rodízio.
// Independente de transporte: WebSocket (via relay), WebRTC DataChannel, BroadcastChannel, memória. Sem dependências.
// Roda em navegador moderno e Node ≥ 18 (WebCrypto + TextEncoder + btoa).
//
// O que ele GARANTE: continuidade de identidade (id = hash da chave pública; mensagens assinadas, janela anti-replay).
// O que NÃO garante: honestidade (por isso a reputação), sigilo (use wss:// / DTLS; payload é visível ao relay), anti-Sybil forte
//   (id novo é grátis; o freio é: começa no nível 0, a cadeira do novato é limitada pelo rodízio, e nada crítico vai a quem não provou).
//
// Big-O (P = pares conhecidos, limitado a MAX_PEERS; K = 8; C = candidatos por capacidade ≤ 64):
//   enviar/receber: O(tamanho) + 1 assinatura/verificação · find/escolha: O(C) · consulta de descoberta: O(K log K), independe de P
//   memória: pares ≤ 256 · células de reputação ≤ 4096 (LRU) · nonces ≤ 2048 · pendentes ≤ maxPending.
// ============================================================================

const enc = new TextEncoder();
const b64 = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const canon = o => (o === null || typeof o !== 'object') ? JSON.stringify(o)
    : Array.isArray(o) ? '[' + o.map(canon).join(',') + ']'
    : '{' + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
const subtle = () => globalThis.crypto.subtle;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

// ------------------------------------------------------------------ identidade
export async function createIdentity(saved) {
    let priv, pub;
    if (saved) {
        priv = await subtle().importKey('jwk', saved.priv, ECDSA, true, ['sign']);
        pub = await subtle().importKey('jwk', saved.pub, ECDSA, true, ['verify']);
    } else {
        const kp = await subtle().generateKey(ECDSA, true, ['sign', 'verify']);
        priv = kp.privateKey; pub = kp.publicKey;
    }
    const raw = new Uint8Array(await subtle().exportKey('raw', pub));
    return {
        id: await idOf(raw), priv, pubB64: b64(raw),
        // guarde isto (localStorage/IndexedDB) para manter a MESMA identidade entre sessões
        exportar: async () => ({ priv: await subtle().exportKey('jwk', priv), pub: await subtle().exportKey('jwk', pub) })
    };
}
async function idOf(raw) { return b64(new Uint8Array(await subtle().digest('SHA-256', raw))).slice(0, 22); }

// ------------------------------------------------------------------ reputação (por par × capacidade)
const N1 = 4, N2 = 12, N3 = 30;
class Ledger {
    constructor(cfg, now) {
        this.cfg = cfg; this.now = now; this.k = Math.LN2 / cfg.halfLifeMs;
        this.cells = new Map();    // "par|cap" -> {ea, eb, t, restr}   (LRU)
        this.chance = new Map();   // cap -> {ea, eb, t}  (taxa-base de quem responde: o "acaso" da capacidade)
        this.cred = new Map();     // par -> {a, b}  credibilidade como INDICADOR (quem recomenda assume o risco)
        this.refs = new Map();     // "par|cap" -> [{id,t},{id,t}]  quem indicou este par
    }
    _chance(cap) {
        const c = this.chance.get(cap); if (!c) return 0.5;
        const f = Math.exp(-(this.now() - c.t) * this.k);
        return (1 + c.ea * f) / (2 + (c.ea + c.eb) * f);
    }
    read(peer, cap) {
        const key = peer + '|' + cap, c = this.cells.get(key);
        const out = { n: 0, mean: 0.5, lb: 0, chance: this._chance(cap), skill: 0, tier: 0, restr: false };
        if (!c) return out;
        const f = Math.exp(-(this.now() - c.t) * this.k);
        const ea = c.ea * f, eb = c.eb * (c.restr ? f * f : f);     // em restrição o erro antigo some 2× mais rápido
        const A = 1 + ea, B = 1 + eb, S = A + B;
        out.n = ea + eb; out.mean = A / S;
        out.lb = out.mean - Math.sqrt(A * B / (S * S * (S + 1)));
        out.skill = out.lb - out.chance;
        if (c.restr && (out.skill >= -0.02 || out.n < N1)) { c.restr = false; }   // caminho de volta
        out.restr = c.restr;
        if (!out.restr) {
            if (out.n >= N1) out.tier = 1;
            if (out.n >= N2 && out.skill >= 0.05) out.tier = 2;
            if (out.n >= N3 && out.skill >= 0.15) out.tier = 3;
        }
        return out;
    }
    write(peer, cap, hit, w) {
        const key = peer + '|' + cap, t = this.now();
        let c = this.cells.get(key);
        if (c) { this.cells.delete(key); const f = Math.exp(-(t - c.t) * this.k); c.ea *= f; c.eb *= (c.restr ? f * f : f); c.t = t; }
        else c = { ea: 0, eb: 0, t, restr: false };
        if (hit) c.ea += w; else c.eb += w;
        this.cells.set(key, c);
        if (this.cells.size > this.cfg.maxCells) this.cells.delete(this.cells.keys().next().value);
        let g = this.chance.get(cap);
        if (g) { const f = Math.exp(-(t - g.t) * this.k); g.ea *= f; g.eb *= f; g.t = t; } else { g = { ea: 0, eb: 0, t }; this.chance.set(cap, g); }
        if (hit) g.ea += w; else g.eb += w;
        const r = this.read(peer, cap);
        if (!c.restr && !hit && r.n >= N2 && r.skill < -0.10) { c.restr = true; return 'restricao'; }
        return null;
    }
    credOf(id) { const c = this.cred.get(id); return c ? c.a / (c.a + c.b) : 0.5; }
    // quem indicou este par assume o resultado
    ref(peer, cap, refId) {
        const key = peer + '|' + cap; let r = this.refs.get(key);
        if (!r) { r = [{ id: 0, t: 0 }, { id: 0, t: 0 }]; this.refs.set(key, r); if (this.refs.size > this.cfg.maxCells) this.refs.delete(this.refs.keys().next().value); }
        const t = this.now();
        const s = r.find(x => x.id === refId) || (r[0].t <= r[1].t ? r[0] : r[1]);
        s.id = refId; s.t = t;
    }
    settleRefs(peer, cap, hit, w) {
        const r = this.refs.get(peer + '|' + cap); if (!r) return;
        const t = this.now();
        for (const s of r) {
            if (!s.id || t - s.t > this.cfg.refValidMs) continue;
            const c = this.cred.get(s.id) || { a: 2, b: 2 };
            if (hit) c.a += 0.5 * w; else c.b += 1.0 * w;           // indicação furada dói mais do que certa ajuda
            if (c.a + c.b > 60) { c.a *= 0.9; c.b *= 0.9; }
            this.cred.set(s.id, c);
            if (this.cred.size > this.cfg.maxPeers * 4) this.cred.delete(this.cred.keys().next().value);
        }
    }
}

// ------------------------------------------------------------------ nó
const DEF = {
    halfLifeMs: 10 * 60 * 1000, maxPeers: 256, maxCells: 4096, maxCapPeers: 64, maxPending: 256, maxInflight: 32,
    skewMs: 60000, nonceCap: 2048, rateBurst: 60, ratePerSec: 30, refValidMs: 5 * 60 * 1000, epochMs: 60000,
    timeoutMs: 3000, calibMs: 5000, now: () => Date.now()
};

export class Node {
    static async create(opts = {}) {
        const n = new Node(opts); n.ident = opts.identity || await createIdentity(); n.id = n.ident.id; n._start(); return n;
    }
    constructor(opts) {
        this.cfg = { ...DEF, ...opts }; this.now = this.cfg.now;
        this.name = opts.name || 'anon';
        this.caps = new Map();       // cap -> {handler}
        this.tasks = new Map();      // cap -> () => ({payload, check})   (gerador de missão de calibração + verificador automático)
        this.links = new Set();
        this.peers = new Map();      // id -> {name, caps:Set, seen, link, pubB64, key}
        this.index = new Map();      // cap -> Map(id -> seen)   (≤ maxCapPeers por capacidade)
        this.ledger = new Ledger(this.cfg, this.now);
        this.pending = new Map();
        this.nonces = new Map();
        this.buckets = new Map();
        this.load = new Map();       // id -> {c, t}  carga de uso (rodízio)
        this.inflight = 0;
        this.epoch = { id: 0, refs: 0 };
        this.events = [];
        this.stat = { tx: 0, rx: 0, rejeitadas: 0, motivos: {}, req: 0, ok: 0, falhas: 0, timeouts: 0, porNivel: [0, 0, 0, 0] };
        this._timers = [];
        this.onevent = null;
    }
    _start() {
        const t = setInterval(() => this._autopilot(), this.cfg.calibMs);
        if (t.unref) t.unref(); this._timers.push(t);
    }
    close() { for (const t of this._timers) clearInterval(t); for (const l of this.links) try { l.close?.(); } catch (_) {} }
    _ev(tipo, txt) { this.events.push({ t: this.now(), tipo, txt }); if (this.events.length > 40) this.events.shift(); this.onevent?.(tipo, txt); }

    // ---- API: oferecer e pedir
    serve(cap, handler) { this.caps.set(cap, { handler }); this._announce(); return this; }
    // missão de calibração: gen() devolve {payload, check(resultado) -> bool}; o nó a usa para dar chance (e medir) novatos
    defineTask(cap, gen) { this.tasks.set(cap, gen); return this; }

    attach(link) {
        this.links.add(link);
        link.onmessage = raw => this._onRaw(link, typeof raw === 'string' ? raw : raw?.data ?? String(raw));
        link.onclose = () => { this.links.delete(link); for (const p of this.peers.values()) if (p.link === link) p.link = null; };
        this._announce();
        return this;
    }

    // ---- descoberta: índice local + indicações de vizinhos (indicação NÃO é evidência: só vira candidata)
    async find(cap, { k = 3, ask = true } = {}) {
        let cands = this._cands(cap);
        if (ask && cands.length < k) {
            const asked = [...this.peers.entries()].filter(([, p]) => p.link || this.links.size).slice(0, 3);
            const rs = await Promise.all(asked.map(([id]) => this._call(id, 'WHO', { cap, k }, 800).catch(() => null)));
            for (let i = 0; i < rs.length; i++) {
                const r = rs[i]; if (!r || !Array.isArray(r.cands)) continue;
                const refId = asked[i][0];
                for (const c of r.cands.slice(0, 8)) {
                    if (typeof c !== 'string' || c === this.id) continue;
                    this.ledger.ref(c, cap, refId);
                    if (!this.peers.has(c)) this._peer(c, {});          // sem chave ainda: a 1ª resposta dele a traz
                    this._indexAdd(cap, c);
                }
            }
            cands = this._cands(cap);
        }
        return cands.map(id => ({ id, ...this.ledger.read(id, cap) })).sort((a, b) => b.lb - a.lb).slice(0, k);
    }
    _cands(cap) { const m = this.index.get(cap); return m ? [...m.keys()].filter(id => id !== this.id) : []; }

    // Pede uma capacidade. check(resultado) é o verificador AUTOMÁTICO (sem ele o resultado vale como "não verificado": não vira evidência).
    async request(cap, payload, { check, critical = false, timeoutMs = this.cfg.timeoutMs, peer } = {}) {
        this.stat.req++;
        let cands = this._cands(cap);
        if (cands.length === 0) cands = (await this.find(cap, { k: 3 })).map(c => c.id);
        const alvo = peer || this._pick(cap, cands, critical);
        if (!alvo) return { ok: false, erro: 'sem-candidato' };
        return this._exec(alvo, cap, payload, check, timeoutMs);
    }
    async _exec(alvo, cap, payload, check, timeoutMs, peso = 1) {
        const r0 = this.ledger.read(alvo, cap);
        this.stat.porNivel[r0.tier]++;
        this._bumpLoad(alvo);
        let res;
        try { res = await this._call(alvo, 'REQ', { cap, payload }, timeoutMs); }
        catch (e) { this.stat.timeouts++; this._settle(alvo, cap, false, 0.5 * peso); return { ok: false, peer: alvo, erro: String(e.message || e) }; }
        if (!res.ok) { this.stat.falhas++; this._settle(alvo, cap, false, 0.5 * peso); return { ok: false, peer: alvo, erro: res.err || 'erro' }; }
        if (!check) return { ok: true, peer: alvo, result: res.result, verificado: false };
        let certo = false; try { certo = !!(await check(res.result)); } catch (_) { certo = false; }
        this._settle(alvo, cap, certo, peso);
        if (certo) this.stat.ok++; else this.stat.falhas++;
        return { ok: certo, peer: alvo, result: res.result, verificado: true };
    }
    _settle(peer, cap, hit, w) {
        const ev = this.ledger.write(peer, cap, hit, w);
        this.ledger.settleRefs(peer, cap, hit, w);
        if (ev === 'restricao') this._ev('restricao', `${peer.slice(0, 6)} em ${cap}: raio reduzido; volta sozinho com evidência nova`);
    }

    // mérito (0,5) + disponibilidade (0,2) + rodízio (0,3) + cadeira do novato (0,25); crítico = só nível ≥ 2 e fora de restrição
    _pick(cap, cands, critical) {
        const list = []; let tot = 0;
        for (const id of cands.slice(0, 24)) {
            const r = this.ledger.read(id, cap);
            if (critical && (r.tier < 2 || r.restr)) continue;
            const merito = r.restr ? 0 : (r.n >= N1 ? clamp(0.5 + 2.5 * r.skill, 0, 1) : 0.5);   // sem prova = neutro; em restrição = 0
            const rod = 1 / (1 + 0.5 * this._loadOf(id));
            const p = this.peers.get(id); const livre = p && p.busy && this.now() < p.busy ? 0.1 : 1;
            const s = 0.5 * merito + 0.2 * livre + 0.3 * rod + (r.tier === 0 && !r.restr ? 0.25 : 0);   // em restrição: sem cadeira de novato (só a missão de calibração a reabilita)
            list.push([id, s]); tot += s;
        }
        if (!list.length) return null;
        let x = Math.random() * tot;
        for (const [id, s] of list) { x -= s; if (x <= 0) return id; }
        return list[list.length - 1][0];
    }
    _loadOf(id) { const l = this.load.get(id); return l ? l.c * Math.exp(-(this.now() - l.t) * Math.LN2 / 60000) : 0; }
    _bumpLoad(id) { this.load.set(id, { c: this._loadOf(id) + 1, t: this.now() }); if (this.load.size > this.cfg.maxPeers * 2) this.load.delete(this.load.keys().next().value); }

    // missões de calibração: dá chance a quem ainda está no nível 0 (e à restrição, que precisa reconstruir histórico)
    async calibrate(cap) {
        const gen = this.tasks.get(cap); if (!gen) return null;
        const novatos = this._cands(cap).filter(id => this.ledger.read(id, cap).tier === 0);
        if (!novatos.length) return null;
        const alvo = novatos[(Math.random() * novatos.length) | 0];
        const { payload, check } = gen();
        const r = await this._exec(alvo, cap, payload, check, this.cfg.timeoutMs, 1);
        return { peer: alvo, ok: r.ok };
    }
    _autopilot() { for (const cap of this.tasks.keys()) this.calibrate(cap).catch(() => {}); }

    signal(to, body) { return this._send(to, 'RTC', body); }

    // ---- glass-box
    explain(id, cap) {
        const r = this.ledger.read(id, cap), p = this.peers.get(id);
        return `${p?.name || '?'} (${id.slice(0, 8)}) em "${cap}": evidência ${r.n.toFixed(1)}, taxa ${r.mean.toFixed(2)} (limite inferior ${r.lb.toFixed(2)}) vs acaso ${r.chance.toFixed(2)} → vantagem ${r.skill.toFixed(2)}, nível ${r.tier}${r.restr ? ', EM RESTRIÇÃO' : ''}; credibilidade como indicador ${this.ledger.credOf(id).toFixed(2)}`;
    }
    stats() { return { id: this.id, peers: this.peers.size, ...this.stat, eventos: this.events.slice(-10) }; }

    // ------------------------------------------------------------ protocolo
    _peer(id, patch) {
        let p = this.peers.get(id);
        if (!p) {
            p = { name: '?', caps: new Set(), seen: this.now(), link: null, pubB64: null, key: null, busy: 0 };
            this.peers.set(id, p);
            if (this.peers.size > this.cfg.maxPeers) {                       // eviction do mais antigo sem reputação relevante
                let ve = null, vt = Infinity;
                for (const [k, v] of this.peers) if (v.seen < vt && k !== id) { vt = v.seen; ve = k; }
                if (ve) this._dropPeer(ve);
            }
        }
        Object.assign(p, patch); return p;
    }
    _dropPeer(id) { const p = this.peers.get(id); if (!p) return; for (const c of p.caps) this.index.get(c)?.delete(id); this.peers.delete(id); }
    _indexAdd(cap, id) {
        let m = this.index.get(cap); if (!m) { m = new Map(); this.index.set(cap, m); }
        m.delete(id); m.set(id, this.now());
        if (m.size > this.cfg.maxCapPeers) m.delete(m.keys().next().value);
    }

    async _env(t, to, body, h = 0) {
        const env = { v: 1, t, from: this.id, n: b64(crypto.getRandomValues(new Uint8Array(9))), ts: this.now(), body };
        if (to) env.to = to;
        const sig = await subtle().sign(SIG, this.ident.priv, enc.encode(canon(env)));
        env.sig = b64(new Uint8Array(sig)); env.pub = this.ident.pubB64; env.h = h;
        return env;
    }
    _raw(env, link) { const s = JSON.stringify(env); this.stat.tx++; (link ? [link] : [...this.links]).forEach(l => { try { l.send(s); } catch (_) {} }); }
    async _send(to, t, body) { const p = this.peers.get(to); this._raw(await this._env(t, to, body), p?.link || null); }
    _call(to, t, body, timeoutMs) {
        if (this.pending.size >= this.cfg.maxPending) return Promise.reject(new Error('muitos-pendentes'));
        return new Promise(async (resolve, reject) => {
            const rid = b64(crypto.getRandomValues(new Uint8Array(9)));
            const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error('timeout')); }, timeoutMs);
            this.pending.set(rid, { to, resolve, timer });
            try { await this._send(to, t, { rid, ...body }); } catch (e) { clearTimeout(timer); this.pending.delete(rid); reject(e); }
        });
    }
    async _announce() {
        if (!this.links.size) return;
        this._raw(await this._env('ANN', null, { name: this.name, caps: [...this.caps.keys()].slice(0, 16) }, 0));
    }

    _reject(motivo) { this.stat.rejeitadas++; this.stat.motivos[motivo] = (this.stat.motivos[motivo] || 0) + 1; }
    _bucket(id) {
        const t = this.now(); let b = this.buckets.get(id);
        if (!b) { b = { n: this.cfg.rateBurst, t }; this.buckets.set(id, b); if (this.buckets.size > this.cfg.maxPeers * 4) this.buckets.delete(this.buckets.keys().next().value); }
        b.n = Math.min(this.cfg.rateBurst, b.n + (t - b.t) / 1000 * this.cfg.ratePerSec); b.t = t;
        if (b.n < 1) return false; b.n--; return true;
    }

    async _onRaw(link, raw) {
        let env; try { env = JSON.parse(raw); } catch (_) { return this._reject('json'); }
        if (!env || env.v !== 1 || typeof env.from !== 'string' || typeof env.sig !== 'string' || typeof env.pub !== 'string' || typeof env.n !== 'string') return this._reject('formato');
        if (env.from === this.id) return;
        if (env.to && env.to !== this.id) return;                                   // não é para mim (relay em broadcast)
        const t = this.now();
        if (Math.abs(t - env.ts) > this.cfg.skewMs) return this._reject('relogio');
        if (this.nonces.has(env.n)) return this._reject('replay');
        if (!this._bucket(env.from)) return this._reject('taxa');
        // identidade: o id TEM de ser o hash da chave pública, e a assinatura TEM de fechar
        let p = this.peers.get(env.from);
        try {
            if (!p || p.pubB64 !== env.pub) {
                const raw = unb64(env.pub);
                if (await idOf(raw) !== env.from) return this._reject('id-nao-bate');
                const key = await subtle().importKey('raw', raw, ECDSA, false, ['verify']);
                p = this._peer(env.from, { pubB64: env.pub, key });
            }
            const { sig, pub, h, ...assinado } = env;
            if (!(await subtle().verify(SIG, p.key, unb64(sig), enc.encode(canon(assinado))))) return this._reject('assinatura');
        } catch (_) { return this._reject('cripto'); }
        this.nonces.set(env.n, t); if (this.nonces.size > this.cfg.nonceCap) this.nonces.delete(this.nonces.keys().next().value);
        this.stat.rx++;
        p.seen = t; if (!(p.rtc && p.rtc.open)) p.link = link;      // enlace WebRTC direto tem preferência sobre o relay
        const b = env.body || {};
        switch (env.t) {
            case 'ANN': return this._onAnn(env, p, b);
            case 'RTC': return this.onRtc?.(env.from, b);              // sinalização WebRTC (assinada, endereçada)
            case 'REQ': return this._onReq(env, p, b);
            case 'WHO': return this._onWho(env, p, b);
            case 'RES': case 'WHOR': {
                const q = this.pending.get(b.rid);
                if (q && q.to === env.from) { clearTimeout(q.timer); this.pending.delete(b.rid); q.resolve(b); }
                return;
            }
        }
    }

    async _onAnn(env, p, b) {
        const eraNovo = !p.caps.size && !p.annSeen;
        for (const c of p.caps) this.index.get(c)?.delete(env.from);
        p.name = String(b.name || '?').slice(0, 32); p.caps = new Set((Array.isArray(b.caps) ? b.caps : []).filter(x => typeof x === 'string').slice(0, 16)); p.annSeen = true;
        for (const c of p.caps) this._indexAdd(c, env.from);
        if (eraNovo) { this._announce(); this.onPeerNew?.(env.from); }               // apresentação mútua (+ gancho p/ abrir WebRTC)
        if ((env.h || 0) < 2 && this.links.size > 1) {                              // gossip limitado (2 saltos, nunca de volta)
            const re = { ...env, h: (env.h || 0) + 1 };
            for (const l of this.links) if (l !== p.link) try { l.send(JSON.stringify(re)); } catch (_) {}
        }
    }

    async _onReq(env, p, b) {
        const resp = async (ok, extra) => this._send(env.from, 'RES', { rid: b.rid, ok, ...extra });
        const c = this.caps.get(b.cap);
        if (!c) return resp(false, { err: 'sem-capacidade' });
        if (this.inflight >= this.cfg.maxInflight) return resp(false, { err: 'ocupado' });
        this.inflight++;
        try { resp(true, { result: await c.handler(b.payload, { from: env.from, name: p.name }) }); }
        catch (e) { resp(false, { err: String(e.message || e).slice(0, 80) }); }
        finally { this.inflight--; }
    }

    // indicação com orçamento: 3 plenas por época; quem indica só cita quem ele próprio já provou (nível ≥ 1, fora de restrição)
    async _onWho(env, p, b) {
        const t = this.now(); const ep = (t / this.cfg.epochMs) | 0;
        if (this.epoch.id !== ep) this.epoch = { id: ep, refs: 0 };
        this.epoch.refs++;
        const k = clamp(b.k | 0 || 3, 1, 8);
        const lim = this.epoch.refs > 12 ? 1 : k;                                   // além do orçamento, indica menos
        const cands = this._cands(String(b.cap)).filter(id => id !== env.from)
            .map(id => ({ id, r: this.ledger.read(id, b.cap) })).filter(x => x.r.tier >= 1 && !x.r.restr)
            .sort((a, c) => c.r.lb - a.r.lb).slice(0, lim).map(x => x.id);
        this._send(env.from, 'WHOR', { rid: b.rid, cands });
    }
}

// ------------------------------------------------------------------ transportes (send/onmessage/close)
export class MemoryHub {
    constructor({ adversario } = {}) { this.links = new Set(); this.adversario = adversario; }
    connect() {
        const l = { onmessage: null, onclose: null, send: raw => { for (const o of this.links) if (o !== l) { const r = this.adversario ? this.adversario(raw) : raw; if (r != null) queueMicrotask(() => o.onmessage?.(r)); } }, close: () => this.links.delete(l) };
        this.links.add(l); return l;
    }
}
export function wsTransport(url, WS = globalThis.WebSocket) {
    const ws = new WS(url), l = { onmessage: null, onclose: null, send: s => ws.send(s), close: () => ws.close() };
    l.ready = new Promise((ok, no) => { ws.onopen = () => ok(l); ws.onerror = no; });
    ws.onmessage = e => l.onmessage?.(typeof e.data === 'string' ? e.data : String(e.data)); ws.onclose = () => l.onclose?.();
    return l;
}
export function rtcTransport(dc) {                 // RTCDataChannel já aberto
    const l = { onmessage: null, onclose: null, send: s => dc.send(s), close: () => dc.close() };
    dc.onmessage = e => l.onmessage?.(e.data); dc.onclose = () => l.onclose?.(); return l;
}
export function channelTransport(nome = 'koinonia') {   // abas/janelas da mesma origem
    const bc = new BroadcastChannel(nome), l = { onmessage: null, onclose: null, send: s => bc.postMessage(s), close: () => bc.close() };
    bc.onmessage = e => l.onmessage?.(e.data); return l;
}
