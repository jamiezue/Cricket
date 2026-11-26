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
        conn: null
    };

    const $ = (id) => document.getElementById(id);

    // ==========================================
    // 3. VISUAL CREASE POSITIONING (Batter & Bowler)
    // ==========================================
    function updateVisualPositions() {
        // 1. Update Batter Position on Pitch
        const guard = getActiveVal('batterGuardGroup'); // 'off' | 'middle' | 'leg'
        const depth = getActiveVal('footworkGroup');    // 'advance' | 'crease' | 'back'
        const batEl = $('batsman');

        // Top of pitch = Off side (28%), Center = Middle (50%), Bottom = Leg side (72%)
        const batY = guard === 'off' ? 28 : guard === 'leg' ? 72 : 50;
        // Left = Advancing down pitch (73%), Normal crease (83%), Deep in crease (88%)
        const batX = depth === 'advance' ? 73 : depth === 'back' ? 88 : 83;

        batEl.style.top = `${batY}%`;
        batEl.style.left = `${batX}%`;

        // 2. Update Bowler Position on Pitch
        const angle = getActiveVal('bowlAngleGroup'); // 'over' | 'wide' | 'round'
        const bowlEl = $('bowlerEnd');
        const bowlY = angle === 'wide' ? 22 : angle === 'round' ? 72 : 36;
        bowlEl.style.top = `${bowlY}%`;
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

        // Swing Bat
        if (e.code === 'Space' && state.ballInFlight && !state.shotTaken) {
            e.preventDefault();
            triggerBatterSwing();
        }
    });

    function getActiveVal(groupId) {
        const active = $(groupId).querySelector('.active');
        return active ? active.dataset.val : '';
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
            const ballsLeft = (state.maxOvers * 6) - chasing.balls;
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
        const sweetMin = depth === 'advance' ? 64 : depth === 'back' ? 78 : 72;
        const sweetMax = sweetMin + 15;

        if (pct >= sweetMin && pct <= sweetMax) return 'perfect';
        if ((pct >= sweetMin - 16 && pct < sweetMin) || (pct > sweetMax && pct <= sweetMax + 10)) return 'good';
        return pct < sweetMin ? 'early' : 'late';
    }

    function launchBallFlight(delivery, aiBatterShot = null) {
        if (state.flightAnimId) cancelAnimationFrame(state.flightAnimId);

        state.activeDelivery = delivery;
        state.ballInFlight = true;
        state.shotTaken = false;
        state.flightProgress = 0;

        // Position bowler sprite according to chosen angle
        const startY = delivery.angle === 'wide' ? 22 : delivery.angle === 'round' ? 72 : 36;
        $('bowlerEnd').style.top = `${startY}%`;

        // Telemetry display
        $('telAngle').textContent = delivery.angle.toUpperCase();
        $('telSpeed').textContent = delivery.speed;
        $('telLine').textContent = delivery.line.toUpperCase();
        $('telLength').textContent = getLengthLabel(delivery.lengthVal).toUpperCase();
        $('telMove').textContent = delivery.variation.toUpperCase();

        // Bounce marker derived from continuous length slider (15..92 -> pitch X 36%..78%)
        const marker = $('pitchMarker');
        const bouncePct = 28 + (Number(delivery.lengthVal) * 0.54);
        const targetY = delivery.line === 'off' ? 28 : delivery.line === 'leg' ? 72 : 50;
        marker.style.left = `${bouncePct}%`;
        marker.style.top = `${targetY}%`;
        marker.style.opacity = '1';

        const ball = $('ball');
        ball.style.opacity = '1';
        SoundFX.bowlWhoosh();

        if (isLocalBatting()) {
            $('playShotBtn').disabled = false;
            $('readyToBatBtn').disabled = true;
            $('statusMsg').textContent = '🔥 BALL IN FLIGHT! Move in crease (WASD), pick shot & press SPACE!';
        } else {
            $('statusMsg').textContent = '🎳 Ball released! Watching batter react...';
        }

        const flightDurationMs = Math.max(1500, 2950 - (delivery.speed * 9.5));
        const startTime = performance.now();
        let bounced = false;
        let aiSwung = false;

        function frame(now) {
            const elapsed = now - startTime;
            const pct = Math.min(100, (elapsed / flightDurationMs) * 100);
            state.flightProgress = pct;

            $('timingCursor').style.left = `${pct}%`;

            // Horizontal travel from bowler release (12%) to keeper (92%)
            const xPos = 12 + (pct * 0.80);
            ball.style.left = `${xPos}%`;

            // Diagonal angle from bowler release point -> pitch bounce spot -> post-bounce swing/spin
            let yPos = startY;
            if (pct < bouncePct) {
                const preRatio = pct / bouncePct;
                yPos = startY + (targetY - startY) * preRatio;
            } else {
                if (!bounced) {
                    bounced = true;
                    SoundFX.pitchBounce();
                }
                const postRatio = (pct - bouncePct) / (100 - bouncePct);
                // Angle momentum + lateral swing/spin
                const angleDrift = (targetY - startY) * 0.22;
                let deviation = angleDrift;
                if (delivery.variation === 'inswing' || delivery.variation === 'spin') deviation += 13;
                if (delivery.variation === 'outswing') deviation -= 13;
                yPos = targetY + (deviation * postRatio);
            }
            ball.style.top = `${Math.max(14, Math.min(86, yPos))}%`;

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
        $('ball').style.opacity = '0';
        $('pitchMarker').style.opacity = '0';

        if (shot.type !== 'leave') {
            const bat = $('batsman');
            bat.classList.add('swing');
            setTimeout(() => bat.classList.remove('swing'), 250);
        }

        const outcome = precomputedOutcome || resolveBall(delivery, shot);

        if (outcome.isOut) {
            if (outcome.commentary.includes('BOWLED')) {
                SoundFX.stumpsShatter();
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
        team.balls += 1;
        if (outcome.isOut) team.wickets += 1;
        else team.score += outcome.runs;

        const teamName = state.battingSide === 'p1' ? $('p1Label').textContent : $('p2Label').textContent;
        const logType = outcome.isOut ? 'wicket' : (outcome.runs >= 4 ? 'boundary' : '');
        const timingLabel = shot.type === 'leave' ? 'BALL LEFT' : `Timing: ${shot.timing.toUpperCase()}`;
        const summary = `[${Math.floor((team.balls - 1)/6)}.${(team.balls - 1)%6 + 1}] ${teamName}: ${outcome.commentary} (${timingLabel})`;

        $('ballResult').textContent = outcome.commentary;
        addLog(summary, logType);
        updateScoreboard();

        setTimeout(prepareNextBall, 1300);
    }

    // ==========================================
    // 6. ADVANCED CREASE & ANGLE PHYSICS ENGINE
    // ==========================================
    function resolveBall(delivery, shot) {
        const lengthCat = getLengthCategory(delivery.lengthVal);

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

        let outChance = 0.05;
        if (!goodDepth) outChance += 0.13;
        if (!coveredLine) outChance += 0.11;
        if (exposedStumpsRisk) outChance += 0.12;
        if (!goodShotChoice) outChance += 0.13;
        if (shot.type === 'loft') outChance += 0.09;
        if (shot.type === 'defend') outChance -= 0.05;
        if (delivery.angle === 'round' && delivery.variation === 'inswing') outChance += 0.05;
        if (shot.timing === 'early' || shot.timing === 'late') outChance += 0.21;
        if (shot.timing === 'perfect') outChance -= 0.06;

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

        return { runs, isOut, commentary };
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
            $('statusMsg').textContent = '🎳 Set crease angle, pitch length & pace, then bowl!';
        }
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

        if (state.mode === 'ai') {
            const aiShot = generateAIShot(delivery);
            launchBallFlight(delivery, aiShot);
        } else {
            state.activeDelivery = delivery;
            sendNet({ type: 'BOWL_DELIVERY', delivery });
            launchBallFlight(delivery, null);
        }
    });

    function generateAIDelivery() {
        const angles = ['over', 'wide', 'round'];
        const lines = ['off', 'middle', 'leg'];
        const vars = ['seam', 'inswing', 'outswing', 'spin'];
        const baseSpeed = state.difficulty === 'hard' ? 140 : state.difficulty === 'easy' ? 102 : 122;
        return {
            angle: angles[Math.floor(Math.random() * angles.length)],
            line: lines[Math.floor(Math.random() * lines.length)],
            variation: vars[Math.floor(Math.random() * vars.length)],
            lengthVal: 20 + Math.floor(Math.random() * 70),
            speed: baseSpeed + Math.floor(Math.random() * 14)
        };
    }

    function generateAIShot(delivery) {
        const chasing = state.p2;
        const ballsLeft = Math.max(1, state.maxOvers * 6 - chasing.balls);
        const reqRate = state.target ? (state.target - chasing.score) / ballsLeft : 1.2;
        const lenCat = getLengthCategory(delivery.lengthVal);

        const types = reqRate > 1.6 ? ['loft', 'cutpull', 'ground'] : ['ground', 'cutpull', 'sweep', 'defend'];
        const footwork = lenCat === 'short' ? 'back' : (lenCat === 'good' && Math.random() < 0.3 ? 'advance' : 'crease');
        const timings = state.difficulty === 'hard'
            ? ['perfect', 'perfect', 'good']
            : state.difficulty === 'easy'
                ? ['good', 'early', 'late']
                : ['perfect', 'good', 'good'];

        return {
            guard: delivery.line,
            footwork,
            type: types[Math.floor(Math.random() * types.length)],
            dir: delivery.line,
            timing: timings[Math.floor(Math.random() * timings.length)]
        };
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
                state.innings = 2;
                state.target = current.score + 1;
                state.battingSide = state.battingSide === 'p1' ? 'p2' : 'p1';
                SoundFX.crowdRoar(false);
                addLog(`=== INNINGS BREAK! Target set: ${state.target} runs ===`, 'boundary');
                $('ballResult').textContent = `Innings Break! Target: ${state.target}`;
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

        $('gameLog').innerHTML = '';
        $('formatBadge').textContent = `${state.maxOvers} OVERS • ${state.mode === 'ai' ? 'VS AI' : '2P ONLINE'}`;
        $('p1Label').textContent = state.mode === 'ai' ? 'YOUR TEAM' : (role === 'host' ? 'YOU (HOST)' : 'HOST (P1)');
        $('p2Label').textContent = state.mode === 'ai' ? `AI (${state.difficulty.toUpperCase()})` : (role === 'guest' ? 'YOU (GUEST)' : 'GUEST (P2)');
        $('connectionBadge').style.display = state.mode === 'online' ? 'inline-block' : 'none';

        showScreen('gameScreen');
        addLog(`Match Started: ${state.maxOvers} Overs per side.`);
        prepareNextBall();
    }

    $('startSoloBtn').addEventListener('click', () => {
        SoundFX.click();
        initMatch('host');
    });

    $('restartBtn').addEventListener('click', () => {
        SoundFX.click();
        if (state.flightAnimId) cancelAnimationFrame(state.flightAnimId);
        if (state.peer) { state.peer.destroy(); state.peer = null; }
        showScreen('startScreen');
    });

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
            alert('Opponent disconnected from the match.');
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