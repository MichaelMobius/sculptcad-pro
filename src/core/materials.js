import * as THREE from 'three';

let materialUI = null;

export function setMaterialUI(ui) {
  materialUI = ui;
}

export function makeTextureCanvas(color = '#e6c5b5', size = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Uniforme desde el inicio: evita que una grilla de textura marque costuras UV.
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 12;
  tex.needsUpdate = true;
  return { canvas, ctx, texture: tex };
}

export function createMaterial(textureSet) {
  const roughness = parseFloat(materialUI?.roughness?.value ?? 0.72);
  const metalness = parseFloat(materialUI?.metalness?.value ?? 0.04);
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: textureSet.texture,
    roughness,
    metalness,
    vertexColors: true,
    flatShading: false,
    side: THREE.DoubleSide
  });
}

export function disposeMaterial(material) {
  if (!material) return;
  if (Array.isArray(material)) {
    material.forEach(disposeMaterial);
    return;
  }
  if (material.map) material.map.dispose?.();
  material.dispose?.();
}

export function disposeTextureSet(textureSet) {
  textureSet?.texture?.dispose?.();
}

export function sampleCanvasBaseColor(texCanvas) {
  const ctx = texCanvas.getContext('2d');
  const data = ctx.getImageData(0, 0, 1, 1).data;
  return '#' + [data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}


const MATCAP_PROFILES = {
  clay: {
    base: [214, 166, 137],
    shadow: [72, 45, 40],
    highlight: [255, 237, 210],
    rim: [158, 87, 75]
  },
  grey: {
    base: [178, 182, 184],
    shadow: [45, 49, 54],
    highlight: [248, 250, 248],
    rim: [106, 116, 128]
  },
  red: {
    base: [198, 94, 78],
    shadow: [72, 30, 35],
    highlight: [255, 205, 174],
    rim: [140, 42, 50]
  }
};

const matcapTextureCache = new Map();

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function mixColor(a, b, t) {
  const k = clamp01(t);
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k
  ];
}

function addColor(a, b, t) {
  const k = clamp01(t);
  return [
    Math.min(255, a[0] + b[0] * k),
    Math.min(255, a[1] + b[1] * k),
    Math.min(255, a[2] + b[2] * k)
  ];
}

export function getMatcapTexture(profileName = 'clay') {
  const key = MATCAP_PROFILES[profileName] ? profileName : 'clay';
  if (matcapTextureCache.has(key)) return matcapTextureCache.get(key);

  const profile = MATCAP_PROFILES[key];
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const ny = 1 - (y / (size - 1)) * 2;
      const r2 = nx * nx + ny * ny;
      const i = (y * size + x) * 4;

      if (r2 > 1.0) {
        data[i] = profile.shadow[0];
        data[i + 1] = profile.shadow[1];
        data[i + 2] = profile.shadow[2];
        data[i + 3] = 255;
        continue;
      }

      const z = Math.sqrt(Math.max(0, 1 - r2));
      const light1 = clamp01(nx * -0.35 + ny * 0.55 + z * 0.78);
      const light2 = clamp01(nx * 0.55 + ny * -0.25 + z * 0.55);
      const rim = Math.pow(clamp01(Math.sqrt(r2)), 2.2);
      const spec = Math.pow(clamp01(nx * -0.45 + ny * 0.62 + z * 0.68), 34);
      const core = 0.18 + 0.72 * light1 + 0.10 * light2;

      let color = mixColor(profile.shadow, profile.base, core);
      color = mixColor(color, profile.rim, rim * 0.18);
      color = addColor(color, profile.highlight, spec * 0.85);

      data[i] = Math.round(color[0]);
      data[i + 1] = Math.round(color[1]);
      data[i + 2] = Math.round(color[2]);
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  matcapTextureCache.set(key, tex);
  return tex;
}

export function createMatcapMaterial(profileName = 'clay') {
  return new THREE.MeshMatcapMaterial({
    color: 0xffffff,
    matcap: getMatcapTexture(profileName),
    vertexColors: true,
    flatShading: false,
    side: THREE.DoubleSide
  });
}

export function disposeRecordMaterials(record) {
  if (!record) return;
  const materials = new Set();
  if (record.pbrMaterial) materials.add(record.pbrMaterial);
  if (record.mesh?.material) materials.add(record.mesh.material);
  if (record.matcapMaterials instanceof Map) {
    for (const mat of record.matcapMaterials.values()) materials.add(mat);
    record.matcapMaterials.clear();
  }
  for (const mat of materials) disposeMaterial(mat);
}
