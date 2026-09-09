import * as THREE from 'three';

function getTriangleIndices(geometry) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!position) return new Uint32Array(0);
  if (index) return index.array;
  const sequential = new Uint32Array(position.count);
  for (let i = 0; i < position.count; i++) sequential[i] = i;
  return sequential;
}

export function geometryStats(geometry) {
  const position = geometry?.getAttribute?.('position');
  const index = geometry?.getIndex?.();
  return {
    vertices: position?.count || 0,
    triangles: Math.floor((index?.count ?? position?.count ?? 0) / 3)
  };
}

function copyOriginalAttributes(geometry) {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const mask = geometry.userData?.maskWeights;
  const vertices = [];
  const uvs = [];
  const masks = [];

  for (let i = 0; i < position.count; i++) {
    vertices.push(position.getX(i), position.getY(i), position.getZ(i));
    if (uv) uvs.push(uv.getX(i), uv.getY(i));
    if (mask && mask.length === position.count) masks.push(mask[i]);
  }

  return { vertices, uvs, masks, hasUv: !!uv, hasMask: !!mask && mask.length === position.count };
}

export function subdivideGeometry(geometry) {
  const source = geometry.clone();
  const position = source.getAttribute('position');
  if (!position) return source;

  const sourceIndices = getTriangleIndices(source);
  const { vertices, uvs, masks, hasUv, hasMask } = copyOriginalAttributes(source);
  const newIndices = [];
  const midpointCache = new Map();

  const addMidpoint = (a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}_${hi}`;
    const cached = midpointCache.get(key);
    if (cached !== undefined) return cached;

    const ia = a * 3;
    const ib = b * 3;
    const next = vertices.length / 3;
    vertices.push(
      (vertices[ia] + vertices[ib]) * 0.5,
      (vertices[ia + 1] + vertices[ib + 1]) * 0.5,
      (vertices[ia + 2] + vertices[ib + 2]) * 0.5
    );

    if (hasUv) {
      const ua = a * 2;
      const ub = b * 2;
      let u0 = uvs[ua];
      let u1 = uvs[ub];
      // Evita que una arista que cruza la costura UV promedie 0.99 con 0.01
      // y cree una pincelada que atraviesa toda la textura.
      if (Math.abs(u0 - u1) > 0.5) {
        if (u0 < u1) u0 += 1;
        else u1 += 1;
      }
      uvs.push(THREE.MathUtils.euclideanModulo((u0 + u1) * 0.5, 1), (uvs[ua + 1] + uvs[ub + 1]) * 0.5);
    }

    if (hasMask) masks.push((masks[a] + masks[b]) * 0.5);
    midpointCache.set(key, next);
    return next;
  };

  for (let i = 0; i < sourceIndices.length; i += 3) {
    const a = sourceIndices[i];
    const b = sourceIndices[i + 1];
    const c = sourceIndices[i + 2];
    if (a === undefined || b === undefined || c === undefined) continue;

    const ab = addMidpoint(a, b);
    const bc = addMidpoint(b, c);
    const ca = addMidpoint(c, a);

    newIndices.push(
      a, ab, ca,
      ab, b, bc,
      ca, bc, c,
      ab, bc, ca
    );
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  if (hasUv) result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  result.setIndex(newIndices);
  if (hasMask) result.userData.maskWeights = new Float32Array(masks);
  result.computeVertexNormals();
  result.computeBoundingBox();
  result.computeBoundingSphere();
  source.dispose();
  return result;
}

function buildVertexNeighbors(geometry) {
  const position = geometry.getAttribute('position');
  const indices = getTriangleIndices(geometry);
  const neighbors = Array.from({ length: position.count }, () => new Set());
  const add = (a, b) => {
    if (a === b || a < 0 || b < 0 || a >= position.count || b >= position.count) return;
    neighbors[a].add(b);
    neighbors[b].add(a);
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    add(a, b); add(b, c); add(c, a);
  }
  return neighbors.map((set) => Array.from(set));
}

function laplacianStep(position, neighbors, factor) {
  const src = new Float32Array(position.array);
  const dst = position.array;
  for (let i = 0; i < position.count; i++) {
    const list = neighbors[i];
    if (!list || !list.length) continue;
    let ax = 0, ay = 0, az = 0;
    for (const j of list) {
      const k = j * 3;
      ax += src[k];
      ay += src[k + 1];
      az += src[k + 2];
    }
    const inv = 1 / list.length;
    const base = i * 3;
    ax *= inv; ay *= inv; az *= inv;
    dst[base] += (ax - src[base]) * factor;
    dst[base + 1] += (ay - src[base + 1]) * factor;
    dst[base + 2] += (az - src[base + 2]) * factor;
  }
  position.needsUpdate = true;
}

export function relaxGeometry(geometry, iterations = 4) {
  const result = geometry.clone();
  const position = result.getAttribute('position');
  if (!position) return result;
  const neighbors = buildVertexNeighbors(result);

  // Suavizado tipo Taubin: una pasada positiva y una negativa reducen ruido
  // sin encoger tanto el volumen como un laplaciano común.
  for (let i = 0; i < iterations; i++) {
    laplacianStep(position, neighbors, 0.42);
    laplacianStep(position, neighbors, -0.36);
  }

  result.computeVertexNormals();
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

export function softRemeshGeometry(geometry, { subdivide = true, relaxIterations = 5 } = {}) {
  const base = subdivide ? subdivideGeometry(geometry) : geometry.clone();
  const relaxed = relaxGeometry(base, relaxIterations);
  base.dispose();
  return relaxed;
}


function buildWeldedVertexIds(position, epsilon = null) {
  const ids = new Uint32Array(position.count);
  const buckets = new Map();
  if (!(epsilon > 0)) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    epsilon = Math.max(1e-9, diagonal * 1e-7);
  }
  const inv = 1 / Math.max(epsilon, 1e-12);
  let nextId = 0;
  const get = (x, y, z) => buckets.get(x)?.get(y)?.get(z);
  const set = (x, y, z, value) => {
    let byY = buckets.get(x);
    if (!byY) buckets.set(x, byY = new Map());
    let byZ = byY.get(y);
    if (!byZ) byY.set(y, byZ = new Map());
    byZ.set(z, value);
  };
  for (let i = 0; i < position.count; i++) {
    const x = Math.round(position.getX(i) * inv);
    const y = Math.round(position.getY(i) * inv);
    const z = Math.round(position.getZ(i) * inv);
    let id = get(x, y, z);
    if (id === undefined) { id = nextId++; set(x, y, z, id); }
    ids[i] = id;
  }
  return { ids, count: nextId };
}

export function localSubdivideGeometry(geometry, {
  center = new THREE.Vector3(),
  centers = null,
  radius = 1,
  maxEdgeLength = 0.08,
  maxTriangles = 900,
  boundaryExpansion = 1,
  candidateTriangles = null
} = {}) {
  const position = geometry.getAttribute('position');
  if (!position) return { geometry: null, changed: false, splitTriangles: 0, addedTriangles: 0 };

  const sourceIndices = getTriangleIndices(geometry);
  const triangleCount = Math.floor(sourceIndices.length / 3);
  if (!triangleCount) return { geometry: null, changed: false, splitTriangles: 0, addedTriangles: 0 };

  // Dynamic Topology recibe desde main.js los triángulos cercanos obtenidos con
  // el hash espacial del pincel. Así evitamos clonar/copiar todos los atributos
  // antes de saber si realmente hay una arista que necesita subdivisión.
  let scanTriangles;
  if (candidateTriangles !== null && candidateTriangles !== undefined) {
    const unique = new Set();
    for (const tri of candidateTriangles) {
      if (Number.isInteger(tri) && tri >= 0 && tri < triangleCount) unique.add(tri);
    }
    scanTriangles = Array.from(unique);
  } else {
    scanTriangles = Array.from({ length: triangleCount }, (_, tri) => tri);
  }
  if (!scanTriangles.length) return { geometry: null, changed: false, splitTriangles: 0, addedTriangles: 0 };

  const candidates = [];
  const selected = new Set();
  const edgeToTriangles = new Map();
  // Para STL/no-indexed, caras vecinas suelen tener índices distintos aunque
  // compartan exactamente la misma arista. Las decisiones rojo-verde usan IDs
  // soldados por posición para que ambos lados de la costura se refinen juntos.
  const welded = buildWeldedVertexIds(position);
  const weldedBase = welded.count + 1;
  const actualBase = position.count + 1;
  const edgeKey = (a, b) => {
    const wa = welded.ids[a];
    const wb = welded.ids[b];
    const lo = Math.min(wa, wb);
    const hi = Math.max(wa, wb);
    return lo * weldedBase + hi;
  };
  const actualEdgeKey = (a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return lo * actualBase + hi;
  };
  const edgeLenSq = (a, b) => {
    const dx = position.getX(a) - position.getX(b);
    const dy = position.getY(a) - position.getY(b);
    const dz = position.getZ(a) - position.getZ(b);
    return dx * dx + dy * dy + dz * dz;
  };

  const radiusSq = radius * radius;
  const maxEdgeSq = maxEdgeLength * maxEdgeLength;
  const activeCenters = Array.isArray(centers) && centers.length ? centers : [center];

  for (const tri of scanTriangles) {
    const i = tri * 3;
    const a = sourceIndices[i];
    const b = sourceIndices[i + 1];
    const c = sourceIndices[i + 2];
    if (a === undefined || b === undefined || c === undefined) continue;

    for (const [e0, e1] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(e0, e1);
      let list = edgeToTriangles.get(key);
      if (!list) edgeToTriangles.set(key, list = []);
      list.push(tri);
    }

    const cx = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
    const cy = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
    const cz = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
    let distSq = Infinity;
    let centerIndex = 0;
    for (let ci = 0; ci < activeCenters.length; ci++) {
      const activeCenter = activeCenters[ci];
      const dx = cx - activeCenter.x;
      const dy = cy - activeCenter.y;
      const dz = cz - activeCenter.z;
      const candidateDistSq = dx * dx + dy * dy + dz * dz;
      if (candidateDistSq < distSq) {
        distSq = candidateDistSq;
        centerIndex = ci;
      }
    }
    const longestSq = Math.max(edgeLenSq(a, b), edgeLenSq(b, c), edgeLenSq(c, a));

    if (distSq <= radiusSq && longestSq > maxEdgeSq) {
      candidates.push({ tri, distSq, longestSq, centerIndex });
    }
  }

  if (!candidates.length) return { geometry: null, changed: false, splitTriangles: 0, addedTriangles: 0 };

  candidates.sort((a, b) => a.distSq - b.distSq || b.longestSq - a.longestSq);
  if (activeCenters.length <= 1) {
    for (const item of candidates.slice(0, Math.max(1, maxTriangles))) selected.add(item.tri);
  } else {
    // Reparte el presupuesto de triángulos entre las regiones simétricas. Un
    // único sort global podía consumir el límite en el lado original y dejar
    // los reflejos con menor densidad.
    const perCenter = Array.from({ length: activeCenters.length }, () => []);
    for (const item of candidates) perCenter[item.centerIndex]?.push(item);
    let cursor = 0;
    while (selected.size < Math.max(1, maxTriangles)) {
      let added = false;
      for (const bucket of perCenter) {
        const item = bucket[cursor];
        if (!item) continue;
        selected.add(item.tri);
        added = true;
        if (selected.size >= maxTriangles) break;
      }
      if (!added) break;
      cursor++;
    }
  }

  // La expansión sigue siendo una aproximación local, no un refinamiento
  // rojo-verde completo. Al menos ahora opera solo sobre el vecindario que ya
  // entregó el índice espacial, en lugar de reconstruir información global.
  for (let pass = 0; pass < boundaryExpansion; pass++) {
    const additions = [];
    for (const tri of selected) {
      const i = tri * 3;
      const a = sourceIndices[i];
      const b = sourceIndices[i + 1];
      const c = sourceIndices[i + 2];
      for (const [e0, e1] of [[a, b], [b, c], [c, a]]) {
        if (edgeLenSq(e0, e1) < maxEdgeSq * 0.55) continue;
        const list = edgeToTriangles.get(edgeKey(e0, e1)) || [];
        for (const neighborTri of list) if (!selected.has(neighborTri)) additions.push(neighborTri);
      }
    }
    for (const tri of additions.slice(0, Math.max(0, maxTriangles - selected.size))) selected.add(tri);
  }

  if (!selected.size) return { geometry: null, changed: false, splitTriangles: 0, addedTriangles: 0 };

  // Refinamiento rojo-verde: las caras seleccionadas dividen sus tres aristas
  // (rojo). Cualquier cara vecina que comparta una o dos de esas aristas se
  // divide con un patrón conforme (verde). Así no quedan T-junctions en el borde.
  const splitEdges = new Set();
  for (const tri of selected) {
    const i = tri * 3;
    const a = sourceIndices[i];
    const b = sourceIndices[i + 1];
    const c = sourceIndices[i + 2];
    splitEdges.add(edgeKey(a, b));
    splitEdges.add(edgeKey(b, c));
    splitEdges.add(edgeKey(c, a));
  }

  // Solo cuando hay un parche real copiamos los buffers globales necesarios
  // para producir una BufferGeometry nueva. Se elimina así el peor caso de
  // copiar la malla completa en cada comprobación fallida del pincel.
  const { vertices, uvs, masks, hasUv, hasMask } = copyOriginalAttributes(geometry);
  const newIndices = [];
  const midpointCache = new Map();

  const addMidpoint = (a, b) => {
    const key = actualEdgeKey(a, b);
    const cached = midpointCache.get(key);
    if (cached !== undefined) return cached;

    const ia = a * 3;
    const ib = b * 3;
    const next = vertices.length / 3;
    vertices.push(
      (vertices[ia] + vertices[ib]) * 0.5,
      (vertices[ia + 1] + vertices[ib + 1]) * 0.5,
      (vertices[ia + 2] + vertices[ib + 2]) * 0.5
    );

    if (hasUv) {
      const ua = a * 2;
      const ub = b * 2;
      let u0 = uvs[ua];
      let u1 = uvs[ub];
      if (Math.abs(u0 - u1) > 0.5) {
        if (u0 < u1) u0 += 1;
        else u1 += 1;
      }
      uvs.push(THREE.MathUtils.euclideanModulo((u0 + u1) * 0.5, 1), (uvs[ua + 1] + uvs[ub + 1]) * 0.5);
    }

    if (hasMask) masks.push((masks[a] + masks[b]) * 0.5);
    midpointCache.set(key, next);
    return next;
  };

  for (let tri = 0; tri < triangleCount; tri++) {
    const i = tri * 3;
    const a = sourceIndices[i];
    const b = sourceIndices[i + 1];
    const c = sourceIndices[i + 2];
    if (a === undefined || b === undefined || c === undefined) continue;

    const splitAB = splitEdges.has(edgeKey(a, b));
    const splitBC = splitEdges.has(edgeKey(b, c));
    const splitCA = splitEdges.has(edgeKey(c, a));
    const splitCount = Number(splitAB) + Number(splitBC) + Number(splitCA);

    if (splitCount === 0) {
      newIndices.push(a, b, c);
      continue;
    }

    const ab = splitAB ? addMidpoint(a, b) : -1;
    const bc = splitBC ? addMidpoint(b, c) : -1;
    const ca = splitCA ? addMidpoint(c, a) : -1;

    if (splitCount === 1) {
      if (splitAB) newIndices.push(a, ab, c, ab, b, c);
      else if (splitBC) newIndices.push(b, bc, a, bc, c, a);
      else newIndices.push(c, ca, b, ca, a, b);
      continue;
    }

    if (splitCount === 2) {
      if (splitAB && splitBC) {
        newIndices.push(b, bc, ab, a, ab, bc, a, bc, c);
      } else if (splitAB && splitCA) {
        newIndices.push(a, ab, ca, b, c, ca, b, ca, ab);
      } else {
        newIndices.push(c, ca, bc, a, b, bc, a, bc, ca);
      }
      continue;
    }

    newIndices.push(
      a, ab, ca,
      ab, b, bc,
      ca, bc, c,
      ab, bc, ca
    );
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  if (hasUv) result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  result.setIndex(newIndices);
  if (hasMask) result.userData.maskWeights = new Float32Array(masks);
  // Normales, bounds y topología se calculan una sola vez en prepareGeometry().
  const addedTriangles = Math.max(0, Math.floor(newIndices.length / 3) - triangleCount);
  return { geometry: result, changed: true, splitTriangles: selected.size, addedTriangles };
}
