// ============================================================================
// B.I.F.R.O.S.T. — a ponte entre o Pytronicos (T.H.E.M.I.S.) e o mundo real (Koinonia)
// js/modules/OMEGA/bifrost.js — [2026-10-25]
//
// Analogia: é a ponte-levadiça do castelo (o Pytronicos) com um GUARDA e um SINO.
//   • O guarda olha a ponte a cada 2 s e a cada 30 s manda um mensageiro até o outro lado
//     (um "eco" a algum par) para PROVAR que ela está de pé — ponte que parece inteira mas
//     não leva ninguém ao outro lado não conta como ponte.
//   • O sino toca (faixa vermelha, vibração, título da aba, notificação) quando ela cai e
//     de novo, em verde, quando volta, dizendo QUANTO tempo ficou fora e a causa provável.
//   • As moradoras (entidades) ganham 6 SENTIDOS sobre a ponte (env_ponte_*): elas podem
//     descobrir sozinhas, por hipótese e verificação (THEMIS), o que faz a ponte cair —
//     por ex. "a ponte cai quando a aba fica oculta". Não recebem texto: recebem fatos.
//
// O que atravessa a ponte (a "parede" continua de pé):
//   SAI  (só leitura, agregado, sem ids de entidades): eco · pytronicos.pulso · pytronicos.especialistas
//   ENTRA nada executável: só respostas a pedidos que o próprio Pytronicos faz (consultar()).
//   Nenhuma hipótese, energia ou recompensa entra por ela.
//
// Limites honestos: avisa SÓ enquanto a página está aberta (fora dela não há quem vigie);
//   em celular a aba oculta é congelada pelo sistema; um socket "morto em silêncio" só é pego
//   quando há algum par para responder à sonda; sem cifra de payload (use wss).
// Autônomo: sem flag para ligar. Ablação (só para provar efeito): window.bifrostOff = true.
// Depende de koinonia.js (v0.2) e koinonia-rtc.js NA MESMA PASTA deste arquivo; pleiades.js e aduana.js são opcionais (mesma pasta).
//
// v1.4 (2026-10-27): recados CIFRADOS e SELADOS (Koinonia v0.2) · prova de identidade no relay (worker v2) — o painel diz
//   se o relay aceitou · identidade salva de novo a cada início (guarda a chave de cifra nova) · A.D.U.A.N.A. ligada à
//   Pleiades (julga o que entra; quem foi pego mentindo fica 1 h sem pulso/especialistas) · etiqueta da aduana nos
//   recados (só etiqueta: você decide) · fatia 2 da Pleiades: bateria + campo magnético (sentidos env_rede_bat/_mag).
// ============================================================================
import { Node, createIdentity } from './koinonia.js';
import { rtcMesh } from './koinonia-rtc.js';

const RELAY = 'wss://koinonia.caio-marciahelena.workers.dev/pytronicos';   // sala "pytronicos" (troque com localStorage.bifrostRelay)
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];                    // + TURN seu, se um dia precisar
const GRACA_MS = 6000;       // quanto uma queda precisa durar para MUDAR O ESTADO (painel e sentidos das entidades)
const SINO_MS = 60000;       // quanto precisa durar para TOCAR O SINO (faixa, vibração, notificação): "1 minuto é uma eternidade" (AGI)
const MEIA_VIDA_PARES = 3 * 24 * 3600 * 1000;   // a reputação dos pares vale dias (o Pytronicos só liga quando você abre), não minutos
const SONDA_MS = 30000;      // prova de vida
const INICIO_TICK = 60;      // espera o jogo subir antes de ligar a ponte
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
};
const dur = ms => ms < 60000 ? Math.round(ms / 1000) + ' s' : Math.round(ms / 60000) + ' min';

export class BIFROST_Engine {
    constructor() {
        this.versao = '1.4 (2026-10-27)'; this.pleiades = null; this.aduana = null; this._abertoEm = 0;
        this.node = null; this.mesh = null; this._ws = null;
        this._tick = 0; this._iniciou = false; this._t0 = Date.now();
        this._estado = 'iniciando';           // iniciando | conectando | ok | degradada | caida | inativa
        this._cand = 'iniciando'; this._candDesde = Date.now();
        this._jaConectou = false; this._wsAberto = false;
        this._tentativas = 0; this._backoff = 1000; this._timerRec = null;
        this._ultimoCodigo = null; this._ultimoMotivo = '';
        this._rtt = 0; this._sondaOk = null; this._falhasSeguidas = 0; this._ultimaSonda = 0; this._viaUltima = '';
        this._fatal = '';                     // causa permanente (ex.: sem WebCrypto)
        this._queda = null;                   // {ini, causa, nivel} da queda em curso
        this._hist = []; try { this._hist = JSON.parse(ls.get('bifrost.hist') || '[]'); } catch (_) { this._hist = []; }
        this._log = []; this._c = { quedas: 0, reconexoes: 0, sondas: 0, sondasFalhas: 0, erros: 0, ultimoErro: '' };
        this._ctx = {
            env_ponte_up: 0, env_ponte_rtt: 0, env_ponte_pares: 0, env_ponte_direto: 0, env_ponte_oculta: 0, env_ponte_offline: 0,
            'Ω_ponte_up': 0, 'Ω_ponte_rtt': 0, 'Ω_ponte_pares': 0, 'Ω_ponte_direto': 0, 'Ω_ponte_oculta': 0, 'Ω_ponte_offline': 0,
            env_rede_rtt: 0, env_rede_relay_visto: 0, env_rede_relogio: 0, env_rede_confianca: 0.5, env_rede_bat: 0, env_rede_mag: 0,
            'Ω_rede_rtt': 0, 'Ω_rede_relay_visto': 0, 'Ω_rede_relogio': 0, 'Ω_rede_confianca': 0.5, 'Ω_rede_bat': 0, 'Ω_rede_mag': 0
        };
        this._caixa = []; try { this._caixa = JSON.parse(ls.get('bifrost.caixa') || '[]'); } catch (_) { this._caixa = []; }   // recados recebidos (só leitura; nada é executado)
        this._conhecidos = new Map(); try { this._conhecidos = new Map(JSON.parse(ls.get('bifrost.conhecidos') || '[]')); } catch (_) {}   // id -> nome (para deixar recado a quem está offline)
        this._ui = null; this._aberto = false; this._tituloOrig = null;
    }

    // ------------------------------------------------------------------ ciclo de vida
    tick(f) {
        this._tick = f;
        if (typeof window !== 'undefined' && window.bifrostOff === true) return;
        if (!this._iniciou && f >= INICIO_TICK) { this._iniciou = true; this._inicia().catch(e => this._erro(e)); }
        if (f % 15 === 0) this._sentidos();
        else if (f % 15 === 7 && this.aduana) { try { if (this.aduana.tick(f)) this.pleiades?._recalcula?.(); } catch (e) { this._erro(e); } }   // aduana julga DENTRO do tick (mesma thread do jogo; sem corrida com a entidade)
    }

    async _inicia() {
        this._montaPainel();
        if (!globalThis.crypto?.subtle) { this._fatal = 'sem-webcrypto'; this._estado = 'inativa'; this._avisa('erro', 'Ponte inativa', this.diagnostico().texto); return; }
        if (typeof WebSocket === 'undefined') { this._fatal = 'sem-websocket'; this._estado = 'inativa'; return; }
        let ident = null;
        try { const s = ls.get('bifrost.id'); if (s) ident = await createIdentity(JSON.parse(s)); } catch (_) { ident = null; }
        if (!ident) ident = await createIdentity();
        if (ident.novaCifra) ls.set('bifrost.id', JSON.stringify(await ident.exportar()));   // v1.4: guarda a chave de cifra (nova ou não) junto da identidade
        this.node = await Node.create({ identity: ident, name: 'pytronicos', halfLifeMs: MEIA_VIDA_PARES });
        try { const l = ls.get('bifrost.ledger'); if (l && this.node.importLedger(JSON.parse(l))) this._reg('memoria', `reputação dos pares restaurada (${this.node.ledger.cells.size} células)`); } catch (_) {}
        try { this.node.importNotas(JSON.parse(ls.get('bifrost.notas') || '[]')); } catch (_) {}
        this.node.onnote = n => this._recebeRecado(n);
        this._salvaLedger = () => { try { ls.set('bifrost.ledger', JSON.stringify(this.node.exportLedger())); ls.set('bifrost.notas', JSON.stringify(this.node.exportNotas())); ls.set('bifrost.conhecidos', JSON.stringify([...this._conhecidos].slice(-100))); } catch (_) {} };
        setInterval(this._salvaLedger, 30000);
        window.addEventListener('pagehide', this._salvaLedger);
        this.node.onevent = (t, x) => this._reg('koinonia:' + t, x);
        this._serve();
        if (globalThis.RTCPeerConnection) { try { this.mesh = rtcMesh(this.node, { iceServers: ICE }); } catch (e) { this._erro(e); } }
        (async () => {                                  // aduana + rede de sensores (opcionais: se um arquivo faltar, a ponte segue sem ele)
            try { const a = await import('./aduana.js'); this.aduana = new a.ADUANA({ log: t => this._reg('aduana', t) }); this._reg('aduana', 'aduana ativa (sombra até provar)'); }
            catch (e) { this._reg('aduana', 'não iniciou: ' + (e?.message || e)); }
            try {
                const m = await import('./pleiades.js');
                if (window.pleiadesOff === true) return;
                const fis = () => window.substrateBridge?.getPhysicalStats?.();
                this.pleiades = new m.PLEIADES(this.node, {
                    horaUrl: m.horaDeRelay(this._url()), relayAberto: () => this._wsAberto, log: t => this._reg('pleiades', t), aduana: this.aduana,
                    fontes: { cf: () => fis()?.rtt, mag: () => { const s = fis(); return s ? { vivo: s.mag.source !== 'indisponível', d: s.mag.disturb } : null; } }
                });
                this.aduana?.ligar(this.pleiades);
                this._reg('pleiades', 'rede de sensores ativa');
            } catch (e) { this._reg('pleiades', 'não iniciou: ' + (e?.message || e)); }
        })();
        window.addEventListener('online', () => { this._reg('rede', 'aparelho voltou a ter internet'); this._reconecta(0); });
        window.addEventListener('offline', () => this._reg('rede', 'aparelho ficou SEM internet'));
        document.addEventListener('visibilitychange', () => { if (document.hidden) this._salvaLedger?.(); this._reg('aba', document.hidden ? 'aba oculta (o sistema pode congelar a ponte)' : 'aba visível de novo'); if (!document.hidden) this._reconecta(0); });
        setInterval(() => { try { this._avalia(); } catch (e) { this._erro(e); } }, 2000);
        setInterval(() => { this._sonda().catch(e => this._erro(e)); }, SONDA_MS);
        this._estado = 'conectando'; this._cand = 'conectando';
        this._conecta();
    }

    // O que o Pytronicos oferece ao mundo: só leitura e agregado (nenhum id de entidade, nenhuma hipótese).
    _serve() {
        this.node.serve('eco', x => (JSON.stringify(x ?? null).length <= 2000 ? x : null));
        const guarda = q => { if (this.aduana?.barrado?.(q?.from)) throw new Error('barrado-pela-aduana'); };   // pego mentindo: 1 h sem nada nosso
        this.node.serve('pytronicos.pulso', (_, q) => {
            guarda(q);
            const t = window.themis?.getStats?.();
            return {
                tick: this._tick, ponte: this.estado(),
                themis: t ? { registros: t.registros, niveis: t.niveis, brierSkill: t.brierSkill, restritos: t.restritos } : null
            };
        });
        this.node.serve('pytronicos.especialistas', (dom, q) => {
            guarda(q);
            if (typeof dom !== 'string' || dom.length > 24 || !window.themis) return [];
            return window.themis.procurar(dom, 3).map(e => ({ nivel: e.nivel, limiteInferior: e.limiteInferior, evidencia: e.evidencia }));
        });
    }

    // Único caminho de ENTRADA: o Pytronicos pede, um par responde, o verificador (check) confere. Sem check, o resultado é só informação.
    async consultar(cap, payload, opts = {}) {
        if (!this.node || this._estado === 'caida' || this._estado === 'inativa') return { ok: false, erro: 'ponte-' + this._estado };
        return this.node.request(cap, payload, opts);
    }

    // ------------------------------------------------------------------ recados (caixa postal no relay)
    // SAÍDA: o Pytronicos (ou você, pelo painel) deixa um recado assinado, com validade, para um par que pode estar desligado agora.
    async deixarRecado(paraId, tema, dados, horas = 24) {
        if (!this.node) throw new Error('ponte-inativa');
        await this.node.note(paraId, String(tema).slice(0, 48), dados, { ttlMs: horas * 3600e3 });
        this._reg('recado', `deixado para ${this._conhecidos.get(paraId) || paraId.slice(0, 6)} (${tema}, vale ${horas} h)`);
    }
    // ENTRADA: só vira texto na caixa de entrada. Nada é executado, nada entra no mundo das entidades.
    _recebeRecado(n) {
        if (!/^[\w.:-]{1,48}$/.test(n.cap)) return;
        let txt; try { txt = typeof n.data === 'string' ? n.data : JSON.stringify(n.data); } catch (_) { txt = '?'; }
        let etq = ''; try { etq = this.aduana?.etiquetaRecado?.(n.from) || ''; } catch (_) {}
        this._caixa.push({ id: n.id, de: n.from, nome: String(n.name || this._conhecidos.get(n.from) || '?').slice(0, 24), tema: n.cap, texto: String(txt).slice(0, 2000), ts: n.ts, nivel: n.nivel, etiqueta: etq, lido: false });
        if (this._caixa.length > 50) this._caixa.shift();
        ls.set('bifrost.caixa', JSON.stringify(this._caixa));
        this._reg('recado', `recebido de ${this._caixa[this._caixa.length - 1].nome} (${n.cap})`);
        try { window.dispatchEvent(new CustomEvent('bifrost:recado', { detail: { de: n.from, tema: n.cap } })); } catch (_) {}
        try { navigator.vibrate?.(100); } catch (_) {}
        this._pinta();
    }
    recados() { return this._caixa.slice(); }

    // ------------------------------------------------------------------ conexão com reconexão
    _conecta() {
        if (this._ws && this._ws.readyState < 2) return;
        const url = ls.get('bifrostRelay') || RELAY;
        let ws;
        try { ws = new WebSocket(url); } catch (e) { this._ultimoMotivo = 'url-invalida'; this._agendaRec(); return; }
        this._tentativas++;
        const link = { relay: true, onmessage: null, onclose: null, send: s => ws.send(s), close: () => ws.close() };   // relay: true → responde ao DESAFIO do relay
        let abriu = false;
        ws.onopen = () => {
            abriu = true; this._ws = ws; this._wsAberto = true; this._jaConectou = true; this._abertoEm = Date.now();
            this._tentativas = 0; this._backoff = 1000; this._falhasSeguidas = 0; this._ultimoCodigo = null; this._ultimoMotivo = '';
            this.node.attach(link); this._c.reconexoes++;
            this._reg('ponte', 'socket aberto em ' + url.replace(/^wss?:\/\//, '').slice(0, 48));
        };
        ws.onmessage = e => link.onmessage?.(typeof e.data === 'string' ? e.data : String(e.data));
        ws.onerror = () => {};                                   // o navegador não revela o motivo; o código vem no onclose
        ws.onclose = e => {
            this._wsAberto = false; if (this._ws === ws) this._ws = null;
            this._ultimoCodigo = e.code; this._ultimoMotivo = e.reason || '';
            try { link.onclose?.(); } catch (_) {}
            this._reg('ponte', `socket fechado (código ${e.code}${e.reason ? ', ' + e.reason : ''}${abriu ? '' : ', nunca chegou a abrir'})`);
            this._agendaRec();
        };
    }
    _agendaRec() {
        if (this._timerRec) return;
        const d = Math.min(30000, this._backoff) * (0.7 + Math.random() * 0.6);
        this._backoff = Math.min(30000, this._backoff * 2);
        this._timerRec = setTimeout(() => { this._timerRec = null; this._conecta(); }, d);
    }
    _reconecta(ms) {
        if (!this.node || this._wsAberto) return;
        if (this._timerRec) { clearTimeout(this._timerRec); this._timerRec = null; }
        this._backoff = 1000; setTimeout(() => this._conecta(), ms);
    }
    reconectarAgora() {
        if (this._ws) { try { this._ws.close(); } catch (_) {} } else this._reconecta(0);
        this._reg('ponte', 'reconexão manual pedida');
    }

    // ------------------------------------------------------------------ prova de vida
    async _sonda() {
        if (!this.node || !this._wsAberto) return;
        const ids = [...this.node.peers.entries()].filter(([, p]) => p.caps?.has?.('eco')).map(([id]) => id);
        if (!ids.length) { this._sondaOk = null; return; }                    // sozinha na sala: não há como provar
        const id = ids[(Math.random() * ids.length) | 0], s = 'b' + ((Math.random() * 1e9) | 0), t0 = performance.now();
        this._c.sondas++;
        const r = await this.node.request('eco', s, { peer: id, check: x => x === s, timeoutMs: 6000 });
        if (r.ok) {
            const ms = performance.now() - t0;
            this._rtt = this._rtt ? this._rtt * 0.7 + ms * 0.3 : ms;
            this._sondaOk = true; this._falhasSeguidas = 0; this._ultimaSonda = Date.now();
            this._viaUltima = this.node.peers.get(id)?.rtc?.open ? 'direto' : 'relay';
        } else {
            this._c.sondasFalhas++; this._falhasSeguidas++; this._sondaOk = false;
            this._reg('sonda', `falhou (${r.erro || 'check'}), ${this._falhasSeguidas} seguida(s)`);
            if (this._falhasSeguidas >= 3 && this._ws) { this._reg('ponte', 'socket sem prova de vida: derrubando para reconectar'); try { this._ws.close(); } catch (_) {} }
        }
    }

    // ------------------------------------------------------------------ estado + sino
    estado() {
        const n = this.node, pares = n ? n.peers.size : 0;
        const diretos = n ? [...n.peers.values()].filter(p => p.rtc?.open).length : 0;
        return { estado: this._estado, pares, diretos, rttMs: Math.round(this._rtt), sondaOk: this._sondaOk, viaUltimaSonda: this._viaUltima };
    }
    _avalia() {
        const e = this.estado();
        if (this.node) for (const [id, p] of this.node.peers) if (p.name && this._conhecidos.get(id) !== p.name) { this._conhecidos.delete(id); this._conhecidos.set(id, String(p.name).slice(0, 24)); }
        let cand;
        if (this._fatal) cand = 'inativa';
        else if (!this.node) cand = 'iniciando';
        else if (this._wsAberto) cand = 'ok';
        else if (e.diretos > 0) cand = 'degradada';
        else if (!this._jaConectou && Date.now() - this._t0 < 20000 && this._tentativas < 3) cand = 'conectando';
        else cand = 'caida';
        if (cand !== this._cand) { this._cand = cand; this._candDesde = Date.now(); }
        const subindo = cand === 'ok' || cand === 'conectando' || cand === 'iniciando';
        if (cand !== this._estado && (subindo || Date.now() - this._candDesde >= GRACA_MS)) this._transicao(this._estado, cand);
        this._pinta();
    }
    _transicao(de, para) {
        this._estado = para;
        this._reg('estado', `${de} → ${para}`);
        if (para === 'caida' || para === 'degradada') {
            if (!this._queda) { this._queda = { ini: Date.now(), causa: this.diagnostico().causa, nivel: para }; this._c.quedas++; }
            else this._queda.nivel = para === 'caida' ? 'caida' : this._queda.nivel;
            clearTimeout(this._tSino);                          // o sino só toca se a queda durar SINO_MS; antes disso fica só no registro/painel/sentidos
            this._tSino = setTimeout(() => {
                if (!this._queda || this._estado === 'ok' || this._estado === 'conectando') return;
                this._queda.avisada = true;
                const d = this.diagnostico();
                this._avisa(this._estado === 'caida' ? 'erro' : 'aviso', this._estado === 'caida' ? '🌉 Ponte CAIU' : '🌉 Ponte degradada', `Fora há ${dur(Date.now() - this._queda.ini)}. ` + d.texto + (d.sugestao ? '\n→ ' + d.sugestao : ''));
            }, SINO_MS);
        } else if (para === 'ok' && this._queda) {
            const q = this._queda; this._queda = null; clearTimeout(this._tSino);
            const ms = Date.now() - q.ini;
            this._hist.push({ ini: q.ini, ms, causa: q.causa, nivel: q.nivel }); if (this._hist.length > 20) this._hist.shift();
            ls.set('bifrost.hist', JSON.stringify(this._hist));
            if (q.avisada) this._avisa('ok', '🌉 Ponte de volta', `Ficou fora ${dur(ms)} (causa provável: ${q.causa}).`);
            else this._reg('ponte', `queda curta de ${dur(ms)} (${q.causa}): sem sino, abaixo de ${dur(SINO_MS)}`);
        } else if (para === 'ok' && de === 'conectando') {
            this._reg('ponte', 'ponte de pé pela primeira vez nesta sessão');
        } else if (para === 'inativa') {
            this._avisa('erro', '🌉 Ponte inativa', this.diagnostico().texto);
        }
    }

    // Causa provável, da mais determinante para a mais genérica (a verdade que o navegador deixa saber é pouca: ver "limites").
    diagnostico() {
        const e = this.estado(), n = this.node, cod = this._ultimoCodigo;
        const out = (causa, texto, sugestao = '') => ({ causa, texto, sugestao });
        if (this._fatal === 'sem-webcrypto') return out('sem-webcrypto', 'Esta página não tem WebCrypto (precisa ser https:// ou localhost) — a ponte não consegue nem criar identidade.', 'Abra o Pytronicos por https ou por localhost.');
        if (this._fatal === 'sem-websocket') return out('sem-websocket', 'Este navegador não oferece WebSocket.', 'Use um navegador atual.');
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return out('aparelho-offline', 'O aparelho está SEM internet (modo avião, Wi‑Fi ou dados desligados).', 'Religue a conexão; a ponte volta sozinha.');
        if (typeof document !== 'undefined' && document.hidden) return out('aba-oculta', 'A aba está em segundo plano: celulares congelam sockets e temporizadores de abas ocultas.', 'Volte para a aba; a ponte reconecta sozinha.');
        if (cod === 1008) return out('limite-de-taxa', 'O relay fechou a conexão por excesso de mensagens (código 1008).', 'Reduza o tráfego; a ponte tenta de novo com espera crescente.');
        if (cod === 1013) return out('sala-cheia', 'A sala do relay está cheia (64 conexões).', 'Use outra sala em localStorage.bifrostRelay.');
        if (n?.stat.motivos?.relogio > 0 && this._estado === 'ok') return out('relogio', 'Mensagens estão sendo rejeitadas por diferença de relógio (> 60 s) entre os aparelhos.', 'Ative a hora automática nos aparelhos.');
        if (this._estado === 'degradada' || this._estado === 'caida') {
            const vr = this.pleiades?.veRelay?.();
            if (vr && vr.up + vr.down >= 2) {
                if (vr.down === 0 && vr.up >= 2) return out('minha-rede', `Pares por canal direto dizem que o relay está DE PÉ (${vr.up} de ${vr.up + vr.down}): o problema está na SUA rede/caminho até o relay, não no relay.`, 'Troque de rede (Wi‑Fi↔dados) ou espere; o relay está bem.');
                if (vr.up === 0 && vr.down >= 2) return out('relay-fora-confirmado', `Pares por canal direto também perderam o relay (${vr.down} de ${vr.up + vr.down}): o relay (Cloudflare) está fora ou a cota acabou.`, 'Não é a sua rede. Confira o painel da Cloudflare e o UptimeRobot.');
            }
        }
        if (this._estado === 'degradada') return out('relay-fora-canal-direto-vivo', 'O relay não responde, mas há canais diretos (WebRTC) abertos: a ponte funciona só com quem já estava conectado, sem achar pares novos.', 'Espere o relay voltar (ou confira o Worker na Cloudflare).');
        if (this._estado === 'caida' || this._estado === 'conectando') {
            const t = this._tentativas;
            if (!this._jaConectou) return out('relay-inacessivel', `Nunca conectou (${t} tentativa(s), último código ${cod ?? '—'}): URL do relay errada, relay fora do ar ou bloqueado pela rede.`, 'Confira o endereço (wss://…/sala), abra a URL https do Worker no navegador (deve responder "Koinonia relay") e tente em outra rede.');
            return out('relay-caiu-ou-rede-instavel', `A conexão que estava de pé caiu (código ${cod ?? '—'}, ${t} tentativa(s) de religar). Causas possíveis, da mais comum: troca/oscilação de rede (Wi‑Fi↔dados), o relay reiniciou ou o plano grátis da Cloudflare atingiu o limite diário.`, 'Costuma voltar sozinha; se durar, veja o painel da Cloudflare (Workers → koinonia → Metrics) por erros/cota.');
        }
        const pv = n?.stat?.relayProvado, aberto = this._wsAberto ? Date.now() - this._abertoEm : 0;
        if (this._estado === 'ok' && pv === false && aberto > 10000) return out('relay-recusou', 'O relay não aceitou a prova de identidade deste aparelho: sem ela não chegam recados nem dá para falar na sala.', 'Veja o motivo nos eventos (koinonia:relay). Se a identidade salva estiver corrompida, apague localStorage "bifrost.id" (perde a reputação deste aparelho).');
        if (this._estado === 'ok' && pv == null && aberto > 10000) return out('relay-v1', 'O relay não pediu prova de identidade: é a versão antiga do worker.js. Recados selados não ficam guardados nele.', 'Publique o worker.js v2 na Cloudflare.');
        if (this._estado === 'ok' && e.pares === 0) return out('sala-vazia', 'Conectada ao relay, mas ninguém mais está na sala: a ponte está de pé, só não há com quem falar (e por isso não dá para provar vida).', '');
        if (this._estado === 'ok' && this._sondaOk === false) return out('pares-nao-respondem', 'O socket está aberto, mas os pares não respondem às sondas: pode ser socket morto em silêncio ou par travado.', 'A ponte derruba e religa sozinha após 3 falhas.');
        if (this.mesh && this.mesh.stat.falhas > 2 && this.mesh.stat.abertas === 0) return out('nat-sem-turn', 'Canais diretos não abrem (NAT de operadora). Tudo passa pelo relay, que funciona.', 'Só um servidor TURN abriria canal direto; não é obrigatório.');
        return out('ok', 'Ponte saudável.', '');
    }

    _avisa(nivel, titulo, texto) {
        this._reg('AVISO', titulo + ' — ' + texto.replace(/\n/g, ' '));
        try { window.dispatchEvent(new CustomEvent('bifrost:estado', { detail: { nivel, titulo, texto, estado: this._estado } })); } catch (_) {}
        try { if (nivel !== 'ok') navigator.vibrate?.([200, 100, 200]); } catch (_) {}
        try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(titulo, { body: texto, tag: 'bifrost' }); } catch (_) {}
        try {
            if (this._tituloOrig === null) this._tituloOrig = document.title;
            document.title = nivel === 'ok' ? this._tituloOrig : (nivel === 'erro' ? '🔴 ' : '🟡 ') + this._tituloOrig;
            let b = document.getElementById('bifrost-faixa');
            if (!b) {
                b = document.createElement('div'); b.id = 'bifrost-faixa';
                Object.assign(b.style, { position: 'fixed', left: '0', right: '0', top: '0', zIndex: '99999', padding: '8px 12px', font: '12px/1.35 monospace', color: '#fff', whiteSpace: 'pre-wrap', cursor: 'pointer' });
                b.onclick = () => { b.style.display = 'none'; };
                document.body.appendChild(b);
            }
            b.style.background = nivel === 'ok' ? '#1f7a3a' : nivel === 'erro' ? '#a32222' : '#a06a12';
            b.textContent = titulo + '\n' + texto; b.style.display = 'block';
            clearTimeout(this._tFaixa);
            if (nivel === 'ok') this._tFaixa = setTimeout(() => { b.style.display = 'none'; }, 9000);
        } catch (_) {}
    }

    // ------------------------------------------------------------------ sentidos das entidades (O(1), objeto reutilizado)
    _sentidos() {
        const e = this.estado(), c = this._ctx;
        const up = e.estado === 'ok' ? 1 : e.estado === 'degradada' ? 0.5 : 0;
        const v = {
            up, rtt: clamp(e.rttMs / 2000, 0, 1), pares: clamp(e.pares / 8, 0, 1), direto: e.pares ? e.diretos / e.pares : 0,
            oculta: (typeof document !== 'undefined' && document.hidden) ? 1 : 0,
            offline: (typeof navigator !== 'undefined' && navigator.onLine === false) ? 1 : 0
        };
        for (const k in v) { c['env_ponte_' + k] = v[k]; c['Ω_ponte_' + k] = v[k]; }
        if (this.pleiades) Object.assign(c, this.pleiades.getContextAugment());
    }
    getContextAugment() { return this._ctx; }
    _url() { return ls.get('bifrostRelay') || RELAY; }

    // ------------------------------------------------------------------ explicação (humanos; as entidades recebem os sentidos acima)
    explicar() {
        const e = this.estado(), d = this.diagnostico(), L = [];
        L.push(`B.I.F.R.O.S.T. ${this.versao} — estado: ${this._estado.toUpperCase()} — pares ${e.pares} (${e.diretos} direto) — RTT ${e.rttMs || '—'} ms${e.viaUltimaSonda ? ' via ' + e.viaUltimaSonda : ''}`);
        L.push(`Diagnóstico: ${d.texto}${d.sugestao ? '\n  → ' + d.sugestao : ''}`);
        L.push('');
        L.push('COMO A PONTE FUNCIONA');
        L.push('1. O Pytronicos tem uma identidade criptográfica própria (guardada neste aparelho) e entra numa sala do relay (Cloudflare) por WebSocket. Tudo que sai é assinado.');
        L.push('2. Quando acha outro par na sala, tenta abrir um canal DIRETO (WebRTC); o relay vira só ponto de encontro e reserva.');
        L.push('3. Para fora só vai leitura agregada (pulso, especialistas por domínio, eco). Para dentro só entram respostas a pedidos que o Pytronicos mesmo fez.');
        L.push('4. A cada 30 s uma sonda ("eco") prova que o outro lado responde; 3 falhas seguidas derrubam e religam o socket.');
        L.push('5. O estado muda após 6 s fora; o sino (faixa, vibração, notificação) só toca se a queda durar 1 min. Religa com espera crescente (1 s → 30 s).\n6. A reputação dos pares é guardada neste aparelho e vale por dias: quem você já conheceu é lembrado quando você reabre.');
        L.push('');
        L.push('SE ESTIVER FORA, CAUSAS POSSÍVEIS: aparelho sem internet · aba oculta/congelada · relay fora ou URL errada · cota diária do plano grátis · troca de rede · relógio desajustado · sala cheia. O navegador não diz qual; o diagnóstico acima é a melhor inferência.');
        L.push('RECADOS: você pode deixar um recado a um par que já se apresentou alguma vez (mesmo desligado agora); ele chega quando o par abrir. CIFRADO e SELADO: o relay vê só o destino, a validade e o tamanho — nem o texto nem quem assinou. Valem até 72 h pelo painel. A aduana só põe etiqueta; quem decide é você.');
        L.push('REDE DE SENSORES: cada aparelho mede a hora do relay e o RTT; os pares se conferem (tempo e RTT são provados; CF só é plausível); mentiroso pesa zero. Só sai valor arredondado. Sentidos: env_rede_rtt / _relay_visto / _relogio / _confianca.');
        L.push('SENTIDOS DAS ENTIDADES: env_ponte_up / _rtt / _pares / _direto / _oculta / _offline (todas em 0–1). Elas podem descobrir sozinhas as relações entre eles (THEMIS verifica).');
        L.push('');
        L.push('HISTÓRICO DE QUEDAS (últimas): ' + (this._hist.length ? this._hist.slice(-5).map(h => `${new Date(h.ini).toLocaleString()} · ${dur(h.ms)} · ${h.causa}`).join(' | ') : 'nenhuma registrada'));
        L.push(`Sondas ${this._c.sondas} (falhas ${this._c.sondasFalhas}) · quedas nesta sessão ${this._c.quedas} · reconexões ${this._c.reconexoes} · erros ${this._c.erros}${this._c.ultimoErro ? ' (' + this._c.ultimoErro + ')' : ''}`);
        if (this.node) { L.push(`Pares lembrados entre sessões: ${new Set([...this.node.ledger.cells.keys()].map(k => k.split('|')[0])).size} · chaves de cifra conhecidas: ${this.node.chaves?.size ?? '— (koinonia.js antigo!)'}`); const s = this.node.stats(); L.push(`Koinonia: tx ${s.tx} rx ${s.rx} rejeitadas ${s.rejeitadas} ${JSON.stringify(s.motivos)} · id ${this.node.id.slice(0, 8)} · relay ${s.relayProvado === true ? 'ACEITOU a prova de identidade' : s.relayProvado === false ? 'NÃO aceitou (ainda)' : 'não pediu prova (worker antigo?)'}`); }
        const nl = this._caixa.filter(c => !c.lido).length;
        L.push(`CAIXA DE ENTRADA: ${this._caixa.length} recado(s), ${nl} não lido(s) — só texto, nada é executado${this._caixa.length ? ':' : ''}`);
        for (const c of this._caixa.slice(-4)) L.push(`  ${c.lido ? ' ' : '•'} ${new Date(c.ts).toLocaleString()} de ${c.nome} (nível ${c.nivel}) [${c.tema}] ${c.texto.slice(0, 140)}${c.etiqueta ? '  ' + c.etiqueta : ''}`);
        if (this.pleiades) L.push('', this.pleiades.resumo(), '');
        if (this.aduana) L.push(this.aduana.resumo(), '');
        try { const x = window.themis?.getStats?.().externo; if (x && x.length) L.push('O QUE AS ENTIDADES TENTAM USAR DO MUNDO EXTERNO: ' + x.map(e => `${e.chave} (${e.usos} usos, ${Math.round(e.acerto * 100)}% úteis)`).join(' · ')); } catch (_) {}
        L.push('— eventos —');
        for (const x of this._log.slice(-10)) L.push(`${new Date(x.t).toLocaleTimeString()} ${x.tipo}: ${x.txt}`);
        return L.join('\n');
    }

    _reg(tipo, txt) { this._log.push({ t: Date.now(), tipo, txt: String(txt).slice(0, 200) }); if (this._log.length > 60) this._log.shift(); }
    _erro(e) { this._c.erros++; this._c.ultimoErro = String(e?.message || e).slice(0, 80); }

    // ------------------------------------------------------------------ painel (auto-injeta, sem tocar o HTML)
    _montaPainel() {
        const css = (el, o) => { for (const k in o) el.style[k] = o[k]; };
        const btn = document.createElement('button');
        btn.id = 'bifrost-btn'; btn.textContent = '🌉 Bifrost ●';
        css(btn, { font: '12px monospace', padding: '4px 8px', margin: '4px', background: '#1d2b3a', color: '#cfe3ff', border: '1px solid #3b5878', borderRadius: '6px', cursor: 'pointer' });
        const box = document.createElement('div');
        box.id = 'bifrost-box';
        css(box, { display: 'none', position: 'fixed', left: '8px', bottom: '48px', width: 'min(94vw, 480px)', maxHeight: '70vh', overflow: 'auto', zIndex: '99998', background: 'rgba(12,18,26,0.96)', color: '#cfe3ff', border: '1px solid #3b5878', borderRadius: '8px', padding: '8px', font: '11px/1.35 monospace' });
        const pre = document.createElement('pre'); css(pre, { margin: '0 0 6px 0', whiteSpace: 'pre-wrap' });
        const b1 = document.createElement('button'); b1.textContent = 'Reconectar agora'; css(b1, { font: '11px monospace', marginRight: '6px' });
        b1.onclick = () => this.reconectarAgora();
        const b2 = document.createElement('button'); b2.textContent = 'Ativar avisos do sistema'; css(b2, { font: '11px monospace' });
        b2.onclick = async () => {
            try { const r = await Notification.requestPermission(); b2.textContent = r === 'granted' ? 'Avisos do sistema: ligados' : 'Avisos do sistema: ' + r; } catch (_) { b2.textContent = 'Avisos do sistema: indisponível aqui'; }
        };
        const sel = document.createElement('select'); css(sel, { font: '11px monospace', margin: '6px 4px 0 0', maxWidth: '150px' });
        const inp = document.createElement('input'); inp.placeholder = 'recado'; css(inp, { font: '11px monospace', width: '45%', margin: '6px 4px 0 0' });
        const b3 = document.createElement('button'); b3.textContent = 'Deixar recado'; css(b3, { font: '11px monospace' });
        b3.onclick = async () => {
            try { if (!sel.value || !inp.value) return; await this.deixarRecado(sel.value, 'texto', inp.value.slice(0, 1000), 72); inp.value = ''; b3.textContent = 'Deixado (cifrado) ✓'; }
            catch (e) { const m = String(e.message || e); b3.textContent = m === 'sem-chave-do-destino' ? 'Sem chave: ele precisa entrar 1× na sala' : 'Falhou: ' + m.slice(0, 24); }
            setTimeout(() => { b3.textContent = 'Deixar recado'; }, 2500);
        };
        const b4 = document.createElement('button'); b4.textContent = 'Marcar lidos'; css(b4, { font: '11px monospace', marginLeft: '6px' });
        b4.onclick = () => { this._caixa.forEach(c => { c.lido = true; }); ls.set('bifrost.caixa', JSON.stringify(this._caixa)); this._pinta(); };
        box.append(pre, b1, b2, document.createElement('br'), sel, inp, b3, b4);
        btn.onclick = () => { this._aberto = !this._aberto; box.style.display = this._aberto ? 'block' : 'none'; this._pinta(); };
        document.body.appendChild(box);
        this._ui = { btn, box, pre, sel, ancorado: false, tentativas: 0, selSig: '' };
        this._ancora();
    }
    _ancora() {
        const u = this._ui; if (!u || u.ancorado) return;
        u.tentativas++;
        const ref = document.getElementById('themis-btn') || [...document.querySelectorAll('button')].filter(b => b !== u.btn && /harpocrates|athena/i.test((b.textContent || '').replace(/\./g, ''))).pop();
        if (ref && ref.parentNode) { ref.insertAdjacentElement('afterend', u.btn); u.ancorado = true; }
        else if (!u.btn.isConnected) { css2(u.btn); document.body.appendChild(u.btn); }
        if (u.tentativas >= 12) u.ancorado = true; else setTimeout(() => this._ancora(), 2500);
    }
    _pinta() {
        const u = this._ui; if (!u) return;
        if (!u.ancorado) this._ancora();
        const cor = { ok: '#4cd964', conectando: '#ffd60a', iniciando: '#8e8e93', degradada: '#ff9f0a', caida: '#ff453a', inativa: '#8e8e93' }[this._estado] || '#8e8e93';
        const nl = this._caixa.filter(c => !c.lido).length;
        u.btn.innerHTML = '🌉 Bifrost <span style="color:' + cor + '">●</span>' + (nl ? ' 📬' + nl : '');
        if (this._aberto) {
            u.pre.textContent = this.explicar();
            const sig = [...this._conhecidos].map(x => x.join('=')).join('|');
            if (sig !== u.selSig) { u.selSig = sig; const v = u.sel.value; u.sel.textContent = ''; for (const [id, nome] of this._conhecidos) { const o = document.createElement('option'); o.value = id; o.textContent = nome + ' (' + id.slice(0, 5) + ')'; u.sel.appendChild(o); } if (v) u.sel.value = v; }
        }
    }
}
function css2(b) { b.style.position = 'fixed'; b.style.left = '110px'; b.style.bottom = '8px'; b.style.zIndex = '99998'; }
