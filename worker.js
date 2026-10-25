// Koinonia no Cloudflare Workers (plano gratuito): uma Durable Object por sala, WebSocket com hibernação.
// Só retransmite (broadcast na sala); o destino filtra por "to" e confere a assinatura.
export class Sala {
    constructor(state) { this.state = state; }
    async fetch(req) {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('Koinonia relay', { status: 426 });
        if (this.state.getWebSockets().length >= 64) return new Response('sala cheia', { status: 503 });
        const [cli, srv] = Object.values(new WebSocketPair());
        this.state.acceptWebSocket(srv);
        return new Response(null, { status: 101, webSocket: cli });
    }
    webSocketMessage(ws, msg) {
        if (typeof msg !== 'string' || msg.length > 65536) return;
        for (const o of this.state.getWebSockets()) if (o !== ws) { try { o.send(msg); } catch (_) {} }
    }
    webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code); } catch (_) {} }
}
export default {
    fetch(req, env) {
        const sala = new URL(req.url).pathname.slice(0, 64) || '/';
        return env.SALA.get(env.SALA.idFromName(sala)).fetch(req);
    }
};
