// Time trial on top of js/race.js's RaceManager (gate crossing and lap timing), following what
// race timers and sims do (research notes: MultiGP, RotorHazard, Velocidrone manual):
// - Start: a quick one, as the user asked: arming shows "Ready" for a second, then "Go" with
//   RotorHazard's 880 Hz start tone (0.7 s). The whoop is held until Go. Holeshot = Go to the
//   first start/finish crossing; the clock starts there (MultiGP). Runs are 3 laps.
// - Gates: square frames. The next gate in the accent with a dark keyline, the one after it in
//   the quiet colour, the rest faint white; start/finish has a chequered top bar. A gate flares
//   white as you pass it; flying the next gate the wrong way flashes it red and buzzes; an arrow
//   at the screen edge points to an off-screen next gate (Velocidrone's gate navigation).
// - The path ahead: a line from the last gate through the next two only, shading from the
//   accent to the quiet colour, on a dark keyline.
// - Sounds: gate tick 1 kHz with a pitch ladder; lap chime 660/990 Hz plus the time spoken;
//   best lap 1200/1800 Hz square (RotorHazard's leader tone) plus speech; finish pattern.
// - Best lap stored in the browser (per track): its split at every gate and its flight path,
//   replayed as a ghost whoop. The best 3-lap total is stored separately for the title card.
// - HUD (moment-based): mid-flight only the running clock, the next gate's distance and the
//   camera angle (controls.js). Everything else appears at its moment and leaves: title card
//   before the run, Ready / Go, the delta to the best lap's split at each gate (small,
//   under the clock), the lap time at each lap, the result at the finish. Look: the Cambridge
//   University Drone Society brand (Ubuntu, near-black plates, cyan and sage). Every font and
//   colour is a CSS custom property in index.html's :root, and the in-world colours are
//   GATE_COLOURS below. Animation is computed from the sim clock passed to update() (the
//   offline recorder steps it), and the DOM is written only when a value changes, with
//   transforms and opacity for motion.
import * as THREE from 'three/webgpu';
import { positionView, smoothstep, float, uv, mix, uniform } from 'three/tsl';
import { formatTime } from '../../js/tracks.js?v=36';
import { linePoints, LEAD, SPONZA_PLAN } from './track.js';

// In-world colours (sRGB hex) and opacities: gates, path (accent to quiet along the line), the
// keylines under the next gate and the path, the ghost.
export const GATE_COLOURS = {
    next: 0x00d3f0, after: 0xa3c1ad, idle: 0xffffff, start: 0xffffff, wrong: 0xff6b57, flash: 0xffffff, keyline: 0x14140a,
    nextOp: 1, afterOp: 0.9, idleOp: 0.22, startOp: 0.55, keylineOp: 0.55,
    path: [0x00d3f0, 0xa3c1ad], pathOp: 0.95, pathKeylineOp: 0.5, ghost: 0xa3c1ad,
};
const C = GATE_COLOURS;
const secs = (ms) => (ms / 1000).toFixed(1);
const say = (text) => {
    if (window.ttSay) return window.ttSay(text); // recording: logged and voiced separately
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.1; speechSynthesis.speak(u); } catch { /* no speech */ }
};
const READY_MS = 1000; // "Ready" before "Go"
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => 1 - (1 - x) * (1 - x);
// Deltas: at most two significant figures and two decimals (+0.01, -0.18, +0.4, -1.2, +12), a true minus sign, green
// when faster; judged on the value shown, so 0 is neither.
const deltaVal = (d) => (d === 0 ? 0 : Math.sign(d) * Math.round(Number((Math.abs(Math.round(d)) / 1000).toPrecision(2)) * 100) / 100);
const deltaText = (d) => { const v = deltaVal(d); return `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v)}`; };
const deltaCls = (d) => { const v = deltaVal(d); return v < 0 ? 'good' : v > 0 ? 'bad' : ''; };

// Exact colours through the tone mapping: three's WebGPU renderer tone maps the whole frame (there
// is no per-material toneMapped), so for ACES (the warm and noon looks) the marks are given the
// input that ACES maps back to the wanted colour at the current exposure (three's ACESFilmic fit
// inverted: output matrix, the RRT+ODT rational per channel, input matrix). A colour ACES cannot
// reach (the brand cyan: no red at all) would clamp to a pale tint, so it gets the nearest one
// it can reach in sRGB instead (a short pattern search through the forward fit), a slightly
// deeper cyan. Other tone mappings only get the exposure divided out.
const colM = (c0, c1, c2) => new THREE.Matrix3().set(c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]);
const ACES_IN = colM([0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]);
const ACES_OUT = colM([1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]);
const ACES_IN_INV = ACES_IN.clone().invert(), ACES_OUT_INV = ACES_OUT.clone().invert();
const _cv = new THREE.Vector3(), _fv = new THREE.Vector3();
const rrt = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const toSRGB = (l) => { l = Math.min(1, Math.max(0, l)); return l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055; };
function acesOut(c, exposure) { // scene-linear input -> displayed sRGB 0..1
    _fv.copy(c).multiplyScalar(exposure / 0.6).applyMatrix3(ACES_IN);
    _fv.set(rrt(_fv.x), rrt(_fv.y), rrt(_fv.z)).applyMatrix3(ACES_OUT);
    return [toSRGB(_fv.x), toSRGB(_fv.y), toSRGB(_fv.z)];
}
function sceneColour(out, hex, exposure, aces) {
    out.setHex(hex);
    if (!aces) return out.multiplyScalar(1 / exposure);
    _cv.set(out.r, out.g, out.b).applyMatrix3(ACES_OUT_INV);
    for (const k of ['x', 'y', 'z']) {
        const w = Math.min(Math.max(_cv[k], 0), 0.999), A = 1 - 0.983729 * w, B = 0.0245786 - 0.432951 * w, Cc = -(0.000090537 + 0.238081 * w);
        _cv[k] = (-B + Math.sqrt(B * B - 4 * A * Cc)) / (2 * A);
    }
    _cv.applyMatrix3(ACES_IN_INV).multiplyScalar(0.6 / exposure);
    if (Math.min(_cv.x, _cv.y, _cv.z) < 0) {
        const want = new THREE.Color(hex).getRGB(new THREE.Color(), THREE.SRGBColorSpace), t = [want.r, want.g, want.b];
        const c = [Math.max(0, _cv.x), Math.max(0, _cv.y), Math.max(0, _cv.z)], v = new THREE.Vector3();
        const err = () => { const o = acesOut(v.fromArray(c), exposure); return (o[0] - t[0]) ** 2 + (o[1] - t[1]) ** 2 + (o[2] - t[2]) ** 2; };
        let e = err();
        for (let step = Math.max(...c) / 2; step > 1e-5;) {
            let better = false;
            for (let i = 0; i < 3; i++) for (const d of [step, -step]) {
                const was = c[i]; c[i] = Math.max(0, was + d); const n = err();
                if (n < e) { e = n; better = true; } else c[i] = was;
            }
            if (!better) step /= 2;
        }
        _cv.fromArray(c);
    }
    return out.setRGB(Math.max(0, _cv.x), Math.max(0, _cv.y), Math.max(0, _cv.z), THREE.LinearSRGBColorSpace);
}

const CSS = `
#tt { position: fixed; inset: 0; z-index: 5; pointer-events: none; color: var(--hud-text); font-family: var(--hud-font); font-style: var(--hud-style);
  font-weight: var(--hud-w-regular); font-variant-numeric: var(--hud-num); line-height: 1; }
#tt > div { position: absolute; visibility: hidden; }
#tt .on { visibility: visible; }
#tt .pl { background: var(--hud-plate); white-space: nowrap; }
#tt .q { color: var(--hud-quiet); }
#tt .lt { font-weight: var(--hud-w-light); }
#tt .good { color: var(--hud-good); } #tt .bad { color: var(--hud-bad); }
#tt .mid { left: 0; right: 0; text-align: center; }
#tt .mid > .pl { display: inline-block; }
#tt .clock { top: calc(18 * var(--hud-u)); }
#tt .clock > .pl { padding: calc(3 * var(--hud-u)) calc(16 * var(--hud-u)) calc(4 * var(--hud-u)); font-size: calc(26 * var(--hud-u)); line-height: calc(32 * var(--hud-u)); contain: layout paint; }
#tt .delta { top: calc(61 * var(--hud-u)); will-change: opacity; }
#tt .delta > .pl { padding: calc(1 * var(--hud-u)) calc(9 * var(--hud-u)) calc(2 * var(--hud-u)); font-size: calc(17 * var(--hud-u)); line-height: calc(22 * var(--hud-u)); }
#tt .dist { left: 0; top: 0; padding: 0 calc(6 * var(--hud-u)); font-size: calc(14 * var(--hud-u)); line-height: calc(20 * var(--hud-u)); font-weight: var(--hud-w-light); will-change: transform; }
/* Title card: no plate, one left edge, the type carried by a soft shadow. */
#tt .title { left: calc(56 * var(--hud-u)); top: calc(48 * var(--hud-u)); text-shadow: var(--hud-title-shadow); }
#tt .title > * { display: block; margin: 0; }
#tt .title .badge { height: calc(44 * var(--hud-u)); width: auto; margin-left: calc(-4 * var(--hud-u)); filter: drop-shadow(0 1px 3px rgba(0,0,0,.6)); }
#tt .title .nm { margin-top: calc(14 * var(--hud-u)); font-size: calc(32 * var(--hud-u)); line-height: calc(36 * var(--hud-u)); }
#tt .hd { display: flex; align-items: center; gap: calc(12 * var(--hud-u)); }
#tt .hd img { height: calc(40 * var(--hud-u)); width: auto; }
#tt .title .sub { font-size: calc(18 * var(--hud-u)); line-height: calc(22 * var(--hud-u)); margin-top: calc(6 * var(--hud-u)); }
#tt .title .sub span { color: var(--hud-text); }
#tt .title svg { margin-top: calc(18 * var(--hud-u)); width: calc(300 * var(--hud-u)); height: auto; overflow: visible; filter: drop-shadow(0 1px 2px rgba(0,0,0,.7)); }
#tt .keys { display: flex; gap: calc(26 * var(--hud-u)); font-size: calc(17 * var(--hud-u)); font-weight: var(--hud-w-light); }
#tt .keys b { font-weight: inherit; background: var(--hud-plate); border: 1px solid var(--hud-quiet); padding: calc(1 * var(--hud-u)) calc(7 * var(--hud-u)); margin-right: calc(8 * var(--hud-u)); }
#tt .title .keys { display: flex; margin-top: calc(18 * var(--hud-u)); line-height: calc(24 * var(--hud-u)); }
#tt .title .keys b { background: none; border-color: var(--hud-text); box-shadow: 0 1px 2px rgba(0,0,0,.5); }
#tt .title .cr { margin-top: calc(18 * var(--hud-u)); max-width: calc(300 * var(--hud-u)); white-space: normal; font-size: calc(11 * var(--hud-u)); line-height: 1.35; }
#tt .title .cr a { color: inherit; pointer-events: auto; }
#tt .count { top: calc(440 * var(--hud-u)); }
#tt .count > .pl { padding: calc(10 * var(--hud-u)) calc(26 * var(--hud-u)) calc(14 * var(--hud-u)); font-size: calc(40 * var(--hud-u)); line-height: calc(48 * var(--hud-u)); font-weight: var(--hud-w-light); }
#tt .count .bar { margin-top: calc(8 * var(--hud-u)); height: calc(3 * var(--hud-u)); background: var(--hud-track); }
#tt .count .bar i { display: block; height: 100%; background: var(--hud-text); transform-origin: 0 0; transform: scaleX(0); will-change: transform; }
#tt .go { top: calc(440 * var(--hud-u)); will-change: transform, opacity; }
#tt .go > .pl { padding: calc(10 * var(--hud-u)) calc(26 * var(--hud-u)) calc(14 * var(--hud-u)); min-width: calc(56 * var(--hud-u)); font-size: calc(40 * var(--hud-u)); line-height: calc(48 * var(--hud-u)); font-weight: var(--hud-w-regular); }
#tt .go .bar { margin-top: calc(8 * var(--hud-u)); height: calc(3 * var(--hud-u)); background: var(--hud-text); }
#tt .lap { top: calc(548 * var(--hud-u)); will-change: transform, opacity; }
#tt .lap > .pl { text-align: left; padding: calc(10 * var(--hud-u)) calc(20 * var(--hud-u)) calc(12 * var(--hud-u)); }
#tt .lap .n { font-size: calc(15 * var(--hud-u)); line-height: calc(18 * var(--hud-u)); font-weight: var(--hud-w-light); }
#tt .lap .t { font-size: calc(36 * var(--hud-u)); line-height: calc(42 * var(--hud-u)); }
#tt .lap .r { display: flex; gap: calc(16 * var(--hud-u)); font-size: calc(16 * var(--hud-u)); line-height: calc(20 * var(--hud-u)); font-weight: var(--hud-w-light); }
#tt .lap .r .good, #tt .lap .r .bad { font-weight: var(--hud-w-regular); }
#tt .final { top: calc(560 * var(--hud-u)); will-change: transform, opacity; }
#tt .final > .pl { padding: calc(8 * var(--hud-u)) calc(22 * var(--hud-u)) calc(10 * var(--hud-u)); font-size: calc(30 * var(--hud-u)); line-height: calc(36 * var(--hud-u)); }
#tt .fin { inset: 0; background: var(--hud-dim); will-change: opacity; }
#tt .fin > * { position: absolute; }
#tt .fin .panel { left: 0; top: 0; bottom: 0; width: calc(600 * var(--hud-u)); background: var(--hud-panel); }
#tt .fin .body { left: calc(72 * var(--hud-u)); top: calc(56 * var(--hud-u)); }
#tt .fin .hd span { font-size: calc(22 * var(--hud-u)); font-weight: var(--hud-w-light); }
#tt .fin .nb { font-size: calc(22 * var(--hud-u)); margin-top: calc(30 * var(--hud-u)); }
#tt .fin .tot { font-size: calc(84 * var(--hud-u)); line-height: calc(92 * var(--hud-u)); margin: calc(8 * var(--hud-u)) 0 0 calc(-4 * var(--hud-u)); }
#tt .fin .dl { display: flex; align-items: baseline; gap: calc(16 * var(--hud-u)); margin-top: calc(2 * var(--hud-u)); }
#tt .fin .dl > span:first-child { font-size: calc(30 * var(--hud-u)); }
#tt .fin .dl > span + span { font-size: calc(18 * var(--hud-u)); font-weight: var(--hud-w-light); }
#tt .fin .laps { margin-top: calc(30 * var(--hud-u)); }
#tt .fin .laps div { display: flex; align-items: baseline; gap: calc(22 * var(--hud-u)); font-size: calc(22 * var(--hud-u)); line-height: calc(34 * var(--hud-u)); font-weight: var(--hud-w-light); }
#tt .fin .laps span:first-child { width: calc(16 * var(--hud-u)); color: var(--hud-quiet); }
#tt .fin .laps .best { color: var(--hud-accent); font-weight: var(--hud-w-regular); }
#tt .fin .laps .best span:first-child { color: inherit; }
#tt .fin .laps em { font-style: normal; font-size: calc(15 * var(--hud-u)); }
#tt .fin svg { left: calc(680 * var(--hud-u)); top: calc(170 * var(--hud-u)); width: calc(540 * var(--hud-u)); height: auto; overflow: visible; }
#tt .fin .keys { left: calc(72 * var(--hud-u)); bottom: calc(36 * var(--hud-u)); }
#tt svg .wall { fill: none; stroke: var(--hud-plan-wall); }
#tt svg .gate { stroke: var(--hud-plan-gate); stroke-linecap: round; }
#tt svg .gate.s { stroke: var(--hud-plan-start); }
#tt svg .line { fill: none; stroke: var(--hud-plan-line); stroke-linejoin: round; stroke-linecap: round; }
#tt svg .key { fill: none; stroke: var(--hud-keyline); stroke-linejoin: round; stroke-linecap: round; }
#tt-arrow { position: fixed; left: 50%; top: 50%; width: 0; height: 0; z-index: 5; pointer-events: none; display: none; will-change: transform;
  border-left: 14px solid transparent; border-right: 14px solid transparent; border-bottom: 26px solid var(--hud-accent); filter: drop-shadow(0 0 1.5px var(--hud-keyline)); }`;

export class TimeTrial {
    // keyLabel(action): the key bound to a pilot action ('reset', 'menu', 'arm'), for the hints.
    // toneMap(): [exposure, isACES] of the renderer now (auto-exposure moves the exposure), so the
    // in-world marks keep their exact colours.
    constructor({ scene, race, track, camera, getAudio, isFake = false, keyLabel = () => '', toneMap = () => [1, false] }) {
        this.toneMap = toneMap; this.race = race; this.track = track; this.camera = camera; this.getAudio = getAudio; this.keyLabel = keyLabel;
        this.laps = track.laps || 3;
        this.group = race.group;
        this.bestKey = `tm.sponza.best.${track.id}`;
        this.runKey = `tm.sponza.bestRun.${track.id}`;
        try { this.best = JSON.parse(localStorage.getItem(this.bestKey) || 'null'); } catch { this.best = null; }
        try { this.bestRun = JSON.parse(localStorage.getItem(this.runKey) || 'null'); } catch { this.bestRun = null; }
        this._sc = {}; this._scKey = '';
        this._buildGates();
        this._buildPath();
        this._buildHud();
        // The ghost fades out near the camera: flying the best lap's line, it would sit on the lens.
        this.ghostMesh = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.03, 0.075), Object.assign(new THREE.MeshBasicNodeMaterial({ color: C.ghost, transparent: true, depthWrite: false }),
            { opacityNode: float(0.55).mul(smoothstep(0.25, 0.8, positionView.length())) }));
        this.ghostMesh.visible = false; this.group.add(this.ghostMesh);
        this.moments = {};
        this.reset();
        this.isFake = isFake;
    }

    // --- gates ---------------------------------------------------------------------------
    _buildGates() {
        const half = this.track.gateRadius, bar = 0.045, o = half + bar / 2;
        const frameGeo = (b) => {
            const oo = half + b / 2, parts = [
                new THREE.BoxGeometry(2 * half + 2 * b, b, b).translate(0, oo, 0),
                new THREE.BoxGeometry(2 * half + 2 * b, b, b).translate(0, -oo, 0),
                new THREE.BoxGeometry(b, 2 * half, b).translate(oo, 0, 0),
                new THREE.BoxGeometry(b, 2 * half, b).translate(-oo, 0, 0),
            ];
            const pos = [], idx = []; let base = 0;
            for (const p of parts) { const ni = p.index.array, pa = p.attributes.position.array; pos.push(...pa); for (const k of ni) idx.push(k + base); base += pa.length / 3; p.dispose(); }
            const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); return g;
        };
        // Chequered top bar for start/finish.
        const cv = document.createElement('canvas'); cv.width = 64; cv.height = 8;
        const cx = cv.getContext('2d');
        for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { cx.fillStyle = (i + j) % 2 ? '#111' : '#fff'; cx.fillRect(i * 4, j * 4, 4, 4); }
        const chk = new THREE.CanvasTexture(cv); chk.colorSpace = THREE.SRGBColorSpace; chk.magFilter = THREE.NearestFilter;
        const geo = frameGeo(bar);
        for (const g of this.race.gates) {
            g.mesh.geometry.dispose();
            g.mesh.geometry = geo;
            g.mesh.material.dispose();
            g.mesh.material = new THREE.MeshBasicNodeMaterial({ color: C.idle, transparent: true, opacity: 1 });
            // RaceManager orients the mesh's +Z onto the gate normal; keep the frame upright.
            const n = g.normal, up = new THREE.Vector3(0, 1, 0), x = new THREE.Vector3().crossVectors(up, n).normalize(), y = new THREE.Vector3().crossVectors(n, x);
            g.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
            g.label.visible = false; // no text on gates
            if (g.index === 0) {
                const top = new THREE.Mesh(new THREE.BoxGeometry(2 * half + 2 * bar + 0.002, bar + 0.012, bar + 0.012), new THREE.MeshBasicNodeMaterial({ map: chk }));
                top.position.set(0, o, 0); g.mesh.add(top);
            }
            g.wrongUntil = 0; g.flashUntil = 0;
        }
        // The next gate's keyline: a thicker dark frame drawn first, without depth, so the accent
        // frame covers its middle and it shows as an outline (it reads on bright stone).
        this.keyline = new THREE.Mesh(frameGeo(bar * 1.9), new THREE.MeshBasicNodeMaterial({ color: C.keyline, transparent: true, opacity: C.keylineOp, depthWrite: false }));
        this.keyline.renderOrder = -1; this.keyline.visible = false; this.group.add(this.keyline);
    }

    // Colours for the scene's current tone mapping, recomputed when the exposure moves.
    _sceneColours() {
        const [e, aces] = this.toneMap(), key = `${aces}:${e.toFixed(3)}`;
        if (key === this._scKey) return false;
        this._scKey = key;
        for (const k of ['next', 'after', 'idle', 'start', 'wrong', 'flash', 'keyline', 'ghost']) sceneColour(this._sc[k] ??= new THREE.Color(), C[k], e, aces);
        sceneColour(this.pathA.value, C.path[0], e, aces); sceneColour(this.pathB.value, C.path[1], e, aces);
        sceneColour(this.pathKey.value, C.keyline, e, aces);
        this.keyline.material.color.copy(this._sc.keyline); this.ghostMesh.material.color.copy(this._sc.ghost);
        return true;
    }

    _colour(now, pos) {
        const n = this.race.nextGate, N = this.race.gates.length, live = this.stage !== 'done', S = this._sc;
        this._sceneColours();
        for (const g of this.race.gates) {
            const m = g.mesh.material; let col, op;
            if (now < g.wrongUntil) { col = S.wrong; op = 1; }
            else if (now < g.flashUntil) { col = S.flash; op = 1; }
            else if (g.index === n && live) { col = S.next; op = C.nextOp; }
            else if (g.index === (n + 1) % N && live) { col = S.after; op = C.afterOp; }
            else if (g.index === 0) { col = S.start; op = C.startOp; }
            else { col = S.idle; op = C.idleOp; }
            m.color.copy(col); m.opacity = op;
        }
        const g = this.race.gates[n];
        this.keyline.visible = live;
        if (live) { this.keyline.position.copy(g.position); this.keyline.quaternion.copy(g.mesh.quaternion); }
        this._gateD = live ? g.position.distanceTo(pos) : Infinity;
    }

    // --- the path ahead ---------------------------------------------------------------------
    // Two tubes per stretch: the line (accent to quiet along its length) and a fatter dark
    // keyline seen only from inside (its back faces), so it rims the line. Both fade out within
    // a metre of the camera (you fly along the line; close up the tube would fill the view).
    // Built once per stretch and kept: a rebuild on every gate cost a ~20 ms frame.
    _buildPath() {
        this.pathA = uniform(new THREE.Color(C.path[0])); this.pathB = uniform(new THREE.Color(C.path[1])); this.pathKey = uniform(new THREE.Color(C.keyline));
        const fade = smoothstep(0.35, 1.2, positionView.length());
        this._pathMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
        this._pathMat.colorNode = mix(this.pathA, this.pathB, uv().x); this._pathMat.opacityNode = float(C.pathOp).mul(fade);
        this._pathKeyMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.BackSide });
        this._pathKeyMat.colorNode = this.pathKey; this._pathKeyMat.opacityNode = float(C.pathKeylineOp).mul(fade);
        this._paths = new Map(); this._pathOn = null; this._pathFor = null;
        for (let n = 0; n < this.race.gates.length; n++) this._pathGroup(true, n, null);
    }

    _pathGroup(started, n, pos) {
        const key = `${started}:${n}`;
        let grp = this._paths.get(key);
        if (grp) return grp;
        const G = this.race.gates, N = G.length;
        // The same flown line as the course check: via points (corners), lead-in, gate, lead-out.
        // Before the start it runs from the whoop straight to the first gate (its corner via
        // points lie behind the spawn), beginning a third of the way there.
        const from = started ? G[(n - 1 + N) % N].position.clone().addScaledVector(G[(n - 1 + N) % N].normal, LEAD) : new THREE.Vector3(pos.x, pos.y, pos.z);
        const raw = this.track.gates.map((g, i) => ({ ...g, _i: i, via: !started && i === n ? [] : g.via }));
        const pts = [from, ...linePoints(raw, THREE.Vector3, (g) => G[g._i].normal, n, 2)];
        if (!started) pts[0].lerp(pts[1], 0.35);
        const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
        grp = new THREE.Group();
        const key2 = new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 0.016, 6, false), this._pathKeyMat); key2.renderOrder = -2;
        grp.add(key2, new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 0.009, 6, false), this._pathMat));
        grp.visible = false; this.group.add(grp);
        if (started) this._paths.set(key, grp); // the pre-start line depends on where the whoop sits
        return grp;
    }

    _path(pos) {
        const started = this.stage === 'racing' || this.stage === 'done', n = this.race.nextGate, key = `${started}:${n}`;
        if (key === this._pathFor) return;
        this._pathFor = key;
        if (this._pathOn) { this._pathOn.visible = false; if (!this._paths.has(this._pathOnKey)) { this.group.remove(this._pathOn); this._pathOn.children.forEach((m) => m.geometry.dispose()); } }
        this._pathOn = this._pathGroup(started, n, pos); this._pathOnKey = key; this._pathOn.visible = true;
    }

    // --- sound ---------------------------------------------------------------------------
    _tone(f, at, len, { type = 'sine', gain = 0.3, fade = 0.02 } = {}) {
        const ctx = this.getAudio(); if (!ctx) return;
        const t0 = ctx.currentTime + at, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
        g.gain.setValueAtTime(gain, t0 + Math.max(0.006, len - fade)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
        o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + len + 0.02);
    }
    // The gate and lap sounds: short soft sine blips (each note [Hz, start s, length s]).
    _blip(notes) {
        const ctx = this.getAudio(); if (!ctx) return;
        const t0 = ctx.currentTime;
        for (const [f, at, len] of notes) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'sine'; o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
            o.connect(g).connect(ctx.destination); o.start(t0 + at); o.stop(t0 + at + len + 0.02);
        }
    }
    _buzz() {
        const ctx = this.getAudio(); if (!ctx) return;
        const t0 = ctx.currentTime, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.value = 180; f.type = 'lowpass'; f.frequency.value = 800;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(f).connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + 0.25);
    }

    // --- HUD -----------------------------------------------------------------------------
    _buildHud() {
        const css = document.createElement('style'); css.textContent = CSS; document.head.appendChild(css);
        this.el = document.createElement('div'); this.el.id = 'tt';
        this.el.innerHTML = '<div class="title"></div><div class="count mid"><div class="pl"><div></div><div class="bar"><i></i></div></div></div>'
            + '<div class="go mid"><div class="pl">Go<div class="bar"></div></div></div><div class="clock mid"><div class="pl"></div></div><div class="dist pl"></div>'
            + '<div class="lap mid"><div class="pl"><div class="n q"></div><div class="t"></div><div class="r"><span></span><span class="q"></span></div></div></div>'
            + '<div class="final mid"><div class="pl">Final lap</div></div><div class="delta mid"><div class="pl"></div></div><div class="fin"></div>';
        document.body.appendChild(this.el);
        const $ = (s) => this.el.querySelector(s);
        this.ui = {
            title: $('.title'), count: $('.count'), countWord: $('.count .pl > div'), countBar: $('.count .bar i'), go: $('.go'),
            clock: $('.clock'), clockT: $('.clock .pl'), dist: $('.dist'), lap: $('.lap'), lapN: $('.lap .n'), lapT: $('.lap .t'),
            lapD: $('.lap .r span'), lapB: $('.lap .r .q'), final: $('.final'), delta: $('.delta'), deltaT: $('.delta .pl'), fin: $('.fin'),
        };
        this.arrow = document.createElement('div'); this.arrow.id = 'tt-arrow'; document.body.appendChild(this.arrow);
        this._cache = new Map();
        this._v3 = new THREE.Vector3();
    }

    // Write-on-change helpers: the DOM is touched only when a value differs from the last write.
    _set(el, key, v, fn) { const k = this._cache.get(el) || {}; if (k[key] === v) return; k[key] = v; this._cache.set(el, k); fn(v); }
    _show(el, on) { this._set(el, 'on', on, () => el.classList.toggle('on', on)); }
    _text(el, s) { this._set(el, 'text', s, () => (el.textContent = s)); }
    _html(el, s) { this._set(el, 'html', s, () => (el.innerHTML = s)); }
    _cls(el, base, c) { this._set(el, 'cls', c, () => (el.className = `${base} ${c}`.trim())); }
    _fx(el, op, tf) { this._set(el, 'op', op, () => (el.style.opacity = op)); this._set(el, 'tf', tf, () => (el.style.transform = tf)); }

    _keys(pairs) { return `<div class="keys">${pairs.filter(([k]) => k).map(([k, w]) => `<span><b>${k}</b>${w}</span>`).join('')}</div>`; }
    _head(text) { return `<div class="hd"><img src="brand/cuds-badge.png" alt="">${text}</div>`; }

    // Top-down plan of the course (x right, z down, equal scale, so not mirrored): the gallery's
    // surveyed outline (track.js), the gates as short bars across their openings, and either the
    // planned line or the laps flown. The highlighted line runs accent to quiet like the path.
    _plan(lines) {
        const P = SPONZA_PLAN, pad = 0.1, x0 = P.x[0] - pad, z0 = P.z[0] - pad, W = P.x[1] - P.x[0] + 2 * pad, H = P.z[1] - P.z[0] + 2 * pad;
        const k = 900 / W, X = (x) => ((x - x0) * k).toFixed(1), Z = (z) => ((z - z0) * k).toFixed(1);
        const rect = (r) => `<rect class="wall" x="${X(r.x[0])}" y="${Z(r.z[0])}" width="${((r.x[1] - r.x[0]) * k).toFixed(1)}" height="${((r.z[1] - r.z[0]) * k).toFixed(1)}" stroke-width="1.5"/>`;
        const id = `pg${this._planN = (this._planN || 0) + 1}`;
        let s = `<svg viewBox="0 0 900 ${(H * k).toFixed(0)}"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="900" y2="0">`
            + `<stop offset="0" style="stop-color:var(--hud-accent)"/><stop offset="1" style="stop-color:var(--hud-quiet)"/></linearGradient></defs>${rect(P)}${rect(P.opening)}`;
        for (const l of lines) {
            const d = l.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0])},${Z(p[1])}`).join('');
            if (l.hi) s += `<path class="key" d="${d}" stroke-width="${l.w + 3}" stroke-opacity=".55"/><path class="line" d="${d}" style="stroke:url(#${id})" stroke-width="${l.w}"/>`;
            else s += `<path class="line" d="${d}" stroke-width="${l.w}" stroke-opacity="${l.op}"/>`;
        }
        const r = this.track.gateRadius;
        for (const g of this.race.gates) {
            const p = g.position, n = g.normal, h = Math.hypot(n.x, n.z) || 1, ax = n.z / h * r * 1.3, az = -n.x / h * r * 1.3;
            s += `<line class="gate${g.index === 0 ? ' s' : ''}" x1="${X(p.x - ax)}" y1="${Z(p.z - az)}" x2="${X(p.x + ax)}" y2="${Z(p.z + az)}" stroke-width="${g.index === 0 ? 7 : 5}"/>`;
        }
        return s + '</svg>';
    }

    // The planned line: closed centripetal Catmull-Rom through every gate's via points, lead-in,
    // gate and lead-out (track.js linePoints, as drawn ahead in flight).
    _courseLine() {
        const G = this.race.gates;
        const raw = this.track.gates.map((g, i) => ({ ...g, _i: i }));
        const pts = linePoints(raw, THREE.Vector3, (g) => G[g._i].normal);
        return new THREE.CatmullRomCurve3(pts, true, 'centripetal').getPoints(400).map((p) => [p.x, p.z]);
    }

    _titleCard() {
        const best = this.bestRun ? `, best <span>${formatTime(this.bestRun.ms)}</span>` : '';
        // Key hints as one pair of keycaps: the arm key (or "Switch" when a radio arms it) and Menu.
        const arm = this.keyLabel('arm') || 'Switch';
        this._html(this.ui.title, '<img class="badge" src="brand/cuds-badge.png" alt="CUDS">' + `<div class="nm">${this.track.name}</div><div class="sub q lt">${this.laps} laps${best}</div>`
            + this._plan([{ pts: this._courseLine(), w: 4, hi: true }])
            + this._keys([[arm, 'Arm'], [this.keyLabel('menu'), 'Menu']])
            + '<div class="cr q lt"><a href="https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Sponza" target="_blank" rel="noopener">Sponza by Crytek (Frank Meinl, after Marko Dabrovic), PBR textures by Alexandre Pestana</a></div>');
    }

    _finishCard() {
        const prev = this.bestRun?.ms, tot = this.total, isNew = prev == null || tot < prev;
        const bestLap = Math.min(...this.lapTimes);
        let h = '<div class="panel"></div><div class="body">' + this._head(`<span>${this.track.name}, ${this.laps} laps</span>`);
        if (isNew) h += '<div class="nb q">New best</div>';
        h += `<div class="tot">${formatTime(tot)}</div>`;
        if (prev != null) h += `<div class="dl"><span class="${deltaCls(tot - prev)}">${deltaText(tot - prev)}</span><span class="q">${isNew ? 'was' : 'best'} ${formatTime(prev)}</span></div>`;
        h += '<div class="laps">' + this.lapTimes.map((ms, i) => `<div${ms === bestLap ? ' class="best"' : ''}><span>${i + 1}</span><span>${formatTime(ms)}</span>${ms === bestLap ? '<em>best lap</em>' : ''}</div>`).join('') + '</div></div>';
        const lines = this.runLaps.map((pts, i) => (this.lapTimes[i] === bestLap ? { pts, w: 4, hi: true } : { pts, w: 1.6, op: 0.35 }));
        lines.sort((a, b) => !!a.hi - !!b.hi); // best lap drawn last, on top
        h += this._plan(lines);
        h += this._keys([[this.keyLabel('reset'), 'Retry'], [this.keyLabel('menu'), 'Menu']]);
        this._html(this.ui.fin, h);
        if (isNew) {
            this.bestRun = { ms: tot, laps: this.lapTimes.slice() };
            try { localStorage.setItem(this.runKey, JSON.stringify(this.bestRun)); } catch { /* storage full */ }
        }
    }

    _hud(now) {
        const u = this.ui, st = this.stage;
        const unit = Math.min(innerWidth / 1280, innerHeight / 720);
        // Title card: only before arming.
        this._show(u.title, st === 'idle');
        // Ready: for the second before Go, the bar filling towards it.
        this._show(u.count, st === 'countdown');
        if (st === 'countdown') { this._text(u.countWord, 'Ready'); this._fx(u.countBar, '1', `scaleX(${clamp01((now - this.t0) / READY_MS).toFixed(2)})`); }
        // Go: held 0.6 s, then gone in two frames (a quick scale-out).
        const tg = (now - this.goAt) / 1000, goOn = (st === 'go' || st === 'racing') && tg >= 0 && tg < 0.64;
        this._show(u.go, goOn);
        if (goOn) { const e = clamp01((tg - 0.6) / 0.04); this._fx(u.go, e ? (1 - e).toFixed(2) : '1', e ? `scale(${(1 + 0.35 * e).toFixed(3)})` : 'none'); }
        // Clock: the run time, from the first start/finish crossing (0:00.000 from Go until then);
        // the finish card replaces it.
        const clockOn = st === 'go' || st === 'racing';
        this._show(u.clock, clockOn);
        if (clockOn) this._text(u.clockT, formatTime(st === 'racing' ? this.race.clock * 1000 : 0));
        // Distance to the next gate, beside its top corner.
        this._distance(st !== 'done', unit);
        // Gate pass: the delta to the best lap's split, small, just under the clock, for 1.5 s
        // (a quick fade in and out).
        const dl = this.delta, dt = dl ? (now - dl.at) / 1000 : 99, dOn = clockOn && dt >= 0 && dt < 1.5;
        this._show(u.delta, dOn);
        if (dOn) {
            this._text(u.deltaT, dl.text); this._cls(u.deltaT, 'pl', dl.cls);
            this._fx(u.delta, Math.min(1, dt / 0.08, (1.5 - dt) / 0.25).toFixed(2), 'none');
        }
        // Lap complete: lap number and time in the lower third, the delta a beat later; after
        // ~2 s it folds up into the clock. After the second-last lap, "Final lap" follows.
        const L = this.lapMoment, lt = L ? (now - L.at) / 1000 : 99, lOn = lt >= 0.1 && lt < 2.5;
        this._show(u.lap, lOn);
        if (lOn) {
            this._text(u.lapT, formatTime(L.ms)); this._text(u.lapN, `Lap ${L.n}`);
            this._text(u.lapD, L.d == null ? '' : deltaText(L.d)); this._cls(u.lapD, '', L.d == null ? '' : deltaCls(L.d));
            this._text(u.lapB, L.prev == null ? '' : `best ${formatTime(L.prev)}`);
            this._set(u.lapD, 'vis', lt >= 0.5, (v) => (u.lapD.style.visibility = v ? 'inherit' : 'hidden'));
            const pin = ease(clamp01((lt - 0.1) / 0.3)), fold = clamp01((lt - 2.0) / 0.5), fy = fold * fold;
            // Fold target: the clock, top centre (block centre ~590 of 720 up to ~34).
            this._fx(u.lap, ((0.85 + 0.15 * pin) * (1 - fold)).toFixed(2), `translateY(${(-556 * fy * unit).toFixed(1)}px) scale(${((1 - 0.6 * fold) * (1.06 - 0.06 * pin)).toFixed(3)})`);
        }
        const fOn = !!L?.final && lt >= 2.6 && lt < 3.6;
        this._show(u.final, fOn);
        if (fOn) { const a = clamp01((lt - 2.6) / 0.12), z = clamp01((lt - 3.45) / 0.15); this._fx(u.final, (a * (1 - z)).toFixed(2), `scale(${(1.06 - 0.06 * ease(a)).toFixed(3)})`); }
        // Finish: the result card fades in over the run.
        const ft = st === 'done' ? (now - this.doneAt) / 1000 : -1;
        this._show(u.fin, ft >= 0.3);
        if (ft >= 0.3) this._fx(u.fin, clamp01((ft - 0.3) / 0.4).toFixed(2), 'none');
        // Off-screen next gate: arrow at the screen edge.
        const ang = st === 'done' || this._onScreen ? null : this.race.pointerAngle(this.camera);
        this._set(this.arrow, 'on', ang !== null, (on) => (this.arrow.style.display = on ? 'block' : 'none'));
        if (ang !== null) {
            const R = Math.min(innerWidth, innerHeight) * 0.3; // clear of the clock at the top
            this._set(this.arrow, 'tf', `translate(${(Math.sin(ang) * R - 14).toFixed(1)}px, ${(-Math.cos(ang) * R - 13).toFixed(1)}px) rotate(${ang.toFixed(3)}rad)`, (v) => (this.arrow.style.transform = v));
        }
    }

    // The next gate's distance, beside the top-right corner of its frame on screen.
    _distance(live, unit) {
        const u = this.ui, g = this.race.gates[this.race.nextGate], cam = this.camera;
        cam.updateMatrixWorld(); // FPV camera hangs off the airframe; refresh before projecting
        const c = this._v3.copy(g.position).project(cam);
        this._onScreen = c.z < 1 && c.z > -1 && Math.abs(c.x) < 0.95 && Math.abs(c.y) < 0.95;
        let on = live && this._gateD > 1.5 && this._gateD < 60;
        if (on) {
            const r = this.track.gateRadius, v = this._v3, q = g.mesh.quaternion;
            let mx = -Infinity, my = Infinity;
            for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                v.set(sx * r * 1.09, sy * r * 1.09, 0).applyQuaternion(q).add(g.position).project(cam);
                if (v.z > 1 || v.z < -1) { on = false; break; }
                mx = Math.max(mx, v.x); my = Math.min(my, -v.y);
            }
            if (on) {
                const x = (mx + 1) / 2 * innerWidth + 10 * unit, y = (my + 1) / 2 * innerHeight - 2 * unit;
                on = x > 0 && x < innerWidth - 40 * unit && y > 0 && y < innerHeight;
                if (on) {
                    this._text(u.dist, `${Math.max(1, Math.round(this._gateD))} m`);
                    this._set(u.dist, 'tf', `translate3d(${x.toFixed(0)}px,${y.toFixed(0)}px,0)`, (t) => (u.dist.style.transform = t));
                }
            }
        }
        this._show(u.dist, on);
    }

    // --- run -----------------------------------------------------------------------------
    reset() {
        this.race.resetRun();
        this.stage = 'idle'; this.goAt = -1e9; this.doneAt = 0; this.holeshot = null; this.lapTimes = []; this.total = 0;
        this.delta = null; this.lapMoment = null; this.splits = []; this.path = []; this.runLaps = []; this._lapLine = []; this._pathFor = null; this._hadArm = false;
        this.moments = {};
        this._titleCard();
        try { speechSynthesis.cancel(); } catch { /* */ }
    }

    get holding() { return this.stage === 'countdown'; }

    // Per frame, after physics. Returns nothing; read `holding` to keep the whoop on the ground.
    update(dt, now, pos, armed) {
        const r = this.race;
        if (this.stage === 'idle') {
            this.moments.title ??= now;
            // Start on arming (a fresh arm, so a run doesn't start by itself after a reset).
            if (this._hadArm === false && armed) { this.stage = 'countdown'; this.t0 = now; this.moments.countdown = now; }
            this._hadArm = armed;
        }
        if (this.stage === 'countdown') {
            if (now - this.t0 >= READY_MS) { this.stage = 'go'; this.goAt = now; this.moments.go = now; this._tone(880, 0, 0.7, { type: 'triangle', gain: 0.4, fade: 0.25 }); }
        }
        if (this.stage === 'go' || this.stage === 'racing') {
            const next = r.gates[r.nextGate], prevD = this._prevD;
            r.update(pos, dt);
            // Wrong way through the next gate: flash it red and buzz.
            const d = (pos.x - next.position.x) * next.normal.x + (pos.y - next.position.y) * next.normal.y + (pos.z - next.position.z) * next.normal.z;
            if (prevD !== undefined && prevD > 0 && d <= 0 && next.position.distanceTo(pos) < this.track.gateRadius * 1.5 && now > next.wrongUntil) { next.wrongUntil = now + 600; this._buzz(); }
            this._prevD = r.gates[r.nextGate] === next ? d : undefined;
            for (const e of r.consumeEvents()) this._event(e, now, next);
            if (this.stage === 'racing') {
                const ms = r.currentLapMs;
                const l = this.path[this.path.length - 1];
                if (!l || ms - l[3] > 40) { this.path.push([+pos.x.toFixed(3), +pos.y.toFixed(3), +pos.z.toFixed(3), Math.round(ms)]); this._lapLine.push([pos.x, pos.z]); }
                this._ghost(ms);
            }
        }
        this._colour(now, pos);
        this._path(pos);
    }

    // Per frame, after the camera has followed the airframe: the HUD (it projects the gate).
    draw(now) { this._hud(now); }

    _ghost(ms) {
        const p = this.best?.path;
        if (!p || p.length < 2) { this.ghostMesh.visible = false; return; }
        let i = this._gi && p[this._gi]?.[3] <= ms ? this._gi : 0;
        while (i < p.length - 2 && p[i + 1][3] < ms) i++;
        this._gi = i;
        const a = p[i], b = p[i + 1], f = Math.min(1, Math.max(0, (ms - a[3]) / Math.max(1, b[3] - a[3])));
        this.ghostMesh.position.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
        this.ghostMesh.visible = ms <= p[p.length - 1][3];
    }

    _event(e, now, gate) {
        if (gate) gate.flashUntil = now + 200; // the passed frame flares white for a beat
        if (e.type === 'start') {
            this.stage = 'racing'; this.holeshot = now - this.goAt; this.splits = []; this.path = []; this._lapLine = []; this._gi = 0;
            this.moments.start = now;
            this._blip([[1320, 0, 0.07]]);
        } else if (e.type === 'gate') {
            const t = this.race.currentLapMs, b = this.best?.splits?.[this.splits.length];
            this.splits.push(Math.round(t));
            this.delta = b != null ? { text: deltaText(t - b), cls: deltaCls(t - b), at: now } : null;
            this.moments[`g${this.lapTimes.length + 1}.${this.splits.length}`] = now;
            this._blip([[1320, 0, 0.07]]);
        } else if (e.type === 'lap') {
            this.lapTimes.push(e.ms);
            this._lapLine.push([this.race.gates[0].position.x, this.race.gates[0].position.z]);
            this.runLaps.push(this._lapLine); this._lapLine = [[this.race.gates[0].position.x, this.race.gates[0].position.z]];
            const prev = this.best?.ms, isBest = prev == null || e.ms < prev, n = this.lapTimes.length;
            this.delta = null;
            this.lapMoment = { n, ms: e.ms, d: prev != null ? e.ms - prev : null, prev, at: now, final: n === this.laps - 1 };
            this.moments[`lap${n}`] = now;
            if (isBest) {
                this.best = { ms: e.ms, splits: this.splits.slice(), path: this.path.slice() };
                try { localStorage.setItem(this.bestKey, JSON.stringify(this.best)); } catch { /* storage full */ }
            }
            this.splits = []; this.path = []; this._gi = 0;
            if (n >= this.laps) {
                this.stage = 'done'; this.doneAt = now; this.moments.done = now; this.lapMoment = null;
                this.total = this.lapTimes.reduce((a, b) => a + b, 0);
                this._finishCard();
                [[1200, 0, 0.05], [1800, 0.05, 0.075], [1200, 0.15, 0.05], [1800, 0.2, 0.075], [1200, 0.3, 0.05], [1800, 0.35, 0.1]].forEach(([f, at, len]) => this._tone(f, at, len, { type: 'square', gain: 0.12 }));
                say(`Race complete. Total ${secs(this.total)}. Best lap ${secs(Math.min(...this.lapTimes))}`);
            } else if (isBest) {
                this._blip([[988, 0, 0.1], [1319, 0.1, 0.1], [1760, 0.2, 0.18]]);
                say(`Best lap, ${secs(e.ms)}`);
            } else {
                this._blip([[1319, 0, 0.08], [1319, 0.12, 0.12]]);
                say(`Lap ${this.lapTimes.length}, ${secs(e.ms)}`);
            }
        }
    }
}
