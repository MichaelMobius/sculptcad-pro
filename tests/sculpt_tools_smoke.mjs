import assert from 'node:assert/strict';
import { applySmoothTool } from '../src/sculpt/tools/SmoothTool.js';
import { applyCreaseTool } from '../src/sculpt/tools/CreaseTool.js';

class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lengthSq() { return this.dot(this); }
  normalize() { const l = Math.sqrt(this.lengthSq()) || 1; return this.multiplyScalar(1 / l); }
}

const THREE = { Vector3: Vec3 };
const smoothItem = { effectiveFalloff: 1, groupId: 0, normal: new Vec3(0, 0, 1) };
const smoothCtx = {
  mesh: {}, topology: {}, smoothStrength: 0.6, THREE,
  smoothPreserveVolume: true, smoothTangent: false,
  computeNeighborAverageWorld: (_mesh, _topology, _group, target) => {
    target.x = 0; target.y = 0; target.z = 0.5; return target;
  }
};
const smoothPosition = new Vec3(0, 0, 1);
assert.equal(applySmoothTool(smoothPosition, smoothItem, smoothCtx), true);
assert.ok(smoothPosition.z < 0.8, `expected visible smoothing, got z=${smoothPosition.z}`);
assert.ok(smoothPosition.z > 0.7, `volume preservation should reduce shrink, got z=${smoothPosition.z}`);

const tangentPosition = new Vec3(0, 0, 1);
applySmoothTool(tangentPosition, smoothItem, { ...smoothCtx, smoothTangent: true });
assert.equal(tangentPosition.z, 1, 'tangent-only mode should reject a purely normal displacement');

const creasePosition = new Vec3(0.1, 0, 0);
const creaseItem = { effectiveFalloff: 1, refWorld: new Vec3(0.1, 0, 0) };
applyCreaseTool(creasePosition, creaseItem, {
  brushCenter: new Vec3(0, 0, 0),
  planeNormal: new Vec3(0, 0, 1),
  negative: false,
  strength: 0.03,
  radius: 1,
  creasePinch: 1,
  creaseDepth: 1
});
assert.ok(creasePosition.x < 0.1, 'crease should pinch toward the brush center');
assert.ok(creasePosition.z < -0.04, `crease depth should be visible, got z=${creasePosition.z}`);

console.log(JSON.stringify({
  smoothZ: Number(smoothPosition.z.toFixed(4)),
  tangentZ: tangentPosition.z,
  creaseX: Number(creasePosition.x.toFixed(4)),
  creaseZ: Number(creasePosition.z.toFixed(4))
}));
