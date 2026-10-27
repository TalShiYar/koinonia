// Koinonia no Cloudflare Workers (plano gratuito): uma Durable Object por sala, WebSocket com hibernação.
// v2 (2026-10-27): PROVA DE IDENTIDADE + RECADOS SELADOS.
//   • Ao entrar, cada conexão recebe um DESAFIO (aleatório). Só depois de responder com uma PROVA assinada pela chave
//     cujo hash é o id ela é aceita: aí recebe os recados guardados e passa a falar na sala. Antes disso o relay ignora tudo.
//     (Fecha o F7: antes, quem se apresentasse com o id X recebia os recados de X.)
//   • Depois de aceita, a conexão só pode falar COMO ELA MESMA (from = id provado), exceto o selo (SEAL), que não tem remetente.
//   • Guarda só recados SELADOS (type "SEAL", cifrados ponta a ponta): o relay vê destino, validade e tamanho, não o conteúdo
//     nem quem assinou. Recado em claro (NOTE) não é guardado nem repassado.
// Analogia: a caixa postal ganhou fechadura (o desafio) e as cartas chegam em envelope lacrado sem remetente.
const MAX_NOTAS = 50, MAX_BYTES = 24576, TTL_MAX = 7 * 864e5;
const enc = new TextEncoder();
const b64 = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const canon = o => (o === null || typeof o !== 'object') ? JSON.stringify(o)
    : Array.isArray(o) ? '[' + o.map(canon).join(',') + ']'
    : '{' + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }, SIG = { name: 'ECDSA', hash: 'SHA-256' };

// PROVA: o id TEM de ser o hash da chave pública, a assinatura TEM de fechar e o desafio TEM de ser o desta conexão.
async function confere(env, c) {
    if (!env || env.v !== 1 || env.t !== 'PROVA' || typeof env.from !== 'string' || env.from.length > 32 || typeof env.pub !== 'string' || typeof env.sig !== 'string') return 'formato';
    if (!env.body || env.body.c !== c || env.body.aud !== 'koinonia-relay') return 'desafio';
    const raw = unb64(env.pub);
    if (b64(new Uint8Array(await crypto.subtle.digest('SHA-256', raw))).slice(0, 22) !== env.from) return 'id-nao-bate';
    const key = await crypto.subtle.importKey('raw', raw, ECDSA, false, ['verify']);
    const { sig, pub, h, ...assinado } = env;
    return (await crypto.subtle.verify(SIG, key, unb64(sig), enc.encode(canon(assinado)))) ? '' : 'assinatura';
}

export class Sala {
    constructor(state) { this.state = state; }
    async fetch(req) {
        if (new URL(req.url).pathname === '/__hora')            // relógio de referência medido PELO MESMO caminho do WebSocket (mesma Durable Object)
            return new Response(JSON.stringify({ t: Date.now() }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('Koinonia relay v2', { status: 426 });
        if (this.state.getWebSockets().length >= 64) return new Response('sala cheia', { status: 503 });
        const [cli, srv] = Object.values(new WebSocketPair());
        this.state.acceptWebSocket(srv);
        const c = b64(crypto.getRandomValues(new Uint8Array(18)));
        srv.serializeAttachment({ c });                          // sobrevive à hibernação
        srv.send(JSON.stringify({ t: 'DESAFIO', c }));
        return new Response(null, { status: 101, webSocket: cli });
    }
    async webSocketMessage(ws, msg) {
        if (typeof msg !== 'string' || msg.length > 65536) return;
        let env = null; try { env = JSON.parse(msg); } catch (_) { return; }
        if (!env || typeof env !== 'object') return;
        const att = ws.deserializeAttachment() || {};
        if (!att.id) {                                           // ainda não provou quem é: só a PROVA é ouvida
            if (env.t !== 'PROVA') return;
            let erro = 'cripto'; try { erro = await confere(env, att.c); } catch (_) {}
            if (erro) { try { ws.send(JSON.stringify({ t: 'RECUSADO', motivo: erro })); } catch (_) {} return; }
            ws.serializeAttachment({ id: env.from });
            try { ws.send(JSON.stringify({ t: 'ACEITO', id: env.from })); } catch (_) {}
            try { await this.entrega(ws, env.from); } catch (_) {}
            return;
        }
        if (env.t === 'SEAL') {                                  // recado selado: sem remetente por fora; guarda e repassa
            if (typeof env.to !== 'string' || env.to.length > 32 || msg.length > MAX_BYTES) return;
            try { await this.guarda(env, msg); } catch (_) {}
        } else if (env.from !== att.id || env.t === 'NOTE' || env.t === 'PROVA') return;   // falar como outro, ou recado em claro: descartado
        for (const o of this.state.getWebSockets()) {
            if (o === ws) continue;
            const a = o.deserializeAttachment();
            if (a && a.id) { try { o.send(msg); } catch (_) {} }   // só para conexões provadas
        }
    }
    async guarda(env, msg) {
        const exp = env.exp, agora = Date.now();
        if (typeof exp !== 'number' || !isFinite(exp) || exp < agora || exp > agora + TTL_MAX || typeof env.iv !== 'string') return;
        const pre = 'n:' + env.to + ':';
        const lista = await this.state.storage.list({ prefix: pre, limit: MAX_NOTAS + 1 });
        if (lista.size >= MAX_NOTAS) await this.state.storage.delete([...lista.keys()][0]);     // cheia: descarta a que vence primeiro
        await this.state.storage.put(pre + String(Math.floor(exp)).padStart(15, '0') + ':' + env.iv.slice(0, 24), msg);
    }
    async entrega(ws, id) {
        const agora = Date.now(), pre = 'n:' + id + ':', vencidas = [];
        const lista = await this.state.storage.list({ prefix: pre, limit: MAX_NOTAS + 1 });
        for (const [k, v] of lista) {
            if (Number(k.slice(pre.length, pre.length + 15)) < agora) { vencidas.push(k); continue; }
            try { ws.send(v); } catch (_) { break; }
        }
        if (vencidas.length) await this.state.storage.delete(vencidas.slice(0, 128));
    }
    webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code); } catch (_) {} }
}
export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (url.pathname === '/saude') {          // para o vigia externo: responde 200 só se a Durable Object (o miolo do relay) também responde
            try {
                const r = await env.SALA.get(env.SALA.idFromName('__saude')).fetch(new Request(req.url));
                return new Response(r.status === 426 ? 'ok' : 'degradado ' + r.status, { status: r.status === 426 ? 200 : 503, headers: { 'cache-control': 'no-store' } });
            } catch (e) { return new Response('erro ' + String(e.message || e).slice(0, 80), { status: 503, headers: { 'cache-control': 'no-store' } }); }
        }
        if (url.pathname.startsWith('/hora/')) {                // GET /hora/<sala> -> {t: ms}: a rede de sensores (P.L.E.I.A.D.E.S.) mede seu desvio de relógio e o RTT até o relay
            const sala = '/' + url.pathname.slice(6, 70);
            return env.SALA.get(env.SALA.idFromName(sala)).fetch(new Request(new URL('/__hora', req.url)));
        }
        const sala = url.pathname.slice(0, 64) || '/';
        return env.SALA.get(env.SALA.idFromName(sala)).fetch(req);
    }
};
