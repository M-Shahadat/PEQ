/* ── THEME TOGGLE LOGIC ──────────────────────────────────────── */
(function initTheme() {
  const btnTheme = document.getElementById('btn-theme');
  let isLight = localStorage.getItem('squig-theme') === 'light' || 
                (!localStorage.getItem('squig-theme') && window.matchMedia('(prefers-color-scheme: light)').matches);
  
  window.themeColors = {};
  
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark'); 
    btnTheme.textContent = isLight ? '☀️' : '🌙';
    
    const s = getComputedStyle(document.documentElement);
    window.themeColors = { 
      grid: s.getPropertyValue('--grid-line').trim(), 
      strong: s.getPropertyValue('--grid-strong').trim(), 
      glow: s.getPropertyValue('--curve-glow').trim(), 
      fill: s.getPropertyValue('--curve-fill').trim(), 
      border: s.getPropertyValue('--handle-brd').trim(), 
      muted: s.getPropertyValue('--muted').trim() 
    };
    
    if (window.redrawGraph) {
      window.redrawGraph();
    }
  }
  
  btnTheme.addEventListener('click', () => { 
    isLight = !isLight; 
    localStorage.setItem('squig-theme', isLight ? 'light' : 'dark'); 
    applyTheme(); 
  });
  
  applyTheme();
})();

/* ── EQUALIZER MATH ENGINE (For Visual Graph ONLY) ───────────── */
Equalizer = (function() {
  let calc_gains = function (freqs, coeffs, sampleRate) {
    sampleRate = sampleRate || 48000; 
    let gains = new Array(freqs.length).fill(0);
    for (let i = 0; i < coeffs.length; ++i) {
      let [a0, a1, a2, b0, b1, b2] = coeffs[i];
      for (let j = 0; j < freqs.length; ++j) {
        let w = 2 * Math.PI * freqs[j] / sampleRate;
        let phi = 4 * Math.pow(Math.sin(w / 2), 2);
        gains[j] += (10 * Math.log10(Math.pow(b0 + b1 + b2, 2) + (b0 * b2 * phi - (b1 * (b0 + b2) + 4 * b0 * b2)) * phi) - 
                     10 * Math.log10(Math.pow(a0 + a1 + a2, 2) + (a0 * a2 * phi - (a1 * (a0 + a2) + 4 * a0 * a2)) * phi));
      }
    } 
    return gains;
  };
  
  let filters_to_coeffs = function (filters, sampleRate) {
    return filters.map(f => {
      if (!f.freq || f.gain == null || !f.q) return null;
      let freq = Math.max(1e-6, Math.min(f.freq / (sampleRate || 48000), 1));
      let q = Math.max(1e-4, Math.min(f.q, 1000));
      let gain = Math.max(-40, Math.min(f.gain, 40));
      
      let w0 = 2 * Math.PI * freq;
      let sin = Math.sin(w0);
      let cos = Math.cos(w0);
      let a = Math.pow(10, (gain / 40));
      let alpha = sin / (2 * q);
      let alphamod = (2 * Math.sqrt(a) * alpha) || 0;
      
      if (f.type === "LSQ") {
        return [ 
          1.0, 
          -2*((a-1)+(a+1)*cos)/((a+1)+(a-1)*cos+alphamod), 
          ((a+1)+(a-1)*cos-alphamod)/((a+1)+(a-1)*cos+alphamod), 
          a*((a+1)-(a-1)*cos+alphamod)/((a+1)+(a-1)*cos+alphamod), 
          2*a*((a-1)-(a+1)*cos)/((a+1)+(a-1)*cos+alphamod), 
          a*((a+1)-(a-1)*cos-alphamod)/((a+1)+(a-1)*cos+alphamod) 
        ];
      }
      if (f.type === "HSQ") {
        return [ 
          1.0, 
          2*((a-1)-(a+1)*cos)/((a+1)-(a-1)*cos+alphamod), 
          ((a+1)-(a-1)*cos-alphamod)/((a+1)-(a-1)*cos+alphamod), 
          a*((a+1)+(a-1)*cos+alphamod)/((a+1)-(a-1)*cos+alphamod), 
          -2*a*((a-1)+(a+1)*cos)/((a+1)-(a-1)*cos+alphamod), 
          a*((a+1)+(a-1)*cos-alphamod)/((a+1)-(a-1)*cos+alphamod) 
        ];
      }
      if (f.type === "PK") {
        return [ 
          1.0, 
          -2*cos/(1+alpha/a), 
          (1-alpha/a)/(1+alpha/a), 
          (1+alpha*a)/(1+alpha/a), 
          -2*cos/(1+alpha/a), 
          (1-alpha*a)/(1+alpha/a) 
        ];
      }
      return null;
    }).filter(f => f);
  };
  
  return { calc_gains, filters_to_coeffs };
})();

/* ── APP LOGIC ───────────────────────────────────────────────── */
(function () {
  let playlist = [];
  let currentIdx = -1;
  let shuffle = false;
  let repeatMode = 0;
  let eqEnabled = true;
  let activeFilters = [];
  let preampDb = 0;
  let tubeDrive = 0;
  
  // NATIVE WEBAUDIO GRAPH
  let audioCtx = null;
  let sourceNode = null;
  let preampNode = null;
  let biquadNodes = [];
  let tubeNode = null;
  let limiterNode = null;
  let makeupNode = null;
  
  const audioEl = new Audio(); 
  audioEl.crossOrigin = 'anonymous'; 
  audioEl.preload = 'auto';
  
  const MAX_BANDS = 30;

  function ensureCtx() {
    if (audioCtx) return;
    
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaElementSource(audioEl);
    
    preampNode = audioCtx.createGain();
    
    // Wire music to EQ engine
    sourceNode.connect(preampNode);
    
    let prev = preampNode;
    
    // Create persistent Biquads
    for(let i = 0; i < MAX_BANDS; i++) {
      let f = audioCtx.createBiquadFilter(); 
      f.type = 'peaking'; 
      f.gain.value = 0;
      biquadNodes.push(f); 
      prev.connect(f); 
      prev = f;
    }
    
    tubeNode = audioCtx.createWaveShaper(); 
    tubeNode.oversample = '4x';
    prev.connect(tubeNode);
    
    // BRICKWALL LIMITER
    limiterNode = audioCtx.createDynamicsCompressor();
    limiterNode.threshold.value = -0.5; 
    limiterNode.knee.value = 0.0; 
    limiterNode.ratio.value = 20.0; 
    limiterNode.attack.value = 0.005; 
    limiterNode.release.value = 0.050;
    
    tubeNode.connect(limiterNode);

    makeupNode = audioCtx.createGain(); 
    makeupNode.gain.value = 1.0;
    
    limiterNode.connect(makeupNode); 
    makeupNode.connect(audioCtx.destination); 
  }

  function createTubeCurve(amount) {
    const k = typeof amount === 'number' ? amount : 50; 
    const n_samples = 44100; 
    const curve = new Float32Array(n_samples); 
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) { 
      let x = i * 2 / n_samples - 1; 
      curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x)); 
    } 
    return curve;
  }

  // Smooth, pop-free audio updates
  function updateAudioGraph() {
    if (!audioCtx) return;
    
    const now = audioCtx.currentTime;
    
    // Smoothly adjust preamp volume
    preampNode.gain.setTargetAtTime(eqEnabled ? Math.pow(10, preampDb / 20) : 1.0, now, 0.02);

    for (let i = 0; i < MAX_BANDS; i++) {
      const node = biquadNodes[i];
      if (eqEnabled && i < activeFilters.length) {
        const f = activeFilters[i];
        node.type = f.type === 'LSQ' ? 'lowshelf' : f.type === 'HSQ' ? 'highshelf' : 'peaking';
        node.frequency.setTargetAtTime(f.freq, now, 0.02);
        node.Q.setTargetAtTime(f.q, now, 0.02);
        node.gain.setTargetAtTime(f.gain, now, 0.02);
      } else {
        node.gain.setTargetAtTime(0, now, 0.02); 
      }
    }
    
    tubeNode.curve = (tubeDrive > 0 && eqEnabled) ? createTubeCurve(tubeDrive * 4) : null;
  }

  let bands = [];
  let selectedBandId = null;
  let nextBandId = 1;
  
  const PLOT_FREQS = Array.from({length: 600}, (_, i) => 20 * Math.pow(20000 / 20, i / 599));
  const DB_MIN = -20;
  const DB_MAX = 20;

  function freqToX(f, W, pad) { 
    return pad.l + Math.log10(f / 20) / Math.log10(20000 / 20) * (W - pad.l - pad.r); 
  }

  function xToFreq(x, W, pad) { 
    return 20 * Math.pow(20000 / 20, (x - pad.l) / (W - pad.l - pad.r)); 
  }

  function dbToY(db, H, pad) { 
    return pad.t + (1 - (db - DB_MIN) / (DB_MAX - DB_MIN)) * (H - pad.t - pad.b); 
  }

  function yToDb(y, H, pad) { 
    return DB_MAX - (y - pad.t) / (H - pad.t - pad.b) * (DB_MAX - DB_MIN); 
  }

  function computeCurve(SR) { 
    const activeBands = bands.filter(b => b.enabled); 
    if (!activeBands.length) return PLOT_FREQS.map(() => 0); 
    return Equalizer.calc_gains(PLOT_FREQS, Equalizer.filters_to_coeffs(activeBands, SR || 48000), SR || 48000); 
  }

  function computeAutoPreamp() { 
    const activeBands = bands.filter(b => b.enabled); 
    if (!activeBands.length) return 0; 
    return -Math.max(0, ...Equalizer.calc_gains(PLOT_FREQS, Equalizer.filters_to_coeffs(activeBands, 48000), 48000)); 
  }

  function syncEQ() {
    activeFilters = bands.filter(b => b.enabled); 
    preampDb = computeAutoPreamp();
    document.getElementById('preamp-val').textContent = preampDb.toFixed(1) + ' dB';
    updateAudioGraph(); 
    drawCurve(); 
    renderBandStrip(); 
    updateTableValues(); 
    updateSimpleSliders();
  }

  const canvas = document.getElementById('eq-canvas');
  const ctx2d = canvas.getContext('2d');
  const PAD = { l: 42, r: 14, t: 14, b: 28 };

  function resizeCanvas() { 
    const wrap = document.getElementById('eq-canvas-wrap'); 
    if (!wrap) return; 
    const dpr = devicePixelRatio || 1; 
    canvas.width = wrap.clientWidth * dpr; 
    canvas.height = wrap.clientHeight * dpr; 
    canvas.style.width = wrap.clientWidth + 'px'; 
    canvas.style.height = wrap.clientHeight + 'px'; 
    ctx2d.scale(dpr, dpr); 
    drawCurve(); 
  }

  function drawCurve() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight; 
    if (!W || !H) return; 
    
    ctx2d.clearRect(0, 0, W, H);
    
    const tc = window.themeColors || { 
      grid: 'rgba(255,255,255,0.04)', 
      strong: 'rgba(255,255,255,0.1)', 
      glow: 'rgba(124,106,247,0.8)', 
      fill: 'rgba(124,106,247,0.25)', 
      border: 'rgba(255,255,255,0.25)', 
      muted: '#7a7a85' 
    };
    
    ctx2d.strokeStyle = tc.grid; 
    ctx2d.lineWidth = 1; 
    ctx2d.setLineDash([3, 3]); 
    
    [20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000].forEach(f => { 
      const x = freqToX(f, W, PAD); 
      ctx2d.beginPath(); 
      ctx2d.moveTo(x, PAD.t); 
      ctx2d.lineTo(x, H - PAD.b); 
      ctx2d.stroke(); 
    }); 
    
    [-18, -12, -9, -6, -3, 0, 3, 6, 9, 12, 18].forEach(db => { 
      const y = dbToY(db, H, PAD); 
      ctx2d.strokeStyle = db === 0 ? tc.strong : tc.grid; 
      ctx2d.beginPath(); 
      ctx2d.moveTo(PAD.l, y); 
      ctx2d.lineTo(W - PAD.r, y); 
      ctx2d.stroke(); 
    }); 
    
    ctx2d.setLineDash([]); 
    
    ctx2d.font = '9px DM Mono, monospace'; 
    ctx2d.fillStyle = tc.muted; 
    ctx2d.textAlign = 'center'; 
    
    [50, 100, 200, 500, '1k', '2k', '5k', '10k', '20k'].forEach((lbl) => { 
      const x = freqToX(typeof lbl === 'string' ? parseInt(lbl) * 1000 : lbl, W, PAD); 
      ctx2d.fillText(lbl, x, H - PAD.b + 13); 
    }); 
    
    ctx2d.textAlign = 'right'; 
    [-18, -12, -6, 0, 6, 12, 18].forEach(db => {
      ctx2d.fillText((db > 0 ? '+' : '') + db, PAD.l - 5, dbToY(db, H, PAD) + 3.5);
    });

    bands.forEach(band => { 
      if (!band.enabled) return; 
      const gains = Equalizer.calc_gains(PLOT_FREQS, Equalizer.filters_to_coeffs([band], 48000), 48000); 
      ctx2d.strokeStyle = band.id === selectedBandId ? 'rgba(124,106,247,0.6)' : 'rgba(124,106,247,0.2)'; 
      ctx2d.lineWidth = band.id === selectedBandId ? 1.5 : 1; 
      ctx2d.beginPath(); 
      gains.forEach((g, i) => { 
        const x = freqToX(PLOT_FREQS[i], W, PAD);
        const y = dbToY(g, H, PAD); 
        i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y); 
      }); 
      ctx2d.stroke(); 
    });
    
    const gains = computeCurve(48000); 
    ctx2d.strokeStyle = eqEnabled ? (document.documentElement.getAttribute('data-theme') === 'light' ? '#6366f1' : '#a89ff9') : tc.muted; 
    ctx2d.lineWidth = 2.5; 
    ctx2d.shadowColor = eqEnabled ? tc.glow : 'transparent'; 
    ctx2d.shadowBlur = 12; 
    ctx2d.beginPath(); 
    
    gains.forEach((g, i) => { 
      const x = freqToX(PLOT_FREQS[i], W, PAD);
      const y = dbToY(g, H, PAD); 
      i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y); 
    }); 
    ctx2d.stroke(); 
    ctx2d.shadowBlur = 0;
    
    if (eqEnabled && activeFilters.length > 0) { 
      ctx2d.lineTo(freqToX(PLOT_FREQS[PLOT_FREQS.length - 1], W, PAD), H - PAD.b); 
      ctx2d.lineTo(freqToX(PLOT_FREQS[0], W, PAD), H - PAD.b); 
      ctx2d.closePath(); 
      let gradient = ctx2d.createLinearGradient(0, PAD.t, 0, H - PAD.b); 
      gradient.addColorStop(0, tc.fill); 
      gradient.addColorStop(1, 'rgba(124,106,247,0.0)'); 
      ctx2d.fillStyle = gradient; 
      ctx2d.fill(); 
    }

    bands.forEach(band => { 
      const x = freqToX(band.freq, W, PAD);
      const y = dbToY(band.gain, H, PAD);
      const sel = band.id === selectedBandId; 
      ctx2d.beginPath(); 
      ctx2d.arc(x, y, sel ? 7 : 5, 0, Math.PI * 2); 
      ctx2d.fillStyle = band.enabled ? (sel ? '#a89ff9' : '#7c6af7') : '#3a3a45'; 
      ctx2d.strokeStyle = sel ? '#fff' : tc.border; 
      ctx2d.lineWidth = sel ? 1.5 : 1; 
      ctx2d.fill(); 
      ctx2d.stroke(); 
    });
  } 
  
  window.redrawGraph = drawCurve;

  function fmtFreq(f) { 
    return f >= 1000 ? (f / 1000).toFixed(f % 1000 === 0 ? 0 : 1) + 'k' : Math.round(f) + ''; 
  }
  
  function fmtGain(g) { 
    return (g >= 0 ? '+' : '') + g.toFixed(1) + ' dB'; 
  }

  function renderBandStrip() {
    const strip = document.getElementById('band-strip'); 
    strip.innerHTML = '';
    
    bands.forEach(band => {
      const card = document.createElement('div'); 
      card.className = 'band-card' + (band.id === selectedBandId ? ' selected' : '') + (band.enabled ? '' : ' disabled'); 
      card.dataset.id = band.id;
      
      const gainClass = band.gain > 0.05 ? 'pos' : band.gain < -0.05 ? 'neg' : '';
      
      card.innerHTML = `
        <div class="band-num">BAND ${bands.indexOf(band) + 1}</div>
        <select class="band-type-sel" data-id="${band.id}">
          <option value="PK" ${band.type === 'PK' ? 'selected' : ''}>PK</option>
          <option value="LSQ" ${band.type === 'LSQ' ? 'selected' : ''}>LSQ</option>
          <option value="HSQ" ${band.type === 'HSQ' ? 'selected' : ''}>HSQ</option>
        </select>
        <div class="band-val">${(band.freq >= 1000 ? (band.freq / 1000).toFixed(band.freq % 1000 === 0 ? 0 : 1) + 'k' : Math.round(band.freq))} Hz</div>
        <div class="band-gain ${band.gain > 0.05 ? 'pos' : band.gain < -0.05 ? 'neg' : ''}">${(band.gain >= 0 ? '+' : '') + band.gain.toFixed(1) + ' dB'}</div>
        <div class="band-val" style="color:var(--muted)">Q ${band.q.toFixed(2)}</div>
        <button class="band-delete" data-id="${band.id}">✕</button>
      `;
      
      card.addEventListener('click', e => { 
        if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT') { 
          selectedBandId = band.id; 
          drawCurve(); 
          renderBandStrip(); 
        }
      });
      
      card.querySelector('.band-type-sel').addEventListener('change', e => { 
        band.type = e.target.value; 
        syncEQ(); 
      }); 
      
      card.querySelector('.band-delete').addEventListener('click', () => { 
        bands = bands.filter(b => b.id !== band.id); 
        if (selectedBandId === band.id) {
          selectedBandId = bands.length ? bands[bands.length - 1].id : null; 
        }
        syncEQ(); 
      }); 
      
      strip.appendChild(card);
    });
  }

  let dragBand = null;
  let qTooltipTimer = null;

  function hitTest(cx, cy) { 
    for (let i = bands.length - 1; i >= 0; i--) { 
      let bandX = freqToX(bands[i].freq, canvas.clientWidth, PAD);
      let bandY = dbToY(bands[i].gain, canvas.clientHeight, PAD);
      if (Math.hypot(cx - bandX, cy - bandY) < 10) {
        return bands[i]; 
      }
    } 
    return null; 
  }

  canvas.addEventListener('mousedown', e => { 
    const hit = hitTest(e.offsetX, e.offsetY); 
    if (hit) { 
      dragBand = hit; 
      selectedBandId = hit.id; 
      canvas.style.cursor = 'grabbing'; 
      renderBandStrip(); 
    }
  });

  window.addEventListener('mousemove', e => { 
    if (!dragBand) return; 
    const rect = canvas.getBoundingClientRect(); 
    let newFreq = xToFreq(e.clientX - rect.left, canvas.clientWidth, PAD);
    dragBand.freq = Math.max(20, Math.min(20000, newFreq)); 
    const snap = e.shiftKey ? 0.1 : 0.5; 
    let rawDb = yToDb(e.clientY - rect.top, canvas.clientHeight, PAD);
    dragBand.gain = Math.max(-20, Math.min(20, Math.round(rawDb / snap) * snap)); 
    syncEQ(); 
  });

  window.addEventListener('mouseup', () => { 
    if (dragBand) { 
      canvas.style.cursor = 'crosshair'; 
      dragBand = null; 
    } 
  });

  canvas.addEventListener('wheel', e => { 
    const hit = hitTest(e.offsetX, e.offsetY); 
    if (!hit) return; 
    e.preventDefault(); 
    
    const step = e.shiftKey ? 0.01 : 0.05;
    let delta = e.deltaY > 0 ? -1 : 1;
    hit.q = Math.max(0.1, Math.min(10, Math.round((hit.q + delta * step) * 100) / 100)); 
    
    selectedBandId = hit.id; 
    syncEQ(); 
    
    const qtt = document.getElementById('q-tooltip'); 
    qtt.textContent = 'Q ' + hit.q.toFixed(2); 
    qtt.style.left = (e.clientX + 14) + 'px'; 
    qtt.style.top = (e.clientY - 28) + 'px'; 
    qtt.style.display = 'block'; 
    
    clearTimeout(qTooltipTimer); 
    qTooltipTimer = setTimeout(() => {
      qtt.style.display = 'none';
    }, 1000); 
  }, { passive: false });

  canvas.addEventListener('dblclick', e => { 
    if (!hitTest(e.offsetX, e.offsetY)) {
      addBand({ 
        freq: Math.max(20, Math.min(20000, Math.round(xToFreq(e.offsetX, canvas.clientWidth, PAD)))), 
        gain: Math.max(-20, Math.min(20, Math.round(yToDb(e.offsetY, canvas.clientHeight, PAD) * 2) / 2)), 
        q: 1.0, 
        type: 'PK' 
      }); 
    }
  });

  canvas.addEventListener('mousemove', e => { 
    if (!dragBand) {
      canvas.style.cursor = hitTest(e.offsetX, e.offsetY) ? 'grab' : 'crosshair'; 
    }
  });

  function addBand(opts) { 
    if (bands.length >= MAX_BANDS) { 
      showMsg('Max 30 bands reached.', 'error'); 
      return; 
    } 
    
    bands.push({ 
      id: nextBandId++, 
      type: opts.type || 'PK', 
      freq: opts.freq || 1000, 
      gain: opts.gain !== undefined ? opts.gain : 0, 
      q: opts.q || 1.0, 
      enabled: true 
    }); 
    
    selectedBandId = bands[bands.length - 1].id; 
    syncEQ(); 
    
    setTimeout(() => {
      document.getElementById('band-strip').scrollLeft = 9999;
    }, 10); 
  }

  function importFilters(text) {
    const filters = []; 
    let preamp = 0;
    
    const chunks = text.replace(/\r\n/g, '\n').split(/(?=Filter\s+\d+:|Preamp:)/i).map(s => s.trim()).filter(Boolean);
    
    chunks.forEach(chunk => {
      const pm = chunk.match(/Preamp:\s*([-\d.]+)\s*dB/i); 
      if (pm) preamp = parseFloat(pm[1]);
      
      const m = chunk.match(/Filter\s+\d+:\s+ON\s+(\w+)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+([-\d.]+)\s+dB\s+Q\s+([\d.]+)/i);
      if (m) {
        let rawType = m[1].toUpperCase();
        let finalType = 'PK';
        if (rawType === 'LS' || rawType === 'LSC') finalType = 'LSQ';
        if (rawType === 'HS' || rawType === 'HSC') finalType = 'HSQ';
        
        filters.push({ 
          type: finalType, 
          freq: parseFloat(m[2]), 
          gain: parseFloat(m[3]), 
          q: parseFloat(m[4]) 
        });
      }
    });
    
    if (!filters.length) { 
      showMsg('No valid filters found.', 'error'); 
      return false; 
    }
    
    bands = filters.slice(0, MAX_BANDS).map(f => ({ ...f, id: nextBandId++, enabled: true })); 
    selectedBandId = bands.length ? bands[0].id : null;
    
    if (preamp !== 0) preampDb = preamp; 
    syncEQ(); 
    
    showMsg(`✓ ${Math.min(filters.length, MAX_BANDS)} bands applied`, 'ok'); 
    return true;
  }

  // ── UI Views & Toggles ─────────────────────────────────────────
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => { 
      document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t === tab)); 
      document.querySelectorAll('.eq-view').forEach(v => v.classList.toggle('visible', v.id === 'view-' + tab.dataset.view)); 
      if (tab.dataset.view === 'graph') {
        setTimeout(resizeCanvas, 10); 
      }
      if (tab.dataset.view === 'table') {
        renderTable(); 
      }
    });
  });

  const eqPill = document.getElementById('eq-pill');
  const eqCheckbox = document.getElementById('eq-enabled');
  
  eqPill.addEventListener('click', () => { 
    eqEnabled = !eqEnabled; 
    eqCheckbox.checked = eqEnabled; 
    eqPill.classList.toggle('on', eqEnabled); 
    document.getElementById('eq-pill-label').textContent = eqEnabled ? 'ON' : 'OFF'; 
    updateAudioGraph(); 
    drawCurve(); 
  });
  
  document.getElementById('btn-add-band').addEventListener('click', () => {
    addBand({ freq: 1000, gain: 0, q: 1.0, type: 'PK' });
  });

  // RESTORED: Table View Add Band Button
  document.getElementById('btn-tbl-add').addEventListener('click', () => {
    addBand({ freq: 1000, gain: 0, q: 1.0, type: 'PK' });
  });
  
  document.getElementById('btn-clear-eq').addEventListener('click', () => { 
    bands = []; 
    selectedBandId = null; 
    activeFilters = []; 
    preampDb = 0; 
    tubeDrive = 0; 
    
    document.getElementById('preamp-val').textContent = '0.0 dB'; 
    document.getElementById('ss-tube').value = 0; 
    document.getElementById('sv-tube').textContent = '0%'; 
    
    document.querySelectorAll('.simple-slider-val').forEach(el => el.textContent = '0.0 dB'); 
    document.querySelectorAll('.simple-slider').forEach(el => {
      el.value = 0; 
      el.style.background = 'var(--bg4)';
    }); 
    
    syncEQ(); 
    showMsg('EQ cleared.', ''); 
  });

  const importOverlay = document.getElementById('import-overlay');
  
  document.getElementById('btn-import').addEventListener('click', () => { 
    importOverlay.classList.add('open'); 
    document.getElementById('iem-input').focus(); 
  }); 
  
  document.getElementById('btn-import-cancel').addEventListener('click', () => {
    importOverlay.classList.remove('open');
  }); 
  
  importOverlay.addEventListener('click', e => { 
    if (e.target === importOverlay) importOverlay.classList.remove('open'); 
  });
  
  document.getElementById('btn-import-apply').addEventListener('click', () => { 
    if (importFilters(document.getElementById('iem-input').value.trim())) {
      importOverlay.classList.remove('open'); 
    }
  });
  
  function showMsg(text, type) { 
    const el = document.getElementById('msg'); 
    el.textContent = text; 
    el.className = type || ''; 
    if (text) {
      setTimeout(() => { 
        if (el.textContent === text) el.textContent = ''; 
      }, 3000); 
    }
  }

  // ── AutoEQ Target Matcher ──────────────────────────────────────
  const targetOverlay = document.getElementById('target-overlay');
  const targetSearch = document.getElementById('target-search');
  const targetResults = document.getElementById('autoeq-results');
  const targetStatus = document.getElementById('autoeq-status'); 
  let autoEqDatabase = [];

  document.getElementById('btn-target-match').addEventListener('click', async () => { 
    targetOverlay.classList.add('open'); 
    targetSearch.focus(); 
    if (autoEqDatabase.length === 0) await fetchAutoEqDatabase(); 
  }); 
  
  document.getElementById('btn-target-cancel').addEventListener('click', () => {
    targetOverlay.classList.remove('open');
  }); 
  
  targetOverlay.addEventListener('click', e => { 
    if (e.target === targetOverlay) targetOverlay.classList.remove('open'); 
  });

  async function fetchAutoEqDatabase() {
    targetStatus.textContent = "Syncing AutoEQ Database from GitHub...";
    try { 
      const res = await fetch('https://api.github.com/repos/jaakkopasanen/AutoEq/git/trees/master?recursive=1'); 
      if (!res.ok) throw new Error("API limit"); 
      const data = await res.json(); 
      
      autoEqDatabase = data.tree.filter(f => f.path.startsWith('results/') && f.path.endsWith('ParametricEQ.txt')).map(f => { 
        const parts = f.path.split('/'); 
        return { 
          name: parts[parts.length - 1].replace(' ParametricEQ.txt', ''), 
          reviewer: parts[1], 
          target: parts[2], 
          path: f.path 
        }; 
      }); 
      
      targetStatus.textContent = `✓ Synced ${autoEqDatabase.length} headphone profiles.`; 
      renderAutoEqResults(autoEqDatabase.slice(0, 50)); 
    } catch(err) { 
      targetStatus.textContent = "Offline Fallback (GitHub limit reached)."; 
      autoEqDatabase = [
        { 
          name: "Sennheiser HD 600", 
          target: "harman", 
          reviewer: "oratory1990", 
          path: "results/oratory1990/harman_over-ear_2018/Sennheiser HD 600/Sennheiser HD 600 ParametricEQ.txt" 
        }, 
        { 
          name: "Moondrop Blessing 2", 
          target: "harman", 
          reviewer: "crinacle", 
          path: "results/crinacle/harman_in-ear_2019v2/Moondrop Blessing 2/Moondrop Blessing 2 ParametricEQ.txt" 
        }
      ]; 
      renderAutoEqResults(autoEqDatabase); 
    }
  }

  targetSearch.addEventListener('input', e => { 
    const q = e.target.value.toLowerCase().trim(); 
    if (q) {
      let filtered = autoEqDatabase.filter(i => i.name.toLowerCase().includes(q) || i.reviewer.toLowerCase().includes(q));
      renderAutoEqResults(filtered.slice(0, 50)); 
    } else {
      renderAutoEqResults(autoEqDatabase.slice(0, 50));
    }
  });

  function renderAutoEqResults(results) {
    targetResults.innerHTML = ''; 
    if (!results.length) { 
      targetResults.innerHTML = '<div style="padding:10px; color:var(--muted); font-size:12px;">No matches found.</div>'; 
      return; 
    }
    
    results.forEach(item => { 
      const div = document.createElement('div'); 
      div.className = 'aeq-item'; 
      div.innerHTML = `
        <div class="aeq-name">${item.name}</div>
        <div class="aeq-meta">Target: ${item.target} • Source: ${item.reviewer}</div>
      `; 
      
      div.addEventListener('click', async () => { 
        targetStatus.textContent = `Fetching profile...`; 
        try { 
          const res = await fetch(`https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/${item.path}`); 
          if(!res.ok) throw new Error("404"); 
          
          const textData = await res.text();
          if (importFilters(textData)) { 
            targetOverlay.classList.remove('open'); 
            targetSearch.value = ''; 
          } 
        } catch(err) { 
          targetStatus.textContent = "Error fetching raw profile data."; 
        } 
      }); 
      
      targetResults.appendChild(div); 
    });
  }

  // ── Local Files & DB ──────────────────────────────────────────
  function loadLibrary() { 
    const libEl = document.getElementById('library'); 
    if (sessionTracks.length === 0) {
      libEl.innerHTML = `<div id="lib-status">No music sources yet.</div>`; 
    } else {
      mergeSessionIntoLibrary(); 
    }
  }

  function renderLibraryMixed(sessionFiles) {
    const libEl = document.getElementById('library'); 
    if (!sessionFiles.length) { 
      libEl.innerHTML = '<div id="lib-status">No tracks found.</div>'; 
      return; 
    }
    
    let html = ''; 
    const groups = {}; 
    
    sessionFiles.forEach(t => { 
      if (!groups[t.folder]) {
        groups[t.folder] = []; 
      }
      groups[t.folder].push(t); 
    });
    
    for (const [folder, tracks] of Object.entries(groups)) { 
      html += `<div class="lib-folder" style="color:var(--accent2)">📂 ${folder}</div>`; 
      for (const t of tracks) {
        html += `<div class="lib-track" data-path="${t.id}">${t.name}</div>`; 
      }
    }
    
    libEl.innerHTML = html; 
    
    libEl.querySelectorAll('.lib-track').forEach(el => {
      el.addEventListener('click', () => { 
        currentIdx = playlist.indexOf(el.dataset.path); 
        if (currentIdx === -1) currentIdx = 0; 
        playTrack(el.dataset.path); 
      });
    });
    
    highlightCurrent();
  }

  function highlightCurrent() { 
    document.querySelectorAll('.lib-track').forEach(el => {
      el.classList.toggle('playing', el.dataset.path === (playlist[currentIdx] || ''));
    }); 
  }

  const AUDIO_EXTS_RE = /\.(mp3|flac|m4a|wav|aac|ogg|opus|aiff|wma)$/i; 
  let sessionTracks = [];
  let sessionCounter = 0;
  let dirHandles = [];
  const IDB_NAME = 'squiglink-player';
  const IDB_STORE = 'dir-handles';
  const IDB_VER = 3; 
  let idb = null;

  async function openIDB() { 
    if (idb) return idb; 
    return new Promise((res, rej) => { 
      const req = indexedDB.open(IDB_NAME, IDB_VER); 
      req.onupgradeneeded = e => { 
        if (!e.target.result.objectStoreNames.contains(IDB_STORE)) {
          e.target.result.createObjectStore(IDB_STORE, { keyPath: 'name' }); 
        }
      }; 
      req.onsuccess = e => { 
        idb = e.target.result; 
        res(idb); 
      }; 
      req.onerror = e => rej(e.target.error); 
    }); 
  }

  async function idbSaveHandle(name, handle) { 
    const db = await openIDB(); 
    return new Promise((res, rej) => { 
      const tx = db.transaction(IDB_STORE, 'readwrite'); 
      tx.objectStore(IDB_STORE).put({ name, handle }); 
      tx.oncomplete = res; 
      tx.onerror = e => rej(e.target.error); 
    }); 
  }

  async function idbGetAllHandles() { 
    const db = await openIDB(); 
    return new Promise((res, rej) => { 
      const tx = db.transaction(IDB_STORE, 'readonly'); 
      const req = tx.objectStore(IDB_STORE).getAll(); 
      req.onsuccess = e => res(e.target.result); 
      req.onerror = e => rej(e.target.error); 
    }); 
  }

  async function idbDeleteHandle(name) { 
    const db = await openIDB(); 
    return new Promise((res, rej) => { 
      const tx = db.transaction(IDB_STORE, 'readwrite'); 
      tx.objectStore(IDB_STORE).delete(name); 
      tx.oncomplete = res; 
      tx.onerror = e => rej(e.target.error); 
    }); 
  }

  async function loadHandleIntoSession(handle, savedName) {
    const folderName = savedName || handle.name; 
    sessionTracks = sessionTracks.filter(t => t.dirName !== folderName); 
    const files = [];
    
    async function walk(dirHandle, path) { 
      try { 
        for await (const entry of dirHandle.values()) { 
          if (entry.kind === 'file' && AUDIO_EXTS_RE.test(entry.name)) { 
            const file = await entry.getFile(); 
            Object.defineProperty(file, 'webkitRelativePath', { value: path + entry.name, configurable: true }); 
            files.push({ file, path }); 
          } else if (entry.kind === 'directory') {
            await walk(entry, path + entry.name + '/'); 
          }
        } 
      } catch(e) {
        console.warn("Could not walk", e);
      } 
    }
    
    await walk(handle, ''); 
    
    files.forEach(({ file, path }) => { 
      sessionTracks.push({ 
        id: 'session:' + (sessionCounter++), 
        name: file.name.replace(/\.[^.]+$/, ''), 
        folder: path ? folderName + ' / ' + path.slice(0, -1) : folderName, 
        blobUrl: URL.createObjectURL(file), 
        file, 
        dirName: folderName 
      }); 
    }); 
    
    return files.length;
  }

  async function restorePersistedHandles() { 
    let saved; 
    try { 
      saved = await idbGetAllHandles(); 
    } catch (e) { 
      return; 
    } 
    
    if (!saved || !saved.length) return; 
    
    for (const { name, handle } of saved) { 
      try { 
        if (await handle.queryPermission({ mode: 'read' }) === 'granted') { 
          dirHandles.push({ handle, name }); 
          await loadHandleIntoSession(handle, name); 
        } else {
          dirHandles.push({ handle, name, needsGrant: true }); 
        }
      } catch(err) {
        console.warn(err);
      } 
    } 
    mergeSessionIntoLibrary(); 
    renderSavedHandlesBanner(); 
  }

  function renderSavedHandlesBanner() {
    const needs = dirHandles.filter(d => d.needsGrant);
    const libEl = document.getElementById('library');
    const existing = document.getElementById('regrant-banner'); 
    
    if (existing) existing.remove(); 
    if (!needs.length) return;
    
    const banner = document.createElement('div'); 
    banner.id = 'regrant-banner'; 
    banner.style.cssText = 'padding:10px 20px;background:rgba(124,106,247,0.12);border-bottom:1px solid rgba(124,106,247,0.25);font-size:11px;color:var(--accent2);cursor:pointer;'; 
    banner.innerHTML = `🔐 Click to restore <strong>${needs.length}</strong> saved folder(s)`;
    
    banner.addEventListener('click', async () => { 
      for (const d of needs) { 
        try { 
          if (await d.handle.requestPermission({ mode: 'read' }) === 'granted') { 
            d.needsGrant = false; 
            await loadHandleIntoSession(d.handle, d.name); 
          } 
        } catch(e) {
          console.warn("Permission denied", e);
        } 
      } 
      mergeSessionIntoLibrary(); 
      renderSavedHandlesBanner(); 
      loadSources(); 
    });
    
    libEl.parentElement.insertBefore(banner, libEl);
  }

  function addSessionFiles(fileList) {
    const files = Array.from(fileList).filter(f => AUDIO_EXTS_RE.test(f.name)); 
    if (!files.length) return 0;
    
    files.forEach(file => { 
      sessionTracks.push({ 
        id: 'session:' + (sessionCounter++), 
        name: file.name.replace(/\.[^.]+$/, ''), 
        folder: (file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1).join(' / ') : 'Session') || 'Session', 
        blobUrl: URL.createObjectURL(file), 
        file 
      }); 
    });
    
    mergeSessionIntoLibrary(); 
    return files.length;
  }

  function mergeSessionIntoLibrary() { 
    playlist = sessionTracks.map(t => t.id); 
    renderLibraryMixed(sessionTracks); 
  }

  const sourcesOverlay = document.getElementById('sources-overlay');
  
  document.querySelectorAll('.src-tab').forEach(tab => {
    tab.addEventListener('click', () => { 
      document.querySelectorAll('.src-tab').forEach(t => t.classList.toggle('active', t === tab)); 
      document.querySelectorAll('.src-pane').forEach(p => p.classList.toggle('visible', p.id === tab.dataset.pane)); 
      if (tab.dataset.pane === 'pane-current') {
        loadSources(); 
      }
    });
  });

  document.getElementById('btn-manage-sources').addEventListener('click', () => { 
    sourcesOverlay.classList.add('open'); 
    loadSources(); 
  }); 
  
  document.getElementById('btn-sources-close').addEventListener('click', () => {
    sourcesOverlay.classList.remove('open');
  }); 
  
  sourcesOverlay.addEventListener('click', e => { 
    if (e.target === sourcesOverlay) sourcesOverlay.classList.remove('open'); 
  });

  const dropZone = document.getElementById('drop-zone');
  const folderPicker = document.getElementById('folder-picker');
  const dropProgress = document.getElementById('drop-progress');
  const hasFSAPI = window.isSecureContext && typeof window.showDirectoryPicker === 'function';
  
  if (hasFSAPI) { 
    folderPicker.style.display = 'none'; 
    dropZone.querySelector('.drop-sub').innerHTML = 'Folder is <strong>remembered across sessions</strong> (Chrome/Edge/Opera).<br><span style="color:var(--muted)">Safari/Firefox: drag-and-drop works but won\'t persist.</span>'; 
  } else { 
    dropZone.querySelector('.drop-sub').innerHTML = window.isSecureContext ? '<span style="color:var(--danger)">⚠ Saving disabled: Unsupported Browser.</span><br><span style="color:var(--muted)">Firefox and Safari block persistent access. Use Chrome for full features.</span>' : '<span style="color:var(--danger)">⚠ Saving disabled: Insecure context.</span><br><span style="color:var(--muted)">Host on HTTPS to enable automatic folder saving.</span>'; 
  }

  dropZone.addEventListener('click', async e => { 
    if (e.target === folderPicker) return; 
    
    if (hasFSAPI) { 
      try { 
        const handle = await window.showDirectoryPicker({ mode: 'read' }); 
        dropProgress.textContent = 'Scanning…'; 
        const n = await loadHandleIntoSession(handle, handle.name); 
        
        if (!dirHandles.find(d => d.name === handle.name)) { 
          dirHandles.push({ handle, name: handle.name }); 
          try { 
            await idbSaveHandle(handle.name, handle); 
          } catch(dbErr) { 
            return; 
          } 
        } 
        
        mergeSessionIntoLibrary(); 
        dropProgress.textContent = `✓ ${n} tracks — remembered`; 
        
        setTimeout(() => {
          sourcesOverlay.classList.remove('open');
        }, 1400); 
      } catch (err) {
        console.warn("Picker cancelled");
      } 
    } else {
      folderPicker.click(); 
    }
  });

  folderPicker.addEventListener('change', () => { 
    if (addSessionFiles(folderPicker.files)) { 
      dropProgress.textContent = `✓ Loaded (session only)`; 
      setTimeout(() => {
        sourcesOverlay.classList.remove('open');
      }, 1200); 
    } 
  });

  dropZone.addEventListener('dragover', e => { 
    e.preventDefault(); 
    dropZone.classList.add('dragover'); 
  }); 

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', async e => {
    e.preventDefault(); 
    dropZone.classList.remove('dragover'); 
    const items = e.dataTransfer.items;
    
    if (items && items.length && hasFSAPI) { 
      for (const item of items) { 
        if (item.getAsFileSystemHandle) { 
          try { 
            const handle = await item.getAsFileSystemHandle(); 
            if (handle && handle.kind === 'directory') { 
              dropProgress.textContent = 'Scanning…'; 
              const n = await loadHandleIntoSession(handle, handle.name); 
              
              if (!dirHandles.find(d => d.name === handle.name)) { 
                dirHandles.push({ handle, name: handle.name }); 
                await idbSaveHandle(handle.name, handle); 
              } 
              
              mergeSessionIntoLibrary(); 
              dropProgress.textContent = `✓ ${n} tracks`; 
              
              setTimeout(() => {
                sourcesOverlay.classList.remove('open');
              }, 1400); 
              return; 
            } 
          } catch (err) {
            console.warn("Handle error", err);
          } 
        } 
      } 
    }
    
    const allFiles2 = []; 
    let pending = 0;
    
    function scanEntry(entry, path) { 
      path = path || ''; 
      if (entry.isFile) { 
        pending++; 
        entry.getFile(file => { 
          if (AUDIO_EXTS_RE.test(file.name)) { 
            Object.defineProperty(file, 'webkitRelativePath', { value: path + file.name }); 
            allFiles2.push(file); 
          } 
          pending--; 
          if (pending === 0) finish(); 
        }); 
      } else if (entry.isDirectory) { 
        const reader = entry.createReader(); 
        const readAll = () => reader.readEntries(entries => { 
          if (!entries.length) return; 
          entries.forEach(e2 => scanEntry(e2, path + entry.name + '/')); 
          readAll(); 
        }); 
        readAll(); 
      } 
    }
    
    if (items && items.length) { 
      for (const item of items) { 
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; 
        if (entry) {
          scanEntry(entry); 
        } else if (item.kind === 'file') {
          allFiles2.push(item.getAsFile()); 
        }
      } 
      if (pending === 0) finish(); 
    }
    
    function finish() { 
      if (!allFiles2.length) return; 
      const dt = new DataTransfer(); 
      allFiles2.forEach(f => dt.items.add(f)); 
      if (addSessionFiles(dt.files)) { 
        dropProgress.textContent = `✓ Loaded`; 
        setTimeout(() => {
          sourcesOverlay.classList.remove('open');
        }, 1200); 
      } 
    }
  });

  function loadSources() {
    const listEl = document.getElementById('sources-list'); 
    let html = '';
    
    dirHandles.forEach(d => {
      let trackCount = sessionTracks.filter(t => t.dirName === d.name).length;
      html += `
        <div class="source-row session">
          <div class="source-icon">📂</div>
          <div class="source-info">
            <div class="source-path">${d.name}</div>
            <div class="source-count">${d.needsGrant ? '🔐 click to restore' : trackCount + ' tracks'}</div>
          </div>
          <button class="source-remove" data-name="${d.name}">✕</button>
        </div>
      `;
    });
    
    if (!html) { 
      listEl.innerHTML = '<div class="source-empty">No sources yet.</div>'; 
      return; 
    } 
    
    listEl.innerHTML = html;
    
    listEl.querySelectorAll('.source-remove').forEach(btn => {
      btn.addEventListener('click', async () => { 
        const name = btn.dataset.name; 
        sessionTracks.filter(t => t.dirName === name).forEach(t => URL.revokeObjectURL(t.blobUrl)); 
        sessionTracks = sessionTracks.filter(t => t.dirName !== name); 
        dirHandles = dirHandles.filter(d => d.name !== name); 
        
        await idbDeleteHandle(name); 
        mergeSessionIntoLibrary(); 
        renderSavedHandlesBanner(); 
        loadSources(); 
      });
    });
  }

  function readLocalMetadata(file) {
    if (!window.jsmediatags) return;
    jsmediatags.read(file, {
      onSuccess: function(tag) {
        if (tag.tags.title) {
          document.getElementById('np-title').textContent = tag.tags.title;
        }
        if (tag.tags.artist) {
          document.getElementById('np-folder').textContent = `${tag.tags.artist}${tag.tags.album ? ' — ' + tag.tags.album : ''}`;
        }
        
        const artEl = document.getElementById('now-playing-art');
        const fallback = document.getElementById('art-fallback');
        
        if (tag.tags.picture) {
          let base64String = ""; 
          for (let i = 0; i < tag.tags.picture.data.length; i++) {
            base64String += String.fromCharCode(tag.tags.picture.data[i]);
          }
          artEl.src = `data:${tag.tags.picture.format};base64,${window.btoa(base64String)}`; 
          artEl.style.display = 'block'; 
          fallback.style.display = 'none';
        } else { 
          artEl.style.display = 'none'; 
          fallback.style.display = 'block'; 
        }
      },
      onError: function() { 
        document.getElementById('now-playing-art').style.display = 'none'; 
        document.getElementById('art-fallback').style.display = 'block'; 
      }
    });
  }

  // ── Playback & Transport ───────────────────────────────────────
  function playTrack(path) {
    ensureCtx(); 
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    const session = sessionTracks.find(t => t.id === path);
    if (session) {
      audioEl.src = session.blobUrl; 
      document.getElementById('np-title').textContent = session.name; 
      document.getElementById('np-folder').textContent = '⚡ ' + session.folder;
      
      document.getElementById('now-playing-art').style.display = 'none'; 
      document.getElementById('art-fallback').style.display = 'block';
      
      if (session.file) {
        readLocalMetadata(session.file);
      }
      
      audioEl.play(); 
      document.getElementById('btn-play').textContent = '⏸'; 
      updateAudioGraph(); 
      highlightCurrent();
    }
  }

  function togglePlay() { 
    ensureCtx(); 
    if (audioCtx.state === 'suspended') {
      audioCtx.resume(); 
    }
    
    if (audioEl.paused) { 
      if (!audioEl.src) { 
        if (playlist.length) { 
          currentIdx = 0; 
          playTrack(playlist[0]); 
        } 
        return; 
      } 
      audioEl.play(); 
      document.getElementById('btn-play').textContent = '⏸'; 
    } else { 
      audioEl.pause(); 
      document.getElementById('btn-play').textContent = '▶'; 
    } 
  }

  function playNext() { 
    if (playlist.length === 0) return; 
    if (repeatMode === 2) { 
      audioEl.currentTime = 0; 
      audioEl.play(); 
      return; 
    } 
    currentIdx = shuffle ? Math.floor(Math.random() * playlist.length) : (currentIdx + 1) % playlist.length; 
    playTrack(playlist[currentIdx]); 
  }

  function playPrev() { 
    if (playlist.length === 0) return; 
    if (audioEl.currentTime > 3) { 
      audioEl.currentTime = 0; 
      return; 
    } 
    currentIdx = (currentIdx - 1 + playlist.length) % playlist.length; 
    playTrack(playlist[currentIdx]); 
  }

  function fmt(s) { 
    s = Math.floor(s || 0); 
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); 
  }

  const seekSlider = document.getElementById('seek-slider'); 
  let isDraggingSeek = false;
  
  function updateSliderFill(el, color) { 
    let percent = (el.value / el.max) * 100;
    el.style.background = `linear-gradient(to right, ${color} ${percent}%, var(--bg4) ${percent}%)`; 
  }
  
  seekSlider.addEventListener('input', () => { 
    isDraggingSeek = true; 
    updateSliderFill(seekSlider, 'var(--btn-invert-bg)'); 
    if (audioEl.duration && isFinite(audioEl.duration)) {
      document.getElementById('time-cur').textContent = fmt((seekSlider.value / 1000) * audioEl.duration); 
    }
  });

  seekSlider.addEventListener('change', () => { 
    if (audioEl.duration && isFinite(audioEl.duration)) {
      audioEl.currentTime = (seekSlider.value / 1000) * audioEl.duration; 
    }
    isDraggingSeek = false; 
  });

  audioEl.addEventListener('timeupdate', () => { 
    if (!isDraggingSeek && audioEl.duration && isFinite(audioEl.duration)) { 
      seekSlider.value = (audioEl.currentTime / audioEl.duration) * 1000; 
      updateSliderFill(seekSlider, 'var(--btn-invert-bg)'); 
      document.getElementById('time-cur').textContent = fmt(audioEl.currentTime); 
      document.getElementById('time-tot').textContent = fmt(audioEl.duration); 
    } 
  });

  audioEl.addEventListener('ended', () => { 
    if (repeatMode === 2) { 
      audioEl.play(); 
      return; 
    } 
    if (repeatMode === 1 || currentIdx < playlist.length - 1 || shuffle) {
      playNext(); 
    } else {
      document.getElementById('btn-play').textContent = '▶'; 
    }
  });

  audioEl.addEventListener('play', () => {
    document.getElementById('btn-play').textContent = '⏸';
  }); 
  
  audioEl.addEventListener('pause', () => {
    document.getElementById('btn-play').textContent = '▶';
  });

  const volSlider = document.getElementById('vol-slider');
  
  volSlider.addEventListener('input', e => { 
    let val = parseFloat(e.target.value);
    if (makeupNode) {
      makeupNode.gain.value = val; 
    } else {
      audioEl.volume = Math.min(1, val); 
    }
    updateSliderFill(volSlider, 'var(--text)'); 
  });

  updateSliderFill(volSlider, 'var(--text)');

  document.getElementById('btn-play').addEventListener('click', togglePlay); 
  document.getElementById('btn-prev').addEventListener('click', playPrev); 
  document.getElementById('btn-next').addEventListener('click', playNext);
  
  document.getElementById('btn-shuffle').addEventListener('click', function() { 
    shuffle = !shuffle; 
    this.classList.toggle('active', shuffle); 
  });

  document.getElementById('btn-repeat').addEventListener('click', function() { 
    repeatMode = (repeatMode + 1) % 3; 
    this.classList.toggle('active', repeatMode > 0); 
    this.textContent = repeatMode === 2 ? '↻¹' : '↻'; 
  });

  document.getElementById('search').addEventListener('input', function() { 
    const q = this.value.toLowerCase().trim(); 
    renderLibraryMixed(q ? sessionTracks.filter(f => f.name.toLowerCase().includes(q)) : sessionTracks); 
  });

  // ── Table View ────────────────────────────────────────────────
  function renderTable() {
    const tbody = document.getElementById('peq-tbody'); 
    if (!tbody) return; 
    tbody.innerHTML = '';
    
    bands.forEach(band => {
      const tr = document.createElement('tr'); 
      tr.className = 'peq-row' + (band.id === selectedBandId ? ' selected-row' : ''); 
      tr.dataset.id = band.id;
      
      let isPos = band.gain > 0.05 ? 'gain-pos' : band.gain < -0.05 ? 'gain-neg' : '';
      
      tr.innerHTML = `
        <td><input type="checkbox" class="tbl-enabled" ${band.enabled ? 'checked' : ''} data-id="${band.id}"></td>
        <td>
          <select class="tbl-type" data-id="${band.id}">
            <option value="PK" ${band.type === 'PK' ? 'selected' : ''}>PK</option>
            <option value="LSQ" ${band.type === 'LSQ' ? 'selected' : ''}>LSQ</option>
            <option value="HSQ" ${band.type === 'HSQ' ? 'selected' : ''}>HSQ</option>
          </select>
        </td>
        <td><input class="tbl-input" type="number" step="1" min="20" max="20000" data-field="freq" data-id="${band.id}" value="${Math.round(band.freq)}"></td>
        <td><input class="tbl-input ${isPos}" type="number" step="0.1" min="-20" max="20" data-field="gain" data-id="${band.id}" value="${band.gain.toFixed(1)}"></td>
        <td><input class="tbl-input" type="number" step="0.01" min="0.1" max="10" data-field="q" data-id="${band.id}" value="${band.q.toFixed(2)}"></td>
        <td><button class="tbl-del" data-id="${band.id}">✕</button></td>
      `;
      
      tr.addEventListener('mousedown', e => { 
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return; 
        selectedBandId = band.id; 
        document.querySelectorAll('.peq-row').forEach(r => {
          r.classList.toggle('selected-row', parseInt(r.dataset.id) === selectedBandId);
        }); 
        drawCurve(); 
        renderBandStrip(); 
      });

      tr.querySelectorAll('.tbl-input').forEach(inp => {
        let lastVal = inp.value; 
        const commit = () => { 
          if (inp.value === lastVal) return; 
          lastVal = inp.value; 
          const b = bands.find(x => x.id === parseInt(inp.dataset.id)); 
          if (!b) return; 
          
          let val = parseFloat(inp.value); 
          if (isNaN(val)) { 
            inp.value = lastVal; 
            return; 
          } 
          
          const field = inp.dataset.field; 
          if (field === 'freq') val = Math.max(20, Math.min(20000, Math.round(val))); 
          if (field === 'gain') val = Math.max(-20, Math.min(20, Math.round(val * 10) / 10)); 
          if (field === 'q') val = Math.max(0.1, Math.min(10, Math.round(val * 100) / 100)); 
          
          b[field] = val; 
          selectedBandId = b.id; 
          
          if (field === 'gain') {
            inp.className = 'tbl-input ' + (val > 0.05 ? 'gain-pos' : val < -0.05 ? 'gain-neg' : '');
          }
          syncEQ(); 
        };
        
        inp.addEventListener('input', commit); 
        inp.addEventListener('change', commit); 
        inp.addEventListener('keydown', e => { 
          if (e.key === 'Enter') inp.blur(); 
        });
      });

      tr.querySelector('.tbl-type').addEventListener('change', e => { 
        const b = bands.find(x => x.id === parseInt(e.target.dataset.id)); 
        if (b) { 
          b.type = e.target.value; 
          selectedBandId = b.id; 
          syncEQ(); 
        } 
      }); 

      tr.querySelector('.tbl-enabled').addEventListener('change', e => { 
        const b = bands.find(x => x.id === parseInt(e.target.dataset.id)); 
        if (b) { 
          b.enabled = e.target.checked; 
          syncEQ(); 
        } 
      }); 

      tr.querySelector('.tbl-del').addEventListener('click', () => { 
        bands = bands.filter(x => x.id !== band.id); 
        if (selectedBandId === band.id) {
          selectedBandId = bands.length ? bands[bands.length - 1].id : null; 
        }
        syncEQ(); 
        tr.remove(); 
      });

      tbody.appendChild(tr);
    });
  }

  function updateTableValues() { 
    const tbody = document.getElementById('peq-tbody'); 
    if (!tbody) return; 
    
    const rows = tbody.querySelectorAll('tr.peq-row'); 
    if (rows.length !== bands.length) { 
      renderTable(); 
      return; 
    } 
    
    rows.forEach((tr, i) => { 
      const band = bands[i]; 
      if (!band || parseInt(tr.dataset.id) !== band.id) { 
        renderTable(); 
        return; 
      } 
      
      tr.classList.toggle('selected-row', band.id === selectedBandId); 
      
      tr.querySelectorAll('.tbl-input').forEach(inp => { 
        if (document.activeElement === inp) return; 
        
        const field = inp.dataset.field; 
        const newVal = field === 'freq' ? String(Math.round(band.freq)) : field === 'gain' ? band.gain.toFixed(1) : band.q.toFixed(2); 
        
        if (inp.value !== newVal) {
          inp.value = newVal; 
        }
        
        if (field === 'gain') {
          inp.className = 'tbl-input ' + (band.gain > 0.05 ? 'gain-pos' : band.gain < -0.05 ? 'gain-neg' : ''); 
        }
      }); 
      
      const sel = tr.querySelector('.tbl-type'); 
      if (sel && sel.value !== band.type) {
        sel.value = band.type; 
      }
      
      const cb = tr.querySelector('.tbl-enabled'); 
      if (cb && cb.checked !== band.enabled) {
        cb.checked = band.enabled; 
      }
    }); 
  }

  // ── Simple / Tube Sliders ──────────────────────────────────────
  const SIMPLE_BANDS = [
    { id: 'subbass', label: 'Sub Bass', hz: '40-60 Hz', freq: 50, q: 0.7, type: 'PK' }, 
    { id: 'bass', label: 'Bass', hz: '100-150 Hz', freq: 120, q: 1.0, type: 'PK' }, 
    { id: 'warmth', label: 'Warmth', hz: '200-300 Hz', freq: 250, q: 1.0, type: 'PK' }, 
    { id: 'mids', label: 'Mids', hz: '800-1k Hz', freq: 900, q: 0.8, type: 'PK' }, 
    { id: 'presence', label: 'Presence', hz: '3-5 kHz', freq: 4000, q: 1.2, type: 'PK' }, 
    { id: 'treble', label: 'Treble', hz: '8-10 kHz', freq: 9000, q: 1.0, type: 'PK' }, 
    { id: 'air', label: 'Air', hz: '14-16 kHz', freq: 15000, q: 1.0, type: 'HSQ' }
  ];
  
  const simpleContainer = document.getElementById('simple-sliders-container');
  
  SIMPLE_BANDS.forEach(def => {
    simpleContainer.innerHTML += `
      <div class="slider-band">
        <div class="slider-band-label">
          <div class="slider-band-name">${def.label}</div>
          <div class="slider-band-hz">${def.hz}</div>
        </div>
        <input class="simple-slider" type="range" id="ss-${def.id}" min="-12" max="12" step="0.5" value="0">
        <div class="simple-slider-val" id="sv-${def.id}">0.0 dB</div>
      </div>
    `;
  });

  function getSimpleBand(sid) { 
    return bands.find(b => b.__simpleId === sid); 
  }

  function updateSimpleSliders() { 
    SIMPLE_BANDS.forEach(def => { 
      const slider = document.getElementById('ss-' + def.id); 
      const valEl = document.getElementById('sv-' + def.id); 
      
      if (!slider || !valEl) return; 
      
      const b = getSimpleBand(def.id); 
      const gain = b ? b.gain : 0; 
      
      if (parseFloat(slider.value) !== gain) {
        slider.value = gain; 
      }
      
      valEl.textContent = (gain >= 0 ? '+' : '') + gain.toFixed(1) + ' dB'; 
      valEl.className = 'simple-slider-val' + (gain > 0 ? ' pos' : gain < 0 ? ' neg' : ''); 
      
      const val = ((gain + 12) / 24) * 100; 
      slider.style.background = `linear-gradient(to right, var(--accent2) ${val}%, var(--bg4) ${val}%)`; 
    }); 
  }

  SIMPLE_BANDS.forEach(def => {
    const slider = document.getElementById('ss-' + def.id);
    const valEl = document.getElementById('sv-' + def.id); 
    
    if (!slider) return;
    
    slider.addEventListener('input', () => {
      const gain = parseFloat(slider.value); 
      valEl.textContent = (gain >= 0 ? '+' : '') + gain.toFixed(1) + ' dB'; 
      valEl.className = 'simple-slider-val' + (gain > 0 ? ' pos' : gain < 0 ? ' neg' : '');
      
      let percent = ((gain + 12) / 24) * 100;
      slider.style.background = `linear-gradient(to right, var(--accent2) ${percent}%, var(--bg4) ${percent}%)`;
      
      if (gain === 0) { 
        const b = getSimpleBand(def.id); 
        if (b) bands = bands.filter(x => x !== b); 
      } else { 
        let b = getSimpleBand(def.id); 
        if(!b) { 
          b = { 
            id: nextBandId++, 
            type: def.type, 
            freq: def.freq, 
            gain: 0, 
            q: def.q, 
            enabled: true, 
            __simpleId: def.id 
          }; 
          bands.push(b); 
        } 
        b.gain = gain; 
      } 
      syncEQ();
    });
  });

  // RESTORED: Simple View Reset All Button
  document.getElementById('btn-simple-reset').addEventListener('click', () => {
    SIMPLE_BANDS.forEach(def => {
      const slider = document.getElementById('ss-' + def.id);
      const valEl = document.getElementById('sv-' + def.id);
      
      if (slider) {
        slider.value = 0;
        slider.style.background = 'var(--bg4)';
      }
      if (valEl) {
        valEl.textContent = '0.0 dB';
        valEl.className = 'simple-slider-val';
      }
    });
    
    bands = bands.filter(b => !b.__simpleId);
    syncEQ();
  });

  document.getElementById('ss-tube').addEventListener('input', e => { 
    tubeDrive = parseFloat(e.target.value); 
    document.getElementById('sv-tube').textContent = tubeDrive + '%'; 
    e.target.style.background = `linear-gradient(to right, #f9a8a8 ${tubeDrive}%, var(--bg4) ${tubeDrive}%)`; 
    updateAudioGraph(); 
  });

  // ── Shortcuts ────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      return;
    }
    
    if (e.code === 'Space') { 
      e.preventDefault(); 
      togglePlay(); 
    }
    
    if (e.code === 'ArrowRight') { 
      if(audioEl.duration) {
        audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + 10); 
      }
    }
    
    if (e.code === 'ArrowLeft') { 
      if(audioEl.duration) {
        audioEl.currentTime = Math.max(0, audioEl.currentTime - 10); 
      }
    }
    
    if (e.code === 'ArrowUp') { 
      volSlider.value = Math.min(1.5, parseFloat(volSlider.value) + 0.05); 
      if (makeupNode) {
        makeupNode.gain.value = parseFloat(volSlider.value); 
      }
      updateSliderFill(volSlider, 'var(--text)'); 
    }
    
    if (e.code === 'ArrowDown') { 
      volSlider.value = Math.max(0, parseFloat(volSlider.value) - 0.05); 
      if (makeupNode) {
        makeupNode.gain.value = parseFloat(volSlider.value); 
      }
      updateSliderFill(volSlider, 'var(--text)'); 
    }
    
    if ((e.code === 'Backspace' || e.code === 'Delete') && selectedBandId !== null) { 
      bands = bands.filter(b => b.id !== selectedBandId); 
      selectedBandId = bands.length ? bands[bands.length - 1].id : null; 
      syncEQ(); 
    }
  });

  new ResizeObserver(resizeCanvas).observe(document.getElementById('eq-canvas-wrap'));
  
  updateSimpleSliders(); 
  document.getElementById('ss-tube').style.background = `linear-gradient(to right, #f9a8a8 0%, var(--bg4) 0%)`;
  
  resizeCanvas(); 
  loadLibrary(); 
  restorePersistedHandles(); 
  
})();