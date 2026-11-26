#!/usr/bin/env node
// vendor-deps.mjs - Fetch the browser dependencies into vendor/.
//
// The page has no bundler and no `npm install`; the importmap in index.html points at committed
// copies under vendor/ rather than at a CDN. That is deliberate. Loading three.js from unpkg meant
// the simulator could not run offline and went dark whenever unpkg did, which for a tool people
// fly on is not an acceptable failure mode. It also means the exact bytes being shipped are in
// git and reviewable, rather than whatever a URL resolves to today.
//
// This script exists so refreshing those copies is reproducible. Run it after changing a version
// in DEPS below; the versions here and the ones documented in project_plan.md are the same fact
// and must be kept in step.
//
//   node tools/vendor-deps.mjs            download anything missing
//   node tools/vendor-deps.mjs --force    re-download everything
//   node tools/vendor-deps.mjs --check    verify every file is present and matches its sha256
//
// Every file is pinned by sha256, checked on download and by --check, so a CDN serving different
// bytes for the same version fails loudly instead of being committed. The three.js hashes are the
// ones in vendor/three/MANIFEST.txt, taken from the npm tarball (whose sha512 is recorded there);
// unpkg serves the files of that same tarball. Bumping a version means updating the hashes too,
// from a tarball checked against the registry's `dist.integrity`.
//
// vendor/three is a single copy of three.js shared by the main sim (WebGLRenderer, through
// three.module.js) and the Sponza map (WebGPURenderer and TSL, through three.webgpu.js and
// three.tsl.js). three.module.js, three.webgpu.js and three.tsl.js all import three.core.js by
// relative path, so it must sit next to them. The addons are the union of what the two pages
// load, and their relative imports close on the set: GLTFLoader pulls in BufferGeometryUtils and
// SkeletonUtils, SunLight its SunLightShadow, SunLightNode its SunShadowNode, LightProbeGrid its
// LightProbeGridUtils and tsl/lighting/LightProbeGridNode, TRAANode and TAAUNode tsl/utils/TAAUtils.
// three-mesh-bvh imports 'three' and cannon-es imports nothing. Adding a new three.js addon means
// checking its imports and vendoring whatever they reach, or the page will fail on a bare
// specifier or relative path the importmap cannot resolve.

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const THREE = '0.187.0';
const CANNON = '0.20.0';
const BVH = '0.7.3';

// [path inside the three package, path under vendor/three, sha256]
const THREE_FILES = [
    ['LICENSE', 'LICENSE', '8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc'],
    ['build/three.module.js', 'three.module.js', '104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341'],
    ['build/three.core.js', 'three.core.js', '613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578'],
    ['build/three.webgpu.js', 'three.webgpu.js', 'eafead3154ec06093f3108bddceab360f048a6fcebd7c085d5aae0ab5404bd25'],
    ['build/three.tsl.js', 'three.tsl.js', 'd8f3cdb8b85b799a5631bd9a8d77e185d88ce1eb1bb051f48b332728a5423e3f'],
    ['examples/jsm/loaders/GLTFLoader.js', 'addons/loaders/GLTFLoader.js', '532ac726e120039acbcd6cf54328c57acbf7b438176afaa6951257126d11bff1'],
    ['examples/jsm/loaders/DDSLoader.js', 'addons/loaders/DDSLoader.js', 'c0ebc0ccd6ab51852958f2fcd5b04d99c550b016c750b87c94e96e50460f9301'],
    ['examples/jsm/utils/BufferGeometryUtils.js', 'addons/utils/BufferGeometryUtils.js', '7bda2a8ba836b2bcf67cb938d4b9e1bb5d1b1bc616817103ed858c0b58296ce7'],
    ['examples/jsm/utils/SkeletonUtils.js', 'addons/utils/SkeletonUtils.js', 'b1632a703206c3d830de9fcbe515696770d04b71a15ee6b50afa6d2c3298c86f'],
    ['examples/jsm/objects/SkyMesh.js', 'addons/objects/SkyMesh.js', '64804362f468a70d5d0283161241d85ef5c47fa1944ca916542a04217c3ebe64'],
    ['examples/jsm/lights/SunLight.js', 'addons/lights/SunLight.js', '580a50687031518ea66e4b0cb85884d657d2f7dc72d38e64e6c874d51f5aa2eb'],
    ['examples/jsm/lights/SunLightNode.js', 'addons/lights/SunLightNode.js', 'd64be448da7631e35c8382b4b80906326613739f4891301820886bddaaf9c337'],
    ['examples/jsm/lights/SunLightShadow.js', 'addons/lights/SunLightShadow.js', 'fd3ecd1e7d426813607f2829a1f767c0473ddbf3b3507d1cc9cca888a6839e31'],
    ['examples/jsm/lights/SunShadowNode.js', 'addons/lights/SunShadowNode.js', '3e5e7f347c49f59b946b6958f2b88863fc7ee38fd6b992917f4a6c2f2190654c'],
    ['examples/jsm/lighting/LightProbeGrid.js', 'addons/lighting/LightProbeGrid.js', '99ce7d83a8a1f5ae0188443fc915fd8dad9ef5d8f735e225bcb3ed6e2cad95d6'],
    ['examples/jsm/lighting/LightProbeGridUtils.js', 'addons/lighting/LightProbeGridUtils.js', '11786b3ba83b0cc2d1e3e569ff40e7ba2e6709016da195d3813411eee3f2fc1d'],
    ['examples/jsm/tsl/lighting/LightProbeGridNode.js', 'addons/tsl/lighting/LightProbeGridNode.js', '29354f1e40dde26a76d130822b6812d984d68b38f4d3b11b6c2e69f470ff10b5'],
    ['examples/jsm/tsl/display/FSR1Node.js', 'addons/tsl/display/FSR1Node.js', 'f968f97cd733a97c51bbe3bf06c495a280be53fe0da95b5b8fd8781208447d47'],
    ['examples/jsm/tsl/display/FXAANode.js', 'addons/tsl/display/FXAANode.js', 'fe11c77f90f9eac220a382a6796b7ee8a49d41603c6813d9271b29dbe39469d5'],
    ['examples/jsm/tsl/display/SMAANode.js', 'addons/tsl/display/SMAANode.js', '397ca1a38d5f31681c86705df052271eaff230b52848f768b6dd9ed482f4ae0a'],
    ['examples/jsm/tsl/display/TAAUNode.js', 'addons/tsl/display/TAAUNode.js', 'b5f0f0e226065a708aa225bcaeaf0054d0872eafa3d6766b14a44308a5812c07'],
    ['examples/jsm/tsl/display/TRAANode.js', 'addons/tsl/display/TRAANode.js', 'c1e253f9953b90534b1604e4e8afd8a0a7f4865ecc29697068df050c2e1c25e2'],
    ['examples/jsm/tsl/utils/TAAUtils.js', 'addons/tsl/utils/TAAUtils.js', 'f1a9b0530383c20bbeceda2c4276d6e676130ca9bea71c74a3373bf35a637bb7']
];

const DEPS = [
    ...THREE_FILES.map(([from, to, sha256]) => ({
        url: `https://unpkg.com/three@${THREE}/${from}`,
        path: `vendor/three/${to}`,
        sha256
    })),
    {
        url: `https://unpkg.com/cannon-es@${CANNON}/dist/cannon-es.js`,
        path: 'vendor/cannon-es/cannon-es.js',
        sha256: 'f0700cbd3a482954949b9d58c1b0f76dcc74767750297647a39d8c40dd63d37c'
    },
    {
        url: `https://unpkg.com/three-mesh-bvh@${BVH}/build/index.module.js`,
        path: 'vendor/three-mesh-bvh/index.module.js',
        sha256: 'dfb82fc704a834a54dd600334fd79b2cb8b0a850092ca0f368798d7f3e028405'
    }
];

const exists = (p) => access(p).then(() => true, () => false);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
    const mode = process.argv[2];
    let bad = 0;

    for (const dep of DEPS) {
        const target = join(root, dep.path);
        const present = await exists(target);

        if (mode === '--check') {
            let status = 'MISSING';
            if (present) status = sha256(await readFile(target)) === dep.sha256 ? 'ok     ' : 'CHANGED';
            if (status !== 'ok     ') bad++;
            console.log(`  ${status} ${dep.path}`);
            continue;
        }

        if (present && mode !== '--force') {
            console.log(`  skip    ${dep.path} (already vendored)`);
            continue;
        }

        const res = await fetch(dep.url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${dep.url}`);
        // Raw bytes, not text(): decoding and re-encoding could change them, and the hash is of
        // the file as published.
        const body = Buffer.from(await res.arrayBuffer());

        // Also catches a CDN error page served as a 200, or a truncated module, which would
        // otherwise fail at runtime in a way that points nowhere near here.
        const got = sha256(body);
        if (got !== dep.sha256) {
            throw new Error(`${dep.url}: sha256 ${got}, expected ${dep.sha256}`);
        }

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body);
        console.log(`  wrote   ${dep.path} (${(body.length / 1024).toFixed(0)} KB)`);
    }

    if (mode === '--check' && bad > 0) {
        console.error(`\n${bad} vendored file(s) missing or changed. Run: node tools/vendor-deps.mjs --force`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
