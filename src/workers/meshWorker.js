// Worker de operaciones pesadas de malla.
// Mantiene el hilo principal libre durante subdivisión/remesh/relajación.

function getTriangleIndices(index, vertexCount) {
  if (index && index.length) return index;
  const sequential = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) sequential[i] = i;
  return sequential;
}

function euclideanModulo(n, m) {
  return ((n % m) + m) % m;
}

function subdivideData(data) {
  const positions = data.positions;
  const uvs = data.uvs;
  const masks = data.masks;
  const vertexCount = positions.length / 3;
  const sourceIndices = getTriangleIndices(data.index, vertexCount);

  const vertices = Array.from(positions);
  const nextUvs = uvs ? Array.from(uvs) : null;
  const nextMasks = masks ? Array.from(masks) : null;
  const newIndices = [];
  const midpointCache = new Map();
  const edgeKeyBase = vertexCount + 1;

  const addMidpoint = (a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * edgeKeyBase + hi;
    if (midpointCache.has(key)) return midpointCache.get(key);

    const ia = a * 3;
    const ib = b * 3;
    const next = vertices.length / 3;
    vertices.push(
      (vertices[ia] + vertices[ib]) * 0.5,
      (vertices[ia + 1] + vertices[ib + 1]) * 0.5,
      (vertices[ia + 2] + vertices[ib + 2]) * 0.5
    );

    if (nextUvs) {
      const ua = a * 2;
      const ub = b * 2;
      let u0 = nextUvs[ua];
      let u1 = nextUvs[ub];
      if (Math.abs(u0 - u1) > 0.5) {
        if (u0 < u1) u0 += 1;
        else u1 += 1;
      }
      nextUvs.push(euclideanModulo((u0 + u1) * 0.5, 1), (nextUvs[ua + 1] + nextUvs[ub + 1]) * 0.5);
    }

    if (nextMasks) nextMasks.push((nextMasks[a] + nextMasks[b]) * 0.5);
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

  return {
    positions: new Float32Array(vertices),
    uvs: nextUvs ? new Float32Array(nextUvs) : null,
    masks: nextMasks ? new Float32Array(nextMasks) : null,
    index: new Uint32Array(newIndices)
  };
}

function buildWeldedTopology(data, epsilon = null) {
  const positions = data.positions;
  const vertexCount = positions.length / 3;
  const indices = getTriangleIndices(data.index, vertexCount);
  const vertexToGroup = new Uint32Array(vertexCount);
  const groups = [];
  const buckets = new Map();
  if (!(epsilon > 0)) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    epsilon = Math.max(1e-9, diagonal * 1e-7);
  }
  const inv = 1 / Math.max(epsilon, 1e-12);

  const getBucket = (qx, qy, qz) => buckets.get(qx)?.get(qy)?.get(qz);
  const setBucket = (qx, qy, qz, value) => {
    let byY = buckets.get(qx);
    if (!byY) buckets.set(qx, byY = new Map());
    let byZ = byY.get(qy);
    if (!byZ) byY.set(qy, byZ = new Map());
    byZ.set(qz, value);
  };

  for (let i = 0; i < vertexCount; i++) {
    const k = i * 3;
    const qx = Math.round(positions[k] * inv);
    const qy = Math.round(positions[k + 1] * inv);
    const qz = Math.round(positions[k + 2] * inv);
    let groupId = getBucket(qx, qy, qz);
    if (groupId === undefined) {
      groupId = groups.length;
      setBucket(qx, qy, qz, groupId);
      groups.push({ vertices: [], neighbors: new Set() });
    }
    vertexToGroup[i] = groupId;
    groups[groupId].vertices.push(i);
  }

  const addNeighbor = (a, b) => {
    const ga = vertexToGroup[a];
    const gb = vertexToGroup[b];
    if (ga === gb) return;
    groups[ga].neighbors.add(gb);
    groups[gb].neighbors.add(ga);
  };

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    addNeighbor(a, b); addNeighbor(b, c); addNeighbor(c, a);
  }

  return {
    vertexToGroup,
    groups: groups.map((group) => ({ vertices: group.vertices, neighbors: Array.from(group.neighbors) }))
  };
}

function laplacianWeldedStep(positions, topology, factor) {
  const src = new Float32Array(positions);
  const groupCenters = new Float64Array(topology.groups.length * 3);

  for (let g = 0; g < topology.groups.length; g++) {
    const vertices = topology.groups[g].vertices;
    if (!vertices.length) continue;
    let x = 0, y = 0, z = 0;
    for (const vertex of vertices) {
      const k = vertex * 3;
      x += src[k]; y += src[k + 1]; z += src[k + 2];
    }
    const inv = 1 / vertices.length;
    const base = g * 3;
    groupCenters[base] = x * inv;
    groupCenters[base + 1] = y * inv;
    groupCenters[base + 2] = z * inv;
  }

  for (let g = 0; g < topology.groups.length; g++) {
    const group = topology.groups[g];
    if (!group.neighbors.length) continue;
    let ax = 0, ay = 0, az = 0;
    for (const neighbor of group.neighbors) {
      const k = neighbor * 3;
      ax += groupCenters[k];
      ay += groupCenters[k + 1];
      az += groupCenters[k + 2];
    }
    const inv = 1 / group.neighbors.length;
    ax *= inv; ay *= inv; az *= inv;
    const base = g * 3;
    const nx = groupCenters[base] + (ax - groupCenters[base]) * factor;
    const ny = groupCenters[base + 1] + (ay - groupCenters[base + 1]) * factor;
    const nz = groupCenters[base + 2] + (az - groupCenters[base + 2]) * factor;
    for (const vertex of group.vertices) {
      const k = vertex * 3;
      positions[k] = nx;
      positions[k + 1] = ny;
      positions[k + 2] = nz;
    }
  }
}

function relaxData(data, iterations = 4) {
  const result = {
    positions: new Float32Array(data.positions),
    uvs: data.uvs ? new Float32Array(data.uvs) : null,
    masks: data.masks ? new Float32Array(data.masks) : null,
    index: data.index ? new Uint32Array(data.index) : null
  };
  // Weld lógico: STL y otras geometrías no indexadas duplican vértices por cara.
  // Relajar por índice separaba esos duplicados y abría grietas. Aquí los vértices
  // coincidentes comparten una posición de grupo, conservando las costuras UV.
  const topology = buildWeldedTopology(result);
  for (let i = 0; i < iterations; i++) {
    laplacianWeldedStep(result.positions, topology, 0.42);
    laplacianWeldedStep(result.positions, topology, -0.36);
  }
  return result;
}


function cloneData(data) {
  return {
    positions: new Float32Array(data.positions),
    uvs: data.uvs ? new Float32Array(data.uvs) : null,
    masks: data.masks ? new Float32Array(data.masks) : null,
    index: data.index ? new Uint32Array(data.index) : null
  };
}

function computeVertexNormalBins(positions, indices) {
  const vertexCount = positions.length / 3;
  const sums = new Float32Array(vertexCount * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const ak = a * 3, bk = b * 3, ck = c * 3;
    const abx = positions[bk] - positions[ak];
    const aby = positions[bk + 1] - positions[ak + 1];
    const abz = positions[bk + 2] - positions[ak + 2];
    const acx = positions[ck] - positions[ak];
    const acy = positions[ck + 1] - positions[ak + 1];
    const acz = positions[ck + 2] - positions[ak + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const vertex of [a, b, c]) {
      const k = vertex * 3;
      sums[k] += nx; sums[k + 1] += ny; sums[k + 2] += nz;
    }
  }

  const bins = new Int8Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const k = i * 3;
    const length = Math.hypot(sums[k], sums[k + 1], sums[k + 2]) || 1;
    // Cinco niveles por componente. Las paredes enfrentadas quedan en clusters
    // distintos aunque estén dentro de la misma celda espacial.
    bins[k] = Math.round((sums[k] / length) * 2);
    bins[k + 1] = Math.round((sums[k + 1] / length) * 2);
    bins[k + 2] = Math.round((sums[k + 2] / length) * 2);
  }
  return bins;
}

function orientedTriangleKey(a, b, c) {
  // Las rotaciones cíclicas representan la misma cara y el mismo winding.
  // La orientación opuesta conserva una clave diferente y no se descarta.
  const k0 = `${a}_${b}_${c}`;
  const k1 = `${b}_${c}_${a}`;
  const k2 = `${c}_${a}_${b}`;
  return k0 < k1 ? (k0 < k2 ? k0 : k2) : (k1 < k2 ? k1 : k2);
}

function reduceData(data, targetFraction = 0.65) {
  const positions = data.positions;
  const uvs = data.uvs;
  const masks = data.masks;
  const vertexCount = positions.length / 3;
  if (vertexCount < 80) return cloneData(data);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const k = i * 3;
    const x = positions[k], y = positions[k + 1], z = positions[k + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const sx = Math.max(maxX - minX, 1e-6);
  const sy = Math.max(maxY - minY, 1e-6);
  const sz = Math.max(maxZ - minZ, 1e-6);
  const fraction = Math.max(0.12, Math.min(0.92, targetFraction));
  const indices = getTriangleIndices(data.index, vertexCount);
  const normalBins = computeVertexNormalBins(positions, indices);

  // Vertex clustering progresivo. Se intenta con varias resoluciones hasta
  // lograr una reducción útil sin bloquear el hilo principal.
  for (let attempt = 0; attempt < 4; attempt++) {
    const desiredClusters = Math.max(24, vertexCount * fraction * Math.pow(0.78, attempt));
    const volumeScale = Math.cbrt((desiredClusters * sx * sy * sz) / Math.max(1e-12, sx * sy * sz));
    const base = Math.max(2, volumeScale);
    const nx = Math.max(2, Math.round(base * sx / Math.cbrt(sx * sy * sz)));
    const ny = Math.max(2, Math.round(base * sy / Math.cbrt(sx * sy * sz)));
    const nz = Math.max(2, Math.round(base * sz / Math.cbrt(sx * sy * sz)));

    const clusters = new Map();
    const remap = new Uint32Array(vertexCount);
    const accum = [];

    for (let i = 0; i < vertexCount; i++) {
      const k = i * 3;
      const qx = Math.min(nx - 1, Math.max(0, Math.floor(((positions[k] - minX) / sx) * nx)));
      const qy = Math.min(ny - 1, Math.max(0, Math.floor(((positions[k + 1] - minY) / sy) * ny)));
      const qz = Math.min(nz - 1, Math.max(0, Math.floor(((positions[k + 2] - minZ) / sz) * nz)));
      // Conserva las dos caras de una costura UV para no mezclar U≈0 con U≈1.
      const seam = uvs ? (uvs[i * 2] < 0.035 ? -1 : uvs[i * 2] > 0.965 ? 1 : 0) : 0;
      const nk = i * 3;
      const key = `${qx},${qy},${qz},${seam},${normalBins[nk]},${normalBins[nk + 1]},${normalBins[nk + 2]}`;
      let clusterId = clusters.get(key);
      if (clusterId === undefined) {
        clusterId = accum.length;
        clusters.set(key, clusterId);
        accum.push({ x: 0, y: 0, z: 0, u: 0, v: 0, mask: 0, count: 0 });
      }
      remap[i] = clusterId;
      const a = accum[clusterId];
      a.x += positions[k]; a.y += positions[k + 1]; a.z += positions[k + 2];
      if (uvs) { a.u += uvs[i * 2]; a.v += uvs[i * 2 + 1]; }
      if (masks) a.mask += masks[i];
      a.count++;
    }

    const nextPositions = new Float32Array(accum.length * 3);
    const nextUvs = uvs ? new Float32Array(accum.length * 2) : null;
    const nextMasks = masks ? new Float32Array(accum.length) : null;
    for (let i = 0; i < accum.length; i++) {
      const a = accum[i];
      const inv = 1 / a.count;
      nextPositions[i * 3] = a.x * inv;
      nextPositions[i * 3 + 1] = a.y * inv;
      nextPositions[i * 3 + 2] = a.z * inv;
      if (nextUvs) {
        nextUvs[i * 2] = euclideanModulo(a.u * inv, 1);
        nextUvs[i * 2 + 1] = a.v * inv;
      }
      if (nextMasks) nextMasks[i] = a.mask * inv;
    }

    const nextIndex = [];
    const triangleSet = new Set();
    for (let i = 0; i < indices.length; i += 3) {
      const a = remap[indices[i]];
      const b = remap[indices[i + 1]];
      const c = remap[indices[i + 2]];
      if (a === b || b === c || c === a) continue;
      const triangleKey = orientedTriangleKey(a, b, c);
      if (triangleSet.has(triangleKey)) continue;
      triangleSet.add(triangleKey);
      nextIndex.push(a, b, c);
    }

    if (nextIndex.length >= 12 && accum.length < vertexCount * 0.96) {
      return {
        positions: nextPositions,
        uvs: nextUvs,
        masks: nextMasks,
        index: new Uint32Array(nextIndex)
      };
    }
  }

  return cloneData(data);
}

function byteLengthOf(data) {
  return (data.positions?.byteLength || 0) + (data.uvs?.byteLength || 0) + (data.masks?.byteLength || 0) + (data.index?.byteLength || 0);
}

function transferListFor(data) {
  return [data.positions, data.uvs, data.masks, data.index]
    .filter(Boolean)
    .map((typed) => typed.buffer);
}

self.onmessage = (event) => {
  const { id, op, geometry, options = {} } = event.data || {};
  try {
    const startBytes = byteLengthOf(geometry);
    let result;
    if (op === 'subdivide') {
      result = subdivideData(geometry);
    } else if (op === 'relax') {
      result = relaxData(geometry, options.iterations ?? 6);
    } else if (op === 'softRemesh') {
      const base = options.subdivide ? subdivideData(geometry) : geometry;
      result = relaxData(base, options.relaxIterations ?? 5);
    } else if (op === 'reduce') {
      result = reduceData(geometry, options.targetFraction ?? 0.65);
    } else {
      throw new Error(`Operación de worker no soportada: ${op}`);
    }
    self.postMessage({ id, ok: true, result, stats: { startBytes, endBytes: byteLengthOf(result) } }, transferListFor(result));
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
};
