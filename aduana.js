// ============================================================================
// A.D.U.A.N.A. — as entidades julgam o que atravessa a parede · js/modules/OMEGA/aduana.js · v1.0 [2026-10-27]
//
// Analogia: um posto de fronteira onde o fiscal é uma cidadã. Ela não decora regras de livro: usa a LEI que ela mesma
//   descobriu sobre o mundo de fora (a proposição mais firme dela no domínio 'externo', medida pela T.H.E.M.I.S.).
//   Para cada leitura que um aparelho vizinho manda, ela imagina dois mundos — SEM a leitura e SEGUNDO a leitura (se ela
//   acreditasse no vizinho) — e pergunta à própria lei: "lá eu continuo certa?". Se a leitura faz a lei quebrar, ela barra, e o MOTIVO
//   é a própria lei, por escrito. Se a leitura não mexe na lei, ela se cala (não tem o que dizer).
//
// Gabarito e mando (decisões do AGI: "manda" no que entra; até alguém chegar ao nível 2, fica a regra fixa de hoje):
//   • Leituras CONFERÍVEIS (RTT pelo relay: a física diz depois se era mentira) são o CAMPO DE TREINO: a aduana julga em
//     sombra e é pontuada (barrou honesto? deixou mentiroso passar?). A física continua decidindo nelas.
//   • Leituras NÃO CONFERÍVEIS (bateria, campo magnético, RTT por canal direto) são onde ela MANDA — só quando:
//     (a) a maioria que votou "barrar" tem nível ≥ 2 no domínio externo; e (b) no treino ela votou ≥ 10 vezes e barrou
//     honesto em ≤ 10 % delas ("só manda quem tem prova", a mesma regra da THEMIS). Antes disso: julga e escreve, não manda.
//   • Recados para você: SÓ ETIQUETA (não há gabarito para "este recado era bom": o único verificador é você).
//   • Saída: quem foi pego mentindo (física) ou barrado com mando fica 1 h sem receber pulso/especialistas do Pytronicos.
//
// Big-O por leitura julgada: 2 agregações da Pleiades O(P) + J ≤ 3 juízes × (1 contexto + 2 avaliações). Fila ≤ 64,
//   ≤ 4 leituras por chamada de tick (a cada 15 ticks). Memória: vereditos ≤ 256, barrados ≤ 64, histórico 12.
// Não mexe em energia, reprodução nem recompensa. Ablação: window.aduanaOff = true (tudo passa como antes).
// Depende de: THEMIS v1.2 (melhorProposicao), Entity.sondaPura (trecho no HTML), PLEIADES v1.1 (agrega).
// ============================================================================
const KS = ['env_rede_rtt', 'env_rede_relay_visto', 'env_rede_bat', 'env_rede_mag'];
const HORA = 3600000;
const desligada = () => typeof window !== 'undefined' && window.aduanaOff === true;

export class ADUANA {
    constructor({ themis = () => window.themis, mundo = () => window.world, log = () => {} } = {}) {
        this.versao = '1.0 (2026-10-27)';
        this.themis = themis; this.mundo = mundo; this.log = log;
        this.pl = null;
        this._fila = [];
        this._vered = new Map();          // 'id|canal' -> {admitido, vinculante, motivo, juiz, nivel, t, votos}
        this._barrados = new Map();       // id -> {t, por}
        this._hist = [];
        this.placar = { n: 0, honestos: 0, mentirosos: 0, votados: 0, votadosHonestos: 0, barrouHonesto: 0, barrouMentiroso: 0, deixouMentiroso: 0 };
        this.c = { julgados: 0, calados: 0, semMudanca: 0, semJuiz: 0, barrados: 0, barradosComMando: 0, erros: 0, ultimoErro: '' };
    }
    ligar(pleiades) { this.pl = pleiades; }

    enfileira(it) {
        if (desligada() || !it || typeof it.id !== 'string') return;
        if (it.verificavel && it.ok === false) this._marca(it.id, 'física');      // mentira provada: marca já
        if (this._fila.length >= 64) this._fila.shift();
        this._fila.push(it);
    }
    veredito(id, canal) {
        if (desligada()) return null;
        const v = this._vered.get(id + '|' + canal);
        return v && Date.now() - v.t < 150000 ? v : null;
    }
    barrado(id) { const b = this._barrados.get(id); return !!(b && Date.now() - b.t < HORA); }
    _marca(id, por) { this._barrados.delete(id); this._barrados.set(id, { t: Date.now(), por }); if (this._barrados.size > 64) this._barrados.delete(this._barrados.keys().next().value); }

    // A aduana só MANDA depois de provar no treino que não barra honesto (regra "só manda quem tem prova").
    provada() { const p = this.placar; return p.votados >= 10 && (p.votadosHonestos === 0 || p.barrouHonesto / p.votadosHonestos <= 0.10); }

    tick(f) {
        if (desligada() || !this.pl || !this._fila.length) return false;
        let n = 0;
        try { while (this._fila.length && n < 4) { this._julga(this._fila.shift()); n++; } }
        catch (e) { this.c.erros++; this.c.ultimoErro = String(e?.message || e).slice(0, 80); }
        return n > 0;
    }

    _julga(it) {
        const chave = it.id + '|' + it.canal, agora = Date.now();
        const sem = this.pl.agrega({ sem: chave }), com = this.pl.mundoSegundo(it.id, it.canal);   // sem a leitura × segundo a leitura
        let mexe = false; for (const k of KS) if (Math.abs(sem[k] - com[k]) > 1e-9) { mexe = true; break; }
        const reg = (v) => {
            v.t = agora; this._vered.delete(chave); this._vered.set(chave, v);
            if (this._vered.size > 256) this._vered.delete(this._vered.keys().next().value);
            this.c.julgados++;
            if (it.verificavel && typeof it.ok === 'boolean') this._pontua(it.ok, v);
            if (!v.admitido) { this.c.barrados++; if (v.vinculante) { this.c.barradosComMando++; this._marca(it.id, 'aduana'); } }
            this._hist.push({ t: agora, nome: it.nome, canal: it.canal, verificavel: !!it.verificavel, ok: it.ok, ...v });
            if (this._hist.length > 12) this._hist.shift();
            if (!v.admitido) this.log(`barrou ${it.canal} de ${it.nome}${v.vinculante ? '' : ' (sombra)'}: ${v.motivo}`);
        };
        if (!mexe) { this.c.semMudanca++; return reg({ admitido: true, vinculante: false, motivo: 'a leitura diz o mesmo que o mundo sem ela', juiz: null, nivel: 0, votos: 0 }); }
        const T = this.themis(), W = this.mundo();
        const juizes = (T && typeof T.procurar === 'function' && typeof T.melhorProposicao === 'function' && W?.allEntities) ? T.procurar('externo', 3) : [];
        let wB = 0, wA = 0, nv = 0, mB = null, mA = null;
        for (const j of juizes) {
            const ent = W.allEntities.get(j.id);
            if (!ent || typeof ent.sondaPura !== 'function') continue;
            const P = T.melhorProposicao(j.id, 'externo');
            if (!P) continue;
            let r = null; try { r = ent.sondaPura(P.keys, [sem, com]); } catch (_) { r = null; }
            if (!r || r[0] === null || r[1] === null) continue;
            const vs = r[0] !== 0, vc = r[1] !== 0;
            if (vs === vc) continue;                                      // a leitura não mexe na lei desta juíza: ela se cala
            const peso = T.peso(j.id, 'externo') || 0.05, voto = { id: j.id, nivel: j.nivel, lei: P.texto, taxa: P.taxa, n: P.n, verdade: P.verdade };
            nv++;
            if (vs === P.verdade && vc !== P.verdade) { wB += peso; if (!mB || j.nivel > mB.nivel) mB = voto; }   // sem ela a lei vale; segundo ela, quebra
            else { wA += peso; if (!mA || j.nivel > mA.nivel) mA = voto; }                                          // segundo ela a lei volta a valer
        }
        if (!nv) { if (!juizes.length) this.c.semJuiz++; else this.c.calados++; return reg({ admitido: true, vinculante: false, motivo: juizes.length ? 'nenhuma juíza tem lei que esta leitura toque' : 'ninguém com nível ≥ 1 no domínio externo', juiz: null, nivel: 0, votos: 0 }); }
        const barra = wB > wA, m = barra ? mB : mA;
        const motivo = (barra ? 'quebraria a lei ' : 'confirma a lei ') + `"${m.lei}" (${m.verdade ? 'verdadeira' : 'falsa'} em ${Math.round((m.verdade ? m.taxa : 1 - m.taxa) * 100)}% de ${m.n} testes) — juíza #${m.id} N${m.nivel}`;
        const vinculante = barra && !it.verificavel && m.nivel >= 2 && this.provada();
        return reg({ admitido: !barra, vinculante, motivo, juiz: m.id, nivel: m.nivel, votos: nv, barrar: +wB.toFixed(2), admitir: +wA.toFixed(2) });
    }

    _pontua(honesto, v) {
        const p = this.placar; p.n++;
        if (honesto) p.honestos++; else p.mentirosos++;
        if (!v.admitido && !honesto) p.barrouMentiroso++;
        if (v.admitido && !honesto) p.deixouMentiroso++;
        if (v.votos > 0) { p.votados++; if (honesto) { p.votadosHonestos++; if (!v.admitido) p.barrouHonesto++; } }
    }

    // Recado: só etiqueta (você decide). Única evidência verificável sobre o remetente: se ele foi pego mentindo nos sensores.
    etiquetaRecado(de) {
        const b = this._barrados.get(de);
        if (b && Date.now() - b.t < 24 * HORA) return `⚠ aduana: remetente ${b.por === 'física' ? 'pego mentindo nos sensores' : 'barrado pela aduana'} há ${Math.round((Date.now() - b.t) / 60000)} min`;
        return '';
    }

    getStats() { return { versao: this.versao, provada: this.provada(), fila: this._fila.length, ...this.c, placar: { ...this.placar }, barrados: this._barrados.size, ultimos: this._hist.slice(-6) }; }

    resumo() {
        const p = this.placar, L = [];
        const T = this.themis();
        const juizes = T?.procurar ? T.procurar('externo', 3) : [];
        const n2 = juizes.some(j => j.nivel >= 2);
        L.push(`A.D.U.A.N.A. ${this.versao} — ${desligada() ? 'DESLIGADA (aduanaOff)' : (n2 && this.provada()) ? 'PODE MANDAR nas leituras não conferíveis' : 'SOMBRA: julga e escreve o motivo, não manda'}`);
        if (!n2) L.push('  por quê: ninguém tem nível ≥ 2 no domínio externo (regra fixa de hoje vale até lá)');
        if (!this.provada()) L.push(`  por quê: ainda sem prova no treino (${p.votados} votos em leituras conferíveis; precisa ≥ 10 e barrar honesto ≤ 10 %)`);
        L.push('Juízas (domínio externo): ' + (juizes.length ? juizes.map(j => { const P = T.melhorProposicao?.(j.id, 'externo'); return `#${j.id} N${j.nivel} ${P ? 'lei "' + P.texto + '" ' + Math.round((P.verdade ? P.taxa : 1 - P.taxa) * 100) + '% em ' + P.n : '(sem lei firme ainda)'}`; }).join(' · ') : 'nenhuma com nível ≥ 1'));
        const base = p.n ? Math.round(100 * p.honestos / p.n) : null;
        L.push(`Treino (leituras conferíveis): ${p.n} julgadas · honestas ${p.honestos} · mentirosas ${p.mentirosos} · votou em ${p.votados} · barrou honesto ${p.barrouHonesto}/${p.votadosHonestos} · barrou mentiroso ${p.barrouMentiroso} · deixou mentiroso ${p.deixouMentiroso}${base === null ? '' : ` · "deixar tudo entrar" acertaria ${base}%`}`);
        L.push(`Julgadas ${this.c.julgados} · caladas ${this.c.calados} · não mexiam em sentido ${this.c.semMudanca} · sem juíza ${this.c.semJuiz} · barradas ${this.c.barrados} (com mando ${this.c.barradosComMando}) · pares barrados na saída ${[...this._barrados.values()].filter(b => Date.now() - b.t < HORA).length} · erros ${this.c.erros}${this.c.ultimoErro ? ' (' + this.c.ultimoErro + ')' : ''}`);
        for (const h of this._hist.slice(-5)) L.push(`  ${new Date(h.t).toLocaleTimeString()} ${h.nome} ${h.canal}${h.verificavel ? (h.ok ? ' [física: honesta]' : ' [física: MENTIRA]') : ' [sem gabarito]'} → ${h.admitido ? 'entra' : 'BARRA'}${!h.admitido && !h.vinculante ? ' (sombra)' : ''} · ${h.motivo}`);
        return L.join('\n');
    }
}
