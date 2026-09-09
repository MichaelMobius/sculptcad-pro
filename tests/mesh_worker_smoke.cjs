const fs = require('fs');
const path = require('path');
const vm = require('vm');
const workerPath = path.join(__dirname, '..', 'src', 'workers', 'meshWorker.js');
const code = fs.readFileSync(workerPath, 'utf8');
let lastMessage = null;
const context = {
  console,
  Float32Array,
  Uint32Array,
  Uint16Array,
  Uint8Array,
  Int8Array,
  Math,
  Map,
  Set,
  Error,
  self: { postMessage(message) { lastMessage = message; } }
};
vm.createContext(context);
vm.runInContext(code, context);

function run(op, geometry, options = {}) {
  lastMessage = null;
  context.self.onmessage({ data: { id: 1, op, geometry, options } });
  if (!lastMessage?.ok) throw new Error(lastMessage?.error || 'Worker failed');
  return lastMessage.result;
}

const quad = {
  positions: new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]),
  uvs: new Float32Array([0,0, 1,0, 1,1, 0,1]),
  masks: new Float32Array([1,1,1,1]),
  index: new Uint32Array([0,1,2, 0,2,3])
};
const subdivided = run('subdivide', quad);
if (subdivided.index.length / 3 !== 8) throw new Error('Subdivide returned an unexpected triangle count');
const relaxed = run('relax', quad, { iterations: 2 });
if (!relaxed.positions.every(Number.isFinite)) throw new Error('Relax produced non-finite values');


const nonIndexedQuad = {
  positions: new Float32Array([
    0,0,0, 1,0,0, 1,1,0,
    0,0,0, 1,1,0, 0,1,0
  ]),
  uvs: null,
  masks: null,
  index: null
};
const nonIndexedRelaxed = run('relax', nonIndexedQuad, { iterations: 1 });
const distance = (a, b) => Math.hypot(
  nonIndexedRelaxed.positions[a * 3] - nonIndexedRelaxed.positions[b * 3],
  nonIndexedRelaxed.positions[a * 3 + 1] - nonIndexedRelaxed.positions[b * 3 + 1],
  nonIndexedRelaxed.positions[a * 3 + 2] - nonIndexedRelaxed.positions[b * 3 + 2]
);
if (distance(0, 3) > 1e-6 || distance(2, 4) > 1e-6) {
  throw new Error('Relax opened cracks between welded vertices of a non-indexed mesh');
}

const doubleSided = {
  positions: new Float32Array([
    0,0,0, 1,0,0, 0,1,0,
    0,0,0.001, 0,1,0.001, 1,0,0.001,
    2,0,0, 3,0,0, 2,1,0,
    3,1,0, 2,1,0, 3,0,0
  ]),
  uvs: null,
  masks: null,
  index: new Uint32Array([0,1,2, 3,4,5, 6,7,8, 9,10,11])
};
const reduced = run('reduce', doubleSided, { targetFraction: 0.7 });
if (!reduced.index.length) throw new Error('Reduce returned an empty mesh');

console.log(JSON.stringify({
  subdividedTriangles: subdivided.index.length / 3,
  relaxedVertices: relaxed.positions.length / 3,
  nonIndexedCrackMax: Math.max(distance(0, 3), distance(2, 4)),
  reducedTriangles: reduced.index.length / 3
}));


// Dos láminas muy próximas pero distintas no deben soldarse por una tolerancia
// absoluta excesiva. La tolerancia ahora escala con la diagonal del modelo.
const closeSheets = {
  positions: new Float32Array([
    0,0,0, 1,0,0, 0,1,0,
    0,0,0.0001, 1,0,0.0001, 0,1,0.0001
  ]),
  uvs: null,
  masks: null,
  index: null
};
const closeRelaxed = run('relax', closeSheets, { iterations: 1 });
const zGap = Math.abs(closeRelaxed.positions[2] - closeRelaxed.positions[11]);
if (zGap < 0.00005) throw new Error('Relax incorrectly welded two nearby independent sheets');
console.log(JSON.stringify({ nearbySheetsGap: zGap }));
