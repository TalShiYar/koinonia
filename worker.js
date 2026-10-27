// Koinonia no Cloudflare Workers (plano gratuito): uma Durable Object por sala, WebSocket com hibernação.
// Retransmite (broadcast na sala; o destino filtra por "to" e confere a assinatura) e guarda RECADOS (type "NOTE")
// até a validade (≤ 7 dias), entregando-os quando o destinatário aparecer. O relay NÃO decifra nada porque nada é cifrado:
// recados são legíveis por quem o relay conhecer. Quem se apresentar com o id X recebe os recados de X (o destino confere assinatura e anti-repetição).
const MAX_NOTAS = 50, MAX_BYTES = 16384, TTL_MAX = 7 * 864e5;
export class Sala {
    constructor(state) { this.state = state; }
    async fetch(req) {
        if (new URL(req.url).pathname === '/__hora')            // relógio de referência medido PELO MESMO caminho do WebSocket (mesma Durable Object)
            return new Response(JSON.stringify({ t: Date.now() }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('Koinonia relay', { status: 426 });
        if (this.state.getWebSockets().length >= 64) return new Response('sala cheia', { status: 503 });
        const [cli, srv] = Object.values(new WebSocketPair());
        this.state.acceptWebSocket(srv);
        return new Response(null, { status: 101, webSocket: cli });
    }
    async webSocketMessage(ws, msg) {
        if (typeof msg !== 'string' || msg.length > 65536) return;
        let env = null; try { env = JSON.parse(msg); } catch (_) {}
        try {
            if (env && typeof env.from === 'string' && env.from.length <= 32 && !ws.deserializeAttachment()) {
                ws.serializeAttachment({ id: env.from });          // primeira identidade vista nesta conexão: entrega os recados guardados
                await this.entrega(ws, env.from);
            }
            if (env && env.t === 'NOTE' && typeof env.to === 'string' && env.to.length <= 32 && msg.length <= MAX_BYTES) await this.guarda(env, msg);
        } catch (_) {}
        for (const o of this.state.getWebSockets()) if (o !== ws) { try { o.send(msg); } catch (_) {} }
    }
    async guarda(env, msg) {
        const exp = env.body && env.body.exp, agora = Date.now();
        if (typeof exp !== 'number' || !isFinite(exp) || exp < agora || exp > agora + TTL_MAX) return;
        const pre = 'n:' + env.to + ':';
        const lista = await this.state.storage.list({ prefix: pre, limit: MAX_NOTAS + 1 });
        if (lista.size >= MAX_NOTAS) await this.state.storage.delete([...lista.keys()][0]);     // cheia: descarta a que vence primeiro
        await this.state.storage.put(pre + String(Math.floor(exp)).padStart(15, '0') + ':' + String(env.n).slice(0, 24), msg);
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
