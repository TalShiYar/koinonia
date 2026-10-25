// Sinalização WebRTC da Koinonia: o relay (ou Worker) só serve de "balcão de encontro"; depois que o DataChannel abre,
// o tráfego vai DIRETO de celular para celular. As ofertas/respostas/ICE viajam como mensagens Koinonia ASSINADAS e endereçadas (tipo RTC),
// então o relay não consegue forjar uma oferta em nome de outro par.
// Uso:  const mesh = rtcMesh(node, { iceServers: [...] });     // depois de node.attach(wsTransport(...))
// Regra anti-colisão: quem tem o id MENOR inicia a conexão.
import { rtcTransport } from './koinonia.js';

export function rtcMesh(node, { iceServers = [{ urls: 'stun:stun.l.google.com:19302' }], RTC = globalThis.RTCPeerConnection, maxConns = 8, timeoutMs = 15000 } = {}) {
    const conns = new Map();       // id -> {pc, dc, link, fila(ICE antes da descrição remota), timer}
    const stat = { tentativas: 0, abertas: 0, falhas: 0 };

    const limpa = (id, motivo) => {
        const c = conns.get(id); if (!c) return;
        clearTimeout(c.timer); conns.delete(id);
        try { c.dc?.close(); } catch (_) {} try { c.pc.close(); } catch (_) {}
        const p = node.peers.get(id); if (p && p.rtc === c.link) p.rtc = null;
        if (c.link) node.links.delete(c.link);
        if (motivo && !c.aberta) stat.falhas++;
    };
    const cria = id => {
        if (conns.has(id)) return conns.get(id);
        if (conns.size >= maxConns) return null;
        const pc = new RTC({ iceServers });
        const c = { pc, dc: null, link: null, fila: [], remoto: false, aberta: false, timer: null };
        conns.set(id, c);
        c.timer = setTimeout(() => limpa(id, 'timeout'), timeoutMs);
        pc.onicecandidate = e => { if (e.candidate) node.signal(id, { k: 'ice', c: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
        pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) limpa(id, pc.connectionState); };
        pc.ondatachannel = e => liga(id, c, e.channel);
        return c;
    };
    const liga = (id, c, dc) => {
        c.dc = dc;
        const abre = () => {
            c.aberta = true; clearTimeout(c.timer); stat.abertas++;
            const link = rtcTransport(dc); link.open = true; c.link = link;
            const oc = dc.onclose; dc.onclose = () => { link.open = false; oc?.(); link.onclose?.(); limpa(id); };
            node.attach(link);
            const p = node.peers.get(id); if (p) { p.rtc = link; p.link = link; }
            node._ev?.('rtc', `canal direto com ${id.slice(0, 6)}`);
        };
        if (dc.readyState === 'open') abre(); else dc.onopen = abre;
    };
    const conecta = async id => {
        if (conns.has(id) || node.id > id) return;                         // só o menor id inicia
        const c = cria(id); if (!c) return;
        stat.tentativas++;
        liga(id, c, c.pc.createDataChannel('koinonia'));
        const of = await c.pc.createOffer(); await c.pc.setLocalDescription(of);
        node.signal(id, { k: 'offer', sdp: of.sdp, type: of.type });
    };
    node.onPeerNew = id => { conecta(id).catch(() => limpa(id, 'erro')); };
    node.onRtc = async (from, b) => {
        try {
            if (b.k === 'offer') {
                const c = cria(from); if (!c) return;
                await c.pc.setRemoteDescription({ type: b.type || 'offer', sdp: b.sdp }); c.remoto = true;
                const an = await c.pc.createAnswer(); await c.pc.setLocalDescription(an);
                node.signal(from, { k: 'answer', sdp: an.sdp, type: an.type });
                for (const x of c.fila.splice(0)) await c.pc.addIceCandidate(x);
            } else if (b.k === 'answer') {
                const c = conns.get(from); if (!c) return;
                await c.pc.setRemoteDescription({ type: b.type || 'answer', sdp: b.sdp }); c.remoto = true;
                for (const x of c.fila.splice(0)) await c.pc.addIceCandidate(x);
            } else if (b.k === 'ice') {
                const c = conns.get(from); if (!c) return;
                if (c.remoto) await c.pc.addIceCandidate(b.c); else if (c.fila.length < 64) c.fila.push(b.c);
            }
        } catch (_) { limpa(from, 'erro'); }
    };
    // pares que já estavam na lista antes da malha ligar
    for (const id of node.peers.keys()) node.onPeerNew(id);
    return { stat, conns, fechar: () => { for (const id of [...conns.keys()]) limpa(id); } };
}
