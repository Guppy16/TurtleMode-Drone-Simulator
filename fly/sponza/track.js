// Sponza time trial on the first-floor gallery, designed from research (MultiGP track design,
// RotorHazard, Velocidrone; notes in the session scratchpad):
// - MultiGP scales its Universal Time Trial for micro quads by 1/4; this building's first floor
//   is that size. Flow: one continuous line, the next gate in view at least ~1 s ahead, no blind
//   descent, nothing threaded through cloth.
// - Surveyed geometry (?mode=survey): gallery floor y 3.32, ceiling 6.8; walkway z 2.0..4.6
//   (north), -2.0..-5.1 (south), ends x 7.3..10.4 and -11.25..-8.3; the opening over the
//   courtyard |z| < 1.3, x -7.6..6.7, with a 0.75 m parapet and arcade columns at x ~ -7.98,
//   -4.95, -1.99, 0.96, 3.94, 6.95 (2.5 m arches between them). The banners hang below the
//   parapet, so none are in the way up here. Sunlight comes in over the opening.
// - Layout: a lap of the gallery ring. Along the north side the line weaves out through one
//   arch window into the sunlit opening, runs 6 m along it and comes back in through another.
//   The arcade is paired arches, a thin post between big columns, so the windows are 1.1 m
//   wide (sill 4.06, top 6.33); window gates sit in their centres within 25 deg of square.
//   The south side is plain corridor. The only sharp turns are the gallery's four corners
//   (2.6-3 m wide).
// - Gates are wide rectangles, flown one way: each spans its corridor (width `w`, the corridor
//   less ~10 cm a side and the 27 mm frame bars, so the frame never touches a wall or column)
//   and as tall as the clear height there (floor or parapet to the lowest point of the vault
//   or arch across its width, less ~10 cm); w x h is the opening, the bars sit outside it. The
//   window gates fill their arched 1.1 m windows; the sunlit gate over the courtyard is 3 m tall.
//   Sizes from ?mode=survey&gates=1&fit=1. `y` is the flown line's height through the gate,
//   `fy` the frame's centre (the opening reaches well above and below the line). Corridor widths are the surveyed walls
//   above; ?mode=survey&gates=1 checks the clearance round every frame. A gate faces along `yaw` / `pitch` if given (tracks.js convention), otherwise from
//   the previous gate towards the next.
// - `via`: points the flown line passes before reaching a gate (corners), so the path drawn
//   ahead and the clearance check follow the corridors instead of cutting the columns.
// - Runs: 2 laps; the lap clock starts at the first start/finish crossing.
// Coordinates: world x, y, z in metres.
export const SPONZA_TRACK = {
    id: 'sponza-gallery',
    name: 'Sponza Gallery',
    gateRadius: 0.5, // half the default opening (1 m); gates give their own w x h
    square: true,
    directional: true,
    laps: 2,
    gates: [
        { name: 'Start', x: -6.5, y: 4.32, fy: 5.13, z: 3.3, yaw: 90, w: 2.3, h: 3.25, via: [[-9.5, 4.32, 2.9], [-8.2, 4.32, 3.3]] },
        { name: 'Window out', x: -2.74, y: 4.9, fy: 5.0, z: 1.71, yaw: 25, w: 0.6, h: 1.55 },
        { name: 'Sunlit run', x: 0.19, y: 4.9, fy: 4.9, z: 0.03, yaw: 90, w: 2.2, h: 3.0 },
        { name: 'Window in', x: 3.14, y: 4.9, fy: 5.04, z: 1.7, yaw: 155, w: 0.6, h: 1.6, via: [[2.0, 4.9, 0.5]] },
        { name: 'East', x: 8.86, y: 4.32, fy: 5.08, z: 0.0, yaw: 0, w: 2.7, h: 3.26, via: [[6.0, 4.4, 3.3], [8.6, 4.32, 2.9]] },
        { name: 'South', x: 2.0, y: 4.32, fy: 5.04, z: -3.86, yaw: 270, w: 1.95, h: 3.17, via: [[8.6, 4.32, -3.2], [6.5, 4.32, -3.7]] },
        { name: 'South 2', x: -4.5, y: 4.32, fy: 4.76, z: -3.86, yaw: 270, w: 1.95, h: 2.61 },
        { name: 'West', x: -9.81, y: 4.32, fy: 5.1, z: 0.0, yaw: 180, w: 2.55, h: 3.23, via: [[-7.8, 4.32, -3.7], [-9.5, 4.32, -3.2]] },
    ],
};
// The gallery's surveyed outline (from the numbers above), for the HUD's top-down plan: the ring's
// outer walls and the opening over the courtyard. x, z in metres.
export const SPONZA_PLAN = { x: [-11.25, 10.4], z: [-5.1, 4.6], opening: { x: [-7.6, 6.7], z: [-1.3, 1.3] } };
// Start: on the gallery floor at the north-west corner, facing along the north walkway.
export const SPONZA_TRACK_SPAWN = { x: -9.4, y: 3.32, z: 3.3, yaw: 90 };

// Gate facing: from the previous gate towards the next, as yaw / pitch in tracks.js's convention.
export function withFacing(gates) {
    const N = gates.length;
    return gates.map((g, i) => {
        if (g.yaw !== undefined) return { ...g, pitch: g.pitch ?? 0 };
        const a = gates[(i - 1 + N) % N], b = gates[(i + 1) % N];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, hz = Math.hypot(dx, dz);
        return { ...g, yaw: Math.atan2(dx, -dz) * 180 / Math.PI, pitch: Math.atan2(dy, hz) * 180 / Math.PI };
    });
}

// The flown line: for each gate its via points, then a lead-in, the gate and a lead-out along
// the gate's normal (so the line passes square through the frame). `n(g)` gives the normal.
export const LEAD = 0.45;
export function linePoints(gates, V, normalOf, from = 0, count = gates.length) {
    const out = [];
    for (let k = 0; k < count; k++) {
        const g = gates[(from + k) % gates.length], n = normalOf(g), p = new V(g.x, g.y, g.z);
        for (const v of g.via || []) out.push(new V(...v));
        out.push(p.clone().addScaledVector(n, -LEAD), p.clone(), p.clone().addScaledVector(n, LEAD));
    }
    return out;
}
