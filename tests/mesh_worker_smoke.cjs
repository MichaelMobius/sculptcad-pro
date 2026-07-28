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
  reducedTriangles: reduced.index.length / 3
}));
