/* ---------- definição das seções e parâmetros ---------- */
// Cada item: key, label, min, max, step, def. Opcionais: rand (false = não sorteia), showIf (função).
const MODES = ['Linear', 'Circular'];
const BLENDS = ['Normal', 'Multiply', 'Screen', 'Overlay', 'Add', 'Difference', 'Soft light'];

const SECTIONS = [
    { id: 'motion', title: 'Movimento', open: true, items: [
        { key: 'speed',  label: 'speed',            min: 0,  max: 2,  step: 0.01, def: 0.15, rand: false },
        { key: 'flow',   label: 'flow',             min: 0,  max: 40, step: 0.1,  def: 15 },
        { key: 'drift',  label: 'drift',            min: 0,  max: 1,  step: 0.01, def: 0.15 },
        { key: 'rotX',   label: 'rotation x', min: -1, max: 1,  step: 0.01, def: 0 },
        { key: 'rotY',   label: 'rotation y', min: -1, max: 1,  step: 0.01, def: 0 },
    ]},
    { id: 'noise', title: 'Noise', open: false, items: [
        { key: 'scaleX',   label: 'noise scale x',     min: 0.1, max: 12,  step: 0.01, def: 2.5 },
        { key: 'scaleY',   label: 'noise scale y',     min: 0.1, max: 12,  step: 0.01, def: 4 },
        { key: 'bump',     label: 'noise bump',        min: 0,   max: 1,   step: 0.01, def: 0.25 },
        { key: 'seed',     label: 'noise seed',        min: 0,   max: 100, step: 0.1,  def: 25 },
        { key: 'fqScale',  label: 'noise fq scale',    min: 0,   max: 1,   step: 0.01, def: 0.5 },
        { key: 'floor',    label: 'noise floor',       min: 0,   max: 1,   step: 0.01, def: 0.1 },
        { key: 'ceil',     label: 'noise ceil',        min: 0,   max: 1,   step: 0.01, def: 0.75 },
        { key: 'ceilF',    label: 'noise ceil factor', min: 0,   max: 1,   step: 0.01, def: 0.07 },
        { key: 'mixNoise', label: 'mix noise',         min: 0,   max: 0.5, step: 0.01, def: 0.02, rand: false },
    ]},
    { id: 'palette', title: 'Paleta', open: true, palette: true },
    { id: 'mode', title: 'Modo', open: true, items: [
        { type: 'segment', key: 'mode', options: MODES, def: 0 },
        { key: 'angle',   label: 'angle',    min: 0,  max: 360, step: 1,    def: 35,  showIf: p => p.mode === 0 },
        { key: 'centerX', label: 'center x', min: -1, max: 1,   step: 0.01, def: 0,   showIf: p => p.mode === 1 },
        { key: 'centerY', label: 'center y', min: -1, max: 1,   step: 0.01, def: 0,   showIf: p => p.mode === 1 },
        { key: 'size',    label: 'size',     min: 0.2, max: 3,  step: 0.01, def: 1.2 },
        { key: 'offset',  label: 'offset',   min: -1, max: 1,   step: 0.01, def: 0,   rand: false },
    ]},
    { id: 'blend', title: 'Blend mode', open: true, items: [
        { type: 'select', key: 'blend', label: 'blend', options: BLENDS, def: 0 },
        { key: 'layerMix', label: 'layer mix', min: 0, max: 1, step: 0.01, def: 0.6 },
    ]},
    { id: 'audio', title: 'Áudio', open: false, audio: true },
];

const DEFAULT_PALETTE = ['#ffffff', '#c04000', '#e8140a', '#a000a0', '#4b0082'];
const MAX_COLORS = 8;

const ITEMS = SECTIONS.flatMap(s => s.items || []);
const state = { params: {}, palette: [...DEFAULT_PALETTE] };
const ui = {};   // key -> { set(v) }
const rows = []; // { el, showIf }

function resetState() {
    ITEMS.forEach(it => state.params[it.key] = it.def);
    state.palette = [...DEFAULT_PALETTE];
    resetAudioCfg();
}
resetState();

/* ---------- WebGL ---------- */
const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });

const VS = `attribute vec2 a; void main(){ gl_Position = vec4(a,0.,1.); }`;

function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
}

let prog, u;
function initGL(FS) {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = n => gl.getUniformLocation(prog, n);
    u = {
        res: U('uRes'), time: U('uTime'),
        scale: U('uScale'), bump: U('uBump'), seed: U('uSeed'), fqScale: U('uFqScale'),
        floor: U('uFloor'), ceil: U('uCeil'), ceilF: U('uCeilF'), mix: U('uMix'),
        rot: U('uRot'), flow: U('uFlow'), drift: U('uDrift'),
        mode: U('uMode'), angle: U('uAngle'), size: U('uSize'), offset: U('uOffset'), center: U('uCenter'),
        blend: U('uBlend'), layerMix: U('uLayerMix'),
        cols: U('uCols[0]'), n: U('uN'),
    };
}

function hexToRgb(h) {
    const v = parseInt(h.slice(1), 16);
    return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}
function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
}
addEventListener('resize', resize); resize();

let time = 0, last = performance.now();
function frame(now) {
    const dt = (now - last) / 1000; last = now;
    audioTick(now);
    const P = applyAudio(state.params);
    time += dt * P.speed;
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.time, time);
    // noise
    gl.uniform2f(u.scale, P.scaleX, P.scaleY);
    gl.uniform1f(u.bump, P.bump); gl.uniform1f(u.seed, P.seed); gl.uniform1f(u.fqScale, P.fqScale);
    gl.uniform1f(u.floor, P.floor); gl.uniform1f(u.ceil, P.ceil); gl.uniform1f(u.ceilF, P.ceilF);
    gl.uniform1f(u.mix, P.mixNoise);
    // movimento
    gl.uniform2f(u.rot, P.rotX, P.rotY);
    gl.uniform1f(u.flow, P.flow); gl.uniform1f(u.drift, P.drift);
    // modo
    gl.uniform1f(u.mode, P.mode);
    gl.uniform1f(u.angle, P.angle * Math.PI / 180);
    gl.uniform1f(u.size, P.size); gl.uniform1f(u.offset, P.offset);
    gl.uniform2f(u.center, P.centerX, P.centerY);
    // blend
    gl.uniform1f(u.blend, P.blend); gl.uniform1f(u.layerMix, P.layerMix);
    // paleta
    const cols = new Float32Array(MAX_COLORS * 3);
    state.palette.forEach((h, i) => cols.set(hexToRgb(h), i * 3));
    gl.uniform3fv(u.cols, cols);
    gl.uniform1i(u.n, state.palette.length);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(frame);
}

fetch('shader.frag')
    .then(r => r.text())
    .then(FS => { initGL(FS); requestAnimationFrame(frame); });

/* ---------- controles do painel ---------- */
const panel = document.getElementById('panel');

function updateVisibility() {
    rows.forEach(r => r.el.hidden = r.showIf ? !r.showIf(state.params) : false);
}

// Linha de slider genérica: barra arrastável + campo numérico. onSet recebe o valor já ajustado.
function sliderRow(label, min, max, step, value, onSet) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label title="${label}">${label}</label><div class="bar"><i></i></div>
        <input type="number" min="${min}" max="${max}" step="${step}">`;
    const bar = row.querySelector('.bar'), fill = row.querySelector('i'), num = row.querySelector('input');
    const dec = (String(step).split('.')[1] || '').length;
    const set = v => {
        v = Math.min(max, Math.max(min, +v));
        v = +(Math.round(v / step) * step).toFixed(dec);
        onSet(v);
        fill.style.width = ((v - min) / (max - min) * 100) + '%';
        num.value = v;
    };
    const fromPointer = e => {
        const r = bar.getBoundingClientRect();
        set(min + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (max - min));
    };
    bar.addEventListener('pointerdown', e => {
        bar.setPointerCapture(e.pointerId); fromPointer(e);
        const mv = ev => fromPointer(ev);
        const up = () => { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); };
        bar.addEventListener('pointermove', mv); bar.addEventListener('pointerup', up);
    });
    num.addEventListener('input', () => { if (num.value !== '') set(num.value); });
    set(value);
    return { row, set };
}

function buildSlider(it) {
    const { key, label, min, max, step } = it;
    const { row, set } = sliderRow(label, min, max, step, state.params[key], v => { state.params[key] = v; });
    ui[key] = { set };
    return row;
}

function buildSegment(it) {
    const wrap = document.createElement('div'); wrap.className = 'seg';
    const btns = it.options.map((name, i) => {
        const b = document.createElement('button'); b.textContent = name;
        b.onclick = () => set(i);
        wrap.appendChild(b); return b;
    });
    const set = v => {
        state.params[it.key] = v;
        btns.forEach((b, i) => b.classList.toggle('on', i === v));
        updateVisibility();
    };
    ui[it.key] = { set };
    set(state.params[it.key]);
    return wrap;
}

function buildSelect(it) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label>${it.label}</label>
        <select>${it.options.map((o, i) => `<option value="${i}">${o}</option>`).join('')}</select>`;
    const sel = row.querySelector('select');
    const set = v => { state.params[it.key] = +v; sel.value = v; };
    sel.addEventListener('change', () => set(sel.value));
    ui[it.key] = { set };
    set(state.params[it.key]);
    return row;
}

/* ---------- paleta ---------- */
function randomColor() {
    const h = Math.random() * 360, s = 60 + Math.random() * 40, l = 25 + Math.random() * 45;
    const a = s * Math.min(l, 100 - l) / 100;
    const f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (l / 100 - a / 100 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return '#' + [f(0), f(8), f(4)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function renderPalette() {
    const wrap = document.getElementById('palette');
    const grad = () => `linear-gradient(90deg, ${state.palette.join(',')})`;
    wrap.innerHTML = `<div class="gradprev" style="background:${grad()}"></div>`;
    state.palette.forEach((hex, i) => {
        const d = document.createElement('div'); d.className = 'stop';
        d.innerHTML = `<input type="color" value="${hex}"><span>${hex}</span><button title="Remover">×</button>`;
        d.querySelector('input').addEventListener('input', e => {
            state.palette[i] = e.target.value;
            d.querySelector('span').textContent = e.target.value;
            wrap.querySelector('.gradprev').style.background = grad();
        });
        d.querySelector('button').addEventListener('click', () => {
            if (state.palette.length <= 2) return toast('Mínimo de 2 cores');
            state.palette.splice(i, 1); renderPalette();
        });
        wrap.appendChild(d);
    });
}

function buildPaletteBody(body) {
    const pal = document.createElement('div'); pal.id = 'palette'; body.appendChild(pal);
    const push = document.createElement('button'); push.className = 'btn'; push.textContent = 'pushColor';
    push.onclick = () => {
        if (state.palette.length >= MAX_COLORS) return toast(`Máximo de ${MAX_COLORS} cores`);
        state.palette.push(randomColor()); renderPalette();
    };
    body.appendChild(push);
}

/* ---------- dock de botões + painel ---------- */
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
    motion:  svg('<path d="M2 12c3.3-7 6.7-7 10 0s6.7 7 10 0"/>'),
    noise:   svg('<path d="M5 7h.01M11 5h.01M17 8h.01M8 12h.01M14 11h.01M20 13h.01M5 17h.01M11 18h.01M17 18h.01" stroke-width="3.2"/>'),
    palette: svg('<path d="M12 3a9 9 0 100 18c1.6 0 2.2-1.1 1.7-2.3-.5-1.2.3-2.2 1.6-2.2H17a4 4 0 004-4c0-5-4-9.5-9-9.5z"/><path d="M7.5 11h.01M10 7.5h.01M15 7.5h.01" stroke-width="3"/>'),
    mode:    svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 3.5v-1M12 21.5v-1"/>'),
    blend:   svg('<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>'),
    audio:   svg('<path d="M5 19v-6M10 19V5M15 19V10M20 19V8"/>'),
};
const dock = document.getElementById('dock');
const openIds = new Set(); // grupos abertos

function applyOpen() {
    dock.querySelectorAll('button').forEach(b => b.classList.toggle('on', openIds.has(b.dataset.id)));
    panel.classList.toggle('hidden', openIds.size === 0);
    panel.querySelectorAll('.sec').forEach(s => s.hidden = !openIds.has(s.dataset.id));
    layoutPanel();
}
function toggleGroup(id) {
    openIds.has(id) ? openIds.delete(id) : openIds.add(id);
    applyOpen();
}

function buildDock() {
    dock.innerHTML = '';
    SECTIONS.forEach(sec => {
        const b = document.createElement('button');
        b.dataset.id = sec.id; b.title = sec.title; b.setAttribute('aria-label', sec.title);
        b.innerHTML = ICONS[sec.id];
        b.onclick = () => toggleGroup(sec.id);
        dock.appendChild(b);
    });
}

function buildPanel() {
    ro.disconnect();
    layoutSig = '';
    panel.innerHTML = '<div class="stash"></div>';
    const stash = panel.firstChild;
    rows.length = 0;
    SECTIONS.forEach(sec => {
        const wrap = document.createElement('div');
        wrap.className = 'sec'; wrap.dataset.id = sec.id;
        const head = document.createElement('div'); head.className = 'sec-head';
        head.innerHTML = `<b>${sec.title}</b><button title="Fechar (H)">×</button>`;
        head.querySelector('button').onclick = () => toggleGroup(sec.id);
        const body = document.createElement('div'); body.className = 'sec-body';
        if (sec.palette) buildPaletteBody(body);
        if (sec.audio) buildAudioBody(body);
        (sec.items || []).forEach(it => {
            const el = it.type === 'segment' ? buildSegment(it)
                     : it.type === 'select' ? buildSelect(it)
                     : buildSlider(it);
            if (it.showIf) rows.push({ el, showIf: it.showIf });
            body.appendChild(el);
        });
        wrap.append(head, body);
        stash.appendChild(wrap);
        ro.observe(wrap);
    });
    renderPalette();
    updateVisibility();
    applyOpen();
}

/* ---------- layout automático dos cartões ---------- */
// Distribui os cartões abertos em colunas, para tudo caber na altura da tela.
const CARD_W = 232, GAP = 8;
let layoutSig = '';
let layoutQueued = false;
const ro = new ResizeObserver(() => {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; layoutPanel(); });
});

function layoutPanel() {
    const stash = panel.querySelector('.stash');
    if (!stash) return;
    const secs = [...panel.querySelectorAll('.sec')].filter(s => !s.hidden);
    if (!secs.length) return;

    const mobile = matchMedia('(max-width: 600px)').matches;
    const top = panel.getBoundingClientRect().top;
    const H = Math.max(160, innerHeight - top - (mobile ? 84 : 12));
    const maxCols = Math.max(1, Math.floor((innerWidth - (mobile ? 16 : 100) + GAP) / (CARD_W + GAP)));
    secs.forEach(s => s.style.maxHeight = H + 'px');
    const hs = secs.map(s => Math.min(s.offsetHeight, H));

    // 1) preenche colunas na ordem, abrindo uma nova quando a altura estoura
    let cols = [[]], used = [0];
    secs.forEach((s, i) => {
        let k = cols.length - 1;
        if (cols[k].length && used[k] + GAP + hs[i] > H) { cols.push([]); used.push(0); k++; }
        used[k] += (cols[k].length ? GAP : 0) + hs[i];
        cols[k].push(i);
    });
    // 2) se não há largura para tantas colunas, equilibra nas que cabem
    if (cols.length > maxCols) {
        cols = Array.from({ length: maxCols }, () => []);
        const sum = Array(maxCols).fill(0);
        secs.forEach((s, i) => {
            const k = sum.indexOf(Math.min(...sum));
            cols[k].push(i); sum[k] += hs[i] + GAP;
        });
    }

    const sig = cols.map(c => c.map(i => secs[i].dataset.id).join(',')).join('|');
    if (sig === layoutSig && panel.querySelectorAll('.col').length === cols.length) return;
    layoutSig = sig;

    panel.querySelectorAll('.sec').forEach(s => stash.appendChild(s));
    panel.querySelectorAll('.col').forEach(c => c.remove());
    cols.forEach(c => {
        const col = document.createElement('div'); col.className = 'col';
        c.forEach(i => col.appendChild(secs[i]));
        panel.insertBefore(col, stash);
    });
}
addEventListener('resize', layoutPanel);

buildDock();
buildPanel();

/* ---------- ações ---------- */
const toastEl = document.getElementById('toast');
let toastT;
function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 1600);
}
addEventListener('keydown', e => { if (e.key === 'h' && !['INPUT', 'SELECT'].includes(e.target.tagName)) { if (openIds.size) openIds.clear(); else openIds.add(SECTIONS[0].id); applyOpen(); } });

document.getElementById('btnReset').onclick = () => { resetState(); buildPanel(); toast('Valores restaurados'); };
document.getElementById('btnRandom').onclick = () => {
    ITEMS.forEach(it => {
        if (it.type || it.rand === false) return;
        ui[it.key].set(it.min + Math.random() * (it.max - it.min));
    });
    ui.mode.set(Math.random() < 0.5 ? 0 : 1);
    const n = 3 + Math.floor(Math.random() * 3);
    state.palette = Array.from({ length: n }, randomColor);
    renderPalette();
};
