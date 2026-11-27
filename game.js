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
            step() { playTone(210, 170, 0.035, 'sine', 0.05); },
            bowlWhoosh() { playNoise(0.22, 950, 'bandpass', 0.12); },
            pitchBounce() { playTone(165, 72, 0.08, 'sine', 0.22); },
            batDefend() {
                playTone(250, 115, 0.08, 'triangle', 0.18);
                playNoise(0.05, 1100, 'highpass', 0.09);
            },
            batCrack(power = 1) {
                playTone(440 * power, 125, 0.12, 'triangle', 0.34);
                playNoise(0.08, 2500, 'bandpass', 0.28);
            },
            stumpsShatter() {
                playNoise(0.32, 1900, 'highpass', 0.35);
                playTone(340, 85, 0.22, 'sawtooth', 0.24);
            },
            crowdRoar(big = false) {
                playNoise(big ? 1.6 : 0.9, 620, 'lowpass', big ? 0.28 : 0.15);
                if (big) playTone(523.25, 659.25, 0.28, 'triangle', 0.1);
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
        peer: null,
        conn: null,
        cameraMode: 'batter',
        fieldPreset: 'balanced',
        field: [],
        // Direct Pitch Aim Coordinates (x: 25..75%, y: 32..76%)
        aimX: 46,
        aimY: 56,
        // 360° Shot Angle in degrees (-140° fine off to +140° fine leg, 0° = straight)
        shotAngle: 0,
        pendingRun: null,
        runTimer: null,
        deliveryId: 0,
        runUpTimers: [],
        replayFrames: [],
        replaying: false,
        freeHit: false,
        powerplay: true,
        extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 },
        autoBallTimer: null,
        autoBowlTimer: null,
        runRequested: false,
        runCrossMs: 1100,
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
        const windKmh = 6 + Math.floor(Math.random() * 22);
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
            pitch,
            swingBoost: (weather === 'Overcast' || weather === 'Humid') ? 0.08 : 0.02,
            spinBoost: pitch.includes('Dry') ? 0.07 : 0
        };
        renderConditions();
    }

    function renderConditions() {
        const c = state.conditions;
        if (!c) return;
        if ($('condVenue')) $('condVenue').textContent = `🏟️ ${c.venue}`;
        if ($('condWeather')) $('condWeather').textContent = `${c.weather === 'Sunny' ? '☀️' : c.weather === 'Light Drizzle' ? '🌧️' : '⛅'} ${c.weather} ${c.tempC}°C`;
        if ($('condPitch')) $('condPitch').textContent = `🌱 ${c.pitch}`;

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
        if (!b || idx === state.lastBowlerIdx || b.oversBowled >= maxBowlerOvers()) return false;
        return true;
    }

    function updateHud() {
        const team = state[state.battingSide];
        const tag = state.battingSide === 'p1' ? 'YOU' : (state.mode === 'ai' ? 'AI' : 'P2');
        $('battingTeamTag').textContent = tag;
        $('liveScore').textContent = team.score;
        $('liveWickets').textContent = team.wickets;
        $('liveOvers').textContent = `(${Math.floor(team.balls / 6)}.${team.balls % 6}/${state.maxOvers})`;

        if (state.target !== null) {
            $('targetBadge').style.display = 'inline-block';
            const need = Math.max(0, state.target - team.score);
            const left = Math.max(0, state.maxOvers * 6 - team.balls);
            $('targetBadge').textContent = `NEED ${need} OFF ${left}B`;
        } else {
            $('targetBadge').style.display = 'none';
        }

        $('freeHitBadge').style.display = state.freeHit ? 'inline-block' : 'none';
        $('powerplayBadge').style.display = state.powerplay ? 'inline-block' : 'none';

        const st = currentStriker(), ns = currentNonStriker(), bw = currentBowler();
        if (st) $('strikerHud').innerHTML = `🏏 <b>${st.name}</b> ${st.batRuns} (${st.batBalls})`;
        if (ns) $('nonStrikerHud').innerHTML = `<b>${ns.name}</b> ${ns.batRuns} (${ns.batBalls})`;
        if (bw) $('bowlerHud').innerHTML = `⚾ <b>${bw.name}</b> ${bw.bowlWkts}/${bw.bowlRuns} (${Math.floor(bw.bowlBalls / 6)}.${bw.bowlBalls % 6})`;
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
    // 3. INTERACTIVE PITCH AIM & 360° SHOT AIM
    // ==========================================
    function updatePitchReticle() {
        const marker = $('pitchMarker');
        if (!marker) return;
        marker.style.left = `${state.aimX}%`;
        marker.style.top = `${state.aimY}%`;
        $('lengthLabel').textContent = getLengthLabelFromY(state.aimY).toUpperCase();
    }

    function getLengthLabelFromY(yPct) {
        if (yPct >= 70) return 'Yorker';
        if (yPct >= 58) return 'Full';
        if (yPct >= 44) return 'Good Length';
        return 'Short / Bouncer';
    }

    function getLengthCategoryFromY(yPct) {
        if (yPct >= 70) return 'yorker';
        if (yPct >= 58) return 'full';
        if (yPct >= 44) return 'good';
        return 'short';
    }

    function getLineCategoryFromX(xPct) {
        if (xPct < 46) return 'off';
        if (xPct > 54) return 'leg';
        return 'middle';
    }

    // Click or drag directly on the pitch to place the ball bounce spot
    function bindPitchAiming() {
        const stage = $('cameraStage');
        const strip = $('pitchStrip');
        if (!stage || !strip) return;

        let aiming = false;
        const setAimFromPointer = (clientX, clientY) => {
            if (isLocalBatting() || state.ballInFlight) return;
            const r = stage.getBoundingClientRect();
            const nx = ((clientX - r.left) / r.width) * 100;
            const ny = ((clientY - r.top) / r.height) * 100;
            // Constrain within playable pitch corridor
            state.aimX = Math.max(36, Math.min(64, nx));
            state.aimY = Math.max(34, Math.min(76, ny));
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
            // When batting, moving mouse horizontally gently steers 360° shot angle
            if (isLocalBatting() && $('gameScreen').classList.contains('active') && !state.shotTaken) {
                const ratio = (e.clientX / window.innerWidth) * 2 - 1; // -1 to +1
                state.shotAngle = Math.round(ratio * 135);
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
    // 4. TACTICAL 9-FIELDER PLACEMENT + POWERPLAY RULES
    // ==========================================
    const FIELD_PRESETS = {
        attacking: [
            { id: 'slip1', short: 'SLIP', x: 41, y: 74 },
            { id: 'gully', short: 'GULLY', x: 31, y: 67 },
            { id: 'point', short: 'POINT', x: 24, y: 56 },
            { id: 'cover', short: 'COVER', x: 30, y: 42 },
            { id: 'midoff', short: 'MID-OFF', x: 42, y: 34 },
            { id: 'midon', short: 'MID-ON', x: 58, y: 34 },
            { id: 'sqleg', short: 'SQ LEG', x: 74, y: 56 },
            { id: 'fineleg', short: 'FINE', x: 68, y: 78 },
            { id: 'shortleg', short: 'S-LEG', x: 60, y: 68 }
        ],
        balanced: [
            { id: 'slip1', short: 'SLIP', x: 41, y: 74 },
            { id: 'point', short: 'POINT', x: 23, y: 55 },
            { id: 'cover', short: 'COVER', x: 28, y: 40 },
            { id: 'midoff', short: 'MID-OFF', x: 41, y: 33 },
            { id: 'midon', short: 'MID-ON', x: 59, y: 33 },
            { id: 'sqleg', short: 'SQ LEG', x: 76, y: 55 },
            { id: 'fineleg', short: 'FINE', x: 70, y: 80 },
            { id: 'longoff', short: 'LONG-OFF', x: 35, y: 22 },
            { id: 'deepmid', short: 'D-MIDWKT', x: 78, y: 30 }
        ],
        defensive: [
            { id: 'deeppt', short: 'D-POINT', x: 14, y: 52 },
            { id: 'deepcov', short: 'D-COVER', x: 20, y: 32 },
            { id: 'longoff', short: 'LONG-OFF', x: 36, y: 21 },
            { id: 'longon', short: 'LONG-ON', x: 64, y: 21 },
            { id: 'deepmid', short: 'D-MIDWKT', x: 80, y: 32 },
            { id: 'deepsq', short: 'D-SQ', x: 85, y: 54 },
            { id: 'deepfine', short: 'D-FINE', x: 76, y: 82 },
            { id: 'thirdman', short: '3RD MAN', x: 22, y: 82 },
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
        // Enforce Powerplay max 2 outside 30-yard circle
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
            el.className = 'fielder' + (f.y < 36 ? ' far' : f.y > 70 ? ' near' : '');
            el.dataset.id = f.id;
            el.style.left = `${f.x}%`;
            el.style.top = `${f.y}%`;
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
                    const nx = Math.max(8, Math.min(92, ((ev.clientX - r.left) / r.width) * 100));
                    const ny = Math.max(20, Math.min(88, ((ev.clientY - r.top) / r.height) * 100));

                    // Powerplay restriction check (max 2 outside 30-yard circle)
                    if (state.powerplay && isOutsideRing(nx, ny) && !isOutsideRing(f.x, f.y) && countOutsideFielders() >= 2) {
                        $('statusMsg').textContent = '⚠️ Powerplay rule: Max 2 fielders allowed outside the 30-yard ring!';
                        return;
                    }
                    f.x = nx;
                    f.y = ny;
                    el.style.left = `${nx}%`;
                    el.style.top = `${ny}%`;
                    el.classList.toggle('far', ny < 36);
                    el.classList.toggle('near', ny > 70);
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
    // 5. VISUAL POSITIONS & CAMERA ENGINE
    // ==========================================
    function updateVisualPositions() {
        const guard = getActiveVal('batterGuardGroup');
        const depth = getActiveVal('footworkGroup');
        const batEl = $('batsman');
        const batX = guard === 'off' ? -24 : guard === 'leg' ? 24 : 0;
        const batY = depth === 'advance' ? -20 : depth === 'back' ? 14 : 0;
        batEl.style.setProperty('--batter-x', `${batX}px`);
        batEl.style.setProperty('--batter-y', `${batY}px`);

        const angle = getActiveVal('bowlAngleGroup');
        const bowlEl = $('bowlerEnd');
        const bowlX = angle === 'wide' ? -22 : angle === 'round' ? 22 : -6;
        bowlEl.style.setProperty('--bowler-x', `${bowlX}px`);
    }

    function setCamera(mode) {
        const pitch = $('pitch');
        if (!pitch) return;
        state.cameraMode = mode;
        pitch.classList.remove('cam-bowler', 'cam-batter', 'cam-broadcast');
        pitch.classList.add(`cam-${mode}`);
        document.querySelectorAll('.hud-btn[data-cam]').forEach(b => b.classList.toggle('active', b.dataset.cam === mode));
    }

    function showBanner(bigText, subText, duration = 2200) {
        const big = $('bannerBig');
        const sub = $('ballResult');
        if (big) big.textContent = bigText;
        if (sub) sub.textContent = subText;
        if (bigText) {
            setTimeout(() => { if (big.textContent === bigText) big.textContent = ''; }, duration);
        }
    }

    function umpireSignal(kind) {
        const u = $('umpire');
        if (!u) return;
        u.classList.remove('signal-four', 'signal-six', 'signal-out', 'signal-wide');
        if (!kind) return;
        u.classList.add('signal-' + kind);
        setTimeout(() => u.classList.remove('signal-' + kind), 2000);
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
            end.style.transition = 'none';
            end.style.top = '18vh';
            void end.offsetWidth;
            end.style.transition = 'transform 0.3s ease, top 1.05s linear';
            end.style.top = '25vh';
        }
        if (fig) {
            fig.classList.remove('delivering');
            fig.classList.add('running');
        }
        setCamera('bowler');
        $('statusMsg').textContent = 'Bowler running in...';

        tracked(() => {
            if (fig) {
                fig.classList.remove('running');
                fig.classList.add('delivering');
            }
            SoundFX.bowlWhoosh();
            tracked(() => {
                if (fig) fig.classList.remove('delivering');
                setCamera('batter');
                onRelease();
            }, 280);
        }, 1050);
    }

    function animateBallPath(from, to, durationMs, opts, onDone) {
        const ball = $('ball'), shadow = $('ballShadow');
        if (!ball) { if (onDone) onDone(); return; }
        const start = performance.now();
        const arc = (opts && opts.arc) || 0;
        const startScale = (opts && opts.startScale) || 1.0;
        const endScale = (opts && opts.endScale) || 0.85;

        ball.style.opacity = '1';
        if (shadow) shadow.style.opacity = '0.5';

        function step(now) {
            const t = Math.min(1, (now - start) / durationMs);
            const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            const x = from.x + (to.x - from.x) * e;
            const y = from.y + (to.y - from.y) * e;
            const lift = -Math.sin(t * Math.PI) * arc;
            const scale = startScale + (endScale - startScale) * e;

            ball.style.left = `${x}%`;
            ball.style.top = `${y}%`;
            ball.style.transform = `translate(-50%, -50%) translateY(${lift}px) scale(${scale.toFixed(2)})`;

            if (shadow) {
                shadow.style.left = `${x}%`;
                shadow.style.top = `${y + 1.5}%`;
                shadow.style.opacity = lift < -15 ? '0.25' : '0.5';
            }

            if (t < 1) requestAnimationFrame(step);
            else if (onDone) onDone();
        }
        requestAnimationFrame(step);
    }

    function throwBallBackToBowler(onDone) {
        const ball = $('ball');
        if (!ball) { if (onDone) onDone(); return; }
        const cur = { x: parseFloat(ball.style.left) || 50, y: parseFloat(ball.style.top) || 45 };
        animateBallPath(cur, { x: 50, y: 26 }, 700, { arc: 18, startScale: 0.85, endScale: 0.55 }, () => {
            ball.style.opacity = '0';
            if ($('ballShadow')) $('ballShadow').style.opacity = '0';
            if (onDone) onDone();
        });
    }

    // ==========================================
    // 6. REAL-TIME BALL FLIGHT & PHYSICS
    // ==========================================
    function getTimingFromProgress(pct, depth) {
        const st = currentStriker();
        const sweetWidth = st ? Math.max(11, Math.min(22, 15 + (st.timing - 72) * 0.16)) : 15;
        const sweetMin = depth === 'advance' ? 64 : depth === 'back' ? 78 : 72;
        const sweetMax = sweetMin + sweetWidth;

        if (pct >= sweetMin && pct <= sweetMax) return 'perfect';
        if ((pct >= sweetMin - 15 && pct < sweetMin) || (pct > sweetMax && pct <= sweetMax + 10)) return 'good';
        return pct < sweetMin ? 'early' : 'late';
    }

    function launchBallFlight(delivery, aiBatterShot = null) {
        if (state.flightAnimId) cancelAnimationFrame(state.flightAnimId);
        state.deliveryId += 1;
        state.replayFrames = [];
        $('replayBtn').disabled = true;
        state.replaying = false;

        if (delivery.extra === undefined) {
            const wideChance = (delivery.aimX <= 38 || delivery.aimX >= 62) ? 0.25 : 0.03;
            const r = Math.random();
            if (r < wideChance) delivery.extra = 'wide';
            else if (r < wideChance + (delivery.speed >= 150 ? 0.1 : 0.04)) delivery.extra = 'noball';
            else delivery.extra = null;

            const bw = currentBowler();
            if (bw && bw.fatigue > 0.3) delivery.speed = Math.max(85, Math.round(delivery.speed - bw.fatigue * 10));
        }

        state.activeDelivery = delivery;
        state.ballInFlight = true;
        state.shotTaken = false;
        state.flightProgress = 0;

        const startX = delivery.angle === 'wide' ? 44 : delivery.angle === 'round' ? 56 : 48;
        const bounceY = delivery.aimY; // 34..76%
        const bounceX = delivery.extra === 'wide' ? (delivery.aimX < 50 ? 34 : 66) : delivery.aimX;

        const ball = $('ball'), shadow = $('ballShadow');
        ball.style.opacity = '1';
        shadow.style.opacity = '0.5';
        ball.style.top = '26%';
        ball.style.left = `${startX}%`;

        if (isLocalBatting()) {
            $('playShotBtn').disabled = false;
            $('runNowBtn').style.display = 'none';
            state.runRequested = false;
        }

        const flightDurationMs = Math.max(1450, 2850 - (delivery.speed * 9));
        const bouncePct = ((bounceY - 26) / (84 - 26)) * 100;

        playBowlerRunUp(() => {
            $('statusMsg').textContent = isLocalBatting()
                ? 'Aim shot (Mouse/Arrows), adjust crease (WASD), press SPACE!'
                : 'Ball in flight...';

            const startTime = performance.now();
            let bounced = false;
            let aiSwung = false;

            function frame(now) {
                const elapsed = now - startTime;
                const pct = Math.min(100, (elapsed / flightDurationMs) * 100);
                state.flightProgress = pct;
                $('timingCursor').style.left = `${pct}%`;

                const yTop = 26 + (pct * 0.58); // 26% -> 84%
                let xPos = startX;
                const cond = state.conditions;
                const windDrift = cond ? cond.windLateral * (cond.windKmh / 25) * 3.5 * (pct / 100) : 0;

                if (pct < bouncePct) {
                    const pre = pct / Math.max(1, bouncePct);
                    // Late air swing before pitching
                    const airSwing = delivery.variation === 'inswing' ? 2.5 * pre * pre :
                                     delivery.variation === 'outswing' ? -2.5 * pre * pre : 0;
                    xPos = startX + (bounceX - startX) * pre + airSwing;
                } else {
                    if (!bounced) {
                        bounced = true;
                        SoundFX.pitchBounce();
                    }
                    const post = (pct - bouncePct) / Math.max(1, 100 - bouncePct);
                    const angleContinue = (bounceX - startX) * 0.25;
                    let seamTurn = 0;
                    if (delivery.variation === 'inswing' || delivery.variation === 'spin') seamTurn = 3.8;
                    if (delivery.variation === 'outswing') seamTurn = -3.8;
                    if (delivery.variation === 'seam') seamTurn = (Math.random() < 0.5 ? 1.5 : -1.5);
                    xPos = bounceX + (angleContinue + seamTurn) * post;
                }
                xPos += windDrift;

                const bounceHeight = bounceY < 45 ? 16 : bounceY > 68 ? 4 : 10;
                const lift = pct > bouncePct
                    ? -Math.sin(Math.min(1, (pct - bouncePct) / (100 - bouncePct)) * Math.PI) * bounceHeight
                    : 0;
                const scale = 0.52 + (pct * 0.0068);

                ball.style.left = `${xPos}%`;
                ball.style.top = `${yTop}%`;
                ball.style.transform = `translate(-50%, -50%) translateY(${lift}px) scale(${scale.toFixed(2)})`;

                shadow.style.left = `${xPos}%`;
                shadow.style.top = `${yTop + 1.2}%`;
                shadow.style.opacity = lift < -6 ? '0.28' : '0.52';

                state.replayFrames.push({ x: xPos, y: yTop, lift, scale });

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
                    shadow.style.opacity = '0';
                    if (isLocalBatting()) {
                        $('playShotBtn').disabled = true;
                        submitBatterShot({
                            guard: getActiveVal('batterGuardGroup'),
                            footwork: getActiveVal('footworkGroup'),
                            type: 'leave',
                            angle: 0,
                            timing: 'none'
                        });
                    }
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
        // Convert shotAngle (-135..+135 deg) & shot power into ground (x%, y%)
        const rad = (shot.angle * Math.PI) / 180;
        const dist = shot.type === 'loft' ? 46 :
                     shot.type === 'defend' ? 10 :
                     shot.timing === 'perfect' ? 38 :
                     shot.timing === 'good' ? 28 : 18;
        const x = 50 + Math.sin(rad) * dist;
        const y = 82 - Math.cos(rad) * dist * 1.15;
        return { x: Math.max(6, Math.min(94, x)), y: Math.max(20, Math.min(88, y)) };
    }

    function resolveBall(delivery, shot) {
        const lengthCat = getLengthCategoryFromY(delivery.aimY);
        const lineCat = getLineCategoryFromX(delivery.aimX);
        const bw = currentBowler();

        if (delivery.extra === 'wide') {
            state.extras.wides += 1;
            return { isOut: false, runs: 1, commentary: 'Wide delivery! +1 extra', extra: 'wide', legal: false, landing: { x: 50, y: 88 } };
        }

        if (shot.type === 'leave') {
            const stumpsExposed = shot.guard === 'leg' && lineCat !== 'off';
            if ((lineCat === 'middle' || stumpsExposed) && lengthCat !== 'short') {
                return { isOut: true, runs: 0, commentary: 'BOWLED! Left a straight one!' };
            }
            return { isOut: false, runs: 0, commentary: 'Well left through to the keeper.' };
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

        let outChance = 0.04;
        if ((shot.type === 'loft' || shot.type === 'cutpull') && near.fielder && near.dist < 14) outChance += 0.16;
        if (!goodDepth) outChance += 0.12;
        if (!goodShotChoice) outChance += 0.12;
        if (shot.type === 'loft') outChance += 0.08;
        if (shot.type === 'defend') outChance -= 0.04;
        if (shot.timing === 'early' || shot.timing === 'late') outChance += 0.22;
        if (shot.timing === 'perfect') outChance -= 0.06;
        if (bw) outChance += (bw.bowlSkill - 70) * 0.002;
        if (state.freeHit) outChance = 0;

        outChance = Math.max(0.01, Math.min(0.68, outChance));

        let isOut = false;
        let runs = 0;
        let commentary = '';

        if (Math.random() < outChance) {
            isOut = true;
            if (lengthCat === 'yorker' && shot.type === 'loft') commentary = 'BOWLED! Timber shattered by a yorker!';
            else if (shot.footwork === 'advance' && delivery.variation === 'spin') commentary = 'STUMPED! Beaten in the flight!';
            else if (near.fielder && (shot.type === 'loft' || shot.type === 'cutpull')) commentary = `CAUGHT by ${near.fielder.short}!`;
            else commentary = 'EDGED & CAUGHT behind!';
        } else {
            if (shot.type === 'defend') {
                runs = (shot.timing === 'perfect' && near.dist > 18 && Math.random() < 0.3) ? 1 : 0;
            } else if (shot.type === 'loft') {
                if (shot.timing === 'perfect' && goodDepth) runs = 6;
                else if (shot.timing === 'good') runs = 4;
                else runs = 1;
            } else {
                if (shot.timing === 'perfect' && goodDepth && goodShotChoice) runs = near.dist > 14 ? 4 : 2;
                else if (shot.timing === 'perfect' || shot.timing === 'good') runs = near.dist > 16 ? 2 : 1;
                else runs = 0;
            }

            if (runs >= 4 && near.fielder && near.dist < 11 && shot.timing !== 'perfect') {
                runs = 2;
                commentary = `Diving stop by ${near.fielder.short}! Saved 2 runs.`;
            } else {
                commentary = runs === 6 ? 'MASSIVE SIX! Clean strike over the ropes!' :
                             runs === 4 ? 'CRACKING FOUR! Pierced the gap!' :
                             runs === 0 ? 'Dot ball.' : `${runs} run${runs > 1 ? 's' : ''}`;
            }
        }

        if (delivery.extra === 'noball') {
            state.extras.noBalls += 1;
            return {
                runs: runs + 1,
                isOut: false,
                commentary: `NO BALL! +1 & FREE HIT next ball!`,
                extra: 'noball',
                legal: false,
                freeHitNext: true,
                landing,
                nearestFielder: near.fielder,
                nearestDist: near.dist,
                gap: near.dist > 20
            };
        }

        return {
            runs,
            isOut,
            commentary,
            landing,
            nearestFielder: near.fielder,
            nearestDist: near.dist,
            gap: near.dist > 20,
            legal: true,
            extra: null
        };
    }

    function finishFlightAndResolve(delivery, shot, precomputed = null) {
        if (state.flightAnimId) cancelAnimationFrame(state.flightAnimId);
        state.ballInFlight = false;
        $('ballShadow').style.opacity = '0';

        if (shot.type !== 'leave') {
            const fig = $('batterFigure');
            if (fig) {
                fig.classList.remove('anim-defend', 'anim-ground', 'anim-cutpull', 'anim-sweep', 'anim-loft');
                void fig.offsetWidth;
                fig.classList.add(`anim-${shot.type}`);
                setTimeout(() => fig.classList.remove(`anim-${shot.type}`), 620);
            }
        }

        const outcome = precomputed || resolveBall(delivery, shot);
        const isRunningHit = !outcome.isOut && outcome.runs >= 1 && outcome.runs <= 3 && shot.type !== 'leave' && !outcome.extra;

        if (isRunningHit) {
            if (state.mode === 'online') {
                applyRunningOutcome(delivery, shot, outcome, outcome.runs, false, outcome.runs);
            } else {
                startRunningPhase(delivery, shot, outcome);
            }
            return;
        }

        animateBallToOutcome(outcome, shot, () => {
            const calledRun = state.runRequested && state.mode === 'ai' && !outcome.isOut && outcome.runs === 0 && shot.type !== 'leave' && !outcome.extra;
            state.runRequested = false;
            if (calledRun) {
                outcome.runs = 1;
                startRunningPhase(delivery, shot, outcome);
                return;
            }
            applyOutcomeNow(delivery, shot, outcome);
        });
    }

    function animateBallToOutcome(outcome, shot, onDone) {
        setCamera('broadcast');
        const landing = outcome.landing || computeLanding360(shot);
        const isBoundary = outcome.runs >= 4;
        const endPt = isBoundary
            ? { x: Math.max(4, Math.min(96, landing.x + (landing.x - 50) * 0.3)), y: Math.max(18, landing.y - 6) }
            : landing;

        if (outcome.nearestFielder) {
            const el = document.querySelector(`.fielder[data-id="${outcome.nearestFielder.id}"]`);
            if (el) {
                el.classList.add('chasing');
                el.style.left = `${endPt.x}%`;
                el.style.top = `${endPt.y}%`;
                setTimeout(() => {
                    el.classList.remove('chasing');
                    el.style.left = `${outcome.nearestFielder.x}%`;
                    el.style.top = `${outcome.nearestFielder.y}%`;
                }, 1400);
            }
        }

        animateBallPath({ x: 50, y: 82 }, endPt, isBoundary ? 1100 : 850, { arc: isBoundary ? 34 : 10, startScale: 1.15, endScale: 0.7 }, () => {
            setTimeout(() => {
                if (state.runRequested && state.mode === 'ai' && outcome.runs === 0 && !outcome.isOut && !outcome.extra) {
                    if (onDone) onDone();
                    return;
                }
                throwBallBackToBowler(onDone);
            }, 550);
        });
    }

    function startRunningPhase(delivery, shot, outcome) {
        state.pendingRun = { delivery, shot, outcome };
        const dist = Math.round(outcome.nearestDist || 25);
        $('runningMsg').textContent = `Gap found (${dist}m)! Call runs:`;

        if (isLocalBatting() && state.mode === 'ai') {
            $('runningPanel').style.display = 'flex';
            state.runTimer = setTimeout(() => chooseRuns(outcome.runs), 3500);
        } else {
            const aiRuns = outcome.gap ? Math.min(3, outcome.runs + 1) : 1;
            setTimeout(() => completeRunning(aiRuns), 500);
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
        let runOutChance = dist < 14 ? 0.24 : dist < 22 ? 0.10 : 0.04;
        if (attempted >= 2) runOutChance += 0.14;
        if (attempted >= 3) runOutChance += 0.18;
        const runOut = attempted > 0 && Math.random() < runOutChance;
        const completed = attempted === 0 ? 0 : runOut ? attempted - 1 : attempted;

        applyRunningOutcome(delivery, shot, outcome, attempted, runOut, completed);
    }

    function applyRunningOutcome(delivery, shot, outcome, attempted, runOut, completed) {
        setCamera('broadcast');
        const landing = outcome.landing || { x: 50, y: 45 };
        animateBallPath({ x: 50, y: 82 }, landing, 850, { arc: 10, startScale: 1.15, endScale: 0.85 }, () => {
            throwBallBackToBowler();
        });

        const bat = $('batsman'), ns = $('nonStriker');
        if (attempted > 0 && bat && ns) {
            let swapped = false;
            const cross = (n) => {
                swapped = !swapped;
                bat.style.transform = swapped ? 'translate(-50%, 0) translateY(-290px)' : '';
                ns.style.transform = swapped ? 'translate(-50%, 0) translateY(290px)' : '';
                if (n < attempted) setTimeout(() => cross(n + 1), state.runCrossMs);
                else setTimeout(() => { bat.style.transform = ''; ns.style.transform = ''; }, state.runCrossMs);
            };
            cross(1);
        }

        const finalOutcome = {
            ...outcome,
            runs: completed,
            isOut: runOut ? true : outcome.isOut,
            commentary: runOut ? `RUN OUT! Short of the crease!` : completed === 0 ? 'No run.' : `${completed} run${completed > 1 ? 's' : ''} completed!`
        };

        setTimeout(() => applyOutcomeNow(delivery, shot, finalOutcome, runOut), Math.max(1050, attempted * state.runCrossMs + 500));
    }

    function applyOutcomeNow(delivery, shot, outcome, runOut = false) {
        if (outcome.isOut || runOut) {
            umpireSignal('out');
            SoundFX.stumpsShatter();
            SoundFX.crowdRoar(false);
            showBanner('OUT!', outcome.commentary);
            const stumps = $('batterStumps');
            if (stumps && outcome.commentary.includes('BOWLED')) {
                stumps.classList.add('shattered');
                setTimeout(() => stumps.classList.remove('shattered'), 900);
            }
        } else if (outcome.runs >= 6) {
            umpireSignal('six');
            SoundFX.batCrack(1.3);
            SoundFX.crowdRoar(true);
            showBanner('SIX!', outcome.commentary);
        } else if (outcome.runs === 4) {
            umpireSignal('four');
            SoundFX.batCrack(1.15);
            SoundFX.crowdRoar(true);
            showBanner('FOUR!', outcome.commentary);
        } else {
            if (outcome.extra === 'wide' || outcome.extra === 'noball') umpireSignal('wide');
            if (outcome.runs > 0) SoundFX.batCrack(0.95);
            else if (shot.type !== 'leave') SoundFX.batDefend();
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
                st.outHow = runOut ? 'run out' : outcome.commentary.includes('BOWLED') ? 'b' : 'c';
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

        setTimeout(prepareNextBall, 1200);
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
        updateHud();
        updateVisualPositions();
        $('timingCursor').style.left = '0%';
        $('runningPanel').style.display = 'none';
        setCamera(state.cameraMode || 'batter');

        if (isLocalBatting()) {
            $('battingControls').style.display = 'flex';
            $('bowlingControls').style.display = 'none';
            $('playShotBtn').disabled = true;
            $('pitchMarker').style.display = 'none';
            $('shotAimGuide').style.display = 'block';

            if (state.mode === 'ai') {
                $('statusMsg').textContent = 'Set guard (WASD) & aim shot — bowler coming in...';
                if (state.autoBallTimer) clearTimeout(state.autoBallTimer);
                state.autoBallTimer = setTimeout(() => {
                    if (isLocalBatting() && !state.ballInFlight) {
                        launchBallFlight(generateAIDelivery(), null);
                    }
                }, 1800);
            }
        } else {
            $('battingControls').style.display = 'none';
            $('bowlingControls').style.display = 'flex';
            $('deliverBallBtn').disabled = false;
            $('pitchMarker').style.display = 'block';
            $('shotAimGuide').style.display = 'none';
            updatePitchReticle();
            renderBowlerDropdown();
            $('statusMsg').textContent = 'Click/drag pitch to aim, drag fielders, then BOWL.';
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
        const baseSpeed = bw ? Math.round(110 + bw.bowlSkill * 0.34) : 128;
        const angle = pick(['over', 'wide', 'round']);
        const variation = pick(['seam', 'inswing', 'outswing', 'spin']);
        let aimX = 42 + Math.floor(Math.random() * 17); // 42..58%
        let aimY = 38 + Math.floor(Math.random() * 35); // 38..73%

        if (state.aiMemory.ballsFaced >= 3 && Math.random() < 0.7) {
            if ((state.aiMemory.shotTypes.loft || 0) >= 2) {
                aimY = 71; // Yorker to block lofts
                setFieldPreset('defensive');
            }
            if ((state.aiMemory.footwork.advance || 0) >= 2) {
                aimY = 38; // Bouncer when advancing
            }
        }

        return { angle, variation, aimX, aimY, speed: baseSpeed + Math.floor(Math.random() * 10) };
    }

    function generateAIShot(delivery) {
        const lenCat = getLengthCategoryFromY(delivery.aimY);
        const types = lenCat === 'short' ? ['cutpull', 'ground'] : lenCat === 'yorker' ? ['defend', 'ground'] : ['ground', 'loft', 'cutpull', 'sweep'];
        const timings = state.difficulty === 'hard' ? ['perfect', 'perfect', 'good'] : state.difficulty === 'easy' ? ['good', 'early', 'late'] : ['perfect', 'good', 'good'];

        // Aim toward open gap
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
                setTimeout(prepareNextBall, 1800);
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
        $('resultMessage').textContent = s1 > s2 ? `YOU WON BY ${s1 - s2} RUNS!` : s2 > s1 ? `OPPONENT WON BY ${PLAYERS_PER_TEAM - 1 - state.p2.wickets} WICKETS!` : 'MATCH TIED!';
        $('finalStats').innerHTML = `
            <div><strong>YOUR TEAM:</strong> ${state.p1.score}/${state.p1.wickets} (${Math.floor(state.p1.balls / 6)}.${state.p1.balls % 6} ov)</div>
            <div><strong>OPPONENT:</strong> ${state.p2.score}/${state.p2.wickets} (${Math.floor(state.p2.balls / 6)}.${state.p2.balls % 6} ov)</div>
        `;
        $('resultScreen').classList.add('active');
    }

    // ==========================================
    // 8. SCORECARD, WAGON WHEEL & REPLAY
    // ==========================================
    function drawCharts() {
        const wc = $('wagonWheel');
        if (wc) {
            const ctx = wc.getContext('2d');
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

        const mc = $('manhattanChart');
        if (mc) {
            const ctx = mc.getContext('2d');
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
        setCamera('batter');
        const ball = $('ball');
        const frames = state.replayFrames;
        const start = performance.now();
        const duration = frames.length * 36;
        ball.style.opacity = '1';

        function step(now) {
            const t = Math.min(1, (now - start) / duration);
            const f = frames[Math.min(frames.length - 1, Math.floor(t * frames.length))];
            if (f) {
                ball.style.left = `${f.x}%`;
                ball.style.top = `${f.y}%`;
                ball.style.transform = `translate(-50%, -50%) translateY(${f.lift}px) scale(${f.scale})`;
            }
            if (t < 1) requestAnimationFrame(step);
            else {
                state.replaying = false;
                ball.style.opacity = '0';
                $('replayBtn').disabled = false;
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

        if (!state.conditions) generateConditions();
        $('startScreen').classList.remove('active');
        $('resultScreen').classList.remove('active');

        if (state.mode === 'online') {
            startInningsData('p1');
            prepareNextBall();
        } else {
            $('tossPanel').style.display = 'block';
            $('tossCallGroup').style.display = 'flex';
            $('tossChoiceGroup').style.display = 'none';
            $('tossMsg').textContent = 'Call Heads or Tails';
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
    bindGroup('bowlVarGroup');
    bindGroup('fieldPresetGroup', d => setFieldPreset(d.val));

    $('bowlSpeedSlider').addEventListener('input', e => $('paceVal').textContent = e.target.value);
    $('bowlerSelectDropdown').addEventListener('change', e => {
        state.currentBowlerIdx = Number(e.target.value);
        updateHud();
    });

    $('deliverBallBtn').addEventListener('click', () => {
        if (isLocalBatting() || state.ballInFlight) return;
        SoundFX.click();
        $('deliverBallBtn').disabled = true;
        const delivery = {
            angle: getActiveVal('bowlAngleGroup'),
            variation: getActiveVal('bowlVarGroup'),
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

    $('playShotBtn').addEventListener('click', triggerBatterSwing);
    $('runNowBtn').addEventListener('click', () => {
        if (state.pendingRun) { $('runningPanel').style.display = 'flex'; return; }
        state.runRequested = true;
        $('runNowBtn').disabled = true;
        $('statusMsg').textContent = 'Run called!';
    });

    document.querySelectorAll('#runningPanel button').forEach(btn => {
        btn.addEventListener('click', () => chooseRuns(Number(btn.dataset.runs)));
    });

    document.querySelectorAll('.hud-btn[data-cam]').forEach(btn => {
        btn.addEventListener('click', () => setCamera(btn.dataset.cam));
    });

    $('rerollConditionsBtn').addEventListener('click', () => { SoundFX.click(); generateConditions(); });
    $('startSoloBtn').addEventListener('click', () => { SoundFX.click(); initMatch('host'); });
    $('restartBtn').addEventListener('click', () => {
        SoundFX.click();
        $('resultScreen').classList.remove('active');
        $('startScreen').classList.add('active');
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
                }, 900);
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

    $('scorecardBtn').addEventListener('click', () => {
        renderScorecard();
        $('scorecardModal').style.display = 'flex';
    });
    $('scorecardCloseBtn').addEventListener('click', () => $('scorecardModal').style.display = 'none');
    $('replayBtn').addEventListener('click', replayLastBall);
    $('soundToggleBtn').addEventListener('click', () => {
        const m = SoundFX.toggleMute();
        $('soundToggleBtn').textContent = m ? '🔇' : '🔊';
    });

    // Keyboard Controls
    document.addEventListener('keydown', (e) => {
        if ($('startScreen').classList.contains('active')) return;
        const k = e.key.toLowerCase();

        if (isLocalBatting()) {
            if (k === 'a') selectButtonByVal('batterGuardGroup', getActiveVal('batterGuardGroup') === 'leg' ? 'middle' : 'off');
            if (k === 'd') selectButtonByVal('batterGuardGroup', getActiveVal('batterGuardGroup') === 'off' ? 'middle' : 'leg');
            if (k === 'w') selectButtonByVal('footworkGroup', getActiveVal('footworkGroup') === 'back' ? 'crease' : 'advance');
            if (k === 's') selectButtonByVal('footworkGroup', getActiveVal('footworkGroup') === 'advance' ? 'crease' : 'back');

            const shots = { '1': 'defend', '2': 'ground', '3': 'cutpull', '4': 'sweep', '5': 'loft' };
            if (shots[e.key]) selectButtonByVal('shotTypeGroup', shots[e.key]);

            if (e.key === 'ArrowLeft') { state.shotAngle = Math.max(-135, state.shotAngle - 20); updateShotAimGuide(); }
            if (e.key === 'ArrowRight') { state.shotAngle = Math.min(135, state.shotAngle + 20); updateShotAimGuide(); }
            if (e.key === 'ArrowUp') { state.shotAngle = 0; updateShotAimGuide(); }

            if (e.code === 'Space' && state.ballInFlight && !state.shotTaken) {
                e.preventDefault();
                triggerBatterSwing();
            }
            if (k === 'r' && (state.ballInFlight || state.shotTaken)) {
                state.runRequested = true;
                $('runNowBtn').disabled = true;
            }
        }
    });

    // PeerJS Online Multiplayer
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

    $('createRoomBtn').addEventListener('click', () => {
        if (typeof Peer === 'undefined') return;
        const code = 'CRIC-' + Math.random().toString(36).substring(2, 6).toUpperCase();
        state.peer = new Peer(code);
        state.peer.on('open', id => $('lobbyStatus').textContent = `Room Code: ${id}`);
        state.peer.on('connection', conn => setupConnection(conn, true));
    });

    $('joinRoomBtn').addEventListener('click', () => {
        const code = $('joinRoomInput').value.trim().toUpperCase();
        if (!code || typeof Peer === 'undefined') return;
        state.peer = new Peer();
        state.peer.on('open', () => setupConnection(state.peer.connect(code), false));
    });

    // Boot
    generateConditions();
    bindPitchAiming();
})();
