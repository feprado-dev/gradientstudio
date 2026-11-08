/* ---------- áudio-reativo ---------- */
// Analisa o som (microfone ou arquivo) em 5 fontes (graves, médios, agudos, volume, beat)
// e modula parâmetros do gradiente por "rotas": fonte -> parâmetro, com quantidade (-1..1).
// Os valores base dos sliders não mudam; a modulação é aplicada só na hora de desenhar.

const AUDIO_SOURCES = [
    ['bass', 'Graves'], ['mid', 'Médios'], ['treble', 'Agudos'], ['level', 'Volume'], ['beat', 'Beat'],
];
const DEFAULT_ROUTES = [
    { src: 'bass',   target: 'offset',   amount: 0.3 },
    { src: 'mid',    target: 'flow',     amount: 0.4 },
    { src: 'treble', target: 'bump',     amount: 0.5 },
    { src: 'beat',   target: 'layerMix', amount: 0.3 },
];
const MAX_ROUTES = 8;
const audioCfg = { gain: 1, release: 0.8, routes: [] };
function resetAudioCfg() {
    audioCfg.gain = 1; audioCfg.release = 0.8;
    audioCfg.routes = DEFAULT_ROUTES.map(r => ({ ...r }));
}
resetAudioCfg();

/* ---------- motor ---------- */
let actx, analyser, freq, audioEl, mediaNode, micNode, micStream, fileUrl;
let activeSource = null;           // 'mic' | 'file' | null
const levels = { bass: 0, mid: 0, treble: 0, level: 0, beat: 0 };
let lastBeat = 0;
let audioUI = null;                // referências do cartão atual (recriadas a cada buildPanel)

function ensureAudio() {
    if (!actx) {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = actx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.5;
        analyser.minDecibels = -100; analyser.maxDecibels = -20;   // menos saturação no topo
        freq = new Uint8Array(analyser.frequencyBinCount);
        audioEl = new Audio();
        audioEl.loop = true;
        audioEl.addEventListener('play', refreshAudioUI);
        audioEl.addEventListener('pause', refreshAudioUI);
        audioEl.addEventListener('timeupdate', () => {
            if (audioUI && audioEl.duration) audioUI.seek.value = audioEl.currentTime / audioEl.duration * 1000;
        });
    }
    if (actx.state === 'suspended') actx.resume();
}

function stopSource() {
    if (micNode) { micNode.disconnect(); micNode = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (mediaNode) mediaNode.disconnect();
    if (audioEl) audioEl.pause();
    if (analyser) analyser.disconnect();
    activeSource = null;
    for (const k in env) { env[k].lo = 1; env[k].hi = 0; }   // reaprende a dinâmica na próxima fonte
    bassTimes.length = 0;
    refreshAudioUI();
}

async function startMic(deviceId) {
    ensureAudio(); stopSource();
    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        }});
    } catch (e) {
        setAudioStatus('Microfone negado ou indisponível'); return;
    }
    micNode = actx.createMediaStreamSource(micStream);
    micNode.connect(analyser);       // não liga na saída, para não dar microfonia
    activeSource = 'mic';
    await fillDevices();
    refreshAudioUI();
}

/* Captura o áudio de uma aba/janela/tela (Spotify Web, SoundCloud, YouTube...). O usuário escolhe no seletor do
   navegador e precisa marcar "Compartilhar áudio". O vídeo é descartado; o som segue tocando na origem. */
async function startCapture() {
    ensureAudio(); stopSource();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        setAudioStatus('Este navegador não captura áudio de aba'); return;
    }
    let s;
    try {
        s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: {
            echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
        setAudioStatus('Captura cancelada'); return;
    }
    const tracks = s.getAudioTracks();
    s.getVideoTracks().forEach(t => t.stop());
    if (!tracks.length) {
        s.getTracks().forEach(t => t.stop());
        setAudioStatus('Sem áudio: marque "Compartilhar áudio da guia"'); return;
    }
    micStream = new MediaStream(tracks);
    tracks[0].addEventListener('ended', stopSource);      // usuário clicou em "Parar de compartilhar"
    micNode = actx.createMediaStreamSource(micStream);
    micNode.connect(analyser);                             // sem saída: o som já toca na origem
    activeSource = 'capture';
    refreshAudioUI();
}

function loadFile(file) {
    ensureAudio(); stopSource();
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(file);
    audioEl.src = fileUrl;
    if (!mediaNode) mediaNode = actx.createMediaElementSource(audioEl);
    mediaNode.connect(analyser);
    analyser.connect(actx.destination);
    audioEl.play().catch(() => setAudioStatus('Clique em ▶ para tocar'));
    activeSource = 'file';
    audioUI && (audioUI.fileName = file.name);
    refreshAudioUI();
}

async function fillDevices() {
    if (!audioUI) return;
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const cur = micStream && micStream.getAudioTracks()[0].getSettings().deviceId;
    audioUI.devices.innerHTML = devs.map(d =>
        `<option value="${d.deviceId}" ${d.deviceId === cur ? 'selected' : ''}>${d.label || 'Entrada de áudio'}</option>`).join('');
}

/* média normalizada (0..1) dos bins entre lo e hi (Hz) */
function band(lo, hi) {
    const hz = actx.sampleRate / analyser.fftSize;
    const i0 = Math.max(1, Math.floor(lo / hz)), i1 = Math.min(freq.length - 1, Math.ceil(hi / hz));
    let s = 0;
    for (let i = i0; i <= i1; i++) s += freq[i];
    return s / ((i1 - i0 + 1) * 255);
}

/* Normalização adaptativa: cada faixa acompanha seu próprio piso e pico recentes (decaem devagar),
   então o efeito responde à dinâmica do som e não fica "colado" em 1 quando a música é alta.
   Todas as constantes de tempo usam dt (segundos), para o resultado não depender do fps. */
const env = { bass: { lo: 1, hi: 0 }, mid: { lo: 1, hi: 0 }, treble: { lo: 1, hi: 0 } };
const BEAT_WINDOW = 0.8;     // s de histórico para a média dos graves
let lastTick = 0;
const bassTimes = [];        // pares [tempo, valor] dos graves recentes

function normalize(k, x, dt) {
    if (x < 0.02) return 0;                                   // silêncio: não ensina nada ao piso/pico
    const e = env[k];
    const kLo = 1 - Math.pow(0.997, dt * 60), kHi = 1 - Math.pow(0.995, dt * 60);
    e.lo = x < e.lo ? x : e.lo + (x - e.lo) * kLo;
    e.hi = x > e.hi ? x : e.hi + (x - e.hi) * kHi;
    const spread = Math.max(e.hi - e.lo, 0.08);               // evita amplificar ruído
    return Math.min(1, Math.max(0, (x - e.lo) / spread));
}

function audioTick(now) {
    const dt = Math.min(0.1, Math.max(0.001, (now - (lastTick || now)) / 1000));
    lastTick = now;
    const decay = r => Math.pow(r, dt * 60);                  // "r por quadro a 60 fps" -> por dt
    if (activeSource) {
        analyser.getByteFrequencyData(freq);
        const g = audioCfg.gain;
        const e = { bass: band(30, 150), mid: band(150, 2000), treble: band(2000, 10000) };   // energia bruta 0..1
        const raw = {
            bass:   Math.min(1, normalize('bass',   e.bass,   dt) * g),
            mid:    Math.min(1, normalize('mid',    e.mid,    dt) * g),
            treble: Math.min(1, normalize('treble', e.treble, dt) * g),
        };
        raw.level = (raw.bass + raw.mid + raw.treble) / 3;
        // ataque instantâneo, queda suave (release)
        const keep = decay(audioCfg.release);
        ['bass', 'mid', 'treble', 'level'].forEach(k => {
            levels[k] = raw[k] > levels[k] ? raw[k] : levels[k] * keep + raw[k] * (1 - keep);
        });
        // beat: ataque dos graves (energia bruta) acima da média dos últimos BEAT_WINDOW s, com intervalo mínimo
        while (bassTimes.length && now - bassTimes[0][0] > BEAT_WINDOW * 1000) bassTimes.shift();
        const avg = bassTimes.length ? bassTimes.reduce((s, p) => s + p[1], 0) / bassTimes.length : 0;
        const rising = bassTimes.length && e.bass - bassTimes[bassTimes.length - 1][1] > 0.03;
        bassTimes.push([now, e.bass]);
        if (e.bass > 0.15 && e.bass > avg * 1.15 && rising && now - lastBeat > 180) { levels.beat = 1; lastBeat = now; }
        else levels.beat *= decay(0.9);
    } else {
        for (const k in levels) levels[k] *= decay(0.9);
    }
    if (audioUI) AUDIO_SOURCES.forEach(([k]) => audioUI.meters[k].style.width = (levels[k] * 100) + '%');
}

/* aplica as rotas sobre uma cópia dos parâmetros */
function applyAudio(base) {
    if (!activeSource) return base;
    const out = { ...base };
    audioCfg.routes.forEach(r => {
        const it = ITEMS.find(i => i.key === r.target);
        if (!it) return;
        const v = out[r.target] + levels[r.src] * r.amount * (it.max - it.min);
        out[r.target] = Math.min(it.max, Math.max(it.min, v));
    });
    return out;
}

/* ---------- interface (cartão "Áudio") ---------- */
function setAudioStatus(msg) { if (audioUI) audioUI.status.textContent = msg; }

function refreshAudioUI() {
    if (!audioUI) return;
    const ui = audioUI;
    ui.btnMic.classList.toggle('on', activeSource === 'mic');
    ui.btnCap.classList.toggle('on', activeSource === 'capture');
    ui.btnFile.classList.toggle('on', activeSource === 'file');
    ui.devices.hidden = activeSource !== 'mic';
    ui.player.hidden = activeSource !== 'file';
    ui.play.textContent = audioEl && !audioEl.paused ? '❚❚' : '▶';
    ui.status.textContent =
        activeSource === 'mic' ? 'Ouvindo a entrada de áudio' :
        activeSource === 'capture' ? 'Capturando o áudio da aba/tela' :
        activeSource === 'file' ? (ui.fileName || 'Arquivo carregado') :
        'Escolha uma fonte de áudio';
}

function pickSelect(options, value, onChange) {
    const s = document.createElement('select');
    s.innerHTML = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
}

function renderRoutes(box) {
    box.innerHTML = '';
    const targets = ITEMS.filter(i => !i.type).map(i => [i.key, i.label]);
    audioCfg.routes.forEach((r, i) => {
        const wrap = document.createElement('div'); wrap.className = 'route';
        const top = document.createElement('div'); top.className = 'route-top';
        const del = document.createElement('button'); del.textContent = '×'; del.title = 'Remover rota';
        del.onclick = () => { audioCfg.routes.splice(i, 1); renderRoutes(box); };
        const arrow = document.createElement('span'); arrow.textContent = '→';
        top.append(pickSelect(AUDIO_SOURCES, r.src, v => r.src = v), arrow,
                   pickSelect(targets, r.target, v => r.target = v), del);
        wrap.append(top, sliderRow('amount', -1, 1, 0.01, r.amount, v => r.amount = v).row);
        box.appendChild(wrap);
    });
}

function buildAudioBody(body) {
    const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

    const status = el('div', 'astatus');
    const btns = el('div', 'abtns');
    const btnMic = el('button', '', 'Entrada');
    btnMic.title = 'Microfone, interface de áudio ou dispositivo virtual (BlackHole, Loopback...)';
    const btnCap = el('button', '', 'Aba / Tela');
    btnCap.title = 'Captura o áudio de uma aba (Spotify Web, SoundCloud, YouTube)';
    const btnFile = el('button', '', 'Arquivo');
    const btnStop = el('button', '', 'Parar');
    const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = 'audio/*'; fileInput.hidden = true;
    btns.append(btnMic, btnCap, btnFile, btnStop);
    const hint = el('div', 'ahint', '<b>Spotify, SoundCloud, YouTube (navegador):</b> use <i>Aba / Tela</i> e marque “Compartilhar áudio”.<br><b>Programas nativos:</b> envie o som para uma entrada virtual (BlackHole, Loopback) e escolha-a em <i>Entrada</i>.');

    const devices = el('select', 'adevices'); devices.hidden = true;
    const player = el('div', 'aplayer'); player.hidden = true;
    const play = el('button', '', '▶');
    const seek = el('input'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = 0;
    player.append(play, seek);

    btnMic.onclick = () => startMic();
    btnCap.onclick = startCapture;
    btnFile.onclick = () => fileInput.click();
    btnStop.onclick = stopSource;
    fileInput.onchange = () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; };
    devices.onchange = () => startMic(devices.value);
    play.onclick = () => { actx.resume(); audioEl.paused ? audioEl.play() : audioEl.pause(); };
    seek.oninput = () => { if (audioEl && audioEl.duration) audioEl.currentTime = seek.value / 1000 * audioEl.duration; };

    const gain = sliderRow('sensitivity', 0, 3, 0.05, audioCfg.gain, v => audioCfg.gain = v).row;
    const release = sliderRow('release', 0, 0.95, 0.01, audioCfg.release, v => audioCfg.release = v).row;

    const meters = {};
    const meterBox = el('div', 'meters');
    AUDIO_SOURCES.forEach(([k, label]) => {
        const m = el('div', 'meter', `<span>${label}</span><div class="mbar"><i></i></div>`);
        meters[k] = m.querySelector('i');
        meterBox.appendChild(m);
    });

    const routesHead = el('div', 'section', 'Rotas: som → parâmetro');
    const routesBox = el('div', 'routes');
    const add = el('button', 'btn alt', '+ rota');
    add.onclick = () => {
        if (audioCfg.routes.length >= MAX_ROUTES) return toast(`Máximo de ${MAX_ROUTES} rotas`);
        audioCfg.routes.push({ src: 'bass', target: 'size', amount: 0.3 });
        renderRoutes(routesBox);
    };
    renderRoutes(routesBox);

    body.append(status, btns, hint, fileInput, devices, player, gain, release, meterBox, routesHead, routesBox, add);
    audioUI = { status, btnMic, btnCap, btnFile, devices, player, play, seek, meters, fileName: audioUI && audioUI.fileName };
    refreshAudioUI();
}
