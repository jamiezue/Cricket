(() => {
    'use strict';

    const PLAYERS_PER_TEAM = 11;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    // ==========================================
    // 0. PHYSICS CONSTANTS (ground units = % of the stage, times in seconds)
    // ==========================================
    const PH = {
        pitchLenM: 18.5,          // release point -> batter, metres
        pitchTop: 27,             // ground y of the bowler's crease
        pitchBottom: 83,          // ground y of the striker's stumps
        pitchHalf: 9,             // half pitch width in ground units
        stumpHalf: 0.85,          // half stump width
        padHalf: 1.6,             // half width of the batter's pads/body when standing still (~0.27 m)
        padHalfSwing: 0.6,        // while playing (and missing) a shot the pad is partly out of the ball's line
        ballR: 0.15,
        wideLimit: 5.6,           // |x-50| beyond which it is a wide
        swingMs: 190,             // bat swing duration (press -> contact)
        fielderSpeed: 7.5,        // units / s
        reaction: 0.18,
        gather: 0.32,             // pick-up + release
        diveReach: 1.6,
        throwSpeed: 30,           // units / s
        relay: 0.35,
        runCross: 2.45,           // seconds per run (22 yards)
        runStart: 0.30,
        rope: { cx: 50, cy: 59, rx: 45, ry: 36.9 },
        ring: { cx: 50, cy: 60.6, rx: 26, ry: 26.2 },
        keeperEnd: { x: 50, y: 85 },
        bowlerEnd: { x: 50, y: 29 }
    };

    // ==========================================
    // 1. PROCEDURAL WEB AUDIO ENGINE
    // ==========================================
    const SoundFX = (() => {
        let ctx = null;
        let muted = false;

        function ensureCtx() {
            if (!ctx) {
                const AudioCtx = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
                if (AudioCtx) ctx = new AudioCtx();
            }
            if (ctx && ctx.state === 'suspended') ctx.resume();
            return ctx;
        }

        function playTone(freq, endFreq, duration, type = 'sine', gainVal = 0.18) {
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

        function playNoise(duration, filterFreq, filterType = 'bandpass', gainVal = 0.22) {
            if (muted) return;
            const c = ensureCtx();
            if (!c) return;
            const bufferSize = Math.floor(c.sampleRate * duration);
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
            click() { playTone(620, 420, 0.04, 'triangle', 0.07); },
            bowlWhoosh() { playNoise(0.2, 950, 'bandpass', 0.12); },
            pitchBounce() { playTone(165, 72, 0.07, 'sine', 0.2); },
            batDefend() {
                playTone(250, 115, 0.08, 'triangle', 0.18);
                playNoise(0.05, 1100, 'highpass', 0.09);
            },
            batCrack(power = 1) {
                playTone(440 * power, 125, 0.12, 'triangle', 0.34);
                playNoise(0.08, 2500, 'bandpass', 0.28);
            },
            stumpsShatter() {
                playNoise(0.3, 1900, 'highpass', 0.34);
                playTone(340, 85, 0.22, 'sawtooth', 0.22);
            },
            crowdRoar(big = false) {
                playNoise(big ? 1.4 : 0.8, 620, 'lowpass', big ? 0.26 : 0.14);
                if (big) playTone(523.25, 659.25, 0.26, 'triangle', 0.1);
            }
        };
    })();

    // ==========================================
    // 2. STATE & SQUADS
    // ==========================================
    const state = {
        maxOvers: 5,
        mode: 'ai',
        difficulty: 'normal',
        timeScale: 1,
        role: 'host',
        innings: 1,
        battingSide: 'p1',
        target: null,
        p1: { score: 0, wickets: 0, balls: 0 },
        p2: { score: 0, wickets: 0, balls: 0 },
        activeDelivery: null,
        plan: null,
        ballInFlight: false,
        busy: false,            // ball is live / being resolved
        swingDone: false,
        pendingShot: null,
        flightT0: 0,
        flightAnimId: null,
        pathAnimId: null,
        peer: null,
        conn: null,
        cameraMode: 'batter',
        povBowler: false,
        endsSwapped: false,
        fieldPreset: 'balanced',
        field: [],
        aimX: 50,
        aimY: 56,
        shotAngle: 0,
        deliveryId: 0,
        runUpTimers: [],
        phaseTimers: [],
        replayFrames: [],
        recording: false,
        replaying: false,
        freeHit: false,
        powerplay: true,
        extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
        autoBallTimer: null,
        preCall: 0,
        decide: null,
        strikerIdx: 0,
        nonStrikerIdx: 1,
        nextBatterIdx: 2,
        currentBowlerIdx: 0,
        lastBowlerIdx: -1,
        overRuns: [],
        currentOverRuns: 0,
        wagonShots: [],
        aiMemory: { shotTypes: {}, footwork: {}, ballsFaced: 0 },
        inningsData: null,
        scorecardHistory: [],
        conditions: null,
        _squads: null
    };

    const $ = (id) => document.getElementById(id);
    const on = (id, ev, fn) => {
        const el = $(id);
        if (!el) return null;
        el.addEventListener(ev, fn);
        return el;
    };
    const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    const setStatus = (msg) => setText('statusMsg', msg);
    const showEl = (id, display) => { const el = $(id); if (el) el.style.display = display; };
    const setDisabled = (id, v) => { const el = $(id); if (el) el.disabled = v; };

    const toScreen = (x, y) => state.povBowler ? { x: 100 - x, y: 100 - y } : { x, y };
    const toGround = (x, y) => state.povBowler ? { x: 100 - x, y: 100 - y } : { x, y };

    // ---------- perspective: pitch units -> screen % ----------
    const geom = { vw: 1000, vh: 700, top: 160, h: 430, w: 300 };
    function recalcGeom() {
        const strip = $('pitchStrip');
        const stage = $('cameraStage');
        if (!strip || !stage) return;
        // layout (untransformed) metrics, so the fixed scene scale never skews the maths
        if (!strip.offsetHeight) return;
        geom.vw = stage.offsetWidth || window.innerWidth || 1000;
        geom.vh = stage.offsetHeight || window.innerHeight || 700;
        geom.top = strip.offsetTop;
        geom.h = strip.offsetHeight;
        geom.w = strip.offsetWidth;
    }
    // % of viewport width covered by one ground unit across the pitch at screen-y %
    function unitPct(sy) {
        const rr = clamp((sy / 100 * geom.vh - geom.top) / geom.h, 0, 1.2);
        const halfPx = geom.w / 2 * (0.3 + 0.7 * rr);
        return (halfPx / PH.pitchHalf) / geom.vw * 100;
    }
    function unitPx(sy) { return unitPct(sy) / 100 * geom.vw; }
    // ball on the pitch (ground coords) -> screen %
    function projectBall(gx, gy) {
        const sy = state.povBowler ? 100 - gy : gy;
        const off = (gx - 50) * (state.povBowler ? -1 : 1);
        return { x: 50 + off * unitPct(sy), y: sy };
    }
    function unprojectPitchX(sxPct, syPct) {
        const off = (sxPct - 50) / unitPct(syPct);
        return 50 + off * (state.povBowler ? -1 : 1);
    }

    const strikerWrap = () => state.endsSwapped ? $('nonStriker') : $('batsman');
    const otherWrap = () => state.endsSwapped ? $('batsman') : $('nonStriker');

    function placeFigures() {
        const bf = $('batterFigure'), rf = $('nonStrikerFigure');
        const sw = strikerWrap(), ow = otherWrap();
        if (bf && sw && bf.parentElement !== sw) sw.appendChild(bf);
        if (rf && ow && rf.parentElement !== ow) ow.appendChild(rf);
    }

    function resetEnds() {
        if (!state.endsSwapped) return;
        state.endsSwapped = false;
        const pitch = $('pitch');
        if (pitch) pitch.classList.remove('ends-swapped');
        placeFigures();
        const b = $('batsman'), n = $('nonStriker');
        if (b) b.style.transform = '';
        if (n) n.style.transform = '';
    }

    function hideBallVisual() {
        if (state.pathAnimId) {
            cancelAnimationFrame(state.pathAnimId);
            state.pathAnimId = null;
        }
        const ball = $('ball'), shadow = $('ballShadow');
        if (ball) {
            ball.style.opacity = '0';
            ball.style.transform = 'translate(-50%, -50%) scale(1)';
        }
        if (shadow) {
            shadow.style.opacity = '0';
            shadow.style.transform = 'translate(-50%, -50%)';
        }
    }

    function clearPendingTimers() {
        state.runUpTimers.forEach(clearTimeout);
        state.runUpTimers = [];
        state.phaseTimers.forEach(clearTimeout);
        state.phaseTimers = [];
        if (state.autoBallTimer) {
            clearTimeout(state.autoBallTimer);
            state.autoBallTimer = null;
        }
    }

    // timer that dies when the next delivery starts
    function after(sec, fn) {
        const id = state.deliveryId;
        const h = setTimeout(() => { if (id === state.deliveryId) fn(); }, Math.max(0, sec * 1000));
        state.phaseTimers.push(h);
        return h;
    }

    const VENUES = [
        { name: 'R. Premadasa Stadium, Colombo' },
        { name: "Lord's, London" },
        { name: 'Melbourne Cricket Ground' },
        { name: 'Eden Gardens, Kolkata' },
        { name: 'Newlands, Cape Town' }
    ];

    function generateConditions() {
        const venue = pick(VENUES);
        const weather = pick(['Sunny', 'Sunny', 'Partly Cloudy', 'Overcast', 'Humid', 'Light Drizzle']);
        const tempC = weather === 'Sunny' ? 30 : weather === 'Overcast' ? 20 : 25;
        const humidity = weather === 'Humid' ? 84 : weather === 'Light Drizzle' ? 92 : 55;
        const windKmh = 6 + Math.floor(Math.random() * 20);
        const dew = Math.round(Math.min(90, Math.max(10, (humidity - 50) * 1.5)));
        const pitch = pick(['Flat Track', 'Green Seamer', 'Dry Turner', 'Two-Paced']);
        state.conditions = { venue: venue.name, weather, tempC, humidity, windKmh, dew, pitch };
        renderConditions();
    }

    function renderConditions() {
        const c = state.conditions;
        if (!c) return;
        setText('condVenue', `🏟️ ${c.venue}`);
        setText('condWeather', `${c.weather === 'Sunny' ? '☀️' : c.weather === 'Light Drizzle' ? '🌧️' : '⛅'} ${c.weather} ${c.tempC}°C`);
        setText('condPitch', `🌱 ${c.pitch}`);
        const sky = $('stadiumSky');
        if (sky) {
            sky.classList.toggle('overcast', c.weather === 'Overcast');
            sky.classList.toggle('night', c.weather === 'Overcast' && c.tempC <= 20);
            sky.classList.toggle('drizzle', c.weather === 'Light Drizzle');
        }
        const strip = $('pitchStrip');
        if (strip) strip.classList.toggle('dewy', c.dew >= 50);
    }

    function makePlayer(name, timing, power, bowlType, bowlSkill) {
        return {
            name, timing, power, bowlType, bowlSkill,
            batRuns: 0, batBalls: 0, fours: 0, sixes: 0, outHow: null, out: false,
            bowlBalls: 0, bowlRuns: 0, bowlWkts: 0, oversBowled: 0, fatigue: 0
        };
    }

    const SQUADS = {
        p1: [
            makePlayer('A. Perera', 88, 82, 'pace', 62), makePlayer('K. Mendis', 85, 78, 'spin', 68),
            makePlayer('D. de Silva', 82, 84, 'spin', 72), makePlayer('C. Asalanka', 84, 86, 'medium', 58),
            makePlayer('P. Nissanka', 80, 76, 'medium', 55), makePlayer('W. Hasaranga', 76, 88, 'spin', 85),
            makePlayer('D. Shanaka', 74, 90, 'medium', 74), makePlayer('M. Theekshana', 64, 65, 'spin', 83),
            makePlayer('D. Chameera', 55, 62, 'pace', 82), makePlayer('M. Pathirana', 48, 55, 'pace', 84),
            makePlayer('A. Fernando', 44, 50, 'pace', 76)
        ],
        p2: [
            makePlayer('R. Sharma', 89, 88, 'spin', 60), makePlayer('V. Kohli', 92, 84, 'medium', 58),
            makePlayer('S. Yadav', 86, 90, 'medium', 55), makePlayer('R. Pant', 82, 87, 'pace', 50),
            makePlayer('H. Pandya', 80, 89, 'pace', 79), makePlayer('R. Jadeja', 78, 80, 'spin', 82),
            makePlayer('A. Patel', 72, 76, 'spin', 78), makePlayer('K. Yadav', 60, 62, 'spin', 84),
            makePlayer('J. Bumrah', 54, 60, 'pace', 91), makePlayer('M. Siraj', 48, 55, 'pace', 81),
            makePlayer('A. Singh', 45, 52, 'pace', 80)
        ]
    };

    function freshSquads() {
        const copy = {};
        Object.keys(SQUADS).forEach(k => {
            copy[k] = SQUADS[k].map(pl => makePlayer(pl.name, pl.timing, pl.power, pl.bowlType, pl.bowlSkill));
        });
        return copy;
    }

    function maxBowlerOvers() { return Math.max(1, Math.floor(state.maxOvers / 5)); }
    function currentStriker() { return state.inningsData ? state.inningsData.batting[state.strikerIdx] : null; }
    function currentNonStriker() { return state.inningsData ? state.inningsData.batting[state.nonStrikerIdx] : null; }
    function currentBowler() { return state.inningsData ? state.inningsData.bowling[state.currentBowlerIdx] : null; }

    function bowlerAvailable(idx) {
        const squad = state.inningsData ? state.inningsData.bowling : [];
        const b = squad[idx];
        return Boolean(b && idx !== state.lastBowlerIdx && b.oversBowled < maxBowlerOvers());
    }

    function updateHud() {
        const team = state[state.battingSide];
        if (!team) return;
        const tag = state.battingSide === 'p1' ? 'YOU' : (state.mode === 'ai' ? 'AI' : 'P2');
        setText('battingTeamTag', tag);
        setText('liveScore', team.score);
        setText('liveWickets', team.wickets);
        setText('liveOvers', `(${Math.floor(team.balls / 6)}.${team.balls % 6}/${state.maxOvers})`);

        if (state.target !== null) {
            showEl('targetBadge', 'inline-block');
            const need = Math.max(0, state.target - team.score);
            const left = Math.max(0, state.maxOvers * 6 - team.balls);
            setText('targetBadge', `NEED ${need} OFF ${left}B`);
        } else {
            showEl('targetBadge', 'none');
        }

        showEl('freeHitBadge', state.freeHit ? 'inline-block' : 'none');
        showEl('powerplayBadge', state.powerplay ? 'inline-block' : 'none');

        const st = currentStriker(), ns = currentNonStriker(), bw = currentBowler();
        const sh = $('strikerHud'); if (st && sh) sh.innerHTML = `🏏 <b>${st.name}</b> ${st.batRuns} (${st.batBalls})`;
        const nh = $('nonStrikerHud'); if (ns && nh) nh.innerHTML = `<b>${ns.name}</b> ${ns.batRuns} (${ns.batBalls})`;
        const bh = $('bowlerHud'); if (bw && bh) bh.innerHTML = `⚾ <b>${bw.name}</b> ${bw.bowlWkts}/${bw.bowlRuns} (${Math.floor(bw.bowlBalls / 6)}.${bw.bowlBalls % 6})`;
    }

    function renderBowlerDropdown() {
        const sel = $('bowlerSelectDropdown');
        if (!sel || !state.inningsData) return;
        sel.innerHTML = '';
        state.inningsData.bowling.forEach((b, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = `${b.name} (${b.bowlType}, ${b.oversBowled}/${maxBowlerOvers()} ov)`;
            opt.disabled = !bowlerAvailable(i) && i !== state.currentBowlerIdx;
            if (i === state.currentBowlerIdx) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    // ==========================================
    // 3. PITCH AIM & 360° SHOT AIM
    // ==========================================
    function getLengthLabelFromY(yPct) {
        if (yPct >= 69) return 'Yorker';
        if (yPct >= 57) return 'Full';
        if (yPct >= 43) return 'Good Length';
        return 'Short';
    }
    function getLengthCategoryFromY(yPct) {
        if (yPct >= 69) return 'yorker';
        if (yPct >= 57) return 'full';
        if (yPct >= 43) return 'good';
        return 'short';
    }

    function updatePitchReticle() {
        const marker = $('pitchMarker');
        if (!marker) return;
        const sc = projectBall(state.aimX, state.aimY);
        marker.style.left = `${sc.x}%`;
        marker.style.top = `${sc.y}%`;
        setText('lengthLabel', getLengthLabelFromY(state.aimY).toUpperCase());
    }

    function bindPitchAiming() {
        const stage = $('cameraStage');
        const strip = $('pitchStrip');
        if (!stage || !strip) return;

        let aiming = false;
        const setAimFromPointer = (clientX, clientY) => {
            if (isLocalBatting() || state.busy) return;
            const r = stage.getBoundingClientRect();
            const sx = ((clientX - r.left) / r.width) * 100;
            const sy = ((clientY - r.top) / r.height) * 100;
            const gy = state.povBowler ? 100 - sy : sy;
            const gx = unprojectPitchX(sx, sy);
            state.aimX = clamp(gx, 41, 59);
            state.aimY = clamp(gy, 36, 75);
            updatePitchReticle();
        };

        strip.addEventListener('pointerdown', (e) => {
            if (isLocalBatting() || state.busy) return;
            aiming = true;
            SoundFX.click();
            setAimFromPointer(e.clientX, e.clientY);
        });

        window.addEventListener('pointermove', (e) => {
            if (aiming) setAimFromPointer(e.clientX, e.clientY);
            if (isLocalBatting() && !state.swingDone) {
                const ratio = (e.clientX / window.innerWidth) * 2 - 1;
                state.shotAngle = Math.round(ratio * 130);
                updateShotAimGuide();
            }
        });

        window.addEventListener('pointerup', () => { aiming = false; });
        window.addEventListener('resize', () => { recalcGeom(); updateVisualPositions(); updatePitchReticle(); });
    }

    function updateShotAimGuide() {
        const guide = $('shotAimGuide');
        if (!guide) return;
        guide.style.transform = `translateX(-50%) rotate(${state.shotAngle}deg)`;
    }

    // ==========================================
    // 4. FIELD PLACEMENT
    // ==========================================
    const FIELD_PRESETS = {
        attacking: [
            { id: 'slip1', short: 'SLIP', x: 44, y: 89 },
            { id: 'gully', short: 'GULLY', x: 34, y: 86 },
            { id: 'point', short: 'POINT', x: 25, y: 56 },
            { id: 'cover', short: 'COVER', x: 31, y: 42 },
            { id: 'midoff', short: 'MID-OFF', x: 42, y: 34 },
            { id: 'midon', short: 'MID-ON', x: 58, y: 34 },
            { id: 'sqleg', short: 'SQ LEG', x: 74, y: 56 },
            { id: 'fineleg', short: 'FINE', x: 66, y: 89 },
            { id: 'shortleg', short: 'S-LEG', x: 60, y: 68 }
        ],
        balanced: [
            { id: 'slip1', short: 'SLIP', x: 44, y: 89 },
            { id: 'point', short: 'POINT', x: 24, y: 55 },
            { id: 'cover', short: 'COVER', x: 29, y: 40 },
            { id: 'midoff', short: 'MID-OFF', x: 41, y: 33 },
            { id: 'midon', short: 'MID-ON', x: 59, y: 33 },
            { id: 'sqleg', short: 'SQ LEG', x: 76, y: 55 },
            { id: 'fineleg', short: 'FINE', x: 67, y: 89 },
            { id: 'longoff', short: 'LONG-OFF', x: 35, y: 24 },
            { id: 'deepmid', short: 'D-MIDWKT', x: 78, y: 32 }
        ],
        defensive: [
            { id: 'deeppt', short: 'D-POINT', x: 16, y: 52 },
            { id: 'deepcov', short: 'D-COVER', x: 22, y: 34 },
            { id: 'longoff', short: 'LONG-OFF', x: 36, y: 23 },
            { id: 'longon', short: 'LONG-ON', x: 64, y: 23 },
            { id: 'deepmid', short: 'D-MIDWKT', x: 80, y: 34 },
            { id: 'deepsq', short: 'D-SQ', x: 84, y: 54 },
            { id: 'deepfine', short: 'D-FINE', x: 76, y: 90 },
            { id: 'thirdman', short: '3RD MAN', x: 24, y: 90 },
            { id: 'midoff', short: 'MID-OFF', x: 42, y: 36 }
        ]
    };

    function isOutsideRing(x, y) {
        const R = PH.ring;
        const dx = (x - R.cx) / R.rx;
        const dy = (y - R.cy) / R.ry;
        return (dx * dx + dy * dy) > 1.0;
    }
    function countOutsideFielders() {
        return state.field.filter(f => isOutsideRing(f.x, f.y)).length;
    }

    function setFieldPreset(name) {
        if (!FIELD_PRESETS[name]) return;
        state.fieldPreset = name;
        state.field = FIELD_PRESETS[name].map(f => ({ ...f }));
        if (state.powerplay) {
            let outside = 0;
            state.field.forEach(f => {
                if (isOutsideRing(f.x, f.y)) {
                    outside++;
                    if (outside > 2) {
                        f.x = PH.ring.cx + (f.x - PH.ring.cx) * 0.62;
                        f.y = PH.ring.cy + (f.y - PH.ring.cy) * 0.62;
                    }
                }
            });
        }
        renderFielders();
        document.querySelectorAll('#fieldPresetGroup button').forEach(b => b.classList.toggle('active', b.dataset.val === name));
    }

    function fielderEl(id) { return document.querySelector(`.fielder[data-id="${id}"]`); }

    function renderFielders() {
        const box = $('fielders');
        if (!box) return;
        box.innerHTML = '';
        state.field.forEach(f => {
            const el = document.createElement('div');
            const sc = toScreen(f.x, f.y);
            el.className = 'fielder' + (sc.y < 36 ? ' far' : sc.y > 70 ? ' near' : '');
            el.dataset.id = f.id;
            el.style.left = `${sc.x}%`;
            el.style.top = `${sc.y}%`;
            el.innerHTML = `<span class="fielder-head"></span><span class="fielder-body"></span><span class="fielder-label">${f.short}</span>`;

            let dragging = false;
            el.addEventListener('pointerdown', (e) => {
                if (isLocalBatting() || state.busy) return;
                e.stopPropagation();
                dragging = true;
                el.classList.add('dragging');
                const stage = $('cameraStage');
                const onMove = (ev) => {
                    if (!dragging) return;
                    const r = stage.getBoundingClientRect();
                    const sx = ((ev.clientX - r.left) / r.width) * 100;
                    const sy = ((ev.clientY - r.top) / r.height) * 100;
                    const g = toGround(sx, sy);
                    const nx = clamp(g.x, 8, 92);
                    const ny = clamp(g.y, 22, 90);

                    if (state.powerplay && isOutsideRing(nx, ny) && !isOutsideRing(f.x, f.y) && countOutsideFielders() >= 2) {
                        setStatus('⚠️ Powerplay: Max 2 fielders outside the 30-yard circle.');
                        return;
                    }
                    f.x = nx;
                    f.y = ny;
                    const sc2 = toScreen(nx, ny);
                    el.style.left = `${sc2.x}%`;
                    el.style.top = `${sc2.y}%`;
                    el.classList.toggle('far', sc2.y < 36);
                    el.classList.toggle('near', sc2.y > 70);
                };
                const onUp = () => {
                    dragging = false;
                    el.classList.remove('dragging');
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
            });

            box.appendChild(el);
        });
    }

    // Move a fielder's DOM element to a ground position over `sec` seconds (linear run)
    function runFielder(id, pos, sec) {
        const el = fielderEl(id);
        if (!el) return;
        const s = toScreen(pos.x, pos.y);
        el.style.transition = `left ${Math.max(0.05, sec)}s linear, top ${Math.max(0.05, sec)}s linear, transform 0.25s ease`;
        el.style.left = `${s.x}%`;
        el.style.top = `${s.y}%`;
    }

    function resetFielders(sec = 0.9) {
        state.field.forEach(f => runFielder(f.id, f, sec));
        document.querySelectorAll('.fielder.catching').forEach(e => e.classList.remove('catching'));
    }

    // ==========================================
    // 5. VISUAL POSITIONS, CAMERA, RUN-UP
    // ==========================================
    function updateVisualPositions() {
        const guard = getActiveVal('batterGuardGroup');
        const depth = getActiveVal('footworkGroup');
        const guardOff = guard === 'off' ? -1.4 : guard === 'leg' ? 1.4 : 0;
        const batY = depth === 'advance' ? -18 : depth === 'back' ? 12 : 0;
        const wrap = strikerWrap();
        if (wrap && !wrap.classList.contains('running-exchange')) {
            const batSy = state.povBowler ? 20 : 82;
            const px = guardOff * unitPx(batSy);
            const sx = state.povBowler ? -px : px;
            const sy = state.povBowler ? -batY : batY;
            const sc = state.povBowler ? ' scale(0.75)' : '';
            wrap.style.transform = `translate(-50%, 0) translateX(${sx}px) translateY(${sy}px)${sc}`;
        }

        const angle = getActiveVal('bowlAngleGroup');
        const bowlEl = $('bowlerEnd');
        if (!bowlEl) return;
        const startX = angle === 'wide' ? 45 : angle === 'round' ? 55 : 48.5;
        const sy = state.povBowler ? 73 : 27;
        const px = (startX - 50) * unitPx(sy);
        bowlEl.style.setProperty('--bowler-x', `${state.povBowler ? -px : px}px`);
        refreshTimingBar();
    }

    function setCamera(mode) {
        const pitch = $('pitch');
        if (!pitch) return;
        state.cameraMode = mode;
        pitch.classList.remove('cam-bowler', 'cam-batter', 'cam-broadcast');
        pitch.classList.add(`cam-${mode}`);
        document.querySelectorAll('.hud-btn[data-cam]').forEach(b => b.classList.toggle('active', b.dataset.cam === mode));
    }

    function setPOV(onBowlerEnd) {
        if (state.povBowler === onBowlerEnd) return;
        state.povBowler = onBowlerEnd;
        const pitch = $('pitch');
        if (pitch) pitch.classList.toggle('pov-bowler', onBowlerEnd);
        showEl('povBadge', onBowlerEnd ? 'inline-block' : 'none');
        const be = $('bowlerEnd');
        if (be) { be.style.top = ''; be.style.bottom = ''; }
        updateVisualPositions();
        renderFielders();
        updatePitchReticle();
    }

    function updateCameraForRole() {
        if (isLocalBatting()) {
            setPOV(false);
            setCamera('batter');
            setStatus('Batting — full pitch in view.');
        } else {
            setPOV(true);
            setCamera('bowler');
            setStatus('Bowling — whole pitch visible. Aim and deliver!');
        }
    }

    function showBanner(bigText, subText, duration = 2000) {
        const big = $('bannerBig');
        const sub = $('ballResult');
        if (big) big.textContent = bigText;
        if (sub) sub.textContent = subText;
        if (bigText) {
            setTimeout(() => { if (big && big.textContent === bigText) big.textContent = ''; }, duration);
        }
    }

    function umpireSignal(kind) {
        const u = $('umpire');
        if (!u) return;
        u.classList.remove('signal-four', 'signal-six', 'signal-out', 'signal-wide');
        if (!kind) return;
        u.classList.add('signal-' + kind);
        setTimeout(() => { if (u) u.classList.remove('signal-' + kind); }, 1800);
    }

    function playBowlerRunUp(onRelease) {
        const fig = $('bowlerFigure');
        const end = $('bowlerEnd');
        const myId = state.deliveryId;
        const tracked = (fn, ms) => {
            const id = setTimeout(() => { if (myId === state.deliveryId) fn(); }, ms);
            state.runUpTimers.push(id);
        };

        if (end) {
            const prop = state.povBowler ? 'bottom' : 'top';
            const other = state.povBowler ? 'top' : 'bottom';
            const startAt = state.povBowler ? '25vh' : '14vh';
            const endAt = state.povBowler ? '16vh' : '21vh';
            end.style.transition = 'none';
            end.style[prop] = startAt;
            end.style[other] = 'auto';
            void end.offsetWidth;
            end.style.transition = 'transform 0.25s ease, top 0.85s linear, bottom 0.85s linear';
            end.style[prop] = endAt;
        }
        if (fig) {
            fig.classList.remove('delivering');
            fig.classList.add('running');
        }
        setStatus('Bowler running in...');

        tracked(() => {
            if (fig) {
                fig.classList.remove('running');
                fig.classList.add('delivering');
            }
            SoundFX.bowlWhoosh();
            tracked(() => {
                if (fig) fig.classList.remove('delivering');
                onRelease();
            }, 220);
        }, 850);
    }

    // ---------- ball drawing (screen % + height in px) ----------
    function drawBallScreen(sx, sy, h) {
        const ball = $('ball'), shadow = $('ballShadow');
        if (!ball) return;
        const r = clamp((sy - 23) / 62, 0, 1.2);
        const scale = 0.7 + 0.5 * r;
        const lift = h * (0.6 + 0.5 * r);
        ball.style.opacity = '1';
        ball.style.left = `${sx}%`;
        ball.style.top = `${sy}%`;
        ball.style.transform = `translate(-50%, -50%) translateY(${-lift.toFixed(1)}px) scale(${scale.toFixed(2)})`;
        if (shadow) {
            shadow.style.opacity = h > 24 ? '0.22' : '0.45';
            shadow.style.left = `${sx}%`;
            shadow.style.top = `${sy + 0.9}%`;
            shadow.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(2)})`;
        }
        if (state.recording) state.replayFrames.push({ x: sx, y: sy, h });
    }
    function drawBallGround(p) {
        const sc = toScreen(p.x, p.y);
        drawBallScreen(sc.x, sc.y, p.h || 0);
    }

    // ==========================================
    // 6. DELIVERY MODEL (one source of truth for the ball's line)
    // ==========================================
    function deliveryMoves(d) {
        const bw = currentBowler();
        const c = state.conditions || {};
        const seamMul = c.pitch === 'Green Seamer' ? 1.5 : c.pitch === 'Flat Track' ? 0.8 : 1;
        const spinMul = c.pitch === 'Dry Turner' ? 1.5 : c.pitch === 'Flat Track' ? 0.8 : c.pitch === 'Green Seamer' ? 0.7 : 1;
        const skill = bw ? 0.8 + bw.bowlSkill / 250 : 1;
        const humid = (c.humidity || 55) >= 80 ? 1.2 : 1;
        const spinF = clamp(1.35 - d.speed / 130, 0.45, 1);
        const sw = humid * seamMul * skill;
        const sp = spinMul * spinF * skill;
        const v = d.variation === 'spin' ? 'offspin' : d.variation;
        switch (v) {
            case 'inswing': return { air: 1.4 * sw, turn: 1.5 * sw };
            case 'outswing': return { air: -1.4 * sw, turn: -1.5 * sw };
            case 'legspin': return { air: -0.7 * sp, turn: -2.4 * sp };
            case 'offspin': return { air: 0.7 * sp, turn: 2.4 * sp };
            default: return { air: 0, turn: (d.angle === 'over' ? -0.4 : d.angle === 'round' ? 0.4 : 0) * seamMul };
        }
    }

    function planDelivery(d) {
        const startX = d.angle === 'wide' ? 45 : d.angle === 'round' ? 55 : 48.5;
        const aimX = clamp(d.aimX, 36, 64);
        const aimY = clamp(d.aimY, 36, 75);
        const mv = d.mv || deliveryMoves(d);
        const finalX = aimX + (aimX - startX) * 0.14 + mv.turn;
        const b = (aimY - PH.pitchTop) / (PH.pitchBottom - PH.pitchTop);
        const v = d.speed / 3.6;
        const ts = state.timeScale || 1;
        const tb = (b * PH.pitchLenM / v) * 1000 * ts;
        const ta = ((1 - b) * PH.pitchLenM / (v * 0.88)) * 1000 * ts;
        const bounceH = clamp(84 - (aimY - 36) * 2.1, 3, 84);
        return {
            startX, aimX, aimY, air: mv.air, turn: mv.turn, finalX,
            b, tb, T: tb + ta, bounceH, endH: bounceH * 0.368, relH: 55,
            lengthCat: getLengthCategoryFromY(aimY),
            wide: Math.abs(finalX - 50) > PH.wideLimit,
            pitchedLeg: aimX > 50 + PH.stumpHalf + 0.5
        };
    }

    // ball position along the delivery, t in ms since release (ground coords + height px)
    function ballAt(plan, t) {
        let gx, h, frac;
        if (t <= plan.tb) {
            const pre = plan.tb > 0 ? t / plan.tb : 1;
            frac = plan.b * pre;
            gx = lerp(plan.startX, plan.aimX, pre) + plan.air * (-2 * pre * (1 - pre));
            h = plan.relH * Math.pow(1 - pre, 1.3);
        } else {
            const post = clamp((t - plan.tb) / Math.max(1, plan.T - plan.tb), 0, 1);
            frac = plan.b + (1 - plan.b) * post;
            gx = plan.aimX + ((plan.aimX - plan.startX) * 0.14 + plan.turn) * post;
            h = plan.bounceH * Math.sin(post * Math.PI * 0.88);
        }
        return { gx, gy: PH.pitchTop + (PH.pitchBottom - PH.pitchTop) * frac, h };
    }

    function finalizeDelivery(d) {
        const bw = currentBowler();
        if (bw && bw.fatigue > 0.35) d.speed = Math.max(85, Math.round(d.speed - bw.fatigue * 8));
        d.mv = deliveryMoves(d);
        const plan = planDelivery(d);
        d.extra = plan.wide ? 'wide' : (Math.random() < (d.speed >= 150 ? 0.04 : 0.012) ? 'noball' : null);
        d.field = state.field.map(f => ({ ...f }));
        return d;
    }

    // ---------- batting timing ----------
    const tcFactor = (depth) => depth === 'advance' ? 0.9 : depth === 'back' ? 1.05 : 1;

    function timingWindows(plan) {
        const st = currentStriker();
        const perfect = Math.max(45, 0.085 * plan.T) + ((st ? st.timing : 72) - 72) * 0.5;
        return { perfect, good: perfect * 2.2, miss: perfect * 3.8 };
    }

    function classifyTiming(pressMs, plan, depth) {
        const win = timingWindows(plan);
        const err = pressMs + PH.swingMs - plan.T * tcFactor(depth);
        const a = Math.abs(err);
        if (a <= win.perfect) return 'perfect';
        if (a <= win.good) return 'good';
        if (a <= win.miss) return err < 0 ? 'early' : 'late';
        return 'miss';
    }

    function refreshTimingBar() {
        const plan = state.plan;
        if (!plan || !isLocalBatting()) return;
        const win = timingWindows(plan);
        const depth = getActiveVal('footworkGroup');
        const ideal = (plan.T * tcFactor(depth) - PH.swingMs) / plan.T * 100;
        const gP = win.good / plan.T * 100, pP = win.perfect / plan.T * 100;
        const set = (cls, v) => { const e = document.querySelector(`.t-seg.${cls}`); if (e) e.style.flex = `${Math.max(0.01, v)}`; };
        set('early', ideal - gP);
        set('good', gP - pP);
        set('sweet', 2 * pP);
        set('good2', gP - pP);
        set('late', 100 - (ideal + gP));
    }

    function playSwingAnim(type) {
        const fig = $('batterFigure');
        if (!fig) return;
        fig.classList.remove('anim-defend', 'anim-ground', 'anim-cutpull', 'anim-sweep', 'anim-loft');
        void fig.offsetWidth;
        fig.classList.add(`anim-${type}`);
        setTimeout(() => { if (fig) fig.classList.remove(`anim-${type}`); }, 600);
    }

    // ==========================================
    // 7. BALL FLIGHT (real time)
    // ==========================================
    function launchBallFlight(delivery, aiBatterShot = null) {
        if (state.flightAnimId) {
            cancelAnimationFrame(state.flightAnimId);
            state.flightAnimId = null;
        }
        clearPendingTimers();
        hideBallVisual();
        document.querySelectorAll('.fielder.catching').forEach(e => e.classList.remove('catching'));

        state.deliveryId += 1;
        const myId = state.deliveryId;
        state.replayFrames = [];
        state.recording = true;
        setDisabled('replayBtn', true);
        state.replaying = false;
        state.busy = true;
        state.swingDone = false;
        state.flightT0 = null;          // set at release; swings before the ball is released are ignored
        state.pendingShot = null;
        state.preCall = 0;
        state.decide = null;
        recalcGeom();

        if (delivery.extra === undefined) finalizeDelivery(delivery);
        const plan = planDelivery(delivery);
        state.plan = plan;
        state.activeDelivery = delivery;
        state.ballInFlight = true;

        const start = projectBall(plan.startX, PH.pitchTop);
        drawBallScreen(start.x, start.y, plan.relH);

        if (isLocalBatting()) {
            setDisabled('playShotBtn', false);
            showEl('runNowBtn', 'none');
            setText('runNowBtn', 'CALL RUN (R)');
            setDisabled('runNowBtn', false);
            refreshTimingBar();
        }

        const isSpin = ['legspin', 'offspin'].includes(delivery.variation);
        const aiSwings = aiBatterShot && aiBatterShot.type !== 'leave';

        playBowlerRunUp(() => {
            if (myId !== state.deliveryId || !state.ballInFlight) return;
            setStatus(isLocalBatting()
                ? 'Aim (Mouse/Arrows), crease (WASD), swing (SPACE)!'
                : `${(delivery.variation === 'legspin' ? 'Leg-spin' : delivery.variation === 'offspin' ? 'Off-spin' : delivery.variation === 'inswing' ? 'In-swing' : delivery.variation === 'outswing' ? 'Out-swing' : 'Seam')} — ball on its way.`);

            state.flightT0 = performance.now();
            let bounced = false;
            let aiSwung = false;

            const frame = (now) => {
                if (myId !== state.deliveryId || !state.ballInFlight) { state.flightAnimId = null; return; }
                const el = Math.min(now - state.flightT0, plan.T);
                const p = ballAt(plan, el);
                const sc = projectBall(p.gx, p.gy);
                drawBallScreen(sc.x, sc.y, p.h);
                const tc = $('timingCursor'); if (tc) tc.style.left = `${(el / plan.T) * 100}%`;

                if (!bounced && el >= plan.tb) { bounced = true; SoundFX.pitchBounce(); }
                if (aiSwings && !aiSwung && el >= plan.T - PH.swingMs) {
                    aiSwung = true;
                    playSwingAnim(aiBatterShot.type);
                }
                if (el >= plan.T) {
                    state.flightAnimId = null;
                    onBallArrived(delivery, plan, aiBatterShot);
                    return;
                }
                state.flightAnimId = requestAnimationFrame(frame);
            };
            state.flightAnimId = requestAnimationFrame(frame);
        });
    }

    function contactPointFor(plan) {
        const sc = projectBall(plan.finalX, 82.5);
        return toGround(sc.x, sc.y);
    }

    function onBallArrived(delivery, plan, aiBatterShot) {
        state.ballInFlight = false;
        const halo = $('timingHalo');
        if (halo) { halo.classList.remove('impact'); void halo.offsetWidth; halo.classList.add('impact'); }
        setDisabled('playShotBtn', true);

        let shot = aiBatterShot || state.pendingShot;
        if (!shot) {
            shot = {
                guard: getActiveVal('batterGuardGroup'),
                footwork: getActiveVal('footworkGroup'),
                type: 'leave', angle: 0, timing: 'none'
            };
        }
        if (!aiBatterShot && !isLocalBatting()) {
            // online bowler: wait for the batter's result
            setStatus('Waiting for the batter...');
            return;
        }
        submitBatterShot(shot);
    }

    function triggerBatterSwing() {
        if (!state.ballInFlight || state.swingDone || !isLocalBatting() || !state.flightT0) return;
        state.swingDone = true;
        const pressMs = performance.now() - state.flightT0;
        const depth = getActiveVal('footworkGroup');
        state.pendingShot = {
            guard: getActiveVal('batterGuardGroup'),
            footwork: depth,
            type: getActiveVal('shotTypeGroup'),
            angle: state.shotAngle,
            timing: classifyTiming(pressMs, state.plan, depth)
        };
        playSwingAnim(state.pendingShot.type);
        setDisabled('playShotBtn', true);
        showEl('runNowBtn', 'inline-block');
    }

    function submitBatterShot(shot) {
        if (isLocalBatting()) recordBatterTendency(shot);
        if (state.mode === 'ai') {
            finishFlightAndResolve(state.activeDelivery, shot);
        } else if (state.role === 'host') {
            const outcome = resolveBall(state.activeDelivery, shot);
            sendNet({ type: 'BALL_RESULT', delivery: state.activeDelivery, shot, outcome });
            finishFlightAndResolve(state.activeDelivery, shot, outcome);
        } else {
            sendNet({ type: 'BATTER_SHOT', shot });
            setStatus('Shot played...');
        }
    }

    // ==========================================
    // 8. HIT PHYSICS, FIELDING, THROWING
    // ==========================================
    function pathPos(p, t) {
        let d, h = 0;
        if (p.mode === 'ground') {
            d = p.vi * p.tau * (1 - Math.exp(-t / p.tau));
            h = 2.5 * Math.abs(Math.sin(t * 12)) * Math.exp(-t * 1.1);
        } else if (t < p.tf) {
            const u = t / p.tf;
            d = p.carry * u;
            h = p.H * 4 * u * (1 - u);
        } else {
            const tt = t - p.tf;
            d = p.carry + p.vr * p.tau2 * (1 - Math.exp(-tt / p.tau2));
            h = Math.abs(Math.sin(tt * 10)) * 4 * Math.exp(-tt * 1.4);
        }
        return { x: clamp(p.x0 + p.dx * d, 2, 98), y: clamp(p.y0 + p.dy * d, 20, 97), h, d };
    }
    function pathEndTime(p) { return p.mode === 'ground' ? p.tau * 5 : p.tf + p.tau2 * 5; }
    function insideRope(x, y) {
        const R = PH.rope;
        const dx = (x - R.cx) / R.rx, dy = (y - R.cy) / R.ry;
        return dx * dx + dy * dy < 1;
    }
    function ropeCrossTime(p) {
        const tEnd = pathEndTime(p);
        for (let t = 0; t <= tEnd; t += 0.02) {
            const q = pathPos(p, t);
            // unclamped position
            const ux = p.x0 + p.dx * q.d, uy = p.y0 + p.dy * q.d;
            if (!insideRope(ux, uy)) return t;
        }
        return null;
    }

    function allFielders() {
        const list = state.field.map(f => ({ id: f.id, short: f.short, x: f.x, y: f.y }));
        list.push({ id: 'keeper', short: 'KEEPER', x: 50, y: 88, virtual: true });
        list.push({ id: 'bowler', short: 'BOWLER', x: 50, y: 33, virtual: true });
        return list;
    }
    const reachTime = (f, P, dive) => PH.reaction + Math.max(0, dist(f, P) - dive) / PH.fielderSpeed;

    function simulateFielding(path, opts = {}) {
        const fielders = allFielders();
        const tRope = ropeCrossTime(path);
        const res = { tRope, boundary: 0, catchInfo: null, dropped: null, pick: null, backup: null };

        if (path.mode === 'air') {
            const ropeInAir = tRope !== null && tRope <= path.tf;
            const tCP = ropeInAir ? tRope : path.tf;
            const P = pathPos(path, tCP);
            let best = null, bt = Infinity;
            fielders.forEach(f => { const r = reachTime(f, P, 1.2); if (r < bt) { bt = r; best = f; } });
            if (best && !opts.noOut && bt <= tCP - 0.05) {
                const margin = tCP - bt;
                let p = clamp(0.38 + margin * 0.5, 0.38, 0.9);
                if (ropeInAir) p *= 0.6;
                if (Math.random() < p) {
                    res.catchInfo = { f: best.id, short: best.short, t: tCP, x: P.x, y: P.y };
                    return res;
                }
                res.dropped = { f: best.id, t: tCP };
            }
            if (ropeInAir) { res.boundary = 6; return res; }
        }

        const tStart = path.mode === 'air' ? path.tf : 0;
        const tEnd = tRope !== null ? tRope : pathEndTime(path) + 8;
        for (let t = tStart; t <= tEnd; t += 0.03) {
            const P = pathPos(path, t);
            let bestF = null, bestR = Infinity;
            fielders.forEach(f => {
                let r = reachTime(f, P, PH.diveReach);
                if (res.dropped && res.dropped.f === f.id) r += 0.45;
                if (r <= t + 1e-6 && r < bestR) { bestR = r; bestF = f; }
            });
            if (bestF) {
                res.pick = { f: bestF.id, short: bestF.short, t, x: P.x, y: P.y, virtual: !!bestF.virtual };
                break;
            }
        }
        if (!res.pick) {
            if (tRope !== null) { res.boundary = 4; return res; }
            const P = pathPos(path, tEnd);
            res.pick = { f: 'bowler', short: 'BOWLER', t: tEnd, x: P.x, y: P.y, virtual: true };
        }
        // second-nearest fielder backs up
        let b2 = null, br = Infinity;
        fielders.forEach(f => {
            if (f.id === res.pick.f || f.virtual) return;
            const r = reachTime(f, res.pick, PH.diveReach);
            if (r < br) { br = r; b2 = f; }
        });
        if (b2) res.backup = { f: b2.id, t: br };
        return res;
    }

    function endPoint(e) { return e === 'B' ? PH.bowlerEnd : PH.keeperEnd; }

    // Evaluate attempted runs against the fielder's throw. Times are seconds since contact.
    function evalRuns(sim, n, tcall, safety = null) {
        const P = sim.pick;
        const tRel = P.t + PH.gather;
        const Tk = (k) => tcall + PH.runStart + k * PH.runCross;
        const res = { n, completed: n, runOutAt: 0, outBatter: null, throws: [], tEnd: 0, tcall };
        let kcur = 0;
        for (let k = 1; k <= n; k++) { if (Tk(k) > tRel) { kcur = k; break; } }

        if (!kcur) {
            const d = dist(P, PH.bowlerEnd);
            const t1 = tRel + d / PH.throwSpeed;
            res.throws.push({ from: { x: P.x, y: P.y }, to: PH.bowlerEnd, t0: tRel, t1 });
            res.tEnd = Math.max(n > 0 ? Tk(n) + 0.25 : 0, t1 + 0.25);
            return res;
        }

        const dB = dist(P, PH.bowlerEnd), dK = dist(P, PH.keeperEnd);
        let end = dB < dK ? 'B' : 'K';
        const len = Math.min(dB, dK);
        let arr = tRel + len / PH.throwSpeed;
        res.throws.push({ from: { x: P.x, y: P.y }, to: endPoint(end), t0: tRel, t1: arr });
        let prevEnd = end;
        let lastArr = arr;
        for (let k = kcur; k <= n; k++) {
            if (k > kcur) {
                const e2 = prevEnd === 'B' ? 'K' : 'B';
                const t0 = lastArr + PH.relay;
                const t1 = t0 + dist(endPoint(prevEnd), endPoint(e2)) / PH.throwSpeed;
                res.throws.push({ from: endPoint(prevEnd), to: endPoint(e2), t0, t1 });
                lastArr = t1; prevEnd = e2;
            }
            const margin = Tk(k) - lastArr;
            const contested = safety !== null ? (lastArr < Tk(k) + safety) : margin > 0.04;
            if (contested) {
                let p = prevEnd === 'K' ? 0.9 : 0.74;
                if (k === kcur && len > 35) p -= 0.15;
                if (safety !== null) p = 1;
                if (Math.random() < p) {
                    res.runOutAt = k;
                    res.completed = k - 1;
                    const odd = k % 2 === 1;
                    res.outBatter = (odd ? prevEnd === 'B' : prevEnd === 'K') ? 'striker' : 'nonstriker';
                    res.tEnd = lastArr + 0.5;
                    return res;
                }
            }
        }
        res.tEnd = Math.max(Tk(n) + 0.25, lastArr + 0.25);
        return res;
    }

    function aiChooseRuns(sim, tcall) {
        const margin = state.mode === 'ai'
            ? (state.difficulty === 'easy' ? 0.5 : state.difficulty === 'hard' ? 0.15 : 0.3)
            : 0.3;
        for (let n = 3; n >= 1; n--) {
            const ev = evalRuns(sim, n, tcall, margin);
            if (!ev.runOutAt) return n;
        }
        return 0;
    }

    // ---------- building a hit ----------
    function shotQuality(shot, plan, lineErr, bw) {
        let score = shot.timing === 'perfect' ? 3 : shot.timing === 'good' ? 2 : 1;
        if (lineErr > 2.6) score -= 1;
        if (bw && Math.random() < Math.max(0, (bw.bowlSkill - 68) * 0.006)) score -= 1;
        const len = plan.lengthCat;
        const fw = shot.footwork;
        const eff = (fw === 'advance' && len === 'good') ? 'full' : len;
        const okDepth =
            (eff === 'short' && fw === 'back') ||
            ((eff === 'full' || eff === 'yorker') && fw !== 'back') ||
            (eff === 'good' && fw !== 'back');
        const okShot =
            (eff === 'short' && (shot.type === 'cutpull' || shot.type === 'defend')) ||
            (eff === 'yorker' && (shot.type === 'defend' || shot.type === 'ground')) ||
            ((eff === 'good' || eff === 'full') && ['ground', 'sweep', 'loft', 'defend'].includes(shot.type));
        if (!okDepth) score -= 1;
        if (!okShot) score -= 1;
        return clamp(score, 1, 3);
    }

    function buildHit(shot, q, contact, noRand = false) {
        const mist = q === 1;
        let angle = shot.angle;
        if (!noRand) {
            const j = q === 3 ? 2 : q === 2 ? 6 : 18 + Math.random() * 22;
            angle += (Math.random() < 0.5 ? -1 : 1) * Math.random() * j;
        }
        let edge = false;
        let mode = 'ground';
        let vi = 20, tau = 1.3, carry = 0, tf = 1, H = 0;
        switch (shot.type) {
            case 'defend': vi = [0, 9, 9, 7][q]; tau = 0.5; break;
            case 'ground': vi = [0, 22, 27, 44][q]; tau = 1.4; break;
            case 'cutpull': vi = [0, 21, 26, 42][q]; tau = 1.4; break;
            case 'sweep': vi = [0, 18, 24, 36][q]; tau = 1.2; break;
            case 'loft':
                mode = 'air';
                carry = q === 3 ? 62 : q === 2 ? 34 : 20 + (noRand ? 5 : Math.random() * 10);
                break;
            default: vi = 20;
        }
        if (!noRand && mist && shot.type !== 'loft' && shot.type !== 'defend' && Math.random() < 0.4) {
            mode = 'air'; edge = true;
            carry = 8 + Math.random() * 14;
            const side = Math.random() < 0.5 ? -1 : 1;
            angle = side * (125 + Math.random() * 45);
        }
        const rad = angle * Math.PI / 180;
        const path = { mode, x0: contact.x, y0: contact.y, dx: Math.sin(rad), dy: -Math.cos(rad), edge };
        if (mode === 'ground') {
            path.vi = vi; path.tau = tau;
        } else {
            tf = 1.0 + carry / 55;
            H = carry * (mist ? 2.3 : 1.9);
            path.carry = carry; path.tf = tf; path.H = H;
            path.vr = (carry / tf) * 0.5; path.tau2 = 0.9;
        }
        return path;
    }

    // ==========================================
    // 9. RESOLVING A BALL
    // ==========================================
    function resolveBall(delivery, shot) {
        const plan = planDelivery(delivery);
        const bw = currentBowler();
        const noOut = state.freeHit || delivery.extra === 'noball';
        const base = {
            runs: 0, batRuns: 0, runsRun: 0, boundary: 0, isOut: false, outType: null, outBatter: 'striker',
            legal: true, extra: null, kind: 'keeper', contacted: false, landing: null, commentary: ''
        };
        const wrap = (o) => {
            if (delivery.extra === 'noball') {
                o.extra = 'noball';
                o.runs += 1;
                o.legal = false;
                o.freeHitNext = true;
                o.commentary = 'NO BALL! +1 & FREE HIT next ball! ' + o.commentary;
            }
            return o;
        };

        if (delivery.extra === 'wide') {
            return { ...base, kind: 'keeper', runs: 1, extra: 'wide', legal: false, commentary: 'Wide ball! +1 extra' };
        }

        const batterX = 50 + (shot.guard === 'off' ? -1.4 : shot.guard === 'leg' ? 1.4 : 0);
        const lineErr = Math.abs(plan.finalX - batterX);
        const reach = shot.type === 'defend' ? 3.8 : shot.type === 'sweep' ? 3.6 : shot.type === 'loft' ? 3.2 : 3.9;
        const swung = shot.type !== 'leave';
        const contact = swung && ['perfect', 'good', 'early', 'late'].includes(shot.timing) && lineErr <= reach;
        const hitsStumps = Math.abs(plan.finalX - 50) <= PH.stumpHalf + PH.ballR;
        const overStumps = plan.endH > 26;
        const spin = ['legspin', 'offspin'].includes(delivery.variation);

        if (!contact) {
            if (swung && shot.footwork === 'advance' && spin && !noOut && Math.random() < 0.55) {
                return wrap({ ...base, isOut: true, outType: 'stumped', commentary: 'STUMPED! Quick glovework by the keeper!' });
            }
            // Pure geometry, no dice: the ball's line decides everything.
            // The batter's pads cover the ball's line when it passes within padHalf of where he stands.
            const padFirst = Math.abs(plan.finalX - batterX) <= (swung ? PH.padHalfSwing : PH.padHalf);
            const lineOff = plan.finalX - 50;                       // + = leg side, - = off side
            if (padFirst) {
                if (hitsStumps && !overStumps) {
                    if (noOut) {
                        return wrap({ ...base, kind: 'pad', commentary: 'Hit on the pad and would have hit — but no dismissal on this ball.' });
                    }
                    if (plan.pitchedLeg) {
                        return { ...base, kind: 'pad', commentary: 'Struck on the pad — but it pitched outside leg stump. Not out.', lbwProject: true };
                    }
                    return {
                        ...base, kind: 'lbw', isOut: true, outType: 'lbw', lbwProject: true,
                        commentary: 'LBW! Pitched in line, struck in line, hitting the stumps!'
                    };
                }
                const why = (hitsStumps && overStumps) ? 'going over the top'
                    : lineOff > 0 ? 'sliding down the leg side' : 'missing off stump';
                return wrap({ ...base, kind: 'pad', lbwProject: true, commentary: `Struck on the pad — ${why}. Not out.` });
            }
            if (hitsStumps && !overStumps) {
                if (noOut) {
                    return wrap({ ...base, kind: 'bowled', commentary: 'Hit the stumps — but it is not a legal dismissal!' });
                }
                return {
                    ...base, kind: 'bowled', isOut: true, outType: 'bowled',
                    commentary: swung ? 'BOWLED! Beaten all ends up!' : 'BOWLED! Left a straight one!'
                };
            }
            return wrap({ ...base, commentary: swung ? 'Beaten! Swing and a miss.' : 'Left cleanly to the keeper.' });
        }

        const q = shotQuality(shot, plan, lineErr, bw);
        const cp = contactPointFor(plan);
        const path = buildHit(shot, q, cp);
        const sim = simulateFielding(path, { noOut });
        const out = { ...base, kind: 'sim', contacted: true, sim: { path, ...sim, q } };

        if (sim.catchInfo) {
            out.isOut = true;
            out.outType = 'caught';
            out.landing = { x: sim.catchInfo.x, y: sim.catchInfo.y };
            out.commentary = sim.catchInfo.f === 'keeper' ? 'CAUGHT behind!' : `CAUGHT by ${sim.catchInfo.short}!`;
        } else if (sim.boundary) {
            out.boundary = sim.boundary;
            out.runs = out.batRuns = sim.boundary;
            const p = pathPos(path, sim.tRope || 0);
            out.landing = { x: p.x, y: p.y };
            out.commentary = sim.boundary === 6 ? 'SIX! Over the boundary rope!' : 'FOUR! Racing to the boundary!';
        } else {
            out.landing = { x: sim.pick.x, y: sim.pick.y };
            out.commentary = sim.dropped ? `Dropped by ${sim.pick.short === 'KEEPER' ? 'the keeper' : 'the fielder'}!` : `Fielded by ${sim.pick.short}.`;
            if (state.mode === 'online') {
                const tcall = 0.4;
                const n = aiChooseRuns(sim, tcall);
                out.runEval = evalRuns(sim, n, tcall);
            }
        }
        return wrap(out);
    }

    // ==========================================
    // 10. PLAYING OUT THE RESULT
    // ==========================================
    function finishFlightAndResolve(delivery, shot, precomputed = null) {
        if (state.flightAnimId) { cancelAnimationFrame(state.flightAnimId); state.flightAnimId = null; }
        state.ballInFlight = false;
        const outcome = precomputed || resolveBall(delivery, shot);

        if (outcome.contacted) {
            if (shot.type === 'defend') SoundFX.batDefend();
            else SoundFX.batCrack(shot.timing === 'perfect' ? 1.25 : 1.0);
        }
        // the ball no longer needs the delivery frames recorded separately: keep recording for the whole ball
        if (outcome.kind === 'sim') playSim(delivery, shot, outcome);
        else playSimple(delivery, shot, outcome);
    }

    // generic ball timeline: segments of {t0,t1,f(t)->{x,y,h}} in ground coords; time in seconds since contact
    function runLive(live) {
        const step = (now) => {
            if (live.id !== state.deliveryId) return;
            const t = (now - live.T0) / 1000;
            let seg = null;
            for (let i = live.segs.length - 1; i >= 0; i--) { if (live.segs[i].t0 <= t) { seg = live.segs[i]; break; } }
            if (!seg) seg = live.segs[0];
            drawBallGround(seg.f(Math.min(t, seg.t1)));
            if (live.finalAt !== null && t >= live.finalAt) {
                state.pathAnimId = null;
                if (live.onEnd) live.onEnd();
                return;
            }
            state.pathAnimId = requestAnimationFrame(step);
        };
        if (state.pathAnimId) cancelAnimationFrame(state.pathAnimId);
        state.pathAnimId = requestAnimationFrame(step);
    }
    const elapsedSince = (live) => (performance.now() - live.T0) / 1000;

    function throwSeg(from, to, t0, t1) {
        const len = dist(from, to);
        return {
            t0, t1, f: (t) => {
                const u = clamp((t - t0) / Math.max(0.01, t1 - t0), 0, 1);
                return { x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u), h: Math.sin(u * Math.PI) * Math.min(22, len * 0.35) + 4 };
            }
        };
    }
    const holdSeg = (p, t0, t1) => ({ t0, t1, f: () => ({ x: p.x, y: p.y, h: 5 }) });

    // simple outcomes: miss / bowled / lbw / pad / keeper / wide
    function playSimple(delivery, shot, outcome) {
        const plan = planDelivery(delivery);
        const cp = contactPointFor(plan);
        const kp = { x: 50, y: 88 };
        const id = state.deliveryId;
        const live = { id, T0: performance.now(), segs: [], finalAt: null, onEnd: null };
        let tEnd;

        if (outcome.kind === 'bowled') {
            const stump = { x: cp.x, y: 83.5 };
            live.segs.push(throwSeg(cp, stump, 0, 0.12));
            live.segs.push(holdSeg(stump, 0.12, 0.6));
            tEnd = 0.8;
            if (outcome.isOut) {
                const stumps = $('batterStumps');
                if (stumps) {
                    stumps.classList.add('shattered');
                    setTimeout(() => { if (stumps) stumps.classList.remove('shattered'); }, 1000);
                }
            }
        } else if (outcome.kind === 'lbw' || outcome.kind === 'pad') {
            // ball-tracking: after the pad hit, show where the ball was heading
            const tgt = { x: plan.finalX, y: 85.5 };
            live.segs.push(holdSeg(cp, 0, 0.4));
            live.segs.push({
                t0: 0.4, t1: 0.9, f: (t) => {
                    const u = clamp((t - 0.4) / 0.5, 0, 1);
                    return { x: lerp(cp.x, tgt.x, u), y: lerp(cp.y, tgt.y, u), h: lerp(5, plan.endH * 0.85, u) };
                }
            });
            live.segs.push({ t0: 0.9, t1: 1.5, f: () => ({ x: tgt.x, y: tgt.y, h: plan.endH * 0.85 }) });
            after(0.4, () => setStatus(outcome.isOut ? 'Ball tracking: hitting the stumps…' : 'Ball tracking: not hitting — not out.'));
            tEnd = 1.5;
        } else {
            // passes bat, keeper collects, returns to the bowler
            const t1 = 0.28;
            live.segs.push(throwSeg(cp, kp, 0, t1));
            live.segs.push(holdSeg(kp, t1, t1 + 0.35));
            const ret = dist(kp, PH.bowlerEnd) / PH.throwSpeed;
            live.segs.push(throwSeg(kp, PH.bowlerEnd, t1 + 0.35, t1 + 0.35 + ret));
            tEnd = t1 + 0.35 + ret + 0.15;
            if (outcome.outType === 'stumped') tEnd = t1 + 0.6;
            const kEl = $('keeper');
            if (kEl && outcome.outType === 'stumped') { kEl.classList.remove('diving'); void kEl.offsetWidth; kEl.classList.add('diving'); }
        }
        live.finalAt = tEnd;
        live.onEnd = () => applyOutcomeNow(delivery, shot, outcome);
        runLive(live);
    }

    function runBatterAnimation(crosses, tStartSec, live) {
        const bat = strikerWrap(), ns = otherWrap();
        if (!crosses || !bat || !ns) return;
        const batFig = bat.querySelector('.player'), nsFig = ns.querySelector('.player');
        const pitchLengthVh = 54;
        const batDelta = state.povBowler ? pitchLengthVh : -pitchLengthVh;
        const nsDelta = state.povBowler ? -pitchLengthVh : pitchLengthVh;
        const dur = PH.runCross;
        const wait = Math.max(0, tStartSec - elapsedSince(live));
        after(wait, () => {
            bat.classList.add('running-exchange');
            ns.classList.add('running-exchange');
            bat.style.transition = `transform ${dur}s linear`;
            ns.style.transition = `transform ${dur}s linear`;
            if (batFig) batFig.classList.add('sprinting');
            if (nsFig) nsFig.classList.add('sprinting');
            let done = 0;
            const doCross = () => {
                const crossed = done % 2 === 0;
                bat.style.transform = crossed ? `translate(-50%, 0) translateY(${batDelta}vh)` : 'translate(-50%, 0) translateY(0)';
                ns.style.transform = crossed ? `translate(-50%, 0) translateY(${nsDelta}vh)` : 'translate(-50%, 0) translateY(0)';
                done++;
                if (done < crosses) after(dur, doCross);
                else after(dur, () => {
                    bat.classList.remove('running-exchange');
                    ns.classList.remove('running-exchange');
                    bat.style.transition = ''; ns.style.transition = '';
                    if (batFig) batFig.classList.remove('sprinting');
                    if (nsFig) nsFig.classList.remove('sprinting');
                });
            };
            doCross();
        });
    }

    function resetRunnerVisuals() {
        const b = $('batsman'), n = $('nonStriker');
        [b, n].forEach(w => {
            if (!w) return;
            w.classList.remove('running-exchange');
            w.style.transition = '';
            const f = w.querySelector('.player');
            if (f) f.classList.remove('sprinting');
        });
    }

    function playSim(delivery, shot, outcome) {
        const sim = outcome.sim;
        const path = sim.path;
        const id = state.deliveryId;
        const live = { id, T0: performance.now(), segs: [], finalAt: null, onEnd: null };

        // ---- caught ----
        if (sim.catchInfo) {
            const c = sim.catchInfo;
            live.segs.push({ t0: 0, t1: c.t, f: (t) => pathPos(path, t) });
            live.segs.push(holdSeg(c, c.t, c.t + 0.6));
            runFielder(c.f, c, Math.max(0.1, c.t - 0.1));
            after(c.t, () => {
                const el = fielderEl(c.f);
                if (el) el.classList.add('catching');
                SoundFX.crowdRoar(false);
                showBanner('CAUGHT!', `${c.short} takes the catch!`);
            });
            live.finalAt = c.t + 0.6;
            live.onEnd = () => applyOutcomeNow(delivery, shot, outcome);
            runLive(live);
            return;
        }

        // ---- boundary ----
        if (sim.boundary) {
            const tR = sim.tRope || 1;
            live.segs.push({ t0: 0, t1: tR, f: (t) => pathPos(path, t) });
            const end = pathPos(path, tR);
            live.segs.push(holdSeg(end, tR, tR + 0.8));
            // nearest fielder chases the ball to the rope
            let best = null, bt = Infinity;
            state.field.forEach(f => { const r = reachTime(f, end, 0); if (r < bt) { bt = r; best = f; } });
            if (best) runFielder(best.id, end, Math.max(0.3, Math.min(bt, tR + 0.6)));
            live.finalAt = tR + 0.8;
            live.onEnd = () => applyOutcomeNow(delivery, shot, outcome);
            runLive(live);
            return;
        }

        // ---- ball in play: fielding, running, throwing ----
        const P = sim.pick;
        live.segs.push({ t0: 0, t1: P.t, f: (t) => pathPos(path, t) });
        if (!P.virtual) runFielder(P.f, P, Math.max(0.1, P.t - PH.reaction));
        if (sim.backup && sim.backup.f !== P.f) {
            const bf = state.field.find(f => f.id === sim.backup.f);
            if (bf) runFielder(bf.id, { x: lerp(bf.x, P.x, 0.5), y: lerp(bf.y, P.y, 0.5) }, Math.min(sim.backup.t, P.t));
        }

        let decided = false;
        const afterDecision = (n, tcall) => {
            const rr = outcome.runEval || evalRuns(sim, n, tcall);
            const lastThrow = rr.throws[rr.throws.length - 1];
            live.segs.push(holdSeg(P, P.t, rr.throws[0].t0));
            rr.throws.forEach(th => live.segs.push(throwSeg(th.from, th.to, th.t0, th.t1)));
            live.segs.push(holdSeg(lastThrow.to, lastThrow.t1, rr.tEnd + 1));

            const crosses = rr.runOutAt ? rr.runOutAt : rr.completed;
            if (crosses > 0) runBatterAnimation(crosses, rr.tcall + PH.runStart, live);

            const completed = rr.completed;
            const result = {
                ...outcome,
                runs: completed,
                batRuns: completed,
                runsRun: completed,
                isOut: !!rr.runOutAt,
                outType: rr.runOutAt ? 'runout' : null,
                outBatter: rr.outBatter || 'striker',
                commentary: rr.runOutAt
                    ? `RUN OUT! ${rr.outBatter === 'nonstriker' ? 'The non-striker' : 'The striker'} is short of the crease!`
                    : completed === 0 ? `Dot ball. ${P.short === 'BOWLER' ? '' : 'Fielded by ' + P.short + '.'}`
                        : `${completed} run${completed > 1 ? 's' : ''} taken — fielded by ${P.short}.`
            };
            if (outcome.extra === 'noball') { result.runs += 1; result.legal = false; result.freeHitNext = true; }
            if (outcome.extra === 'noball' && result.commentary.indexOf('NO BALL') < 0) result.commentary = 'NO BALL! ' + result.commentary;
            if (rr.runOutAt) setStatus('Throw coming in...');
            live.finalAt = rr.tEnd;
            live.onEnd = () => applyOutcomeNow(delivery, shot, result);
        };

        const decideOnce = (n) => {
            if (decided) return;
            decided = true;
            state.decide = null;
            showEl('runningPanel', 'none');
            afterDecision(n, Math.max(0, elapsedSince(live)));
        };

        const human = state.mode === 'ai' && isLocalBatting() && !outcome.runEval;
        // keep the ball in view until a decision extends the timeline
        live.finalAt = null;
        if (outcome.runEval) {
            decided = true;
            afterDecision(outcome.runEval.n, outcome.runEval.tcall);
        } else if (human) {
            showEl('runningPanel', 'flex');
            setText('runningMsg', `Ball in play — fielder ${P.short}. Call (R / 1-3):`);
            state.decide = decideOnce;
            if (state.preCall > 0) decideOnce(Math.min(3, state.preCall));
            else after(1.15, () => decideOnce(0));
        } else {
            after(0.35, () => decideOnce(aiChooseRuns(sim, 0.35)));
        }
        runLive(live);
    }

    // ==========================================
    // 11. APPLYING THE RESULT
    // ==========================================
    function applyOutcomeNow(delivery, shot, outcome) {
        hideBallVisual();
        showEl('runningPanel', 'none');
        state.decide = null;
        resetRunnerVisuals();
        resetFielders(0.9);

        if (outcome.isOut) {
            umpireSignal('out');
            SoundFX.stumpsShatter();
            SoundFX.crowdRoar(false);
            showBanner(outcome.outType === 'lbw' ? 'LBW!' : 'OUT!', outcome.commentary);
        } else if (outcome.boundary === 6) {
            umpireSignal('six');
            SoundFX.crowdRoar(true);
            showBanner('SIX!', outcome.commentary);
        } else if (outcome.boundary === 4) {
            umpireSignal('four');
            SoundFX.crowdRoar(true);
            showBanner('FOUR!', outcome.commentary);
        } else {
            if (outcome.extra === 'wide' || outcome.extra === 'noball') umpireSignal('wide');
            showBanner('', outcome.commentary);
        }

        const team = state[state.battingSide];
        const legal = outcome.legal !== false;
        if (legal) team.balls += 1;
        if (outcome.isOut) team.wickets += 1;
        team.score += outcome.runs;
        if (outcome.extra === 'wide') state.extras.wides += 1;
        if (outcome.extra === 'noball') state.extras.noBalls += 1;
        state.freeHit = !!outcome.freeHitNext;

        const bat = state.inningsData.batting;
        const s0 = state.strikerIdx, n0 = state.nonStrikerIdx;
        const st = bat[s0], bw = currentBowler();
        const batRuns = outcome.batRuns || 0;

        if (st) {
            st.batRuns += batRuns;
            if (outcome.extra !== 'wide') st.batBalls += 1;
            if (outcome.boundary === 4) st.fours += 1;
            if (outcome.boundary === 6) st.sixes += 1;
        }
        if (bw) {
            if (legal) bw.bowlBalls += 1;
            bw.bowlRuns += outcome.runs;
            if (outcome.isOut && outcome.outType !== 'runout') bw.bowlWkts += 1;
            bw.oversBowled = Math.floor(bw.bowlBalls / 6);
            bw.fatigue = Math.min(0.6, bw.bowlBalls * 0.02);
        }

        if (outcome.landing && (outcome.runs > 0 || outcome.isOut)) {
            state.wagonShots.push({ x: outcome.landing.x, y: outcome.landing.y, runs: batRuns });
        }
        state.currentOverRuns += outcome.runs;

        let sIdx = s0, nIdx = n0;
        if ((outcome.runsRun || 0) % 2 === 1) { sIdx = n0; nIdx = s0; }
        if (outcome.isOut) {
            const dead = (outcome.outType === 'runout' && outcome.outBatter === 'nonstriker') ? n0 : s0;
            const p = bat[dead];
            if (p) {
                p.out = true;
                p.outHow = outcome.outType === 'runout' ? 'run out'
                    : outcome.outType === 'lbw' ? 'lbw'
                    : outcome.outType === 'bowled' ? 'b'
                    : outcome.outType === 'stumped' ? 'st' : 'c';
            }
            if (state.nextBatterIdx < PLAYERS_PER_TEAM) {
                const next = state.nextBatterIdx++;
                if (sIdx === dead) sIdx = next; else if (nIdx === dead) nIdx = next;
            }
        }
        state.strikerIdx = sIdx;
        state.nonStrikerIdx = nIdx;

        // visual end swap after an odd number of completed runs
        if ((outcome.runsRun || 0) % 2 === 1) {
            state.endsSwapped = !state.endsSwapped;
            const pitch = $('pitch');
            if (pitch) pitch.classList.toggle('ends-swapped', state.endsSwapped);
            placeFigures();
            const b = $('batsman'), n = $('nonStriker');
            if (b) b.style.transform = '';
            if (n) n.style.transform = '';
        } else {
            const b = $('batsman'), n = $('nonStriker');
            if (b) b.style.transform = '';
            if (n) n.style.transform = '';
        }
        updateVisualPositions();

        updateHud();
        setDisabled('replayBtn', !state.replayFrames.length);
        state.recording = false;

        if (legal && team.balls % 6 === 0 && team.balls > 0) {
            state.overRuns.push(state.currentOverRuns);
            state.currentOverRuns = 0;
            state.lastBowlerIdx = state.currentBowlerIdx;
            const tmp = state.strikerIdx;
            state.strikerIdx = state.nonStrikerIdx;
            state.nonStrikerIdx = tmp;
            updatePowerplay();

            const squad = state.inningsData.bowling;
            const nextIdx = squad.findIndex((_, i) => bowlerAvailable(i));
            if (nextIdx >= 0) {
                state.currentBowlerIdx = nextIdx;
                renderBowlerDropdown();
            }
        }

        state.busy = false;
        setTimeout(prepareNextBall, 1100);
    }

    function updatePowerplay() {
        const team = state[state.battingSide];
        const oversDone = Math.floor((team ? team.balls : 0) / 6);
        state.powerplay = oversDone < Math.max(1, Math.round(state.maxOvers * 0.2));
    }

    // ==========================================
    // 12. TURN FLOW & SMART AI
    // ==========================================
    function isLocalBatting() {
        if (state.mode === 'ai') return state.battingSide === 'p1';
        return (state.role === 'host' && state.battingSide === 'p1') || (state.role === 'guest' && state.battingSide === 'p2');
    }

    function prepareNextBall() {
        if (checkMatchProgression()) return;
        hideBallVisual();
        recalcGeom();
        updateHud();
        updateCameraForRole();
        updateVisualPositions();
        const tc = $('timingCursor'); if (tc) tc.style.left = '0%';
        showEl('runningPanel', 'none');
        showEl('runNowBtn', 'none');

        if (isLocalBatting()) {
            showEl('battingControls', 'flex');
            showEl('bowlingControls', 'none');
            setDisabled('playShotBtn', true);
            showEl('pitchMarker', 'none');
            showEl('shotAimGuide', 'block');
            updateShotAimGuide();

            if (state.mode === 'ai') {
                setStatus('Set guard (WASD) & aim shot — bowler coming in...');
                if (state.autoBallTimer) clearTimeout(state.autoBallTimer);
                state.autoBallTimer = setTimeout(() => {
                    if (isLocalBatting() && !state.ballInFlight && !state.busy) {
                        launchBallFlight(generateAIDelivery(), null);
                    }
                }, 1400);
            }
        } else {
            showEl('battingControls', 'none');
            showEl('bowlingControls', 'flex');
            setDisabled('deliverBallBtn', false);
            showEl('pitchMarker', 'block');
            showEl('shotAimGuide', 'none');
            updatePitchReticle();
            renderBowlerDropdown();
            setStatus('Click/drag pitch to aim, drag fielders, then BOWL.');
        }
    }

    function recordBatterTendency(shot) {
        const m = state.aiMemory;
        m.ballsFaced++;
        m.shotTypes[shot.type] = (m.shotTypes[shot.type] || 0) + 1;
        m.footwork[shot.footwork] = (m.footwork[shot.footwork] || 0) + 1;
    }

    function generateAIDelivery() {
        const bw = currentBowler();
        const isSpinBowler = bw && bw.bowlType === 'spin';
        const baseSpeed = bw ? (isSpinBowler ? Math.round(92 + bw.bowlSkill * 0.2) : Math.round(112 + bw.bowlSkill * 0.3)) : 128;
        const angle = pick(['over', 'over', 'wide', 'round']);
        const variation = isSpinBowler
            ? pick(['legspin', 'offspin', 'legspin', 'offspin', 'seam'])
            : pick(['seam', 'seam', 'inswing', 'outswing', 'legspin', 'offspin']);
        let aimY = 40 + Math.floor(Math.random() * 32);

        if (state.aiMemory.ballsFaced >= 3 && Math.random() < 0.7) {
            if ((state.aiMemory.shotTypes.loft || 0) >= 2) {
                aimY = 70;
                setFieldPreset('defensive');
            }
            if ((state.aiMemory.footwork.advance || 0) >= 2) aimY = 40;
        }

        const d = { angle, variation, speed: baseSpeed + Math.floor(Math.random() * 8), aimY };
        const mv = deliveryMoves(d);
        const startX = angle === 'wide' ? 45 : angle === 'round' ? 55 : 48.5;
        // choose where it should END UP at the stumps, then aim the bounce so that it does
        const target = Math.random() < 0.05
            ? 50 + (Math.random() < 0.5 ? -1 : 1) * rnd(6.2, 7.4)
            : 50 + (Math.random() - 0.5) * 8.4;
        d.aimX = clamp((target + 0.14 * startX - mv.turn) / 1.14, 36, 64);
        return d;
    }

    function generateAIShot(delivery) {
        const plan = planDelivery(delivery);
        const leave = { guard: 'middle', footwork: 'crease', type: 'leave', angle: 0, timing: 'none' };
        if (plan.wide) return leave;
        const off = Math.abs(plan.finalX - 50);
        if (off > 3.4 && Math.random() < 0.4) return leave;

        const lenCat = plan.lengthCat;
        let aggression = 0.3;
        if (state.target !== null) {
            const team = state[state.battingSide];
            const left = Math.max(1, state.maxOvers * 6 - team.balls);
            const need = state.target - team.score;
            aggression = clamp(need / left / 1.6, 0.2, 0.9);
        }
        const types = lenCat === 'short' ? ['cutpull', 'ground'] : lenCat === 'yorker' ? ['defend', 'ground']
            : ['ground', 'ground', 'cutpull', 'sweep'].concat(Math.random() < aggression ? ['loft', 'loft'] : []);
        const type = pick(types);

        const cp = contactPointFor(plan);
        // a batter can only play a given shot into a sensible arc
        const ARC = {
            defend: [-40, -20, 0, 20, 40],
            ground: [-55, -35, -15, 0, 15, 35, 55],
            cutpull: [-115, -95, -75, 75, 95, 115],
            sweep: [45, 65, 90, 115, 135],
            loft: [-50, -30, -10, 10, 30, 50]
        };
        const cand = ARC[type] || ARC.ground;
        const scored = cand.map(a => {
            const path = buildHit({ type, angle: a }, 3, cp, true);
            const s = simulateFielding(path, { noOut: true });
            const score = s.boundary ? 100 + (s.boundary === 6 ? 5 : 0) : (s.pick ? s.pick.t : 0);
            return { a, score: score + Math.random() * 6 };
        }).sort((x, y) => y.score - x.score);
        const angle = scored[Math.floor(Math.random() * Math.min(3, scored.length))].a;

        const diff = state.difficulty;
        const P = diff === 'hard' ? { perfect: 0.40, good: 0.38, early: 0.07, late: 0.07 }
            : diff === 'easy' ? { perfect: 0.10, good: 0.30, early: 0.20, late: 0.20 }
            : { perfect: 0.25, good: 0.40, early: 0.11, late: 0.11 };
        const r = Math.random();
        const timing = r < P.perfect ? 'perfect' : r < P.perfect + P.good ? 'good'
            : r < P.perfect + P.good + P.early ? 'early'
            : r < P.perfect + P.good + P.early + P.late ? 'late' : 'miss';
        return {
            guard: plan.finalX < 48 ? 'off' : plan.finalX > 52 ? 'leg' : 'middle',
            footwork: lenCat === 'short' ? 'back' : (Math.random() < 0.2 ? 'advance' : 'crease'),
            type, angle, timing
        };
    }

    function checkMatchProgression() {
        const current = state[state.battingSide];
        const allOut = current.wickets >= PLAYERS_PER_TEAM - 1;
        const oversDone = current.balls >= state.maxOvers * 6;

        if (state.innings === 2 && current.score >= state.target) {
            finishMatch();
            return true;
        }
        if (allOut || oversDone) {
            if (state.innings === 1) {
                saveInningsScorecard();
                state.innings = 2;
                state.target = current.score + 1;
                state.battingSide = state.battingSide === 'p1' ? 'p2' : 'p1';
                SoundFX.crowdRoar(false);
                showBanner('INNINGS BREAK', `Target: ${state.target}`);
                startInningsData(state.battingSide);
                setTimeout(prepareNextBall, 1500);
                return true;
            }
            finishMatch();
            return true;
        }
        return false;
    }

    function saveInningsScorecard() {
        if (!state.inningsData) return;
        state.scorecardHistory.push({
            team: state.battingSide === 'p1' ? 'YOUR TEAM' : 'OPPONENT',
            batting: state.inningsData.batting.map(b => ({ ...b })),
            bowling: state.inningsData.bowling.map(b => ({ ...b })),
            total: state[state.battingSide].score,
            wickets: state[state.battingSide].wickets,
            balls: state[state.battingSide].balls
        });
    }

    function finishMatch() {
        if (state.scorecardHistory.length < 2) saveInningsScorecard();
        SoundFX.crowdRoar(true);
        const s1 = state.p1.score, s2 = state.p2.score;
        setText('resultMessage', s1 > s2 ? `YOU WON BY ${s1 - s2} RUNS!` : s2 > s1 ? `OPPONENT WON BY ${PLAYERS_PER_TEAM - 1 - state.p2.wickets} WICKETS!` : 'MATCH TIED!');
        const fs = $('finalStats');
        if (fs) {
            fs.innerHTML = `
                <div><strong>YOUR TEAM:</strong> ${state.p1.score}/${state.p1.wickets} (${Math.floor(state.p1.balls / 6)}.${state.p1.balls % 6} ov)</div>
                <div><strong>OPPONENT:</strong> ${state.p2.score}/${state.p2.wickets} (${Math.floor(state.p2.balls / 6)}.${state.p2.balls % 6} ov)</div>
            `;
        }
        const rsF = $('resultScreen'); if (rsF) rsF.classList.add('active');
    }

    // ==========================================
    // 13. SCORECARD, WAGON WHEEL & REPLAY
    // ==========================================
    function drawCharts() {
        const wc = $('wagonWheel');
        if (wc) {
            const ctx = wc.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, wc.width, wc.height);
                ctx.fillStyle = '#0e3816';
                ctx.beginPath(); ctx.arc(90, 90, 84, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.stroke();
                ctx.fillStyle = '#bfa074'; ctx.fillRect(83, 65, 14, 50);

                state.wagonShots.forEach(sh => {
                    const tx = (sh.x / 100) * 180;
                    const ty = (sh.y / 100) * 180;
                    ctx.strokeStyle = sh.runs >= 6 ? '#facc15' : sh.runs === 4 ? '#22c55e' : '#ffffff';
                    ctx.lineWidth = sh.runs >= 4 ? 2.5 : 1.2;
                    ctx.beginPath(); ctx.moveTo(90, 110); ctx.lineTo(tx, ty); ctx.stroke();
                });
            }
        }

        const mc = $('manhattanChart');
        if (mc) {
            const ctx = mc.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, mc.width, mc.height);
                const overs = [...state.overRuns];
                if (state.currentOverRuns) overs.push(state.currentOverRuns);
                if (!overs.length) overs.push(0);
                const max = Math.max(8, ...overs);
                const bw = (mc.width - 20) / overs.length;
                overs.forEach((r, i) => {
                    const h = (r / max) * 130;
                    ctx.fillStyle = '#22c55e';
                    ctx.fillRect(10 + i * bw + 3, 155 - h, bw - 6, h);
                    ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif';
                    ctx.fillText(String(r), 10 + i * bw + bw / 2 - 4, 150 - h);
                });
            }
        }
    }

    function renderScorecard() {
        drawCharts();
        const body = $('scorecardBody');
        if (!body) return;
        const list = [...state.scorecardHistory];
        if (state.inningsData && list.length < state.innings) {
            list.push({
                team: state.battingSide === 'p1' ? 'YOUR TEAM' : 'OPPONENT',
                batting: state.inningsData.batting,
                bowling: state.inningsData.bowling,
                total: state[state.battingSide].score,
                wickets: state[state.battingSide].wickets,
                balls: state[state.battingSide].balls
            });
        }
        body.innerHTML = list.map((inn, idx) => `
            <h4 style="margin:8px 0;color:var(--gold);">Innings ${idx + 1} — ${inn.team} (${inn.total}/${inn.wickets})</h4>
            <table>
                <tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>Status</th></tr>
                ${inn.batting.filter(b => b.batBalls > 0 || b.out).map(b => `
                    <tr><td>${b.name}</td><td>${b.batRuns}</td><td>${b.batBalls}</td><td>${b.fours}</td><td>${b.sixes}</td><td>${b.out ? b.outHow : 'not out'}</td></tr>
                `).join('')}
            </table>
        `).join('');
    }

    function replayLastBall() {
        if (state.replaying || !state.replayFrames.length || state.busy) return;
        state.replaying = true;
        setDisabled('replayBtn', true);
        const frames = state.replayFrames.slice();
        const start = performance.now();
        const duration = frames.length * 20;
        const rec = state.recording;
        state.recording = false;

        const step = (now) => {
            const t = Math.min(1, (now - start) / duration);
            const f = frames[Math.min(frames.length - 1, Math.floor(t * frames.length))];
            if (f) drawBallScreen(f.x, f.y, f.h);
            if (t < 1) {
                requestAnimationFrame(step);
            } else {
                state.replaying = false;
                state.recording = rec;
                hideBallVisual();
                setDisabled('replayBtn', false);
            }
        };
        requestAnimationFrame(step);
    }

    // ==========================================
    // 14. INIT, BINDINGS & KEYBOARD
    // ==========================================
    function getActiveVal(groupId) {
        const g = $(groupId);
        const el = g ? g.querySelector('.active') : null;
        return el && el.dataset ? el.dataset.val : '';
    }

    function selectButtonByVal(groupId, val) {
        const g = $(groupId);
        if (!g) return;
        g.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === val));
        updateVisualPositions();
    }

    function bindGroup(groupId, cb) {
        const g = $(groupId);
        if (!g) return;
        g.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                SoundFX.click();
                g.querySelectorAll('button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                updateVisualPositions();
                if (cb) cb(btn.dataset);
            });
        });
    }

    function startInningsData(battingSide) {
        const bowlingSide = battingSide === 'p1' ? 'p2' : 'p1';
        state.inningsData = {
            batting: state._squads[battingSide],
            bowling: state._squads[bowlingSide]
        };
        state.strikerIdx = 0; state.nonStrikerIdx = 1; state.nextBatterIdx = 2;
        state.currentBowlerIdx = 0; state.lastBowlerIdx = -1;
        state.overRuns = []; state.currentOverRuns = 0; state.wagonShots = [];
        state.freeHit = false;
        resetEnds();
        updatePowerplay();
        setFieldPreset('balanced');
        renderBowlerDropdown();
        updateHud();
    }

    function initMatch(role = 'host') {
        state.role = role;
        state.innings = 1;
        state.battingSide = 'p1';
        state.target = null;
        state.p1 = { score: 0, wickets: 0, balls: 0 };
        state.p2 = { score: 0, wickets: 0, balls: 0 };
        state._squads = freshSquads();
        state.scorecardHistory = [];
        state.busy = false;
        hideBallVisual();

        if (!state.conditions) generateConditions();
        const ss0 = $('startScreen'); if (ss0) ss0.classList.remove('active');
        const rs0 = $('resultScreen'); if (rs0) rs0.classList.remove('active');
        recalcGeom();

        if (state.mode === 'online') {
            startInningsData('p1');
            prepareNextBall();
        } else {
            showEl('tossPanel', 'block');
            showEl('tossCallGroup', 'flex');
            showEl('tossChoiceGroup', 'none');
            setText('tossMsg', 'Call Heads or Tails');
        }
    }

    bindGroup('oversSelect', d => state.maxOvers = Number(d.overs));
    bindGroup('difficultySelect', d => state.difficulty = d.diff);
    bindGroup('timeSelect', d => state.timeScale = Number(d.ts));
    bindGroup('modeSelect', d => {
        state.mode = d.mode;
        $('aiSetupPanel').style.display = d.mode === 'ai' ? 'block' : 'none';
        $('onlineSetupPanel').style.display = d.mode === 'online' ? 'block' : 'none';
    });
    bindGroup('batterGuardGroup');
    bindGroup('footworkGroup');
    bindGroup('shotTypeGroup');
    bindGroup('bowlAngleGroup');
    bindGroup('bowlVarGroup', d => {
        const hints = {
            seam: 'Seam — controlled bounce & seam movement',
            inswing: 'In-swing — curves into the right-hander',
            outswing: 'Out-swing — curves away from the right-hander',
            legspin: 'Leg-spin — turns away from right-hander',
            offspin: 'Off-spin — turns into right-hander'
        };
        setText('bowlHint', hints[d.val] || 'Click/drag pitch spot to aim • Drag fielders to set field');
    });
    bindGroup('fieldPresetGroup', d => setFieldPreset(d.val));

    on('bowlSpeedSlider', 'input', e => setText('paceVal', e.target.value));
    on('bowlerSelectDropdown', 'change', e => {
        state.currentBowlerIdx = Number(e.target.value);
        updateHud();
    });

    on('deliverBallBtn', 'click', () => {
        if (isLocalBatting() || state.ballInFlight || state.busy) return;
        SoundFX.click();
        $('deliverBallBtn').disabled = true;
        const v = getActiveVal('bowlVarGroup');
        const delivery = {
            angle: getActiveVal('bowlAngleGroup'),
            variation: v === 'spin' ? 'offspin' : v,
            aimX: state.aimX,
            aimY: state.aimY,
            speed: Number($('bowlSpeedSlider').value)
        };
        finalizeDelivery(delivery);
        if (state.mode === 'ai') {
            launchBallFlight(delivery, generateAIShot(delivery));
        } else {
            state.activeDelivery = delivery;
            sendNet({ type: 'BOWL_DELIVERY', delivery });
            launchBallFlight(delivery, null);
        }
    });

    on('playShotBtn', 'click', triggerBatterSwing);

    function callRun() {
        if (state.decide) {
            state.decide(Math.min(3, Math.max(1, state.preCall || 1)));
            return;
        }
        state.preCall = Math.min(3, state.preCall + 1);
        setText('runNowBtn', `RUN x${state.preCall} (R)`);
        setStatus(`Run called: ${state.preCall}`);
    }
    on('runNowBtn', 'click', callRun);

    document.querySelectorAll('#runningPanel button').forEach(btn => {
        btn.addEventListener('click', () => { if (state.decide) state.decide(Number(btn.dataset.runs)); });
    });

    document.querySelectorAll('.hud-btn[data-cam]').forEach(btn => {
        btn.addEventListener('click', () => setCamera(btn.dataset.cam));
    });

    on('rerollConditionsBtn', 'click', () => { SoundFX.click(); generateConditions(); });
    on('startSoloBtn', 'click', () => { SoundFX.click(); initMatch('host'); });
    on('restartBtn', 'click', () => {
        SoundFX.click();
        clearPendingTimers();
        hideBallVisual();
        state.busy = false;
        state.deliveryId += 1;
        const rs = $('resultScreen'); if (rs) rs.classList.remove('active');
        const ss = $('startScreen'); if (ss) ss.classList.add('active');
    });

    document.querySelectorAll('#tossCallGroup button').forEach(btn => {
        btn.addEventListener('click', () => {
            const won = btn.dataset.val === (Math.random() < 0.5 ? 'heads' : 'tails');
            if (won) {
                $('tossMsg').textContent = 'You won the toss! Choose:';
                $('tossCallGroup').style.display = 'none';
                $('tossChoiceGroup').style.display = 'flex';
            } else {
                const aiBats = Math.random() < 0.65;
                $('tossMsg').textContent = aiBats ? 'AI won & elected to BAT.' : 'AI won & elected to BOWL.';
                setTimeout(() => {
                    $('tossPanel').style.display = 'none';
                    state.battingSide = aiBats ? 'p2' : 'p1';
                    startInningsData(state.battingSide);
                    prepareNextBall();
                }, 800);
            }
        });
    });

    document.querySelectorAll('#tossChoiceGroup button').forEach(btn => {
        btn.addEventListener('click', () => {
            $('tossPanel').style.display = 'none';
            state.battingSide = btn.dataset.val === 'bat' ? 'p1' : 'p2';
            startInningsData(state.battingSide);
            prepareNextBall();
        });
    });

    on('scorecardBtn', 'click', () => {
        renderScorecard();
        $('scorecardModal').style.display = 'flex';
    });
    on('scorecardCloseBtn', 'click', () => showEl('scorecardModal', 'none'));
    on('replayBtn', 'click', replayLastBall);
    on('soundToggleBtn', 'click', () => {
        const m = SoundFX.toggleMute();
        $('soundToggleBtn').textContent = m ? '🔇' : '🔊';
    });

    document.addEventListener('keydown', (e) => {
        const ssK = $('startScreen'); if (ssK && ssK.classList.contains('active')) return;
        const k = e.key.toLowerCase();

        // after the shot: 1-3 call runs, 0 stays
        if (state.decide && ['0', '1', '2', '3'].includes(e.key)) { state.decide(Number(e.key)); return; }
        if (state.decide && k === 'r') { callRun(); return; }

        if (isLocalBatting()) {
            if (k === 'a') selectButtonByVal('batterGuardGroup', getActiveVal('batterGuardGroup') === 'leg' ? 'middle' : 'off');
            if (k === 'd') selectButtonByVal('batterGuardGroup', getActiveVal('batterGuardGroup') === 'off' ? 'middle' : 'leg');
            if (k === 'w') selectButtonByVal('footworkGroup', getActiveVal('footworkGroup') === 'back' ? 'crease' : 'advance');
            if (k === 's') selectButtonByVal('footworkGroup', getActiveVal('footworkGroup') === 'advance' ? 'crease' : 'back');

            const shots = { '1': 'defend', '2': 'ground', '3': 'cutpull', '4': 'sweep', '5': 'loft' };
            if (shots[e.key] && !state.swingDone) selectButtonByVal('shotTypeGroup', shots[e.key]);

            if (e.key === 'ArrowLeft') { state.shotAngle = Math.max(-130, state.shotAngle - 20); updateShotAimGuide(); }
            if (e.key === 'ArrowRight') { state.shotAngle = Math.min(130, state.shotAngle + 20); updateShotAimGuide(); }
            if (e.key === 'ArrowUp') { state.shotAngle = 0; updateShotAimGuide(); }

            if (e.code === 'Space' && state.ballInFlight && !state.swingDone) {
                e.preventDefault();
                triggerBatterSwing();
            }
            if (k === 'r' && state.busy) callRun();
        }
    });

    function sendNet(payload) { if (state.conn && state.conn.open) state.conn.send(payload); }
    function setupConnection(conn, isHost) {
        state.conn = conn;
        conn.on('open', () => {
            if (isHost) {
                sendNet({ type: 'START_MATCH', maxOvers: state.maxOvers, timeScale: state.timeScale });
                initMatch('host');
            }
        });
        conn.on('data', (data) => {
            if (data.type === 'START_MATCH' && !isHost) {
                state.maxOvers = data.maxOvers;
                state.timeScale = data.timeScale || 1;
                initMatch('guest');
            }
            if (data.type === 'BOWL_DELIVERY' && isLocalBatting()) {
                if (data.delivery.field) { state.field = data.delivery.field.map(f => ({ ...f })); renderFielders(); }
                launchBallFlight(data.delivery, null);
            }
            if (data.type === 'BATTER_SHOT' && isHost) {
                const outcome = resolveBall(state.activeDelivery, data.shot);
                sendNet({ type: 'BALL_RESULT', delivery: state.activeDelivery, shot: data.shot, outcome });
                finishFlightAndResolve(state.activeDelivery, data.shot, outcome);
            }
            if (data.type === 'BALL_RESULT' && !isHost) finishFlightAndResolve(data.delivery, data.shot, data.outcome);
        });
    }

    on('createRoomBtn', 'click', () => {
        if (typeof Peer === 'undefined') return;
        const code = 'CRIC-' + Math.random().toString(36).substring(2, 6).toUpperCase();
        state.peer = new Peer(code);
        state.peer.on('open', id => $('lobbyStatus').textContent = `Room Code: ${id}`);
        state.peer.on('connection', conn => setupConnection(conn, true));
    });

    on('joinRoomBtn', 'click', () => {
        const code = $('joinRoomInput').value.trim().toUpperCase();
        if (!code || typeof Peer === 'undefined') return;
        state.peer = new Peer();
        state.peer.on('open', () => setupConnection(state.peer.connect(code), false));
    });

    generateConditions();
    bindPitchAiming();
    recalcGeom();
    updateVisualPositions();

    if (typeof window !== 'undefined' && window.__CRICKET_DEBUG) {
        window.__cricket = {
            state, PH, planDelivery, resolveBall, simulateFielding, evalRuns, aiChooseRuns, buildHit, pathPos,
            deliveryMoves, finalizeDelivery, generateAIDelivery, generateAIShot, startInningsData, freshSquads,
            setFieldPreset, contactPointFor, classifyTiming, timingWindows
        };
    }
})();
