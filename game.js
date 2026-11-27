(() => {
    'use strict';

    const PLAYERS_PER_TEAM = 11;

    // ==========================================
    // 1. WEB AUDIO SOUND ENGINE
    // ==========================================
    const SoundFX = (() => {
        let ctx = null;
        let muted = false;

        function ensureCtx() {
            if (!ctx) {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (AudioCtx) ctx = new AudioCtx();
            }
            if (ctx && ctx.state === 'suspended') ctx.resume();
            return ctx;
        }

        function playTone(freq, endFreq, duration, type = 'sine', gainVal = 0.2) {
            if (muted) return;
            const c = ensureCtx();
            if (!c) return;
            const osc = c.createOscillator();
            const gain = c.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, c.currentTime);
            if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, c.currentTime + duration);

            gain.gain.setValueAtTime(gainVal, c.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);

            osc.connect(gain);
            gain.connect(c.destination);
            osc.start();
            osc.stop(c.currentTime + duration);
        }

        function playNoise(duration, filterFreq, filterType = 'bandpass', gainVal = 0.25) {
            if (muted) return;
            const c = ensureCtx();
            if (!c) return;
            const bufferSize = c.sampleRate * duration;
            const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

            const noise = c.createBufferSource();
            noise.buffer = buffer;

            const filter = c.createBiquadFilter();
            filter.type = filterType;
            filter.frequency.setValueAtTime(filterFreq, c.currentTime);

            const gain = c.createGain();
            gain.gain.setValueAtTime(gainVal, c.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);

            noise.connect(filter);
            filter.connect(gain);
            gain.connect(c.destination);
            noise.start();
        }

        return {
            toggleMute() { muted = !muted; return muted; },
            click() { playTone(600, 400, 0.05, 'triangle', 0.08); },
            step() { playTone(220, 180, 0.04, 'sine', 0.06); },
            bowlWhoosh() { playNoise(0.25, 900, 'bandpass', 0.12); },
            pitchBounce() { playTone(160, 75, 0.09, 'sine', 0.22); },
            batDefend() {
                playTone(260, 120, 0.08, 'triangle', 0.2);
                playNoise(0.05, 1200, 'highpass', 0.1);
            },
            batCrack(power = 1) {
                playTone(420 * power, 130, 0.12, 'triangle', 0.35);
                playNoise(0.09, 2400, 'bandpass', 0.3);
            },
            stumpsShatter() {
                playNoise(0.35, 1800, 'highpass', 0.35);
                playTone(320, 90, 0.22, 'sawtooth', 0.25);
                setTimeout(() => playTone(240, 70, 0.2, 'square', 0.2), 80);
            },
            crowdRoar(big = false) {
                const dur = big ? 1.8 : 1.1;
                playNoise(dur, 650, 'lowpass', big ? 0.32 : 0.18);
                if (big) playTone(523.25, 659.25, 0.3, 'triangle', 0.12);
            }
        };
    })();

    // ==========================================
    // 2. GAME STATE
    // ==========================================
    const state = {
        maxOvers: 5,
        mode: 'ai',
        difficulty: 'normal',
        role: 'host',
        innings: 1,
        battingSide: 'p1',
        target: null,
        p1: { score: 0, wickets: 0, balls: 0 },
        p2: { score: 0, wickets: 0, balls: 0 },
        activeDelivery: null,
        ballInFlight: false,
        shotTaken: false,
        flightProgress: 0,
        flightAnimId: null,
        peer: null,
        conn: null,
        cameraMode: 'batter',
        fieldPreset: 'balanced',
        field: [],
        pendingRun: null,
        runTimer: null,
        deliveryId: 0,
        runUpTimers: [],
        replayFrames: [],
        replaying: false,
        freeHit: false,
        powerplay: false,
        extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
        tossDone: false,
        strikerIdx: 0,
        nonStrikerIdx: 1,
        nextBatterIdx: 2,
        currentBowlerIdx: 0,
        lastBowlerIdx: -1,
        overRuns: [],
        wagonShots: [],
        aiMemory: { shotTypes: {}, dirs: {}, guards: {}, footwork: {}, bowlLines: {}, bowlLengths: {}, bowlVars: {}, boundaries: 0, ballsFaced: 0 },
        inningsData: null
    };

    const $ = (id) => document.getElementById(id);

    // ==========================================
    // 3. VISUAL CREASE POSITIONING (Batter & Bowler)
    // ==========================================
    function updateVisualPositions() {
        // Batter — behind-top view. Guard = smooth lateral shuffle, depth = up/down the pitch.
        // Off = left (-28px), Leg = right (+28px). CSS transition on transform makes it glide.
        const guard = getActiveVal('batterGuardGroup'); // 'off' | 'middle' | 'leg'
        const depth = getActiveVal('footworkGroup');    // 'advance' | 'crease' | 'back'
        const batEl = $('batsman');
        const batX = guard === 'off' ? -28 : guard === 'leg' ? 28 : 0;
        const batY = depth === 'advance' ? -18 : depth === 'back' ? 14 : 0;
        batEl.style.setProperty('--batter-x', `${batX}px`);
        batEl.style.setProperty('--batter-y', `${batY}px`);

        // Bowler — far end, behind his wicket. Wide = far left, Round = far right.
        const angle = getActiveVal('bowlAngleGroup'); // 'over' | 'wide' | 'round'
        const bowlEl = $('bowlerEnd');
        const bowlX = angle === 'wide' ? -26 : angle === 'round' ? 26 : -8;
        bowlEl.style.setProperty('--bowler-x', `${bowlX}px`);
    }

    // ==========================================
    // 2b. REAL PLAYERS — 11 per side, with timing / power / bowling skill
    // ==========================================
    function makePlayer(name, timing, power, bowlType, bowlSkill) {
        return { name, timing, power, bowlType, bowlSkill,
            batRuns: 0, batBalls: 0, fours: 0, sixes: 0, outHow: null, out: false,
            bowlBalls: 0, bowlRuns: 0, bowlWkts: 0, oversBowled: 0, fatigue: 0 };
    }
    const SQUADS = {
        p1: [
            makePlayer('A. Perera', 88, 82, 'pace', 62), makePlayer('K. Mendis', 85, 78, 'spin', 68),
            makePlayer('D. Silva', 80, 85, 'pace', 58), makePlayer('S. Fernando', 78, 80, 'medium', 60),
            makePlayer('R. Jayawardene', 75, 72, 'spin', 74), makePlayer('T. Kumara', 68, 88, 'pace', 82),
            makePlayer('M. Herath', 65, 70, 'spin', 78), makePlayer('L. Sandakan', 55, 60, 'spin', 80),
            makePlayer('C. Rajapaksa', 50, 65, 'medium', 66), makePlayer('P. Wickramasinghe', 45, 55, 'pace', 70),
            makePlayer('H. Bandara', 40, 50, 'medium', 55)
        ],
        p2: [
            makePlayer('N. Perera', 86, 80, 'pace', 64), makePlayer('B. Rajapaksa', 84, 83, 'spin', 62),
            makePlayer('C. Asalanka', 82, 86, 'medium', 58), makePlayer('D. de Silva', 79, 81, 'pace', 66),
            makePlayer('W. Hasaranga', 76, 84, 'spin', 84), makePlayer('M. Theekshana', 70, 72, 'spin', 82),
            makePlayer('D. Chameera', 64, 78, 'pace', 80), makePlayer('L. Kumara', 58, 66, 'pace', 78),
            makePlayer('P. Nissanka', 52, 60, 'medium', 60), makePlayer('K. Karunaratne', 46, 54, 'pace', 68),
            makePlayer('S. Lakmal', 42, 48, 'medium', 62)
        ]
    };
    function freshSquads() {
        const copy = {};
        Object.keys(SQUADS).forEach(k => { copy[k] = SQUADS[k].map(pl => makePlayer(pl.name, pl.timing, pl.power, pl.bowlType, pl.bowlSkill)); });
        return copy;
    }
    function maxBowlerOvers() { return Math.max(1, Math.floor(state.maxOvers / 5)); }
    function currentStriker() {
        const squad = state.inningsData ? state.inningsData.batting : [];
        return squad[state.strikerIdx] || null;
    }
    function currentNonStriker() {
        const squad = state.inningsData ? state.inningsData.batting : [];
        return squad[state.nonStrikerIdx] || null;
    }
    function currentBowler() {
        const squad = state.inningsData ? state.inningsData.bowling : [];
        return squad[state.currentBowlerIdx] || null;
    }
    function bowlerAvailable(idx) {
        const squad = state.inningsData ? state.inningsData.bowling : [];
        const b = squad[idx];
        if (!b) return false;
        if (idx === state.lastBowlerIdx) return false; // cannot bowl 2 overs in a row
        if (b.oversBowled >= maxBowlerOvers()) return false;
        return true;
    }
    function updatePlayersStrip() {
        const st = currentStriker(), ns = currentNonStriker(), bw = currentBowler();
        const si = $('strikerInfo'), ni = $('nonStrikerInfo'), bi = $('bowlerInfo'), ei = $('extrasInfo');
        if (si) si.innerHTML = st ? `Striker: <b>${st.name}</b> ${st.batRuns} (${st.batBalls}) • timing ${st.timing}` : 'Striker: —';
        if (ni) ni.innerHTML = ns ? `Non-striker: <b>${ns.name}</b> ${ns.batRuns} (${ns.batBalls})` : 'Non-striker: —';
        if (bi) {
            const fat = bw ? Math.round(bw.fatigue * 100) : 0;
            bi.innerHTML = bw ? `Bowler: <b>${bw.name}</b> ${bw.bowlWkts}/${bw.bowlRuns} • ${bw.bowlType} • fatigue ${fat}%` : 'Bowler: —';
        }
        if (ei) ei.textContent = `Extras: ${state.extras.wides + state.extras.noBalls + state.extras.byes + state.extras.legByes} (wd ${state.extras.wides}, nb ${state.extras.noBalls}, b ${state.extras.byes}, lb ${state.extras.legByes})`;
        const fh = $('freeHitBadge');
        if (fh) fh.style.display = state.freeHit ? 'inline-block' : 'none';
        const pp = $('powerplayBadge');
        if (pp) pp.style.display = state.powerplay ? 'inline-block' : 'none';
        const ml = $('maxBowlerOversLabel');
        if (ml) ml.textContent = String(maxBowlerOvers());
    }
    function renderBowlerSelect() {
        const group = $('bowlerSelectGroup');
        if (!group || !state.inningsData) return;
        group.innerHTML = '';
        state.inningsData.bowling.forEach((b, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'opt-btn' + (i === state.currentBowlerIdx ? ' active' : '');
            btn.textContent = `${b.name} • ${b.bowlType} ${b.bowlSkill} • ${b.oversBowled}/${maxBowlerOvers()} ov`;
            btn.disabled = !bowlerAvailable(i) && i !== state.currentBowlerIdx;
            if (btn.disabled) btn.style.opacity = '0.4';
            btn.addEventListener('click', () => {
                if (!bowlerAvailable(i)) return;
                state.currentBowlerIdx = i;
                SoundFX.click();
                renderBowlerSelect();
                updatePlayersStrip();
                const fi = $('bowlerFatigueInfo');
                if (fi) fi.textContent = `${b.name} selected — fatigue ${Math.round(b.fatigue * 100)}%. Fresh bowlers are faster and more accurate.`;
            });
            group.appendChild(btn);
        });
    }
    function startInningsData(battingSide) {
        const battingKey = battingSide;
        const bowlingKey = battingSide === 'p1' ? 'p2' : 'p1';
        state.inningsData = {
            batting: state._squads[battingKey],
            bowling: state._squads[bowlingKey],
            battingSide
        };
        state.strikerIdx = 0; state.nonStrikerIdx = 1; state.nextBatterIdx = 2;
        state.currentBowlerIdx = 0; state.lastBowlerIdx = -1;
        state.overRuns = []; state.wagonShots = []; state.currentOverRuns = 0;
        state.extras = { wides: 0, noBalls: 0, byes: 0, legByes: 0 };
        state.freeHit = false;
        updatePowerplay();
        renderBowlerSelect();
        updatePlayersStrip();
    }
    function updatePowerplay() {
        const team = state[state.battingSide];
        const oversDone = Math.floor((team ? team.balls : 0) / 6);
        // Powerplay = first 20% of overs (min 1 over)
        state.powerplay = oversDone < Math.max(1, Math.round(state.maxOvers * 0.2));
    }
    function swapStrike() {
        const t = state.strikerIdx; state.strikerIdx = state.nonStrikerIdx; state.nonStrikerIdx = t;
        updatePlayersStrip();
    }
    function nextBatterIn() {
        const squad = state.inningsData ? state.inningsData.batting : [];
        if (state.nextBatterIdx >= squad.length) return null;
        state.strikerIdx = state.nextBatterIdx;
        state.nextBatterIdx += 1;
        const b = squad[state.strikerIdx];
        if (b) addLog(`New batter: ${b.name} (timing ${b.timing}, power ${b.power})`);
        updatePlayersStrip();
        return b;
    }

    // ==========================================
    // 3a. FIELD PLACEMENTS — 9 fielders, x/y in % of the pitch box
    // y: 0 = bowler end (top), 100 = batter end (bottom). x: 0 = off side (left), 100 = leg side (right)
    // ==========================================
    const FIELD_PRESETS = {
        attacking: [
            { id: 'slip', name: 'Slip', short: 'SLIP', x: 38, y: 76 },
            { id: 'gully', name: 'Gully', short: 'GULLY', x: 28, y: 68 },
            { id: 'point', name: 'Point', short: 'POINT', x: 20, y: 58 },
            { id: 'cover', name: 'Cover', short: 'COVER', x: 28, y: 38 },
            { id: 'midoff', name: 'Mid-off', short: 'MID-OFF', x: 42, y: 26 },
            { id: 'midon', name: 'Mid-on', short: 'MID-ON', x: 58, y: 26 },
            { id: 'squareleg', name: 'Square Leg', short: 'SQ LEG', x: 76, y: 58 },
            { id: 'fineleg', name: 'Fine Leg', short: 'FINE', x: 74, y: 84 },
            { id: 'shortleg', name: 'Short Leg', short: 'S-LEG', x: 62, y: 70 }
        ],
        balanced: [
            { id: 'slip', name: 'Slip', short: 'SLIP', x: 38, y: 76 },
            { id: 'point', name: 'Point', short: 'POINT', x: 18, y: 54 },
            { id: 'cover', name: 'Cover', short: 'COVER', x: 26, y: 36 },
            { id: 'midoff', name: 'Mid-off', short: 'MID-OFF', x: 40, y: 24 },
            { id: 'midon', name: 'Mid-on', short: 'MID-ON', x: 60, y: 24 },
            { id: 'squareleg', name: 'Square Leg', short: 'SQ LEG', x: 78, y: 54 },
            { id: 'fineleg', name: 'Fine Leg', short: 'FINE', x: 76, y: 86 },
            { id: 'longon', name: 'Long-on', short: 'LONG-ON', x: 62, y: 12 },
            { id: 'longoff', name: 'Long-off', short: 'LONG-OFF', x: 38, y: 12 }
        ],
        defensive: [
            { id: 'deeppoint', name: 'Deep Point', short: 'D-POINT', x: 12, y: 48 },
            { id: 'deepcover', name: 'Deep Cover', short: 'D-COVER', x: 20, y: 26 },
            { id: 'longoff', name: 'Long-off', short: 'LONG-OFF', x: 38, y: 8 },
            { id: 'longon', name: 'Long-on', short: 'LONG-ON', x: 62, y: 8 },
            { id: 'deepmidwicket', name: 'Deep Mid-wicket', short: 'D-MID', x: 78, y: 28 },
            { id: 'deepsquare', name: 'Deep Square', short: 'D-SQ', x: 84, y: 52 },
            { id: 'deepfine', name: 'Deep Fine Leg', short: 'D-FINE', x: 82, y: 88 },
            { id: 'thirdman', name: 'Third Man', short: '3RD MAN', x: 18, y: 88 },
            { id: 'midoff', name: 'Mid-off', short: 'MID-OFF', x: 42, y: 30 }
        ]
    };
    function cloneField(preset) {
        return FIELD_PRESETS[preset].map(f => ({ ...f, deep: false, homeX: f.x, homeY: f.y }));
    }
    function renderFielders() {
        const box = $('fielders');
        if (!box) return;
        box.innerHTML = '';
        state.field.forEach(f => {
            const el = document.createElement('div');
            el.className = 'fielder' + (f.y < 35 ? ' far' : f.y > 75 ? ' near' : '');
            el.dataset.id = f.id;
            el.style.left = `${f.x}%`;
            el.style.top = `${f.y}%`;
            el.title = `${f.name} — click to move in / out`;
            el.innerHTML = `<span class="fielder-head"></span><span class="fielder-body"></span><span class="fielder-label">${f.short}</span>`;
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                SoundFX.click();
                nudgeFielder(f.id);
            });
            box.appendChild(el);
        });
    }
    function setFieldPreset(name) {
        if (!FIELD_PRESETS[name]) return;
        state.fieldPreset = name;
        state.field = cloneField(name);
        renderFielders();
        const status = $('fieldStatus');
        if (status) status.textContent = `Field: ${name[0].toUpperCase() + name.slice(1)} — 9 fielders set. Click a fielder to move him in / out.`;
        const group = $('fieldPresetGroup');
        if (group) group.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === name));
    }
    function nudgeFielder(id) {
        const f = state.field.find(x => x.id === id);
        if (!f) return;
        // Toggle in <-> out. Out = further from the batter, wider from the centre.
        if (!f.deep) {
            f.deep = true;
            f.x = Math.max(8, Math.min(92, 50 + (f.x - 50) * 1.3));
            f.y = Math.max(5, f.y - 16);
        } else {
            f.deep = false;
            f.x = f.homeX; f.y = f.homeY;
        }
        const el = document.querySelector(`.fielder[data-id="${id}"]`);
        if (el) { el.style.left = `${f.x}%`; el.style.top = `${f.y}%`; }
        const status = $('fieldStatus');
        if (status) status.textContent = `Field: ${state.fieldPreset} — ${f.name} moved ${f.deep ? 'out (deeper)' : 'back in'}.`;
    }
    function nearestFielder(x, y) {
        let best = null, bestDist = Infinity;
        state.field.forEach(f => {
            const dx = f.x - x, dy = (f.y - y) * 1.15;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < bestDist) { bestDist = d; best = f; }
        });
        return { fielder: best, dist: bestDist };
    }
    function computeLanding(shot, delivery) {
        // Where the ball ends up after the shot, in pitch-box %.
        // Straight = back past the bowler (top), Off = left, Leg = right.
        const baseX = shot.dir === 'off' ? 20 : shot.dir === 'leg' ? 80 : 50;
        const power = shot.timing === 'perfect' ? 1.25 : shot.timing === 'good' ? 1 : 0.75;
        let x = baseX, y = 45;
        if (shot.type === 'loft') { x = baseX; y = 6; }
        else if (shot.type === 'ground') { y = 32 / power; x = baseX + (shot.dir === 'straight' ? 0 : (baseX - 50) * 0.2); }
        else if (shot.type === 'cutpull') { x = shot.dir === 'leg' ? 86 : 14; y = 55; }
        else if (shot.type === 'sweep') { x = 86; y = 62; }
        else if (shot.type === 'defend') { x = 50; y = 78; }
        return { x: Math.max(6, Math.min(94, x)), y: Math.max(4, Math.min(92, y)) };
    }

    // ==========================================
    // 3a. PERSPECTIVE CAMERA + SMOOTH PLAYER ANIMATION
    // ==========================================
    const CAMERA_LABELS = {
        bowler: '\uD83D\uDCF7 Behind Bowler \u2014 from behind the bowling wicket',
        batter: '\uD83D\uDCF7 Behind Batter \u2014 top view',
        broadcast: '\uD83D\uDCFA Broadcast \u2014 whole pitch'
    };
    function setCamera(mode) {
        const pitch = $('pitch');
        if (!pitch) return;
        state.cameraMode = mode;
        pitch.classList.remove('cam-bowler', 'cam-batter', 'cam-broadcast');
        pitch.classList.add(`cam-${mode}`);
        document.querySelectorAll('.cam-btn').forEach(b => b.classList.toggle('active', b.dataset.cam === mode));
        const label = $('cameraLabel');
        if (label) label.textContent = CAMERA_LABELS[mode] || '';
    }
    function playBowlerRunUp(onRelease) {
        const fig = $('bowlerFigure');
        const myId = state.deliveryId;
        const tracked = (fn, ms) => { const id = setTimeout(() => { if (myId !== state.deliveryId) return; fn(); }, ms); state.runUpTimers.push(id); };
        if (!fig) { onRelease(); return; }
        fig.classList.remove('delivering', 'follow-through');
        void fig.offsetWidth;
        fig.classList.add('running');
        setCamera('bowler');
        tracked(() => {
            fig.classList.remove('running');
            fig.classList.add('delivering');
            SoundFX.bowlWhoosh();
            tracked(() => {
                fig.classList.remove('delivering');
                fig.classList.add('follow-through');
                setCamera('batter');
                onRelease();
                tracked(() => fig.classList.remove('follow-through'), 950);
            }, 300);
        }, 620);
    }
    function playBatterShotAnimation(type) {
        const fig = $('batterFigure');
        if (!fig) return;
        const map = { defend: 'defend', ground: 'ground', cutpull: 'cutpull', sweep: 'sweep', loft: 'loft' };
        const anim = map[type];
        if (!anim) return;
        fig.classList.remove('anim-defend', 'anim-ground', 'anim-cutpull', 'anim-sweep', 'anim-loft');
        void fig.offsetWidth; // force reflow so the same shot can replay smoothly
        fig.classList.add(`anim-${anim}`);
        setTimeout(() => fig.classList.remove(`anim-${anim}`), 680);
    }
    function resetPlayers() {
        const bowler = $('bowlerFigure');
        if (bowler) bowler.classList.remove('running', 'delivering', 'follow-through');
        const batter = $('batterFigure');
        if (batter) batter.classList.remove('anim-defend', 'anim-ground', 'anim-cutpull', 'anim-sweep', 'anim-loft');
    }


    function getLengthCategory(val) {
        const n = Number(val);
        if (n >= 76) return 'yorker';
        if (n >= 62) return 'full';
        if (n >= 40) return 'good';
        return 'short';
    }

    function getLengthLabel(val) {
        const cat = getLengthCategory(val);
        return cat === 'yorker' ? 'Yorker' :
               cat === 'full' ? 'Full / Half-Volley' :
               cat === 'good' ? 'Good Length' : 'Short / Bouncer';
    }

    // ==========================================
    // 4. UI BINDINGS & KEYBOARD CREASE CONTROLS
    // ==========================================
    function bindGroup(groupId, callback) {
        const group = $(groupId);
        if (!group) return;
        group.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                SoundFX.click();
                group.querySelectorAll('button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                updateVisualPositions();
                if (callback) callback(btn.dataset);
            });
        });
    }

    function selectButtonByVal(groupId, val) {
        const group = $(groupId);
        if (!group) return;
        group.querySelectorAll('button').forEach(b => {
            b.classList.toggle('active', b.dataset.val === val);
        });
        updateVisualPositions();
    }

    bindGroup('oversSelect', (d) => { state.maxOvers = Number(d.overs); });
    bindGroup('difficultySelect', (d) => { state.difficulty = d.diff; });
    bindGroup('modeSelect', (d) => {
        state.mode = d.mode;
        $('aiSetupPanel').style.display = d.mode === 'ai' ? 'block' : 'none';
        $('onlineSetupPanel').style.display = d.mode === 'online' ? 'block' : 'none';
    });

    bindGroup('batterGuardGroup');
    bindGroup('footworkGroup');
    bindGroup('shotTypeGroup');
    bindGroup('shotDirGroup');
    bindGroup('bowlAngleGroup');
    bindGroup('bowlLineGroup');
    bindGroup('bowlVarGroup');
    bindGroup('fieldPresetGroup', (d) => setFieldPreset(d.val));
    document.querySelectorAll('.run-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            SoundFX.click();
            chooseRuns(Number(btn.dataset.runs));
        });
    });

    // Camera buttons: Behind Bowler / Behind Batter / Broadcast
    document.querySelectorAll('.cam-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            SoundFX.click();
            setCamera(btn.dataset.cam);
        });
    });

    $('bowlLengthSlider').addEventListener('input', (e) => {
        $('lengthLabel').textContent = getLengthLabel(e.target.value);
    });

    $('bowlSpeedSlider').addEventListener('input', (e) => {
        $('paceVal').textContent = e.target.value;
    });

    $('soundToggleBtn').addEventListener('click', () => {
        const isMuted = SoundFX.toggleMute();
        $('soundToggleBtn').textContent = isMuted ? '🔇 SFX: OFF' : '🔊 SFX: ON';
        $('soundToggleBtn').classList.toggle('muted', isMuted);
    });

    // Live Keyboard Controls (Move around crease with WASD + Shot keys 1-5 + Arrows + Space)
    document.addEventListener('keydown', (e) => {
        if (!$('gameScreen').classList.contains('active')) return;
        if (!isLocalBatting()) return;

        const key = e.key.toLowerCase();

        // Lateral Crease Shuffle (A = Off stump, D = Leg stump / Room)
        if (key === 'a') {
            const cur = getActiveVal('batterGuardGroup');
            selectButtonByVal('batterGuardGroup', cur === 'leg' ? 'middle' : 'off');
            SoundFX.step();
        }
        if (key === 'd') {
            const cur = getActiveVal('batterGuardGroup');
            selectButtonByVal('batterGuardGroup', cur === 'off' ? 'middle' : 'leg');
            SoundFX.step();
        }

        // Depth in Crease (W = Advance down pitch, S = Deep back in crease)
        if (key === 'w') {
            const cur = getActiveVal('footworkGroup');
            selectButtonByVal('footworkGroup', cur === 'back' ? 'crease' : 'advance');
            SoundFX.step();
        }
        if (key === 's') {
            const cur = getActiveVal('footworkGroup');
            selectButtonByVal('footworkGroup', cur === 'advance' ? 'crease' : 'back');
            SoundFX.step();
        }

        // Shot type shortcuts (1-5)
        const shotKeys = { '1': 'defend', '2': 'ground', '3': 'cutpull', '4': 'sweep', '5': 'loft' };
        if (shotKeys[e.key]) {
            selectButtonByVal('shotTypeGroup', shotKeys[e.key]);
            SoundFX.click();
        }

        // Placement shortcuts
        if (e.key === 'ArrowLeft') { selectButtonByVal('shotDirGroup', 'off'); SoundFX.click(); }
        if (e.key === 'ArrowUp') { selectButtonByVal('shotDirGroup', 'straight'); SoundFX.click(); }
        if (e.key === 'ArrowRight') { selectButtonByVal('shotDirGroup', 'leg'); SoundFX.click(); }

        // Running choice by keyboard: 1 / 2 / 3 / 0 while the running panel is open
        if ($('runningPanel') && $('runningPanel').style.display !== 'none' && state.pendingRun) {
            if (['1', '2', '3'].includes(e.key)) { chooseRuns(Number(e.key)); return; }
            if (e.key === '0') { chooseRuns(0); return; }
        }
        if (e.key.toLowerCase() === 'r' && !state.ballInFlight) { replayLastBall(); return; }

        // Swing Bat
        if (e.code === 'Space' && state.ballInFlight && !state.shotTaken) {
            e.preventDefault();
            triggerBatterSwing();
        }
    });

    function getActiveVal(groupId) {
        const group = $(groupId);
        if (!group) return '';
        const active = group.querySelector('.active');
        return active ? active.dataset.val : '';
    }
    function clearAllTimers() {
        // Audit fix: run-up / running / replay timers used to fire after Restart or a new ball.
        state.runUpTimers.forEach(id => clearTimeout(id));
        state.runUpTimers = [];
        if (state.runTimer) { clearTimeout(state.runTimer); state.runTimer = null; }
        if (state.flightAnimId) cancelAnimationFrame(state.flightAnimId);
        state.flightAnimId = null;
        state.ballInFlight = false;
        state.pendingRun = null;
    }

    function showScreen(screenId) {
        ['startScreen', 'gameScreen', 'resultScreen'].forEach(id => {
            $(id).classList.toggle('active', id === screenId);
        });
    }

    function formatOvers(balls) {
        return `${Math.floor(balls / 6)}.${balls % 6} / ${state.maxOvers} overs`;
    }

    function addLog(text, type = '') {
        const div = document.createElement('div');
        div.className = `log-entry ${type}`;
        div.textContent = text;
        const logBox = $('gameLog');
        logBox.insertBefore(div, logBox.firstChild);
    }

    function updateScoreboard() {
        $('p1Score').textContent = state.p1.score;
        $('p1Wickets').textContent = state.p1.wickets;
        $('p1Overs').textContent = formatOvers(state.p1.balls);

        $('p2Score').textContent = state.p2.score;
        $('p2Wickets').textContent = state.p2.wickets;
        $('p2Overs').textContent = formatOvers(state.p2.balls);

        $('p1Card').classList.toggle('active-turn', state.battingSide === 'p1');
        $('p2Card').classList.toggle('active-turn', state.battingSide === 'p2');

        if (state.target !== null) {
            $('targetBadge').style.display = 'inline-block';
            const chasing = state[state.battingSide];
            const runsNeeded = Math.max(0, state.target - chasing.score);
            const ballsLeft = Math.max(0, (state.maxOvers * 6) - chasing.balls);
            $('targetBadge').textContent = `Target: ${state.target} (Need ${runsNeeded} off ${ballsLeft}b)`;
        } else {
            $('targetBadge').style.display = 'none';
        }
    }

    // ==========================================
    // 5. REAL-TIME ANGLED BALL FLIGHT ENGINE
    // ==========================================
    function getTimingFromProgress(pct, depth) {
        // Advancing down the pitch meets the ball earlier (64%-79%), staying deep meets it later (78%-93%)
        // Better batters get a wider sweet spot; tail-enders get a narrower one.
        const st = currentStriker();
        const sweetWidth = st ? Math.max(10, Math.min(22, 15 + (st.timing - 70) * 0.18)) : 15;
        const sweetMin = depth === 'advance' ? 64 : depth === 'back' ? 78 : 72;
        const sweetMax = sweetMin + sweetWidth;

        if (pct >= sweetMin && pct <= sweetMax) return 'perfect';
        if ((pct >= sweetMin - 16 && pct < sweetMin) || (pct > sweetMax && pct <= sweetMax + 10)) return 'good';
        return pct < sweetMin ? 'early' : 'late';
    }

    function launchBallFlight(delivery, aiBatterShot = null) {
        if (state.flightAnimId) cancelAnimationFrame(state.flightAnimId);
        state.deliveryId += 1;
        state.replayFrames = [];
        const _rb0 = $('replayBtn'); if (_rb0) _rb0.disabled = true;
        state.replaying = false;

        // --- Extras decision (host decides, guest reuses delivery.extra) ---
        if (delivery.extra === undefined) {
            const wideChance = (delivery.line === 'off' && delivery.angle === 'wide') ? 0.30 : (delivery.line === 'leg' && delivery.angle === 'round') ? 0.20 : 0.04;
            const r = Math.random();
            if (r < wideChance) delivery.extra = 'wide';
            else if (r < wideChance + (delivery.speed >= 150 ? 0.12 : 0.05)) delivery.extra = 'noball';
            else delivery.extra = null;
            // Fatigue: a tired bowler loses pace and is more likely to stray
            const bw0 = currentBowler();
            if (bw0 && bw0.fatigue > 0.3) delivery.speed = Math.max(85, Math.round(delivery.speed - bw0.fatigue * 12));
        }
        state.activeDelivery = delivery;
        state.ballInFlight = true;
        state.shotTaken = false;
        state.flightProgress = 0;

        // Bowler lateral start (old top-% values become horizontal offsets in perspective)
        const startY = delivery.angle === 'wide' ? 22 : delivery.angle === 'round' ? 72 : 36;
        const startX = 50 + (startY - 50) * 0.28;
        $('bowlerEnd').style.setProperty('--bowler-x', `${delivery.angle === 'wide' ? -26 : delivery.angle === 'round' ? 26 : -8}px`);

        // Telemetry display
        $('telAngle').textContent = delivery.angle.toUpperCase();
        $('telSpeed').textContent = delivery.speed;
        $('telLine').textContent = delivery.line.toUpperCase();
        $('telLength').textContent = getLengthLabel(delivery.lengthVal).toUpperCase();
        $('telMove').textContent = delivery.variation.toUpperCase();

        // Bounce marker — now along the vertical pitch.
        // Short bounces early (near the bowler, ~40% down), yorker bounces late (near the batter, ~75%).
        const marker = $('pitchMarker');
        const bounceTop = 34 + (Number(delivery.lengthVal) * 0.44);
        const targetY = delivery.line === 'off' ? 28 : delivery.line === 'leg' ? 72 : 50;
        let targetX = 50 + (targetY - 50) * 0.32;
        if (delivery.extra === 'wide') targetX = delivery.line === 'leg' ? 94 : 6;
        marker.style.top = `${bounceTop}%`;
        marker.style.left = `${targetX}%`;
        marker.style.opacity = '1';

        const ball = $('ball');
        const shadow = $('ballShadow');
        ball.style.opacity = '1';
        if (shadow) shadow.style.opacity = '0.55';
        ball.style.top = '14%';
        ball.style.left = `${startX}%`;

        if (isLocalBatting()) {
            $('playShotBtn').disabled = false;
            $('readyToBatBtn').disabled = true;
            $('statusMsg').textContent = '\uD83C\uDFB3 Bowler running in from behind the wicket...';
        } else {
            $('statusMsg').textContent = '\uD83C\uDFB3 Bowler running in...';
        }

        const flightDurationMs = Math.max(1500, 2950 - (delivery.speed * 9.5));

        // Start the actual flight only after the run-up + delivery stride.
        // That is what makes the camera move read as one smooth shot, not a cut.
        playBowlerRunUp(() => startFlight());

        function startFlight() {
            if (isLocalBatting()) {
                $('statusMsg').textContent = '\uD83D\uDD25 BALL IN FLIGHT! Move in crease (WASD), pick shot & press SPACE!';
            } else {
                $('statusMsg').textContent = '\uD83C\uDFB3 Ball released! Watching batter react...';
            }
            const startTime = performance.now();
            let bounced = false;
            let aiSwung = false;
            const bouncePct = 28 + (Number(delivery.lengthVal) * 0.54);

            function frame(now) {
                const elapsed = now - startTime;
                const pct = Math.min(100, (elapsed / flightDurationMs) * 100);
                state.flightProgress = pct;
                // replay frames are filled in below, once xPos / yTop are known

                $('timingCursor').style.left = `${pct}%`;

                // Down the pitch: bowler (top, ~13%) -> batter (bottom, ~89%).
                // Ball grows as it comes towards the camera — the perspective cue.
                const yTop = 13 + (pct * 0.76);
                ball.style.top = `${yTop}%`;

                let xPos = startX;
                if (pct < bouncePct) {
                    const preRatio = pct / bouncePct;
                    xPos = startX + (targetX - startX) * preRatio;
                } else {
                    if (!bounced) {
                        bounced = true;
                        SoundFX.pitchBounce();
                    }
                    const postRatio = (pct - bouncePct) / (100 - bouncePct);
                    const angleDrift = (targetX - startX) * 0.22;
                    let deviation = angleDrift;
                    if (delivery.variation === 'inswing' || delivery.variation === 'spin') deviation += 4;
                    if (delivery.variation === 'outswing') deviation -= 4;
                    xPos = targetX + (deviation * postRatio);
                }
                ball.style.left = `${xPos}%`;

                // Small hop just after the bounce, then it settles back onto the pitch line
                const lift = (pct > bouncePct && pct < bouncePct + 14)
                    ? -Math.sin((pct - bouncePct) / 14 * Math.PI) * 9
                    : 0;
                const scale = 0.55 + (pct * 0.007);
                ball.style.transform = `translate(-50%, -50%) translateY(${lift}px) scale(${scale.toFixed(2)})`;
                state.replayFrames.push({ pct, x: xPos, y: yTop, scale });
                if (shadow) {
                    shadow.style.top = `${yTop + 1.4}%`;
                    shadow.style.left = `${xPos}%`;
                    shadow.style.transform = `translate(-50%, 0) scale(${(1.05 - pct * 0.004).toFixed(2)})`;
                    shadow.style.opacity = lift < -2 ? '0.3' : '0.55';
                }

                if (aiBatterShot && !aiSwung && pct >= 78) {
                    aiSwung = true;
                    state.shotTaken = true;
                    finishFlightAndResolve(delivery, aiBatterShot);
                    return;
                }

                if (state.shotTaken) return;

                if (pct >= 100) {
                    state.ballInFlight = false;
                    ball.style.opacity = '0';
                    if (shadow) shadow.style.opacity = '0';
                    marker.style.opacity = '0';
                    if (isLocalBatting()) {
                        $('playShotBtn').disabled = true;
                        const leftShot = {
                            guard: getActiveVal('batterGuardGroup'),
                            footwork: getActiveVal('footworkGroup'),
                            type: 'leave',
                            dir: 'straight',
                            timing: 'none'
                        };
                        submitBatterShot(leftShot);
                    }
                    return;
                }

                state.flightAnimId = requestAnimationFrame(frame);
            }

            state.flightAnimId = requestAnimationFrame(frame);
        }
    }

    function triggerBatterSwing() {
        if (!state.ballInFlight || state.shotTaken || !isLocalBatting()) return;
        state.shotTaken = true;
        $('playShotBtn').disabled = true;

        const depth = getActiveVal('footworkGroup');
        const shot = {
            guard: getActiveVal('batterGuardGroup'),
            footwork: depth,
            type: getActiveVal('shotTypeGroup'),
            dir: getActiveVal('shotDirGroup'),
            timing: getTimingFromProgress(state.flightProgress, depth)
        };

        submitBatterShot(shot);
    }

    $('playShotBtn').addEventListener('click', triggerBatterSwing);

    function submitBatterShot(shot) {
        if (isLocalBatting()) recordBatterTendency(shot);
        if (state.mode === 'ai') {
            finishFlightAndResolve(state.activeDelivery, shot);
        } else {
            if (state.role === 'host') {
                const outcome = resolveBall(state.activeDelivery, shot);
                sendNet({ type: 'BALL_RESULT', delivery: state.activeDelivery, shot, outcome });
                finishFlightAndResolve(state.activeDelivery, shot, outcome);
            } else {
                sendNet({ type: 'BATTER_SHOT', shot });
                $('statusMsg').textContent = '⏳ Shot played! Syncing outcome...';
            }
        }
    }

    function finishFlightAndResolve(delivery, shot, precomputedOutcome = null) {
        if (state.flightAnimId) cancelAnimationFrame(state.flightAnimId);
        state.ballInFlight = false;
        $('pitchMarker').style.opacity = '0';

        if (shot.type !== 'leave') {
            playBatterShotAnimation(shot.type);
        }
        const _shadow = $('ballShadow');
        if (_shadow) _shadow.style.opacity = '0';

        const outcome = precomputedOutcome || resolveBall(delivery, shot);

        // --- Running phase: 1-3 run hits into a gap are NOT scored yet.
        // The batter decides, the batters cross, the fielder chases — then we score.
        // Boundaries, wickets and dots score straight away (with a fielder chase / catch visual).
        // Bug found in testing: wides / no-balls / byes must NOT go through the running
        // choice — they are scored as-is (+1, ball does not count) or the running choice
        // overwrites them and the over stops advancing. See test2 balls 9 & 14.
        const isRunningHit = !outcome.isOut && outcome.runs >= 1 && outcome.runs <= 3 && shot.type !== 'leave' && !outcome.extra;
        if (isRunningHit) {
            // Online: keep the netcode in sync — runs are as resolved, no extra choice / re-roll.
            // The visual crossing still happens in applyRunningOutcome().
            if (state.mode === 'online') {
                applyRunningOutcome(delivery, shot, outcome, outcome.runs, false, outcome.runs);
                return;
            }
            startRunningPhase(delivery, shot, outcome);
            return;
        }

        // Boundary / catch / dot: show the ball going to the fielder / boundary, then score.
        animateBallToOutcome(outcome, shot);
        applyOutcomeNow(delivery, shot, outcome);
    }

    function animateBallToOutcome(outcome, shot) {
        const ball = $('ball');
        if (!ball) return;
        const landing = outcome.landing || computeLanding(shot, state.activeDelivery);
        const near = outcome.nearestFielder ? { fielder: outcome.nearestFielder, dist: outcome.nearestDist } : nearestFielder(landing.x, landing.y);
        ball.classList.add('travelling');
        ball.style.opacity = '1';
        ball.style.left = `${landing.x}%`;
        ball.style.top = `${landing.y}%`;
        ball.style.transform = `translate(-50%, -50%) scale(${outcome.runs >= 4 ? 1.1 : 0.9})`;
        if (near.fielder) {
            const el = document.querySelector(`.fielder[data-id="${near.fielder.id}"]`);
            if (el) {
                el.classList.add(outcome.isOut ? 'catching' : 'chasing');
                // Fielder sprints a little towards the ball
                el.style.left = `${Math.max(6, Math.min(94, (near.fielder.x + landing.x) / 2))}%`;
                el.style.top = `${Math.max(5, Math.min(94, (near.fielder.y + landing.y) / 2))}%`;
                setTimeout(() => {
                    el.classList.remove('chasing', 'catching');
                    el.style.left = `${near.fielder.x}%`;
                    el.style.top = `${near.fielder.y}%`;
                }, 1100);
            }
        }
        setTimeout(() => { ball.classList.remove('travelling'); ball.style.opacity = '0'; }, 1000);
    }

    function applyOutcomeNow(delivery, shot, outcome, runOut = false) {
        if (outcome.isOut || runOut) {
            if (outcome.commentary.includes('BOWLED')) {
                SoundFX.stumpsShatter();
            } else if (runOut) {
                SoundFX.stumpsShatter();
                setTimeout(() => SoundFX.crowdRoar(false), 150);
            } else {
                SoundFX.batCrack(0.7);
                setTimeout(() => SoundFX.crowdRoar(false), 150);
            }
        } else if (shot.type === 'leave') {
            SoundFX.click();
        } else if (shot.type === 'defend') {
            SoundFX.batDefend();
        } else if (outcome.runs >= 4) {
            SoundFX.batCrack(1.25);
            setTimeout(() => SoundFX.crowdRoar(true), 120);
        } else if (outcome.runs > 0) {
            SoundFX.batCrack(0.95);
        } else {
            SoundFX.batDefend();
        }

        const team = state[state.battingSide];
        const isLegal = outcome.legal !== false;
        if (isLegal) team.balls += 1;
        if (outcome.isOut || runOut) team.wickets += 1;
        team.score += outcome.runs;
        // Free hit: this ball used it up, unless this ball itself was a no-ball
        const wasFreeHit = state.freeHit;
        state.freeHit = !!outcome.freeHitNext;
        // --- Player stats ---
        const st = currentStriker(), bw = currentBowler();
        const batRuns = outcome.extra === 'bye' || outcome.extra === 'legbye' ? 0 : outcome.extra === 'wide' ? 0 : Math.max(0, outcome.runs - (outcome.extra === 'noball' ? 1 : 0));
        if (st) {
            st.batRuns += batRuns;
            if (outcome.extra !== 'wide') st.batBalls += 1;
            if (batRuns === 4) st.fours += 1;
            if (batRuns === 6) st.sixes += 1;
            if (outcome.isOut || runOut) {
                st.out = true;
                st.outHow = runOut ? 'run out' : outcome.commentary.includes('BOWLED') ? 'b' : outcome.commentary.includes('CAUGHT') || outcome.commentary.includes('EDGED') ? 'c' : 'b';
            }
        }
        if (bw) {
            if (isLegal) bw.bowlBalls += 1;
            bw.bowlRuns += outcome.runs;
            if (outcome.isOut && !runOut) bw.bowlWkts += 1;
            bw.oversBowled = Math.floor(bw.bowlBalls / 6);
            bw.fatigue = Math.min(0.6, bw.bowlBalls * 0.018 + (bw.oversBowled * 0.08));
        }
        // Wagon wheel + Manhattan data
        if (outcome.landing && (outcome.runs > 0 || outcome.isOut)) {
            state.wagonShots.push({ x: outcome.landing.x, y: outcome.landing.y, runs: batRuns, dir: shot.dir, type: shot.type });
        }
        state.currentOverRuns = (state.currentOverRuns || 0) + outcome.runs;
        // Strike: odd runs swap ends (including run-out completed runs)
        if (!outcome.isOut && !runOut && outcome.runs % 2 === 1) swapStrike();
        // Wicket: new batter in at the striker's end
        if (outcome.isOut || runOut) {
            const nb = nextBatterIn();
            if (!nb) { /* all out — checkMatchProgression will finish it */ }
        }
        drawCharts();
        updatePlayersStrip();

        const teamName = state.battingSide === 'p1' ? $('p1Label').textContent : $('p2Label').textContent;
        const logType = (outcome.isOut || runOut) ? 'wicket' : (outcome.runs >= 4 ? 'boundary' : '');
        const timingLabel = shot.type === 'leave' ? 'BALL LEFT' : `Timing: ${shot.timing.toUpperCase()}`;
        const summary = `[${Math.floor((team.balls - 1)/6)}.${(team.balls - 1)%6 + 1}] ${teamName}: ${outcome.commentary} (${timingLabel})`;

        $('ballResult').textContent = outcome.commentary;
        addLog(summary, logType);
        updateScoreboard();
        const rb = $('replayBtn');
        if (rb) rb.disabled = !state.replayFrames.length;

        // End of over? (legal balls only)
        if (isLegal && team.balls % 6 === 0 && team.balls > 0) {
            state.overRuns.push(state.currentOverRuns || 0);
            addLog(`— End of over ${team.balls / 6}: ${teamName} ${team.score}/${team.wickets} — over went for ${state.currentOverRuns || 0} runs.`, 'boundary');
            state.currentOverRuns = 0;
            state.lastBowlerIdx = state.currentBowlerIdx;
            // Swap ends at the end of the over
            swapStrike();
            updatePowerplay();
            // Auto-pick the next available bowler (AI + solo); the human bowler can change it in the panel
            const squad = state.inningsData ? state.inningsData.bowling : [];
            const nextIdx = squad.findIndex((b, i) => bowlerAvailable(i));
            if (nextIdx >= 0) { state.currentBowlerIdx = nextIdx; renderBowlerSelect(); }
            drawCharts();
        }
        setTimeout(prepareNextBall, 1300);
    }

    // ==========================================
    // 5c. SCORECARD, WAGON WHEEL, MANHATTAN, REPLAY
    // ==========================================
    function drawCharts() {
        // Wagon wheel
        const wc = $('wagonWheel');
        if (wc && wc.getContext) {
            const ctx = wc.getContext('2d');
            ctx.clearRect(0, 0, wc.width, wc.height);
            ctx.fillStyle = '#0e2a12'; ctx.fillRect(0, 0, wc.width, wc.height);
            // pitch
            ctx.fillStyle = '#a1887f'; ctx.fillRect(wc.width / 2 - 14, 20, 28, 160);
            ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.strokeRect(wc.width / 2 - 14, 20, 28, 160);
            // shots from the batter (bottom centre) to the landing point
            const cx = wc.width / 2, cy = 180;
            state.wagonShots.forEach(sh => {
                const x = (sh.x / 100) * wc.width, y = (sh.y / 100) * wc.height;
                ctx.strokeStyle = sh.runs >= 6 ? '#ffd700' : sh.runs === 4 ? '#66bb6a' : 'rgba(255,255,255,0.85)';
                ctx.lineWidth = sh.runs >= 4 ? 3 : 1.5;
                ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
                ctx.fillStyle = ctx.strokeStyle;
                ctx.beginPath(); ctx.arc(x, y, sh.runs >= 4 ? 5 : 3, 0, Math.PI * 2); ctx.fill();
            });
            ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif'; ctx.fillText('Batter', cx - 18, 198);
        }
        // Manhattan
        const mc = $('manhattanChart');
        if (mc && mc.getContext) {
            const ctx = mc.getContext('2d');
            ctx.clearRect(0, 0, mc.width, mc.height);
            ctx.fillStyle = '#0e2a12'; ctx.fillRect(0, 0, mc.width, mc.height);
            const overs = [...state.overRuns];
            if (state.currentOverRuns) overs.push(state.currentOverRuns);
            if (!overs.length) overs.push(0);
            const max = Math.max(6, ...overs);
            const bw = mc.width / Math.max(overs.length, 1);
            overs.forEach((r, i) => {
                const h = (r / max) * (mc.height - 30);
                ctx.fillStyle = i === overs.length - 1 ? '#ffd700' : '#43a047';
                ctx.fillRect(i * bw + 4, mc.height - 20 - h, bw - 8, h);
                ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif';
                ctx.fillText(String(r), i * bw + bw / 2 - 3, mc.height - 24 - h);
                ctx.fillText(`O${i + 1}`, i * bw + bw / 2 - 6, mc.height - 6);
            });
        }
    }
    function renderScorecard() {
        const body = $('scorecardBody');
        if (!body) return;
        const hist = state.scorecardHistory || [];
        const current = state.inningsData ? {
            team: state.battingSide === 'p1' ? $('p1Label').textContent : $('p2Label').textContent,
            batting: state.inningsData.batting, bowling: state.inningsData.bowling,
            total: state[state.battingSide].score, wickets: state[state.battingSide].wickets,
            balls: state[state.battingSide].balls, extras: state.extras
        } : null;
        const inningsList = [...hist];
        if (current) inningsList.push(current);
        if (!inningsList.length) { body.innerHTML = '<p>No innings yet — start a match.</p>'; return; }
        let html = '';
        inningsList.forEach((inn, idx) => {
            html += `<h4>Innings ${idx + 1} — ${inn.team}: ${inn.total}/${inn.wickets} (${Math.floor(inn.balls / 6)}.${inn.balls % 6} ov)</h4>`;
            html += '<table><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>How out</th></tr>';
            inn.batting.forEach(b => {
                const _ns = currentNonStriker();
                if (b.batBalls === 0 && !b.out && b.name !== (currentStriker() && currentStriker().name) && !(_ns && b.name === _ns.name)) return;
                html += `<tr><td>${b.name}${idx === inningsList.length - 1 && currentStriker() && b.name === currentStriker().name ? ' *' : ''}</td><td>${b.batRuns}</td><td>${b.batBalls}</td><td>${b.fours}</td><td>${b.sixes}</td><td>${b.out ? (b.outHow || 'out') : '<span class="not-out">not out</span>'}</td></tr>`;
            });
            html += '</table>';
            html += '<table><tr><th>Bowler</th><th>Ov</th><th>R</th><th>W</th><th>Econ</th></tr>';
            inn.bowling.forEach(b => {
                if (b.bowlBalls === 0) return;
                const ov = `${Math.floor(b.bowlBalls / 6)}.${b.bowlBalls % 6}`;
                const econ = b.bowlBalls ? (b.bowlRuns / (b.bowlBalls / 6)).toFixed(1) : '—';
                html += `<tr><td>${b.name}</td><td>${ov}</td><td>${b.bowlRuns}</td><td>${b.bowlWkts}</td><td>${econ}</td></tr>`;
            });
            html += '</table>';
            html += `<p>Extras: wd ${inn.extras.wides}, nb ${inn.extras.noBalls}, b ${inn.extras.byes}, lb ${inn.extras.legByes}</p>`;
        });
        body.innerHTML = html;
    }
    function replayLastBall() {
        if (state.replaying || !state.replayFrames.length) return;
        if (state.ballInFlight) return;
        state.replaying = true;
        const btn = $('replayBtn');
        if (btn) btn.disabled = true;
        $('statusMsg').textContent = '🔁 Replay — last ball at 0.4x speed…';
        setCamera('batter');
        const ball = $('ball');
        const frames = state.replayFrames;
        const start = performance.now();
        const duration = frames.length * 16 * 2.5; // ~0.4x
        ball.style.opacity = '1';
        function step(now) {
            const t = Math.min(1, (now - start) / duration);
            const idx = Math.min(frames.length - 1, Math.floor(t * frames.length));
            const f = frames[idx];
            if (f) {
                ball.style.left = `${f.x}%`;
                ball.style.top = `${f.y}%`;
                ball.style.transform = `translate(-50%, -50%) scale(${f.scale})`;
            }
            if (t < 1 && state.replaying) requestAnimationFrame(step);
            else {
                state.replaying = false;
                ball.style.opacity = '0';
                if (btn) btn.disabled = false;
                $('statusMsg').textContent = 'Replay finished. Ready for the next ball.';
            }
        }
        requestAnimationFrame(step);
    }

    // ==========================================
    // 5b. RUNNING BETWEEN WICKETS
    // ==========================================
    function hideRunningPanel() {
        const panel = $('runningPanel');
        if (panel) panel.style.display = 'none';
        if (state.runTimer) { clearTimeout(state.runTimer); state.runTimer = null; }
    }
    function resetRunningPositions() {
        const bat = $('batsman');
        if (bat) { bat.classList.remove('sprinting'); bat.style.transform = ''; }
        const ns = $('nonStriker');
        if (ns) { ns.classList.remove('sprinting'); ns.style.transform = ''; }
    }
    function startRunningPhase(delivery, shot, outcome) {
        state.pendingRun = { delivery, shot, outcome };
        const near = outcome.nearestFielder;
        const dist = Math.round(outcome.nearestDist || 99);
        const msg = $('runningMsg');
        if (msg) msg.textContent = `Ball to ${near ? near.name : 'the outfield'} — ${outcome.gap ? 'big gap!' : 'fielder is ' + dist + '% away.'} How many?`;
        const hint = $('runningHint');
        if (hint) {
            hint.textContent = dist < 14
                ? 'Fielder is close — a 2nd run risks a run-out. A 3rd is very risky.'
                : dist < 22
                    ? 'Fielder is mid-distance — 2 is gettable, 3 is risky.'
                    : 'Big gap — 2 is safe, 3 is on if you are quick.';
        }
        // Only the local batter in solo mode chooses. AI batter auto-calls.
        if (isLocalBatting() && state.mode === 'ai') {
            const panel = $('runningPanel');
            if (panel) panel.style.display = 'block';
            $('statusMsg').textContent = '🏃 Ball in the gap! Call your runs — Run 1 / 2 / 3 or Stay.';
            state.runTimer = setTimeout(() => chooseRuns(outcome.runs), 4000);
        } else {
            // AI batting: call based on the gap and the required rate
            const aiRuns = outcome.gap ? Math.min(3, outcome.runs + 1) : (dist < 14 ? 1 : outcome.runs);
            setTimeout(() => completeRunning(Math.max(0, Math.min(3, aiRuns))), 650);
        }
    }
    function chooseRuns(n) {
        if (!state.pendingRun) return;
        hideRunningPanel();
        completeRunning(n);
    }
    function completeRunning(attempted) {
        const pending = state.pendingRun;
        if (!pending) return;
        state.pendingRun = null;
        const { delivery, shot, outcome } = pending;
        // Run-out risk grows with each extra run and shrinks if the fielder is far / timing was perfect.
        const dist = outcome.nearestDist || 99;
        let runOutChance = dist < 12 ? 0.22 : dist < 20 ? 0.12 : 0.05;
        if (attempted >= 2) runOutChance += 0.12;
        if (attempted >= 3) runOutChance += 0.16;
        if (shot.timing === 'perfect') runOutChance -= 0.05;
        runOutChance = Math.max(0.02, Math.min(0.55, runOutChance));
        const runOut = attempted > 0 && Math.random() < runOutChance;
        const runsCompleted = attempted === 0 ? 0 : runOut ? attempted - 1 : attempted;
        applyRunningOutcome(delivery, shot, outcome, attempted, runOut, runsCompleted);
    }
    function applyRunningOutcome(delivery, shot, outcome, attempted, runOut, runsCompleted) {
        // Visual: ball to the fielder, fielder chases, batters cross `attempted` times.
        animateRunning(attempted, outcome, runOut);
        const finalOutcome = {
            ...outcome,
            runs: runsCompleted,
            isOut: runOut ? true : outcome.isOut,
            commentary: attempted === 0
                ? '✋ No run — batters stay put, ball returned to the bowler.'
                : runOut
                    ? `💥 RUN OUT! Went for ${attempted} and ${runsCompleted} completed — direct hit at the ${attempted % 2 === 1 ? "batter's" : "bowler's"} end!`
                    : runsCompleted === 1
                        ? `🏃 Quick single taken${outcome.gap ? ' — into the gap' : ''}.`
                        : `🏃🏃 ${runsCompleted} runs taken — good running between the wickets!`
        };
        // Score after the running animation has had a moment to read (900ms per run, min 900ms)
        const delay = Math.max(900, attempted * 750);
        setTimeout(() => applyOutcomeNow(delivery, shot, finalOutcome, runOut), delay);
    }
    function animateRunning(attempted, outcome, runOut) {
        const ball = $('ball');
        const landing = outcome.landing || { x: 50, y: 45 };
        const near = outcome.nearestFielder ? { fielder: outcome.nearestFielder, dist: outcome.nearestDist } : nearestFielder(landing.x, landing.y);
        if (ball) {
            ball.classList.add('travelling');
            ball.style.opacity = '1';
            ball.style.left = `${landing.x}%`;
            ball.style.top = `${landing.y}%`;
            ball.style.transform = 'translate(-50%, -50%) scale(0.9)';
        }
        if (near.fielder) {
            const el = document.querySelector(`.fielder[data-id="${near.fielder.id}"]`);
            if (el) {
                el.classList.add('chasing');
                el.style.left = `${landing.x}%`;
                el.style.top = `${landing.y}%`;
                setTimeout(() => {
                    el.classList.remove('chasing');
                    el.style.left = `${near.fielder.x}%`;
                    el.style.top = `${near.fielder.y}%`;
                }, Math.max(1100, attempted * 750));
            }
        }
        if (attempted === 0) {
            setTimeout(() => { if (ball) { ball.classList.remove('travelling'); ball.style.opacity = '0'; } }, 800);
            return;
        }
        // Batters cross: striker up the pitch, non-striker down. Swap after each run.
        const bat = $('batsman');
        const ns = $('nonStriker');
        if (!bat || !ns) return;
        bat.classList.add('sprinting');
        ns.classList.add('sprinting');
        const batX = getComputedStyle(bat).getPropertyValue('--batter-x') || '0px';
        let swapped = false;
        const cross = (runNo) => {
            swapped = !swapped;
            if (swapped) {
                bat.style.transform = 'translate(-50%, 0) translateX(0px) translateY(-270px)';
                ns.style.transform = 'translate(-50%, 0) translateY(270px)';
            } else {
                bat.style.transform = '';
                ns.style.transform = '';
            }
            if (runNo < attempted) setTimeout(() => cross(runNo + 1), 720);
            else {
                setTimeout(() => {
                    bat.classList.remove('sprinting');
                    ns.classList.remove('sprinting');
                    // After an odd number of runs the strike has changed — reset for the next ball
                    resetRunningPositions();
                    if (ball) { ball.classList.remove('travelling'); ball.style.opacity = '0'; }
                    if (runOut) SoundFX.stumpsShatter();
                }, 750);
            }
        };
        setTimeout(() => cross(1), 120);
    }

    // ==========================================
    // 6. ADVANCED CREASE & ANGLE PHYSICS ENGINE
    // ==========================================
    function resolveBall(delivery, shot) {
        const lengthCat = getLengthCategory(delivery.lengthVal);
        const _bw = currentBowler();

        // Wide: +1, does not count as a legal ball, batter cannot be out (except run-out, not modelled here)
        if (delivery.extra === 'wide') {
            state.extras.wides += 1;
            const landingW = computeLanding(shot, delivery);
            const nearW = nearestFielder(landingW.x, landingW.y);
            return { isOut: false, runs: 1, commentary: 'Wide ball! +1 run — that one does not count as a legal delivery.', extra: 'wide', legal: false, landing: landingW, nearestFielder: nearW.fielder, nearestDist: nearW.dist, gap: nearW.dist > 28 };
        }

        // Handle leaving the ball
        if (shot.type === 'leave') {
            const stumpsExposed = shot.guard === 'leg' && delivery.line !== 'off';
            if ((delivery.line === 'middle' || stumpsExposed) && lengthCat !== 'short') {
                return { isOut: true, runs: 0, commentary: '💥 BOWLED! Exposed the stumps and left a straight one!' };
            }
            return { isOut: false, runs: 0, commentary: '👀 Well left! Safe carry through to the keeper.' };
        }

        let runs = 0;
        let isOut = false;
        let commentary = '';

        // 1. Crease Depth vs Pitch Length
        // Advancing down pitch converts 'good' length into a driveable half-volley, but is risky vs yorkers/bouncers!
        const effectiveLength = (shot.footwork === 'advance' && lengthCat === 'good') ? 'full' : lengthCat;

        const goodDepth =
            (effectiveLength === 'short' && shot.footwork === 'back') ||
            ((effectiveLength === 'full' || effectiveLength === 'yorker') && (shot.footwork === 'crease' || shot.footwork === 'advance')) ||
            (effectiveLength === 'good' && shot.footwork !== 'back');

        // 2. Lateral Crease Guard vs Delivery Line & Angle
        // Stepping across to 'off' covers outswing/wide balls; backing to 'leg' frees arms for off-side drives!
        const coveredLine =
            (delivery.line === 'off' && (shot.guard === 'off' || shot.guard === 'middle')) ||
            (delivery.line === 'leg' && (shot.guard === 'leg' || shot.guard === 'middle')) ||
            (delivery.line === 'middle');

        const freedArmsBonus = (shot.guard === 'leg' && delivery.line === 'off' && shot.dir === 'off');
        const exposedStumpsRisk = (shot.guard === 'leg' && delivery.line === 'middle');

        // 3. Shot Selection vs Length
        const goodShotChoice =
            (effectiveLength === 'short' && (shot.type === 'cutpull' || shot.type === 'defend')) ||
            (effectiveLength === 'yorker' && (shot.type === 'defend' || shot.type === 'ground')) ||
            ((effectiveLength === 'good' || effectiveLength === 'full') && ['ground', 'sweep', 'loft', 'defend'].includes(shot.type));

        const lineMatch =
            (delivery.line === 'off' && shot.dir === 'off') ||
            (delivery.line === 'leg' && (shot.dir === 'leg' || shot.type === 'sweep')) ||
            (delivery.line === 'middle' && shot.dir === 'straight');

        // Field effect on the catch chance: a fielder sitting under a lofted / mishit ball.
        const _landingEarly = computeLanding(shot, delivery);
        const _nearEarly = nearestFielder(_landingEarly.x, _landingEarly.y);
        let outChance = 0.05;
        if ((shot.type === 'loft' || shot.type === 'cutpull') && _nearEarly.fielder && _nearEarly.dist < 20) outChance += 0.12;
        if (shot.timing !== 'perfect' && _nearEarly.fielder && _nearEarly.dist < 12) outChance += 0.06;
        if (!goodDepth) outChance += 0.13;
        if (!coveredLine) outChance += 0.11;
        if (exposedStumpsRisk) outChance += 0.12;
        if (!goodShotChoice) outChance += 0.13;
        if (shot.type === 'loft') outChance += 0.09;
        if (shot.type === 'defend') outChance -= 0.05;
        if (delivery.angle === 'round' && delivery.variation === 'inswing') outChance += 0.05;
        if (shot.timing === 'early' || shot.timing === 'late') outChance += 0.21;
        if (shot.timing === 'perfect') outChance -= 0.06;

        if (_bw) outChance += (_bw.bowlSkill - 70) * 0.002;
        // Free hit: batter cannot be out (except run-out) on this ball
        if (state.freeHit && !shot.type.includes('run')) outChance = Math.min(outChance, 0.03);
        outChance = Math.max(0.02, Math.min(0.72, outChance));

        if (Math.random() < outChance) {
            isOut = true;
            if (exposedStumpsRisk && (shot.timing === 'early' || shot.timing === 'late')) {
                commentary = '💥 BOWLED! Backed away to leg and missed—leg stump flattened!';
            } else if (shot.footwork === 'advance' && delivery.variation === 'spin') {
                commentary = '🧤 STUMPED! Charged down the track and beaten by sharp turn!';
            } else if (lengthCat === 'yorker' && shot.type === 'loft') {
                commentary = '💥 BOWLED! Tried to slog a toe-crushing yorker!';
            } else if (shot.type === 'loft') {
                commentary = '🙌 CAUGHT IN THE DEEP! Mistimed the lofted hit!';
            } else {
                commentary = '🧤 EDGED & CAUGHT! Angled delivery took the outside edge!';
            }
        } else {
            if (shot.type === 'defend') {
                runs = (shot.timing === 'perfect' && lineMatch && Math.random() < 0.35) ? 1 : 0;
            } else if (shot.type === 'loft') {
                if (shot.timing === 'perfect' && goodDepth) {
                    runs = (lineMatch || freedArmsBonus || goodShotChoice) ? 6 : 4;
                } else if (shot.timing === 'good') {
                    runs = goodDepth ? 4 : 2;
                } else {
                    runs = 1;
                }
            } else {
                if (shot.timing === 'perfect' && goodDepth && goodShotChoice) {
                    runs = (lineMatch || freedArmsBonus) ? 4 : 3;
                } else if (shot.timing === 'perfect' || (shot.timing === 'good' && (lineMatch || freedArmsBonus))) {
                    runs = Math.random() < 0.5 ? 4 : 2;
                } else if (shot.timing === 'good') {
                    runs = 1;
                } else {
                    runs = 0;
                }
            }

            commentary = runs === 6 ? '🚀 MASSIVE SIX! Used the crease brilliantly and cleared the ropes!' :
                         runs === 4 ? '🔥 CRACKING FOUR! Placed into the gap with precision!' :
                         runs === 0 ? 'Dot ball. Tight line and disciplined fielding.' :
                         `🏏 Smart placement — ${runs} run${runs > 1 ? 's' : ''} taken.`;
        }

        // Field effect on runs: a fielder in the deep cuts a boundary down, a gap lets it through.
        const landing = computeLanding(shot, delivery);
        const near = nearestFielder(landing.x, landing.y);
        let finalRuns = runs;
        let finalCommentary = commentary;
        if (!isOut) {
            if (finalRuns >= 4 && near.fielder && near.dist < 13 && shot.timing !== 'perfect') {
                finalRuns = 2;
                finalCommentary = `✂️ Cut off in the deep by ${near.fielder.name}! Saved two — 2 runs.`;
            } else if (finalRuns >= 2 && near.fielder && near.dist < 10) {
                finalRuns = 1;
                finalCommentary = `🧤 Fielded quickly by ${near.fielder.name} — only 1 run.`;
            } else if (isOut === false && finalRuns > 0 && near.fielder && near.dist > 28) {
                finalCommentary = commentary + ` Gap found — ${near.fielder.name} had no chance.`;
            }
        } else if (near.fielder && (shot.type === 'loft' || shot.type === 'cutpull')) {
            finalCommentary = `🙌 CAUGHT by ${near.fielder.name}! Mistimed and straight to the fielder.`;
        }
        // Power: big hitters turn 4s into 6s, weak hitters turn 6s into 4s
        const _st = currentStriker();
        if (!isOut && _st) {
            if (finalRuns === 6 && _st.power < 60) { finalRuns = 4; finalCommentary = finalCommentary.replace('SIX', 'FOUR'); }
            else if (finalRuns === 4 && _st.power >= 88 && Math.random() < 0.25) { finalRuns = 6; finalCommentary = '🚀 MASSIVE SIX! Cleared the ropes with power to spare!'; }
        }
        // Bye / leg-bye: beaten, keeper fumbles — 1 run, counts as a legal ball, no bat runs
        if (!isOut && finalRuns === 0 && (shot.timing === 'early' || shot.timing === 'late') && Math.random() < 0.16 && delivery.extra !== 'noball') {
            const isLeg = delivery.line === 'leg';
            if (isLeg) state.extras.legByes += 1; else state.extras.byes += 1;
            return { runs: 1, isOut: false, commentary: isLeg ? 'Leg-bye! Beaten, 1 run sneaked.' : 'Bye! Beaten, keeper fumbles — 1 run.', extra: isLeg ? 'legbye' : 'bye', legal: true, landing, nearestFielder: near.fielder, nearestDist: near.dist, gap: near.dist > 28 };
        }
        // No-ball: +1 extra, does not count as a legal ball, out is overturned, next ball is a free hit
        if (delivery.extra === 'noball') {
            state.extras.noBalls += 1;
            const wasOut = isOut;
            const nbRuns = finalRuns + 1;
            const nbCommentary = wasOut
                ? `No-ball! +1 — ${finalCommentary} is overturned, batter survives. FREE HIT next ball!`
                : `${finalCommentary} (no-ball +1 — FREE HIT next ball!)`;
            return { runs: nbRuns, isOut: false, commentary: nbCommentary, extra: 'noball', legal: false, freeHitNext: true, landing, nearestFielder: near.fielder, nearestDist: near.dist, gap: near.dist > 28 };
        }
        return { runs: finalRuns, isOut, commentary: finalCommentary, landing, nearestFielder: near.fielder, nearestDist: near.dist, gap: near.dist > 28, legal: true, extra: null };
    }

    // ==========================================
    // 7. TURN FLOW & AI LOGIC
    // ==========================================
    function isLocalBatting() {
        if (state.mode === 'ai') return state.battingSide === 'p1';
        return (state.role === 'host' && state.battingSide === 'p1') ||
               (state.role === 'guest' && state.battingSide === 'p2');
    }

    function prepareNextBall() {
        if (checkMatchProgression()) return;
        updateScoreboard();
        updateVisualPositions();
        $('timingCursor').style.left = '0%';

        resetPlayers();
        setCamera(state.cameraMode || 'batter');
        hideRunningPanel();
        resetRunningPositions();
        if (isLocalBatting()) {
            $('battingControls').style.display = 'block';
            $('bowlingControls').style.display = 'none';
            $('playShotBtn').disabled = true;

            if (state.mode === 'ai') {
                $('readyToBatBtn').style.display = 'inline-block';
                $('readyToBatBtn').disabled = false;
                $('statusMsg').textContent = '👀 Set your guard (A/D), depth (W/S) & click "Ready for Next Ball"!';
            } else {
                $('readyToBatBtn').style.display = 'none';
                $('statusMsg').textContent = '⏳ Waiting for online bowler to deliver...';
            }
        } else {
            $('battingControls').style.display = 'none';
            $('bowlingControls').style.display = 'block';
            $('deliverBallBtn').disabled = false;
            renderBowlerSelect();
            updatePlayersStrip();
            // AI bowling to the user: pick its best bowler for this striker
            if (state.mode === 'ai') aiChooseBowler();
            $('statusMsg').textContent = '🎳 Set crease angle, pitch length & pace, then bowl!';
        }
        updatePlayersStrip();
        drawCharts();
    }

    $('readyToBatBtn').addEventListener('click', () => {
        if (!isLocalBatting() || state.mode !== 'ai') return;
        SoundFX.click();
        $('readyToBatBtn').disabled = true;
        $('statusMsg').textContent = '🎳 Bowler running in...';
        setTimeout(() => {
            const aiDelivery = generateAIDelivery();
            launchBallFlight(aiDelivery, null);
        }, 550);
    });

    $('deliverBallBtn').addEventListener('click', () => {
        if (isLocalBatting() || state.ballInFlight) return;
        SoundFX.click();
        $('deliverBallBtn').disabled = true;

        const delivery = {
            angle: getActiveVal('bowlAngleGroup'),
            line: getActiveVal('bowlLineGroup'),
            variation: getActiveVal('bowlVarGroup'),
            lengthVal: Number($('bowlLengthSlider').value),
            speed: Number($('bowlSpeedSlider').value)
        };
        if (!isLocalBatting()) recordBowlerTendency(delivery);

        if (state.mode === 'ai') {
            const aiShot = generateAIShot(delivery);
            launchBallFlight(delivery, aiShot);
        } else {
            state.activeDelivery = delivery;
            sendNet({ type: 'BOWL_DELIVERY', delivery });
            launchBallFlight(delivery, null);
        }
    });

    function recordBatterTendency(shot) {
        const m = state.aiMemory;
        m.ballsFaced += 1;
        m.shotTypes[shot.type] = (m.shotTypes[shot.type] || 0) + 1;
        m.dirs[shot.dir] = (m.dirs[shot.dir] || 0) + 1;
        m.guards[shot.guard] = (m.guards[shot.guard] || 0) + 1;
        m.footwork[shot.footwork] = (m.footwork[shot.footwork] || 0) + 1;
        if (shot.type === 'loft' || shot.type === 'ground') m.boundaries += 1;
    }
    function recordBowlerTendency(delivery) {
        const m = state.aiMemory;
        m.bowlLines[delivery.line] = (m.bowlLines[delivery.line] || 0) + 1;
        m.bowlLengths[getLengthCategory(delivery.lengthVal)] = (m.bowlLengths[getLengthCategory(delivery.lengthVal)] || 0) + 1;
        m.bowlVars[delivery.variation] = (m.bowlVars[delivery.variation] || 0) + 1;
    }
    function mostCommon(obj) {
        let best = null, bestN = 0;
        Object.entries(obj).forEach(([k, v]) => { if (v > bestN) { bestN = v; best = k; } });
        return best;
    }
    function aiUsesMemory() {
        // Easy mostly ignores what it has learned, Hard almost always uses it
        const p = state.difficulty === 'hard' ? 0.9 : state.difficulty === 'easy' ? 0.25 : 0.55;
        return Math.random() < p;
    }
    function generateAIDelivery() {
        const m = state.aiMemory;
        const bw = currentBowler();
        // Base speed from the current AI bowler's skill, not a flat difficulty number
        const baseSpeed = bw ? Math.round(108 + bw.bowlSkill * 0.35) : (state.difficulty === 'hard' ? 140 : state.difficulty === 'easy' ? 102 : 122);
        let angle = ['over', 'wide', 'round'][Math.floor(Math.random() * 3)];
        let line = ['off', 'middle', 'leg'][Math.floor(Math.random() * 3)];
        let variation = ['seam', 'inswing', 'outswing', 'spin'][Math.floor(Math.random() * 4)];
        let lengthVal = 20 + Math.floor(Math.random() * 70);
        if (aiUsesMemory() && m.ballsFaced >= 4) {
            const favDir = mostCommon(m.dirs);
            const favShot = mostCommon(m.shotTypes);
            const favFoot = mostCommon(m.footwork);
            // User loves driving through off? Bowl leg, round the wicket, set the field there.
            if (favDir === 'off') { line = 'leg'; angle = 'round'; variation = 'inswing'; }
            // User lofts a lot? Yorkers + slower balls, defensive field.
            if (favShot === 'loft') { lengthVal = 78 + Math.floor(Math.random() * 12); variation = 'seam'; setFieldPreset('defensive'); }
            // User advances down the pitch? Bowl short / bouncer and spin.
            if (favFoot === 'advance') { lengthVal = 18 + Math.floor(Math.random() * 15); variation = Math.random() < 0.5 ? 'spin' : 'seam'; }
            // User is timing everything perfectly? Vary length hard and use a slower ball.
            const st = currentStriker();
            if (st && st.timing >= 85) { lengthVal = [22, 58, 82][Math.floor(Math.random() * 3)]; }
            // User struggles vs spin? Bowl more spin.
            if (favShot === 'defend') { variation = 'spin'; lengthVal = 45 + Math.floor(Math.random() * 20); }
        }
        // Fatigue: AI bowler also tires
        const speed = bw ? Math.max(85, Math.round(baseSpeed - bw.fatigue * 10 + Math.floor(Math.random() * 10))) : baseSpeed + Math.floor(Math.random() * 14);
        return { angle, line, variation, lengthVal, speed };
    }
    function generateAIShot(delivery) {
        const chasing = state[state.battingSide];
        const ballsLeft = Math.max(1, state.maxOvers * 6 - chasing.balls);
        const reqRate = state.target ? (state.target - chasing.score) / ballsLeft : 1.2;
        const lenCat = getLengthCategory(delivery.lengthVal);
        const m = state.aiMemory;
        // Pick the gap: the direction whose nearest fielder is furthest away
        const gapDir = (() => {
            const dirs = { off: { x: 20, y: 40 }, straight: { x: 50, y: 20 }, leg: { x: 80, y: 40 } };
            let best = 'straight', bestD = -1;
            Object.entries(dirs).forEach(([d, pt]) => {
                const near = nearestFielder(pt.x, pt.y);
                if (near.dist > bestD) { bestD = near.dist; best = d; }
            });
            return best;
        })();
        let types, footwork;
        if (state.target && reqRate > 1.6) types = ['loft', 'cutpull', 'ground'];
        else if (chasing.wickets >= 7) types = ['ground', 'defend', 'sweep'];
        else types = ['ground', 'cutpull', 'sweep', 'defend'];
        // Read the human bowler: short a lot -> pull, yorker a lot -> defend, off line -> drive off
        if (aiUsesMemory()) {
            const favLen = mostCommon(m.bowlLengths);
            const favLine = mostCommon(m.bowlLines);
            if (favLen === 'short') types = ['cutpull', 'ground'];
            if (favLen === 'yorker') types = ['defend', 'ground'];
            if (favLine === 'off') types = ['ground', 'cutpull'];
        }
        footwork = lenCat === 'short' ? 'back' : (lenCat === 'good' && Math.random() < 0.3 ? 'advance' : 'crease');
        const timings = state.difficulty === 'hard'
            ? ['perfect', 'perfect', 'good']
            : state.difficulty === 'easy'
                ? ['good', 'early', 'late']
                : ['perfect', 'good', 'good'];
        // Faster balls are harder to time perfectly
        const timingPool = delivery.speed >= 145 ? timings.map(t => t === 'perfect' && Math.random() < 0.4 ? 'good' : t) : timings;
        return {
            guard: delivery.line === 'middle' ? 'middle' : delivery.line,
            footwork,
            type: types[Math.floor(Math.random() * types.length)],
            dir: gapDir, // was delivery.line (and 'middle' is not a valid direction) — audit fix
            timing: timingPool[Math.floor(Math.random() * timingPool.length)]
        };
    }
    function aiChooseBowler() {
        // Pick the best available bowler for the current striker, not the last bowler
        const squad = state.inningsData ? state.inningsData.bowling : [];
        const st = currentStriker();
        const candidates = squad.map((b, i) => ({ b, i })).filter(({ i }) => bowlerAvailable(i));
        if (!candidates.length) return;
        candidates.sort((a, b) => {
            // Spin vs a big hitter, pace vs a weak timer — small matchup bonus
            const aBonus = (st && st.power >= 85 && a.b.bowlType === 'spin') ? 6 : 0;
            const bBonus = (st && st.power >= 85 && b.b.bowlType === 'spin') ? 6 : 0;
            return (b.b.bowlSkill + bBonus - b.b.fatigue * 20) - (a.b.bowlSkill + aBonus - a.b.fatigue * 20);
        });
        state.currentBowlerIdx = candidates[0].i;
        renderBowlerSelect();
        updatePlayersStrip();
    }

    function checkMatchProgression() {
        const current = state[state.battingSide];
        const maxBalls = state.maxOvers * 6;
        const allOut = current.wickets >= PLAYERS_PER_TEAM - 1;
        const oversDone = current.balls >= maxBalls;

        if (state.innings === 2 && current.score >= state.target) {
            finishMatch();
            return true;
        }

        if (allOut || oversDone) {
            if (state.innings === 1) {
                // Save this innings for the scorecard before starting the next one
                state.scorecardHistory = state.scorecardHistory || [];
                state.scorecardHistory.push({
                    team: state.battingSide === 'p1' ? $('p1Label').textContent : $('p2Label').textContent,
                    batting: state.inningsData.batting.map(b => ({ ...b })),
                    bowling: state.inningsData.bowling.map(b => ({ ...b })),
                    total: current.score, wickets: current.wickets, balls: current.balls, extras: { ...state.extras }
                });
                state.innings = 2;
                state.target = current.score + 1;
                state.battingSide = state.battingSide === 'p1' ? 'p2' : 'p1';
                SoundFX.crowdRoar(false);
                addLog(`=== INNINGS BREAK! Target set: ${state.target} runs ===`, 'boundary');
                $('ballResult').textContent = `Innings Break! Target: ${state.target}`;
                startInningsData(state.battingSide);
                updateScoreboard();
                setTimeout(prepareNextBall, 1600);
                return true;
            } else {
                finishMatch();
                return true;
            }
        }
        return false;
    }

    function finishMatch() {
        // Save the 2nd innings for the scorecard
        if (state.inningsData && (state.scorecardHistory || []).length < 2) {
            state.scorecardHistory = state.scorecardHistory || [];
            state.scorecardHistory.push({
                team: state.battingSide === 'p1' ? $('p1Label').textContent : $('p2Label').textContent,
                batting: state.inningsData.batting.map(b => ({ ...b })),
                bowling: state.inningsData.bowling.map(b => ({ ...b })),
                total: state[state.battingSide].score, wickets: state[state.battingSide].wickets, balls: state[state.battingSide].balls, extras: { ...state.extras }
            });
        }
        SoundFX.crowdRoar(true);
        const s1 = state.p1.score;
        const s2 = state.p2.score;
        const n1 = $('p1Label').textContent;
        const n2 = $('p2Label').textContent;

        let msg = '';
        if (s1 > s2) msg = `🏆 ${n1} WON by ${s1 - s2} runs!`;
        else if (s2 > s1) msg = `🏆 ${n2} WON by ${PLAYERS_PER_TEAM - 1 - state.p2.wickets} wickets!`;
        else msg = `🤝 MATCH TIED!`;

        $('resultMessage').textContent = msg;
        $('finalStats').innerHTML = `
            <div><strong>${n1}:</strong> ${state.p1.score}/${state.p1.wickets} (${formatOvers(state.p1.balls)})</div>
            <div><strong>${n2}:</strong> ${state.p2.score}/${state.p2.wickets} (${formatOvers(state.p2.balls)})</div>
        `;
        showScreen('resultScreen');
    }

    // ==========================================
    // 8. MATCH INIT & PEERJS ONLINE MULTIPLAYER
    // ==========================================
    function initMatch(role = 'host') {
        state.role = role;
        state.innings = 1;
        state.battingSide = 'p1';
        state.target = null;
        state.p1 = { score: 0, wickets: 0, balls: 0 };
        state.p2 = { score: 0, wickets: 0, balls: 0 };
        state._squads = freshSquads();
        state.scorecardHistory = [];
        state.currentOverRuns = 0;
        state.aiMemory = { shotTypes: {}, dirs: {}, guards: {}, footwork: {}, bowlLines: {}, bowlLengths: {}, bowlVars: {}, boundaries: 0, ballsFaced: 0 };
        clearAllTimers();

        $('gameLog').innerHTML = '';
        if (!state.field.length) state.field = cloneField(state.fieldPreset || 'balanced');
        renderFielders();
        hideRunningPanel();
        resetRunningPositions();
        $('formatBadge').textContent = `${state.maxOvers} OVERS • ${state.mode === 'ai' ? 'VS AI' : '2P ONLINE'}`;
        $('p1Label').textContent = state.mode === 'ai' ? 'YOUR TEAM' : (role === 'host' ? 'YOU (HOST)' : 'HOST (P1)');
        $('p2Label').textContent = state.mode === 'ai' ? `AI (${state.difficulty.toUpperCase()})` : (role === 'guest' ? 'YOU (GUEST)' : 'GUEST (P2)');
        $('connectionBadge').style.display = state.mode === 'online' ? 'inline-block' : 'none';

        showScreen('gameScreen');
        addLog(`Match Started: ${state.maxOvers} Overs per side.`);
        // Online: skip the toss to keep both sides in sync — host bats first.
        if (state.mode === 'online') {
            state.tossDone = true;
            startInningsData('p1');
            prepareNextBall();
            return;
        }
        // Solo: toss first
        state.tossDone = false;
        const tp = $('tossPanel');
        if (tp) tp.style.display = 'block';
        $('tossMsg').textContent = 'Heads or tails? Winner chooses to bat or bowl.';
        $('tossChoiceGroup').style.display = 'none';
        $('tossCallGroup').style.display = 'flex';
        updatePlayersStrip();
    }
    function doToss(call) {
        const result = Math.random() < 0.5 ? 'heads' : 'tails';
        const won = call === result;
        $('tossMsg').textContent = `It is ${result}! You ${won ? 'won' : 'lost'} the toss.`;
        if (won) {
            $('tossCallGroup').style.display = 'none';
            $('tossChoiceGroup').style.display = 'flex';
        } else {
            // AI wins: it bats first 70% of the time
            const aiBats = Math.random() < 0.7;
            $('tossMsg').textContent += aiBats ? ' AI chooses to bat first.' : ' AI chooses to bowl first — you bat.';
            setTimeout(() => { if ($('gameScreen').classList.contains('active')) finishToss(aiBats ? 'p2' : 'p1'); }, 900);
        }
    }
    function finishToss(battingSide) {
        state.tossDone = true;
        state.battingSide = battingSide;
        const tp = $('tossPanel');
        if (tp) tp.style.display = 'none';
        addLog(`Toss: ${battingSide === 'p1' ? $('p1Label').textContent : $('p2Label').textContent} bats first.`);
        startInningsData(battingSide);
        prepareNextBall();
    }

    $('startSoloBtn').addEventListener('click', () => {
        SoundFX.click();
        initMatch('host');
    });

    $('restartBtn').addEventListener('click', () => {
        SoundFX.click();
        clearAllTimers();
        const tp = $('tossPanel'); if (tp) tp.style.display = 'none';
        const sm = $('scorecardModal'); if (sm) sm.style.display = 'none';
        if (state.peer) { state.peer.destroy(); state.peer = null; }
        showScreen('startScreen');
    });
    // Toss, scorecard and replay buttons
    document.querySelectorAll('#tossCallGroup button').forEach(btn => {
        btn.addEventListener('click', () => { SoundFX.click(); doToss(btn.dataset.val); });
    });
    document.querySelectorAll('#tossChoiceGroup button').forEach(btn => {
        btn.addEventListener('click', () => {
            SoundFX.click();
            finishToss(btn.dataset.val === 'bat' ? 'p1' : 'p2');
        });
    });
    $('scorecardBtn').addEventListener('click', () => {
        SoundFX.click();
        renderScorecard();
        $('scorecardModal').style.display = 'flex';
    });
    $('scorecardCloseBtn').addEventListener('click', () => {
        SoundFX.click();
        $('scorecardModal').style.display = 'none';
    });
    $('scorecardModal').addEventListener('click', (e) => {
        if (e.target === $('scorecardModal')) $('scorecardModal').style.display = 'none';
    });
    $('replayBtn').addEventListener('click', () => { SoundFX.click(); replayLastBall(); });

    function sendNet(payload) {
        if (state.conn && state.conn.open) state.conn.send(payload);
    }

    function setupConnectionHandlers(conn, isHost) {
        state.conn = conn;
        conn.on('open', () => {
            if (isHost) {
                sendNet({ type: 'START_MATCH', maxOvers: state.maxOvers });
                initMatch('host');
            }
        });

        conn.on('data', (data) => {
            if (!data || typeof data !== 'object') return;

            if (data.type === 'START_MATCH' && !isHost) {
                state.maxOvers = Number(data.maxOvers) || 5;
                initMatch('guest');
            }

            if (data.type === 'BOWL_DELIVERY' && isLocalBatting()) {
                launchBallFlight(data.delivery, null);
            }

            if (data.type === 'BATTER_SHOT' && isHost && !isLocalBatting() && state.activeDelivery) {
                const outcome = resolveBall(state.activeDelivery, data.shot);
                sendNet({ type: 'BALL_RESULT', delivery: state.activeDelivery, shot: data.shot, outcome });
                finishFlightAndResolve(state.activeDelivery, data.shot, outcome);
            }

            if (data.type === 'BALL_RESULT' && !isHost) {
                finishFlightAndResolve(data.delivery, data.shot, data.outcome);
            }
        });

        conn.on('close', () => {
            $('statusMsg').textContent = '⚠️ Opponent disconnected from the match.';
            addLog('Opponent disconnected.', 'wicket');
            showScreen('startScreen');
        });
    }

    $('createRoomBtn').addEventListener('click', () => {
        SoundFX.click();
        if (typeof Peer === 'undefined') {
            $('lobbyStatus').textContent = 'PeerJS failed to load. Check internet connection.';
            return;
        }
        $('lobbyStatus').textContent = 'Creating online room...';
        const roomId = 'CRICKET-' + Math.random().toString(36).substring(2, 7).toUpperCase();
        state.peer = new Peer(roomId);

        state.peer.on('open', (id) => {
            $('lobbyStatus').textContent = `Room Ready! Share this code with Player 2: ${id}`;
        });

        state.peer.on('connection', (conn) => {
            setupConnectionHandlers(conn, true);
        });
    });

    $('joinRoomBtn').addEventListener('click', () => {
        SoundFX.click();
        const code = $('joinRoomInput').value.trim().toUpperCase();
        if (!code) return;
        $('lobbyStatus').textContent = `Connecting to ${code}...`;
        state.peer = new Peer();
        state.peer.on('open', () => {
            const conn = state.peer.connect(code);
            setupConnectionHandlers(conn, false);
        });
    });
})();
