(() => {
    'use strict';

    const PLAYERS_PER_TEAM = 11;

    // ==========================================
    // 1. PROCEDURAL WEB AUDIO ENGINE
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
        pathAnimId: null,
        peer: null,
        conn: null,
        cameraMode: 'batter',
        povBowler: false,
        endsSwapped: false,
        contactPoint: null,
        lastBallGround: null,
        fieldPreset: 'balanced',
        field: [],
        aimX: 48,
        aimY: 56,
        shotAngle: 0,
        pendingRun: null,
        runTimer: null,
        deliveryId: 0,
        runUpTimers: [],
        phaseTimers: [],
        replayFrames: [],
        replaying: false,
        freeHit: false,
        powerplay: true,
        extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
        autoBallTimer: null,
        runRequested: false,
        runCrossMs: 950,
        strikerIdx: 0,
        nonStrikerIdx: 1,
        nextBatterIdx: 2,
        currentBowlerIdx: 0,
        lastBowlerIdx: -1,
        overRuns: [],
        currentOverRuns: 0,
        wagonShots: [],
        aiMemory: { shotTypes: {}, angles: {}, guards: {}, footwork: {}, bowlLines: {}, bowlLengths: {}, ballsFaced: 0 },
        inningsData: null,
        scorecardHistory: [],
        conditions: null
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

    const VENUES = [
        { name: 'R. Premadasa Stadium, Colombo' },
        { name: "Lord's, London" },
        { name: 'Melbourne Cricket Ground' },
        { name: 'Eden Gardens, Kolkata' },
        { name: 'Newlands, Cape Town' }
    ];

    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    function generateConditions() {
        const venue = pick(VENUES);
        const weather = pick(['Sunny', 'Sunny', 'Partly Cloudy', 'Overcast', 'Humid', 'Light Drizzle']);
        const tempC = weather === 'Sunny' ? 30 : weather === 'Overcast' ? 20 : 25;
        const humidity = weather === 'Humid' ? 84 : weather === 'Light Drizzle' ? 92 : 55;
        const windKmh = 6 + Math.floor(Math.random() * 20);
        const windLateral = pick([-1, 0, 1]);
        const windAlong = pick([-1, 0, 1]);
        const dew = Math.round(Math.min(90, Math.max(10, (humidity - 50) * 1.5)));
        const pitch = pick(['Flat Track', 'Green Seamer', 'Dry Turner', 'Two-Paced']);

        state.conditions = {
            venue: venue.name,
            weather,
            tempC,
            humidity,
            windKmh,
            windLateral,
            windAlong,
            dew,
            pitch
        };
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
    function updatePitchReticle() {
        const marker = $('pitchMarker');
        if (!marker) return;
        const sc = toScreen(state.aimX, state.aimY);
        marker.style.left = `${sc.x}%`;
        marker.style.top = `${sc.y}%`;
        setText('lengthLabel', getLengthLabelFromY(state.aimY).toUpperCase());
    }

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

    function getLineCategoryFromX(xPct) {
        if (xPct < 46) return 'off';
        if (xPct > 54) return 'leg';
        return 'middle';
    }

    function bindPitchAiming() {
        const stage = $('cameraStage');
        const strip = $('pitchStrip');
        if (!stage || !strip) return;

        let aiming = false;
        const setAimFromPointer = (clientX, clientY) => {
            if (isLocalBatting() || state.ballInFlight) return;
            const r = stage.getBoundingClientRect();
            const sx = ((clientX - r.left) / r.width) * 100;
            const sy = ((clientY - r.top) / r.height) * 100;
            const g = toGround(sx, sy);
            state.aimX = Math.max(41, Math.min(59, g.x));
            state.aimY = Math.max(36, Math.min(75, g.y));
            updatePitchReticle();
        };

        strip.addEventListener('pointerdown', (e) => {
            if (isLocalBatting() || state.ballInFlight) return;
            aiming = true;
            SoundFX.click();
            setAimFromPointer(e.clientX, e.clientY);
        });

        window.addEventListener('pointermove', (e) => {
            if (aiming) setAimFromPointer(e.clientX, e.clientY);
            if (isLocalBatting() && $('gameScreen') && !state.shotTaken) {
                const ratio = (e.clientX / window.innerWidth) * 2 - 1;
                state.shotAngle = Math.round(ratio * 130);
                updateShotAimGuide();
            }
        });

        window.addEventListener('pointerup', () => { aiming = false; });
    }

    function updateShotAimGuide() {
        const guide = $('shotAimGuide');
        if (!guide) return;
        guide.style.transform = `translateX(-50%) rotate(${state.shotAngle}deg)`;
    }

    // ==========================================
    // 4. TACTICAL 9-FIELDER PLACEMENT
    // ==========================================
    const FIELD_PRESETS = {
        attacking: [
            { id: 'slip1', short: 'SLIP', x: 42, y: 74 },
            { id: 'gully', short: 'GULLY', x: 32, y: 67 },
            { id: 'point', short: 'POINT', x: 25, y: 56 },
            { id: 'cover', short: 'COVER', x: 31, y: 42 },
            { id: 'midoff', short: 'MID-OFF', x: 42, y: 34 },
            { id: 'midon', short: 'MID-ON', x: 58, y: 34 },
            { id: 'sqleg', short: 'SQ LEG', x: 74, y: 56 },
            { id: 'fineleg', short: 'FINE', x: 68, y: 78 },
            { id: 'shortleg', short: 'S-LEG', x: 60, y: 68 }
        ],
        balanced: [
            { id: 'slip1', short: 'SLIP', x: 42, y: 74 },
            { id: 'point', short: 'POINT', x: 24, y: 55 },
            { id: 'cover', short: 'COVER', x: 29, y: 40 },
            { id: 'midoff', short: 'MID-OFF', x: 41, y: 33 },
            { id: 'midon', short: 'MID-ON', x: 59, y: 33 },
            { id: 'sqleg', short: 'SQ LEG', x: 76, y: 55 },
            { id: 'fineleg', short: 'FINE', x: 70, y: 80 },
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
            { id: 'deepfine', short: 'D-FINE', x: 76, y: 80 },
            { id: 'thirdman', short: '3RD MAN', x: 24, y: 80 },
            { id: 'midoff', short: 'MID-OFF', x: 42, y: 36 }
        ]
    };

    function isOutsideRing(x, y) {
        const dx = (x - 50) / 28;
        const dy = (y - 52) / 34;
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
                        f.x = 50 + (f.x - 50) * 0.62;
                        f.y = 52 + (f.y - 52) * 0.62;
                    }
                }
            });
        }
        renderFielders();
        document.querySelectorAll('#fieldPresetGroup button').forEach(b => b.classList.toggle('active', b.dataset.val === name));
    }

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
                if (isLocalBatting() || state.ballInFlight) return;
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
                    const nx = Math.max(10, Math.min(90, g.x));
                    const ny = Math.max(22, Math.min(86, g.y));

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

    function nearestFielder(x, y) {
        let best = null, bestDist = Infinity;
        state.field.forEach(f => {
            const dx = f.x - x;
            const dy = (f.y - y) * 1.1;
            const d = Math.hypot(dx, dy);
            if (d < bestDist) { bestDist = d; best = f; }
        });
        return { fielder: best, dist: bestDist };
    }

    // ==========================================
    // 5. CONSISTENT VIEW, RUN-UP, BALL & THROWING
    // ==========================================
    function updateVisualPositions() {
        const guard = getActiveVal('batterGuardGroup');
        const depth = getActiveVal('footworkGroup');
        const batX = guard === 'off' ? -22 : guard === 'leg' ? 22 : 0;
        const batY = depth === 'advance' ? -18 : depth === 'back' ? 12 : 0;
        const wrap = strikerWrap();
        if (wrap) {
            const sx = state.povBowler ? -batX : batX;
            const sy = state.povBowler ? -batY : batY;
            const sc = state.povBowler ? ' scale(0.75)' : '';
            wrap.style.transform = `translate(-50%, 0) translateX(${sx}px) translateY(${sy}px)${sc}`;
        }

        const angle = getActiveVal('bowlAngleGroup');
        const bowlEl = $('bowlerEnd');
        if (!bowlEl) return;
        const bowlX = angle === 'wide' ? -20 : angle === 'round' ? 20 : -6;
        bowlEl.style.setProperty('--bowler-x', `${state.povBowler ? -bowlX : bowlX}px`);
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

    function animateBallPath(from, to, durationMs, opts, onDone) {
        if (state.pathAnimId) {
            cancelAnimationFrame(state.pathAnimId);
            state.pathAnimId = null;
        }
        const ball = $('ball'), shadow = $('ballShadow');
        if (!ball) { if (onDone) onDone(); return; }

        const a = toScreen(from.x, from.y);
        const b = toScreen(to.x, to.y);
        const start = performance.now();
        const arc = (opts && opts.arc) || 0;
        const hop = (opts && opts.hop) || 0;
        const startScale = (opts && opts.startScale) || 1.0;
        const endScale = (opts && opts.endScale) || 0.85;

        ball.style.opacity = '1';
        if (shadow) shadow.style.opacity = '0.45';

        function step(now) {
            const t = Math.min(1, (now - start) / durationMs);
            const e = (opts && opts.easing === 'out')
                ? 1 - Math.pow(1 - t, 2.5)
                : t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            const x = a.x + (b.x - a.x) * e;
            const y = a.y + (b.y - a.y) * e;
            const lift = -Math.sin(t * Math.PI) * arc - Math.abs(Math.sin(t * Math.PI * 2)) * hop * (1 - t * 0.5);
            const scale = startScale + (endScale - startScale) * e;

            ball.style.left = `${x}%`;
            ball.style.top = `${y}%`;
            ball.style.transform = `translate(-50%, -50%) translateY(${lift}px) scale(${scale.toFixed(2)})`;

            if (shadow) {
                shadow.style.left = `${x}%`;
                shadow.style.top = `${y + 1.4}%`;
                shadow.style.opacity = lift < -14 ? '0.25' : '0.45';
            }

            if (t < 1) {
                state.pathAnimId = requestAnimationFrame(step);
            } else {
                state.pathAnimId = null;
                if (onDone) onDone();
            }
        }
        state.pathAnimId = requestAnimationFrame(step);
    }

    function throwBallBackToBowler(onDone) {
        const ball = $('ball');
        if (!ball) { if (onDone) onDone(); return; }
        const curS = { x: parseFloat(ball.style.left) || 50, y: parseFloat(ball.style.top) || 50 };
        const cur = toGround(curS.x, curS.y);
        animateBallPath(cur, { x: 50, y: 27 }, 650, { arc: 16, startScale: 0.88, endScale: 0.65 }, () => {
            hideBallVisual();
            if (onDone) onDone();
        });
    }

    // ==========================================
    // 6. REAL-TIME BALL FLIGHT, ACCURACY & LBW
    // ==========================================
    function getTimingFromProgress(pct, depth) {
        const st = currentStriker();
        const sweetWidth = st ? Math.max(12, Math.min(22, 16 + (st.timing - 72) * 0.16)) : 16;
        const sweetMin = depth === 'advance' ? 65 : depth === 'back' ? 77 : 72;
        const sweetMax = sweetMin + sweetWidth;

        if (pct >= sweetMin && pct <= sweetMax) return 'perfect';
        if ((pct >= sweetMin - 14 && pct < sweetMin) || (pct > sweetMax && pct <= sweetMax + 10)) return 'good';
        return pct < sweetMin ? 'early' : 'late';
    }

    function variationLabel(v) {
        return v === 'legspin' ? 'Leg-spin'
            : v === 'offspin' ? 'Off-spin'
            : v === 'inswing' ? 'In-swing'
            : v === 'outswing' ? 'Out-swing'
            : 'Seam';
    }

    function launchBallFlight(delivery, aiBatterShot = null) {
        if (state.flightAnimId) {
            cancelAnimationFrame(state.flightAnimId);
            state.flightAnimId = null;
        }
        clearPendingTimers();
        hideBallVisual();

        state.deliveryId += 1;
        const myDeliveryId = state.deliveryId;
        state.replayFrames = [];
        $('replayBtn').disabled = true;
        state.replaying = false;

        // Keep deliveries accurate to aimed spot unless intentionally aimed way wide
        if (delivery.extra === undefined) {
            const wideChance = (delivery.aimX <= 36 || delivery.aimX >= 64) ? 0.18 : 0.01;
            const r = Math.random();
            if (r < wideChance) delivery.extra = 'wide';
            else if (r < wideChance + (delivery.speed >= 152 ? 0.06 : 0.02)) delivery.extra = 'noball';
            else delivery.extra = null;

            const bw = currentBowler();
            if (bw && bw.fatigue > 0.35) delivery.speed = Math.max(85, Math.round(delivery.speed - bw.fatigue * 8));
        }

        state.activeDelivery = delivery;
        state.ballInFlight = true;
        state.shotTaken = false;
        state.flightProgress = 0;

        const startX = delivery.angle === 'wide' ? 45 : delivery.angle === 'round' ? 55 : 48.5;
        const bounceY = Math.max(36, Math.min(75, delivery.aimY));
        const bounceX = delivery.extra === 'wide'
            ? (delivery.aimX < 50 ? 37 : 63)
            : Math.max(41, Math.min(59, delivery.aimX));

        const ball = $('ball'), shadow = $('ballShadow');
        const startScreen = toScreen(startX, 27);
        if (ball) {
            ball.style.opacity = '1';
            ball.style.top = `${startScreen.y}%`;
            ball.style.left = `${startScreen.x}%`;
        }
        if (shadow) {
            shadow.style.opacity = '0.45';
            shadow.style.top = `${startScreen.y + 1.4}%`;
            shadow.style.left = `${startScreen.x}%`;
        }

        if (isLocalBatting()) {
            setDisabled('playShotBtn', false);
            showEl('runNowBtn', 'none');
            state.runRequested = false;
        }

        const isSpinDel = ['spin', 'legspin', 'offspin'].includes(delivery.variation);
        const effSpeed = isSpinDel ? Math.round(delivery.speed * 0.88) : delivery.speed;
        const flightDurationMs = Math.max(1300, 2400 - (effSpeed * 7));
        const bounceScreenY = toScreen(bounceX, bounceY).y;
        const bouncePct = Math.max(15, Math.min(82, ((bounceScreenY - 27) / (83 - 27)) * 100));

        playBowlerRunUp(() => {
            if (myDeliveryId !== state.deliveryId || !state.ballInFlight) return;
            setStatus(isLocalBatting()
                ? 'Aim (Mouse/Arrows), crease (WASD), swing (SPACE)!'
                : `${variationLabel(delivery.variation)} — ball on its way.`);

            const startTime = performance.now();
            let bounced = false;
            let aiSwung = false;

            function frame(now) {
                if (myDeliveryId !== state.deliveryId || state.shotTaken || !state.ballInFlight) {
                    state.flightAnimId = null;
                    return;
                }

                const elapsed = now - startTime;
                const pct = Math.min(100, (elapsed / flightDurationMs) * 100);
                state.flightProgress = pct;
                const tc = $('timingCursor'); if (tc) tc.style.left = `${pct}%`;

                const yGround = 27 + (pct * 0.56);
                let xGround = startX;

                if (pct < bouncePct) {
                    const pre = pct / Math.max(1, bouncePct);
                    const airSwing = delivery.variation === 'inswing' ? 1.5 * pre * pre :
                                     delivery.variation === 'outswing' ? -1.5 * pre * pre :
                                     delivery.variation === 'legspin' ? -1.0 * pre * pre :
                                     delivery.variation === 'offspin' ? 1.0 * pre * pre : 0;
                    xGround = startX + (bounceX - startX) * pre + airSwing;
                } else {
                    if (!bounced) {
                        bounced = true;
                        SoundFX.pitchBounce();
                    }
                    const post = (pct - bouncePct) / Math.max(1, 100 - bouncePct);
                    const angleContinue = (bounceX - startX) * 0.14;
                    let seamTurn = 0;
                    if (delivery.variation === 'inswing') seamTurn = 2.0;
                    else if (delivery.variation === 'outswing') seamTurn = -2.0;
                    else if (delivery.variation === 'legspin') seamTurn = -2.8;
                    else if (delivery.variation === 'offspin' || delivery.variation === 'spin') seamTurn = 2.8;
                    else if (delivery.variation === 'seam') seamTurn = (delivery.aimX < 50 ? 0.9 : -0.9);
                    xGround = Math.max(36, Math.min(64, bounceX + (angleContinue + seamTurn) * post));
                }

                const bounceHeight = (bounceY < 45 ? 14 : bounceY > 68 ? 4 : 9) + (isSpinDel ? 4 : 0);
                const lift = pct > bouncePct
                    ? -Math.sin(Math.min(1, (pct - bouncePct) / (100 - bouncePct)) * Math.PI) * bounceHeight
                    : 0;
                const scale = state.povBowler ? 1.1 - (pct * 0.0045) : 0.65 + (pct * 0.0045);
                const scr = toScreen(xGround, yGround);
                state.lastBallGround = { x: xGround, y: yGround, impactX: xGround };

                if (ball) {
                    ball.style.left = `${scr.x}%`;
                    ball.style.top = `${scr.y}%`;
                    ball.style.transform = `translate(-50%, -50%) translateY(${lift}px) scale(${scale.toFixed(2)})`;
                }
                if (shadow) {
                    shadow.style.left = `${scr.x}%`;
                    shadow.style.top = `${scr.y + 1.4}%`;
                    shadow.style.opacity = lift < -6 ? '0.25' : '0.45';
                }

                state.replayFrames.push({ x: xGround, y: yGround, lift, scale });

                if (aiBatterShot && !aiSwung && pct >= 78) {
                    aiSwung = true;
                    state.shotTaken = true;
                    state.ballInFlight = false;
                    state.contactPoint = { ...state.lastBallGround };
                    finishFlightAndResolve(delivery, aiBatterShot);
                    return;
                }

                if (pct >= 100) {
                    state.ballInFlight = false;
                    state.flightAnimId = null;
                    setDisabled('playShotBtn', true);
                    submitBatterShot({
                        guard: getActiveVal('batterGuardGroup'),
                        footwork: getActiveVal('footworkGroup'),
                        type: 'leave',
                        angle: 0,
                        timing: 'none'
                    });
                    return;
                }
                state.flightAnimId = requestAnimationFrame(frame);
            }
            state.flightAnimId = requestAnimationFrame(frame);
        });
    }

    function triggerBatterSwing() {
        if (!state.ballInFlight || state.shotTaken || !isLocalBatting()) return;
        state.shotTaken = true;
        state.ballInFlight = false;
        if (state.flightAnimId) {
            cancelAnimationFrame(state.flightAnimId);
            state.flightAnimId = null;
        }
        state.contactPoint = state.lastBallGround ? { ...state.lastBallGround } : { x: 50, y: 82 };

        const halo = $('timingHalo');
        if (halo) { halo.classList.remove('impact'); void halo.offsetWidth; halo.classList.add('impact'); }

        const swing = $('swingGroup');
        if (swing) {
            swing.classList.remove('impact-hit'); void swing.offsetWidth;
            swing.classList.add('impact-hit');
            setTimeout(() => { if (swing) swing.classList.remove('impact-hit'); }, 150);
        }

        $('playShotBtn').disabled = true;
        $('runNowBtn').style.display = 'inline-block';
        $('runNowBtn').disabled = false;

        const depth = getActiveVal('footworkGroup');
        const shot = {
            guard: getActiveVal('batterGuardGroup'),
            footwork: depth,
            type: getActiveVal('shotTypeGroup'),
            angle: state.shotAngle,
            timing: getTimingFromProgress(state.flightProgress, depth)
        };
        submitBatterShot(shot);
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
        }
    }

    function computeLanding360(shot) {
        const rad = (shot.angle * Math.PI) / 180;
        let baseDist;
        if (shot.type === 'loft') {
            baseDist = shot.timing === 'perfect' ? 56 : shot.timing === 'good' ? 42 : 26;
        } else if (shot.type === 'defend') {
            baseDist = 8 + (shot.timing === 'perfect' ? 4 : 0);
        } else if (shot.type === 'ground') {
            baseDist = shot.timing === 'perfect' ? 44 : shot.timing === 'good' ? 32 : 18;
        } else if (shot.type === 'cutpull') {
            baseDist = shot.timing === 'perfect' ? 40 : shot.timing === 'good' ? 28 : 16;
        } else if (shot.type === 'sweep') {
            baseDist = shot.timing === 'perfect' ? 30 : shot.timing === 'good' ? 21 : 12;
        } else {
            baseDist = shot.timing === 'perfect' ? 36 : 22;
        }

        const powerBonus = shot.timing === 'perfect' ? 1.12 : shot.timing === 'good' ? 1.04 : 0.96;
        const dist = baseDist * powerBonus;
        const x = 50 + Math.sin(rad) * dist;
        const y = 82 - Math.cos(rad) * dist * 1.02;
        return {
            x: Math.max(8, Math.min(92, x)),
            y: Math.max(22, Math.min(86, y))
        };
    }

    // LBW evaluation helper: pitched in line / stumps, impact in line with stumps, hitting stumps
    function evaluateLBW(delivery, shot, impactX) {
        if (state.freeHit || delivery.extra === 'noball' || delivery.extra === 'wide') return false;
        const lengthCat = getLengthCategoryFromY(delivery.aimY);
        if (lengthCat === 'short') return false; // too high over stumps

        const pitchedInLine = delivery.aimX >= 44 && delivery.aimX <= 56;
        const impactInLine = impactX >= 45 && impactX <= 55;
        const hitsStumps = Math.abs(impactX - 50) <= 4.2;

        if (!pitchedInLine || !impactInLine || !hitsStumps) return false;

        // If batter left it or missed completely with poor timing on a straight delivery
        const missedBall = shot.type === 'leave' ||
            ((shot.timing === 'early' || shot.timing === 'late') && Math.random() < 0.36);
        return missedBall;
    }

    function resolveBall(delivery, shot) {
        const lengthCat = getLengthCategoryFromY(delivery.aimY);
        const lineCat = getLineCategoryFromX(delivery.aimX);
        const bw = currentBowler();
        const impactX = state.lastBallGround ? state.lastBallGround.impactX : delivery.aimX;

        if (delivery.extra === 'wide') {
            state.extras.wides += 1;
            return { isOut: false, outType: null, runs: 1, commentary: 'Wide ball! +1 extra', extra: 'wide', legal: false, landing: { x: 50, y: 86 } };
        }

        // Check LBW before leave/miss resolution
        if (evaluateLBW(delivery, shot, impactX)) {
            return {
                isOut: true,
                outType: 'lbw',
                runs: 0,
                commentary: 'LBW! Trapped dead in front of the stumps!',
                landing: { x: 50, y: 83 },
                legal: true,
                extra: null
            };
        }

        if (shot.type === 'leave') {
            const stumpsExposed = shot.guard === 'leg' && lineCat !== 'off';
            if ((lineCat === 'middle' || stumpsExposed) && lengthCat !== 'short') {
                if (delivery.extra === 'noball') {
                    state.extras.noBalls += 1;
                    return { isOut: false, outType: null, runs: 1, commentary: 'BOWLED off a no-ball — FREE HIT next!', extra: 'noball', legal: false, freeHitNext: true, landing: { x: 50, y: 85 } };
                }
                return { isOut: true, outType: 'bowled', runs: 0, commentary: 'BOWLED! Left a straight delivery!' };
            }
            return { isOut: false, outType: null, runs: 0, commentary: 'Left cleanly to the keeper.' };
        }

        const effectiveLength = (shot.footwork === 'advance' && lengthCat === 'good') ? 'full' : lengthCat;
        const goodDepth =
            (effectiveLength === 'short' && shot.footwork === 'back') ||
            ((effectiveLength === 'full' || effectiveLength === 'yorker') && shot.footwork !== 'back') ||
            (effectiveLength === 'good' && shot.footwork !== 'back');

        const goodShotChoice =
            (effectiveLength === 'short' && (shot.type === 'cutpull' || shot.type === 'defend')) ||
            (effectiveLength === 'yorker' && (shot.type === 'defend' || shot.type === 'ground')) ||
            ((effectiveLength === 'good' || effectiveLength === 'full') && ['ground', 'sweep', 'loft', 'defend'].includes(shot.type));

        const landing = computeLanding360(shot);
        const near = nearestFielder(landing.x, landing.y);

        let outChance = 0.03;
        if ((shot.type === 'loft' || shot.type === 'cutpull') && near.fielder && near.dist < 15) outChance += 0.16;
        if (!goodDepth) outChance += 0.1;
        if (!goodShotChoice) outChance += 0.1;
        if (shot.type === 'loft') outChance += 0.07;
        if (shot.type === 'defend') outChance -= 0.03;
        if (shot.timing === 'early' || shot.timing === 'late') outChance += 0.2;
        if (shot.timing === 'perfect') outChance -= 0.05;
        if (bw) outChance += (bw.bowlSkill - 72) * 0.0018;
        if (state.freeHit) outChance = 0;

        outChance = Math.max(0.01, Math.min(0.62, outChance));

        let isOut = false;
        let outType = null;
        let runs = 0;
        let commentary = '';

        if (Math.random() < outChance) {
            isOut = true;
            if (lengthCat === 'yorker' && shot.type === 'loft') {
                outType = 'bowled';
                commentary = 'BOWLED! Yorker rattles the stumps!';
            } else if (shot.footwork === 'advance' && ['spin', 'legspin', 'offspin'].includes(delivery.variation)) {
                outType = 'stumped';
                commentary = 'STUMPED! Quick glovework by the keeper!';
            } else if (near.fielder && (shot.type === 'loft' || shot.type === 'cutpull')) {
                outType = 'caught';
                commentary = `CAUGHT by ${near.fielder.short}!`;
            } else {
                outType = 'caught';
                commentary = 'CAUGHT behind the wicket!';
            }
        } else {
            if (shot.type === 'defend') {
                runs = (shot.timing === 'perfect' && near.dist > 18 && Math.random() < 0.35) ? 1 : 0;
            } else if (shot.type === 'loft') {
                if (shot.timing === 'perfect' && goodDepth) runs = 6;
                else if (shot.timing === 'good') runs = 4;
                else runs = 1;
            } else {
                if (shot.timing === 'perfect' && goodDepth && goodShotChoice) runs = near.dist > 13 ? 4 : 2;
                else if (shot.timing === 'perfect' || shot.timing === 'good') runs = near.dist > 15 ? 2 : 1;
                else runs = 0;
            }

            if (runs >= 4 && near.fielder && near.dist < 10 && shot.timing !== 'perfect') {
                runs = 2;
                commentary = `Great fielding by ${near.fielder.short}! Cut off at 2.`;
            } else {
                commentary = runs === 6 ? 'SIX! Over the boundary rope!' :
                             runs === 4 ? 'FOUR! Racing to the boundary!' :
                             runs === 0 ? 'Dot ball.' : `${runs} run${runs > 1 ? 's' : ''}.`;
            }
        }

        if (delivery.extra === 'noball') {
            state.extras.noBalls += 1;
            return {
                runs: runs + 1,
                isOut: false,
                outType: null,
                commentary: 'NO BALL! +1 & FREE HIT next ball!',
                extra: 'noball',
                legal: false,
                freeHitNext: true,
                landing,
                nearestFielder: near.fielder,
                nearestDist: near.dist,
                gap: near.dist > 20
            };
        }

        const beaten = !isOut && runs === 0 && (shot.timing === 'early' || shot.timing === 'late')
            && shot.type !== 'defend' && shot.type !== 'leave';
        return {
            runs,
            isOut,
            outType,
            commentary,
            landing,
            nearestFielder: near.fielder,
            nearestDist: near.dist,
            caughtBy: (isOut && outType === 'caught' && near.fielder) ? near.fielder : null,
            beaten,
            gap: near.dist > 20,
            legal: true,
            extra: null
        };
    }

    function finishFlightAndResolve(delivery, shot, precomputed = null) {
        if (state.flightAnimId) {
            cancelAnimationFrame(state.flightAnimId);
            state.flightAnimId = null;
        }
        state.ballInFlight = false;
        const startPt = state.contactPoint || state.lastBallGround || { x: 50, y: 82 };
        state.contactPoint = null;

        if (shot.type !== 'leave') {
            if (shot.type === 'defend') SoundFX.batDefend();
            else SoundFX.batCrack(shot.timing === 'perfect' ? 1.25 : 1.0);
            const fig = $('batterFigure');
            if (fig) {
                fig.classList.remove('anim-defend', 'anim-ground', 'anim-cutpull', 'anim-sweep', 'anim-loft');
                void fig.offsetWidth;
                fig.classList.add(`anim-${shot.type}`);
                setTimeout(() => { if (fig) fig.classList.remove(`anim-${shot.type}`); }, 550);
            }
        }

        const outcome = precomputed || resolveBall(delivery, shot);
        const isRunningHit = !outcome.isOut && outcome.runs >= 1 && outcome.runs <= 3 && shot.type !== 'leave' && !outcome.extra;

        if (isRunningHit) {
            if (state.mode === 'online') {
                applyRunningOutcome(delivery, shot, outcome, outcome.runs, false, outcome.runs, startPt);
            } else {
                startRunningPhase(delivery, shot, outcome, startPt);
            }
            return;
        }

        animateBallToOutcome(outcome, shot, () => {
            const calledRun = state.runRequested && state.mode === 'ai' && !outcome.isOut && outcome.runs === 0 && shot.type !== 'leave' && !outcome.extra;
            state.runRequested = false;
            if (calledRun) {
                outcome.runs = 1;
                startRunningPhase(delivery, shot, outcome, startPt);
                return;
            }
            applyOutcomeNow(delivery, shot, outcome);
        }, startPt);
    }

    function animateBallToOutcome(outcome, shot, onDone, startPt) {
        const start = startPt || { x: 50, y: 82 };
        const landing = outcome.landing || computeLanding360(shot);
        const isBoundary = !outcome.isOut && outcome.runs >= 4;
        let endPt = landing, mode = 'field';

        if (outcome.outType === 'bowled') {
            endPt = { x: 50, y: 83 };
            mode = 'bowled';
        } else if (outcome.outType === 'lbw') {
            endPt = { x: 50, y: 82 };
            mode = 'lbw';
        } else if (shot.type === 'leave' || outcome.beaten || outcome.outType === 'stumped') {
            endPt = { x: 50, y: 87 };
            mode = 'keeper';
        } else if (outcome.isOut && outcome.caughtBy) {
            endPt = { x: outcome.caughtBy.x, y: outcome.caughtBy.y };
            mode = 'catch';
        } else if (isBoundary) {
            const dx = landing.x - 50;
            const dy = landing.y - 52;
            const len = Math.max(1, Math.hypot(dx, dy));
            endPt = {
                x: Math.max(8, Math.min(92, 50 + (dx / len) * 42)),
                y: Math.max(20, Math.min(84, 52 + (dy / len) * 32))
            };
            mode = 'boundary';
        }

        const arc = mode === 'keeper' || mode === 'lbw' ? 3
            : outcome.runs >= 6 ? 38
            : shot.type === 'loft' ? 32
            : shot.type === 'cutpull' ? 16
            : shot.type === 'sweep' ? 12 : 5;
        const hop = (mode === 'field' || mode === 'boundary') && (shot.type === 'ground' || shot.type === 'defend') ? 8 : 0;
        const ballDur = mode === 'keeper' ? 480 : isBoundary ? 950 : 750;

        const fielderEl = (mode === 'field' || mode === 'catch' || mode === 'boundary') && outcome.nearestFielder
            ? document.querySelector(`.fielder[data-id="${outcome.nearestFielder.id}"]`) : null;

        if (fielderEl) {
            const endS = toScreen(endPt.x, endPt.y);
            fielderEl.classList.add('chasing');
            fielderEl.style.transitionDuration = `${Math.max(350, ballDur - 120)}ms`;
            fielderEl.style.left = `${endS.x}%`;
            fielderEl.style.top = `${endS.y}%`;
        }

        animateBallPath(start, endPt, ballDur, {
            arc,
            hop,
            easing: 'out',
            startScale: 1.05,
            endScale: mode === 'keeper' ? 0.85 : 0.72
        }, () => {
            if (fielderEl && outcome.nearestFielder) {
                fielderEl.classList.remove('chasing');
                if (mode === 'catch') {
                    fielderEl.classList.add('catching');
                    showBanner('CAUGHT!', `${outcome.nearestFielder.short} takes the catch!`);
                    SoundFX.crowdRoar(false);
                }
                setTimeout(() => {
                    if (!fielderEl || !outcome.nearestFielder) return;
                    fielderEl.classList.remove('catching');
                    const home = toScreen(outcome.nearestFielder.x, outcome.nearestFielder.y);
                    fielderEl.style.transitionDuration = '380ms';
                    fielderEl.style.left = `${home.x}%`;
                    fielderEl.style.top = `${home.y}%`;
                }, 550);
            }

            if (mode === 'boundary') {
                setTimeout(() => {
                    hideBallVisual();
                    if (onDone) onDone();
                }, 350);
                return;
            }

            if (state.runRequested && state.mode === 'ai' && outcome.runs === 0 && !outcome.isOut && !outcome.extra) {
                if (onDone) onDone();
                return;
            }
            throwBallBackToBowler(onDone);
        });
    }

    function startRunningPhase(delivery, shot, outcome, startPt) {
        state.pendingRun = { delivery, shot, outcome, startPt };
        const dist = Math.round(outcome.nearestDist || 25);
        $('runningMsg').textContent = `Gap found (${dist}m)! Call runs:`;

        if (isLocalBatting() && state.mode === 'ai') {
            $('runningPanel').style.display = 'flex';
            state.runTimer = setTimeout(() => chooseRuns(outcome.runs), 3200);
        } else {
            const aiRuns = outcome.gap ? Math.min(3, outcome.runs + 1) : 1;
            setTimeout(() => completeRunning(aiRuns), 400);
        }
    }

    function chooseRuns(n) {
        if (!state.pendingRun) return;
        $('runningPanel').style.display = 'none';
        if (state.runTimer) { clearTimeout(state.runTimer); state.runTimer = null; }
        completeRunning(n);
    }

    function completeRunning(attempted) {
        const pending = state.pendingRun;
        if (!pending) return;
        state.pendingRun = null;
        const { delivery, shot, outcome } = pending;

        const dist = outcome.nearestDist || 25;
        let runOutChance = dist < 14 ? 0.22 : dist < 22 ? 0.09 : 0.03;
        if (attempted >= 2) runOutChance += 0.12;
        if (attempted >= 3) runOutChance += 0.16;
        const runOut = attempted > 0 && Math.random() < runOutChance;
        const completed = attempted === 0 ? 0 : runOut ? attempted - 1 : attempted;

        applyRunningOutcome(delivery, shot, outcome, attempted, runOut, completed, pending.startPt);
    }

    function applyRunningOutcome(delivery, shot, outcome, attempted, runOut, completed, startPt) {
        const landing = outcome.landing || { x: 50, y: 45 };
        const start = startPt || { x: 50, y: 82 };
        const runMs = Math.max(0, attempted * state.runCrossMs);

        const fielderEl = outcome.nearestFielder
            ? document.querySelector(`.fielder[data-id="${outcome.nearestFielder.id}"]`) : null;
        if (fielderEl && attempted > 0) {
            const endS = toScreen(landing.x, landing.y);
            fielderEl.classList.add('chasing');
            fielderEl.style.transitionDuration = '750ms';
            fielderEl.style.left = `${endS.x}%`;
            fielderEl.style.top = `${endS.y}%`;
        }

        animateBallPath(start, landing, 750, {
            arc: shot.type === 'loft' ? 26 : 8,
            hop: shot.type === 'ground' ? 8 : 0,
            easing: 'out',
            startScale: 1.05,
            endScale: 0.82
        }, () => {
            setTimeout(() => {
                if (fielderEl && outcome.nearestFielder) {
                    fielderEl.classList.remove('chasing');
                    fielderEl.style.transitionDuration = '';
                    const home = toScreen(outcome.nearestFielder.x, outcome.nearestFielder.y);
                    fielderEl.style.left = `${home.x}%`;
                    fielderEl.style.top = `${home.y}%`;
                }
                throwBallBackToBowler();
            }, Math.max(250, runMs - 750));
        });

        const bat = strikerWrap(), ns = otherWrap();
        if (attempted > 0 && bat && ns) {
            const batFig = bat.querySelector('.player'), nsFig = ns.querySelector('.player');
            const pitchLengthVh = 54;
            const batDelta = state.povBowler ? pitchLengthVh : -pitchLengthVh;
            const nsDelta = state.povBowler ? -pitchLengthVh : pitchLengthVh;
            const runTimePerCross = state.runCrossMs;

            bat.classList.add('running-exchange');
            ns.classList.add('running-exchange');
            if (batFig) batFig.classList.add('sprinting');
            if (nsFig) nsFig.classList.add('sprinting');

            let crossesLeft = attempted;
            const doCross = () => {
                const isCrossed = (attempted - crossesLeft) % 2 === 1;
                bat.style.transform = isCrossed
                    ? `translate(-50%, 0) translateY(${batDelta}vh)`
                    : 'translate(-50%, 0) translateY(0)';
                ns.style.transform = isCrossed
                    ? `translate(-50%, 0) translateY(${nsDelta}vh)`
                    : 'translate(-50%, 0) translateY(0)';

                crossesLeft--;
                if (crossesLeft > 0) {
                    setTimeout(doCross, runTimePerCross);
                } else {
                    setTimeout(() => {
                        bat.classList.remove('running-exchange');
                        ns.classList.remove('running-exchange');
                        if (batFig) batFig.classList.remove('sprinting');
                        if (nsFig) nsFig.classList.remove('sprinting');
                        if (attempted % 2 === 1) {
                            state.endsSwapped = !state.endsSwapped;
                            const pitch = $('pitch');
                            if (pitch) pitch.classList.toggle('ends-swapped', state.endsSwapped);
                            placeFigures();
                        }
                        bat.style.transform = '';
                        ns.style.transform = '';
                        updateVisualPositions();
                    }, runTimePerCross);
                }
            };
            doCross();
        }

        const finalOutcome = {
            ...outcome,
            runs: completed,
            isOut: runOut ? true : outcome.isOut,
            outType: runOut ? 'runout' : outcome.outType,
            commentary: runOut ? 'RUN OUT! Short of the crease!' : completed === 0 ? 'No run.' : `${completed} run${completed > 1 ? 's' : ''} completed!`
        };

        setTimeout(() => applyOutcomeNow(delivery, shot, finalOutcome, runOut), Math.max(950, attempted * state.runCrossMs + 450));
    }

    function applyOutcomeNow(delivery, shot, outcome, runOut = false) {
        hideBallVisual();

        if (outcome.isOut || runOut) {
            umpireSignal('out');
            SoundFX.stumpsShatter();
            SoundFX.crowdRoar(false);
            const bigLabel = outcome.outType === 'lbw' ? 'LBW!' : 'OUT!';
            showBanner(bigLabel, outcome.commentary);
            const stumps = $('batterStumps');
            if (stumps && outcome.outType === 'bowled') {
                stumps.classList.add('shattered');
                setTimeout(() => { if (stumps) stumps.classList.remove('shattered'); }, 850);
            }
        } else if (outcome.runs >= 6) {
            umpireSignal('six');
            SoundFX.crowdRoar(true);
            showBanner('SIX!', outcome.commentary);
        } else if (outcome.runs === 4) {
            umpireSignal('four');
            SoundFX.crowdRoar(true);
            showBanner('FOUR!', outcome.commentary);
        } else {
            if (outcome.extra === 'wide' || outcome.extra === 'noball') umpireSignal('wide');
            showBanner('', outcome.commentary);
        }

        const team = state[state.battingSide];
        const isLegal = outcome.legal !== false;
        if (isLegal) team.balls += 1;
        if (outcome.isOut || runOut) team.wickets += 1;
        team.score += outcome.runs;
        state.freeHit = !!outcome.freeHitNext;

        const st = currentStriker(), bw = currentBowler();
        const batRuns = (outcome.extra === 'wide') ? 0 : Math.max(0, outcome.runs - (outcome.extra === 'noball' ? 1 : 0));

        if (st) {
            st.batRuns += batRuns;
            if (outcome.extra !== 'wide') st.batBalls += 1;
            if (batRuns === 4) st.fours += 1;
            if (batRuns === 6) st.sixes += 1;
            if (outcome.isOut || runOut) {
                st.out = true;
                st.outHow = runOut ? 'run out'
                    : outcome.outType === 'lbw' ? 'lbw'
                    : outcome.outType === 'bowled' ? 'b'
                    : outcome.outType === 'stumped' ? 'st' : 'c';
            }
        }
        if (bw) {
            if (isLegal) bw.bowlBalls += 1;
            bw.bowlRuns += outcome.runs;
            if (outcome.isOut && !runOut) bw.bowlWkts += 1;
            bw.oversBowled = Math.floor(bw.bowlBalls / 6);
            bw.fatigue = Math.min(0.6, bw.bowlBalls * 0.02);
        }

        if (outcome.landing && (outcome.runs > 0 || outcome.isOut)) {
            state.wagonShots.push({ x: outcome.landing.x, y: outcome.landing.y, runs: batRuns });
        }
        state.currentOverRuns += outcome.runs;

        if (!outcome.isOut && !runOut && outcome.runs % 2 === 1) {
            const tmp = state.strikerIdx;
            state.strikerIdx = state.nonStrikerIdx;
            state.nonStrikerIdx = tmp;
        }
        if (outcome.isOut || runOut) {
            if (state.nextBatterIdx < PLAYERS_PER_TEAM) {
                state.strikerIdx = state.nextBatterIdx++;
            }
        }

        updateHud();
        $('replayBtn').disabled = !state.replayFrames.length;

        if (isLegal && team.balls % 6 === 0 && team.balls > 0) {
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

        setTimeout(prepareNextBall, 1050);
    }

    function updatePowerplay() {
        const team = state[state.battingSide];
        const oversDone = Math.floor((team ? team.balls : 0) / 6);
        state.powerplay = oversDone < Math.max(1, Math.round(state.maxOvers * 0.2));
    }

    // ==========================================
    // 7. TURN FLOW & SMART AI
    // ==========================================
    function isLocalBatting() {
        if (state.mode === 'ai') return state.battingSide === 'p1';
        return (state.role === 'host' && state.battingSide === 'p1') || (state.role === 'guest' && state.battingSide === 'p2');
    }

    function prepareNextBall() {
        if (checkMatchProgression()) return;
        hideBallVisual();
        updateHud();
        updateCameraForRole();
        updateVisualPositions();
        const tc = $('timingCursor'); if (tc) tc.style.left = '0%';
        showEl('runningPanel', 'none');

        if (isLocalBatting()) {
            showEl('battingControls', 'flex');
            showEl('bowlingControls', 'none');
            setDisabled('playShotBtn', true);
            showEl('pitchMarker', 'none');
            showEl('shotAimGuide', 'block');

            if (state.mode === 'ai') {
                setStatus('Set guard (WASD) & aim shot — bowler coming in...');
                if (state.autoBallTimer) clearTimeout(state.autoBallTimer);
                state.autoBallTimer = setTimeout(() => {
                    if (isLocalBatting() && !state.ballInFlight && !state.shotTaken) {
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
        const angle = pick(['over', 'wide', 'round']);
        const variation = isSpinBowler
            ? pick(['legspin', 'offspin', 'legspin', 'offspin', 'seam'])
            : pick(['seam', 'seam', 'inswing', 'outswing', 'legspin', 'offspin']);
        let aimX = 44 + Math.floor(Math.random() * 13); // 44..56% accurate corridor
        let aimY = 40 + Math.floor(Math.random() * 32); // 40..71%

        if (state.aiMemory.ballsFaced >= 3 && Math.random() < 0.7) {
            if ((state.aiMemory.shotTypes.loft || 0) >= 2) {
                aimY = 70;
                setFieldPreset('defensive');
            }
            if ((state.aiMemory.footwork.advance || 0) >= 2) {
                aimY = 40;
            }
        }

        return { angle, variation, aimX, aimY, speed: baseSpeed + Math.floor(Math.random() * 8) };
    }

    function generateAIShot(delivery) {
        const lenCat = getLengthCategoryFromY(delivery.aimY);
        const types = lenCat === 'short' ? ['cutpull', 'ground'] : lenCat === 'yorker' ? ['defend', 'ground'] : ['ground', 'loft', 'cutpull', 'sweep'];
        const timings = state.difficulty === 'hard' ? ['perfect', 'perfect', 'good'] : state.difficulty === 'easy' ? ['good', 'early', 'late'] : ['perfect', 'good', 'good'];

        const candidateAngles = [-110, -65, -25, 0, 25, 65, 110];
        let bestAngle = 0, bestDist = -1;
        candidateAngles.forEach(ang => {
            const pt = computeLanding360({ angle: ang, type: 'ground', timing: 'perfect' });
            const near = nearestFielder(pt.x, pt.y);
            if (near.dist > bestDist) { bestDist = near.dist; bestAngle = ang; }
        });

        return {
            guard: getLineCategoryFromX(delivery.aimX),
            footwork: lenCat === 'short' ? 'back' : 'crease',
            type: pick(types),
            angle: bestAngle,
            timing: pick(timings)
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
    // 8. SCORECARD, WAGON WHEEL & REPLAY
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
        if (state.replaying || !state.replayFrames.length || state.ballInFlight) return;
        state.replaying = true;
        $('replayBtn').disabled = true;
        const ball = $('ball');
        const frames = state.replayFrames;
        const start = performance.now();
        const duration = frames.length * 32;
        if (ball) ball.style.opacity = '1';

        function step(now) {
            const t = Math.min(1, (now - start) / duration);
            const f = frames[Math.min(frames.length - 1, Math.floor(t * frames.length))];
            if (f && ball) {
                const sc = toScreen(f.x, f.y);
                ball.style.left = `${sc.x}%`;
                ball.style.top = `${sc.y}%`;
                ball.style.transform = `translate(-50%, -50%) translateY(${f.lift}px) scale(${f.scale})`;
            }
            if (t < 1) {
                requestAnimationFrame(step);
            } else {
                state.replaying = false;
                hideBallVisual();
                $('replayBtn').disabled = false;
                updateCameraForRole();
            }
        }
        requestAnimationFrame(step);
    }

    // ==========================================
    // 9. INIT, BINDINGS & KEYBOARD
    // ==========================================
    function getActiveVal(groupId) {
        const el = $(groupId)?.querySelector('.active');
        return el ? el.dataset.val : '';
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
        hideBallVisual();

        if (!state.conditions) generateConditions();
        const ss0 = $('startScreen'); if (ss0) ss0.classList.remove('active');
        const rs0 = $('resultScreen'); if (rs0) rs0.classList.remove('active');

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
        if (isLocalBatting() || state.ballInFlight) return;
        SoundFX.click();
        $('deliverBallBtn').disabled = true;
        const delivery = {
            angle: getActiveVal('bowlAngleGroup'),
            variation: getActiveVal('bowlVarGroup') === 'spin' ? 'offspin' : getActiveVal('bowlVarGroup'),
            aimX: state.aimX,
            aimY: state.aimY,
            speed: Number($('bowlSpeedSlider').value)
        };
        if (state.mode === 'ai') {
            launchBallFlight(delivery, generateAIShot(delivery));
        } else {
            state.activeDelivery = delivery;
            sendNet({ type: 'BOWL_DELIVERY', delivery });
            launchBallFlight(delivery, null);
        }
    });

    on('playShotBtn', 'click', triggerBatterSwing);
    on('runNowBtn', 'click', () => {
        if (state.pendingRun) { $('runningPanel').style.display = 'flex'; return; }
        state.runRequested = true;
        $('runNowBtn').disabled = true;
        setStatus('Run called!');
    });

    document.querySelectorAll('#runningPanel button').forEach(btn => {
        btn.addEventListener('click', () => chooseRuns(Number(btn.dataset.runs)));
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

        if (isLocalBatting()) {
            if (k === 'a') selectButtonByVal('batterGuardGroup', getActiveVal('batterGuardGroup') === 'leg' ? 'middle' : 'off');
            if (k === 'd') selectButtonByVal('batterGuardGroup', getActiveVal('batterGuardGroup') === 'off' ? 'middle' : 'leg');
            if (k === 'w') selectButtonByVal('footworkGroup', getActiveVal('footworkGroup') === 'back' ? 'crease' : 'advance');
            if (k === 's') selectButtonByVal('footworkGroup', getActiveVal('footworkGroup') === 'advance' ? 'crease' : 'back');

            const shots = { '1': 'defend', '2': 'ground', '3': 'cutpull', '4': 'sweep', '5': 'loft' };
            if (shots[e.key]) selectButtonByVal('shotTypeGroup', shots[e.key]);

            if (e.key === 'ArrowLeft') { state.shotAngle = Math.max(-130, state.shotAngle - 20); updateShotAimGuide(); }
            if (e.key === 'ArrowRight') { state.shotAngle = Math.min(130, state.shotAngle + 20); updateShotAimGuide(); }
            if (e.key === 'ArrowUp') { state.shotAngle = 0; updateShotAimGuide(); }

            if (e.code === 'Space' && state.ballInFlight && !state.shotTaken) {
                e.preventDefault();
                triggerBatterSwing();
            }
            if (k === 'r' && (state.ballInFlight || state.shotTaken)) {
                state.runRequested = true;
                setDisabled('runNowBtn', true);
            }
        }
    });

    function sendNet(payload) { if (state.conn && state.conn.open) state.conn.send(payload); }
    function setupConnection(conn, isHost) {
        state.conn = conn;
        conn.on('open', () => {
            if (isHost) {
                sendNet({ type: 'START_MATCH', maxOvers: state.maxOvers });
                initMatch('host');
            }
        });
        conn.on('data', (data) => {
            if (data.type === 'START_MATCH' && !isHost) { state.maxOvers = data.maxOvers; initMatch('guest'); }
            if (data.type === 'BOWL_DELIVERY' && isLocalBatting()) launchBallFlight(data.delivery, null);
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
})();
