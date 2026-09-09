const fs = require('fs');
const path = require('path');
const vm = require('vm');
const workerPath = path.join(__dirname, '..', 'src', 'workers', 'vectorWorker.js');
const code = fs.readFileSync(workerPath, 'utf8');
let lastMessage = null;
const context = {
  console,
  Uint8Array,
  Uint8ClampedArray,
  Math,
  Map,
  Set,
  Array,
  Error,
  self: { postMessage(message) { lastMessage = message; } }
};
vm.createContext(context);
vm.runInContext(code, context);

const width = 8, height = 8;
const pixels = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const black = x >= 2 && x <= 5 && y >= 2 && y <= 5;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = black ? 0 : 255;
    pixels[i + 3] = 255;
  }
}
context.self.onmessage({ data: {
  id: 1,
  pixels,
  width,
  height,
  options: { threshold: 128, invert: false, noiseArea: 0, smoothStrength: 0, simplifyAmount: 0 }
}});
if (!lastMessage?.ok) throw new Error(lastMessage?.error || 'Vector worker failed');
if (!(lastMessage.result.mask instanceof Uint8Array)) throw new Error('Vector worker returned an invalid mask');
if (!Array.isArray(lastMessage.result.loops) || lastMessage.result.loops.length < 1) throw new Error('Vector worker did not trace the square');
console.log(JSON.stringify({ loops: lastMessage.result.loops.length, maskPixels: lastMessage.result.mask.reduce((a, b) => a + b, 0) }));


// Caso adversarial: checkerboard genera miles de componentes. El worker debe
// rechazarlo antes de devolver una estructura gigantesca al hilo principal.
lastMessage = null;
const cw = 64, ch = 64;
const checker = new Uint8ClampedArray(cw * ch * 4);
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const i = (y * cw + x) * 4;
    const black = ((x + y) & 1) === 0;
    checker[i] = checker[i + 1] = checker[i + 2] = black ? 0 : 255;
    checker[i + 3] = 255;
  }
}
context.self.onmessage({ data: {
  id: 2,
  pixels: checker,
  width: cw,
  height: ch,
  options: { threshold: 128, invert: false, noiseArea: 0, smoothStrength: 0, simplifyAmount: 0, maxContours: 100, maxPoints: 1000 }
}});
if (lastMessage?.ok !== false || !/contornos|complejo/i.test(lastMessage?.error || '')) {
  throw new Error('Vector worker did not reject a pathological contour count');
}
console.log(JSON.stringify({ pathologicalVectorRejected: true }));
