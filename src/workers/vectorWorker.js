// Vectorizador raster -> contornos. Mantiene thresholding, limpieza, suavizado
// y simplificación fuera del hilo principal.

function simplifyLoopPoints(loop) {
  if (!Array.isArray(loop) || loop.length < 4) return loop || [];
  const cleaned = [];
  for (const point of loop) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev || prev.x !== point.x || prev.y !== point.y) cleaned.push(point);
  }
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (first.x === last.x && first.y === last.y) cleaned.pop();
  }
  if (cleaned.length < 3) return cleaned;
  let changed = true;
  while (changed && cleaned.length >= 3) {
    changed = false;
    for (let i = 0; i < cleaned.length; i++) {
      const a = cleaned[(i - 1 + cleaned.length) % cleaned.length];
      const b = cleaned[i];
      const c = cleaned[(i + 1) % cleaned.length];
      const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
      if (collinear) {
        cleaned.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return cleaned;
}

function removeSmallMaskComponents(mask, width, height, minArea = 0) {
  if (!mask || minArea <= 1) return mask;
  const next = new Uint8Array(mask);
  const visited = new Uint8Array(mask.length);
  const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!next[start] || visited[start]) continue;
      const queue = [start];
      const component = [];
      visited[start] = 1;
      while (queue.length) {
        const idx = queue.pop();
        component.push(idx);
        const cx = idx % width;
        const cy = Math.floor(idx / width);
        for (const [dx, dy] of neighbors) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (!next[ni] || visited[ni]) continue;
          visited[ni] = 1;
          queue.push(ni);
        }
      }
      if (component.length < minArea) for (const idx of component) next[idx] = 0;
    }
  }
  return next;
}

function traceMaskLoops(mask, width, height, maxContours = Infinity) {
  const startMap = new Map();
  const edges = [];
  const addEdge = (x1, y1, x2, y2) => {
    const edge = { start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, used: false };
    edges.push(edge);
    const key = `${x1},${y1}`;
    const list = startMap.get(key) || [];
    list.push(edge);
    startMap.set(key, list);
  };
  const filled = (x, y) => x >= 0 && y >= 0 && x < width && y < height && !!mask[y * width + x];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!filled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!filled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!filled(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }
  const dirKey = (dx, dy) => `${dx},${dy}`;
  const directionOrder = ['1,0', '0,1', '-1,0', '0,-1'];
  const chooseNextEdge = (candidates, previous) => {
    if (!candidates?.length) return null;
    if (candidates.length === 1 || !previous) return candidates.find((edge) => !edge.used) || null;
    const prevDir = dirKey(previous.end.x - previous.start.x, previous.end.y - previous.start.y);
    const prevIndex = directionOrder.indexOf(prevDir);
    const preference = [1, 0, 3, 2].map((delta) => directionOrder[(prevIndex + delta + 4) % 4]);
    for (const key of preference) {
      const edge = candidates.find((candidate) => !candidate.used && dirKey(candidate.end.x - candidate.start.x, candidate.end.y - candidate.start.y) === key);
      if (edge) return edge;
    }
    return candidates.find((edge) => !edge.used) || null;
  };
  const loops = [];
  for (const edge of edges) {
    if (edge.used) continue;
    const loop = [{ x: edge.start.x, y: edge.start.y }];
    let current = edge;
    let guard = 0;
    while (current && !current.used && guard < edges.length + 10) {
      current.used = true;
      loop.push({ x: current.end.x, y: current.end.y });
      const start = loop[0];
      const end = current.end;
      if (end.x === start.x && end.y === start.y) break;
      current = chooseNextEdge(startMap.get(`${end.x},${end.y}`), current);
      guard++;
    }
    const simplified = simplifyLoopPoints(loop);
    if (simplified.length >= 3) {
      loops.push(simplified);
      if (loops.length > maxContours) throw new Error(`Demasiados contornos (más de ${maxContours.toLocaleString()}). Aumenta “Eliminar ruido” o simplifica la imagen.`);
    }
  }
  return loops;
}

function loopSignedArea(loop) {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function pointLineDistance(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function simplifyOpenPolyline(points, epsilon) {
  if (!Array.isArray(points) || points.length <= 2 || epsilon <= 0) return points ? points.slice() : [];
  let maxDistance = 0, index = -1;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const distance = pointLineDistance(points[i], first, last);
    if (distance > maxDistance) { maxDistance = distance; index = i; }
  }
  if (maxDistance > epsilon && index !== -1) {
    const left = simplifyOpenPolyline(points.slice(0, index + 1), epsilon);
    const right = simplifyOpenPolyline(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function simplifyClosedLoopRDP(points, epsilon) {
  if (!Array.isArray(points) || points.length <= 3 || epsilon <= 0) return points ? points.slice() : [];
  const open = points.concat([points[0]]);
  const simplified = simplifyOpenPolyline(open, epsilon);
  if (simplified.length > 1) simplified.pop();
  return simplifyLoopPoints(simplified);
}

function chaikinSmoothLoop(points, iterations = 0) {
  let current = points ? points.slice() : [];
  for (let iter = 0; iter < iterations; iter++) {
    if (current.length < 3) break;
    const next = [];
    for (let i = 0; i < current.length; i++) {
      const a = current[i], b = current[(i + 1) % current.length];
      next.push({ x: .75 * a.x + .25 * b.x, y: .75 * a.y + .25 * b.y });
      next.push({ x: .25 * a.x + .75 * b.x, y: .25 * a.y + .75 * b.y });
    }
    current = next;
  }
  return current;
}

function loopPerimeter(loop) {
  let total = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

function resampleLoop(loop, segmentLength = 3) {
  if (!Array.isArray(loop) || loop.length < 3 || segmentLength <= 0) return loop ? loop.slice() : [];
  const perimeter = loopPerimeter(loop);
  if (perimeter <= 0) return loop.slice();
  const count = Math.max(12, Math.min(600, Math.round(perimeter / segmentLength)));
  const cumulative = [0];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    cumulative.push(cumulative[cumulative.length - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cumulative[cumulative.length - 1];
  const samples = [];
  for (let s = 0; s < count; s++) {
    const target = (s / count) * total;
    let edgeIndex = 0;
    while (edgeIndex < loop.length && cumulative[edgeIndex + 1] < target) edgeIndex++;
    const edgeStart = cumulative[edgeIndex], edgeEnd = cumulative[edgeIndex + 1];
    const a = loop[edgeIndex % loop.length], b = loop[(edgeIndex + 1) % loop.length];
    const t = edgeEnd > edgeStart ? (target - edgeStart) / (edgeEnd - edgeStart) : 0;
    samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return samples;
}

function processRasterLoops(rawLoops, width, height, simplifyAmount, smoothAmount) {
  if (!rawLoops?.length) return [];
  const minDimension = Math.max(1, Math.min(width, height));
  const epsilon = simplifyAmount * (minDimension * .05);
  const resampleStep = 1.2 + (4.5 - 1.2) * smoothAmount;
  const smoothIterations = Math.max(0, Math.round(smoothAmount * 4));
  return rawLoops.map((loop) => {
    let next = simplifyLoopPoints(loop);
    if (epsilon > .01) next = simplifyClosedLoopRDP(next, epsilon);
    if (smoothAmount > .001) {
      next = resampleLoop(next, resampleStep);
      next = chaikinSmoothLoop(next, smoothIterations);
      if (epsilon > .01) next = simplifyClosedLoopRDP(next, epsilon * .45);
    }
    return simplifyLoopPoints(next);
  }).filter((loop) => loop.length >= 3 && Math.abs(loopSignedArea(loop)) >= 1);
}

function smoothMask(mask, width, height, strength = 0) {
  const passes = Math.max(0, Math.round((strength / 100) * 3));
  if (!mask || passes <= 0) return mask;
  let current = new Uint8Array(mask);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(current.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, samples = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox, ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            sum += current[ny * width + nx];
            samples++;
          }
        }
        next[y * width + x] = sum >= Math.ceil(samples * .5) ? 1 : 0;
      }
    }
    current = next;
  }
  return current;
}

function loopsToSvg(loops, width, height) {
  if (!loops?.length) return '';
  const chunks = [];
  for (const loop of loops) {
    if (!loop?.length) continue;
    let path = '';
    for (let i = 0; i < loop.length; i++) {
      const point = loop[i];
      path += `${i === 0 ? 'M' : 'L'} ${point.x} ${point.y} `;
    }
    chunks.push(path + 'Z');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n  <path d="${chunks.join(' ')}" fill="#000" fill-rule="evenodd"/>\n</svg>`;
}

self.onmessage = (event) => {
  const { id, pixels, width, height, options = {} } = event.data || {};
  try {
    const threshold = Number(options.threshold ?? 128);
    const invert = !!options.invert;
    const noiseArea = Number(options.noiseArea || 0);
    const smoothStrength = Number(options.smoothStrength || 0);
    const simplifyAmount = Number(options.simplifyAmount || 0) / 100;
    const smoothAmount = smoothStrength / 100;
    const maxContours = Math.max(100, Number(options.maxContours || 20000));
    const maxPoints = Math.max(1000, Number(options.maxPoints || 250000));
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) {
      const k = i * 4;
      const r = pixels[k], g = pixels[k + 1], b = pixels[k + 2], a = pixels[k + 3] / 255;
      const luminance = .2126 * r + .7152 * g + .0722 * b;
      const effective = luminance * a + 255 * (1 - a);
      mask[i] = (invert ? effective >= threshold : effective < threshold) ? 1 : 0;
    }
    const denoised = removeSmallMaskComponents(mask, width, height, noiseArea);
    const cleaned = smoothMask(denoised, width, height, smoothStrength);
    const rawLoops = traceMaskLoops(cleaned, width, height, maxContours);
    if (rawLoops.length > maxContours) {
      throw new Error(`Demasiados contornos (${rawLoops.length.toLocaleString()}). Aumenta “Eliminar ruido” o simplifica la imagen.`);
    }
    const loops = processRasterLoops(rawLoops, width, height, simplifyAmount, smoothAmount);
    let pointCount = 0;
    for (const loop of loops) {
      pointCount += loop.length;
      if (pointCount > maxPoints) {
        throw new Error(`Vector demasiado complejo (más de ${maxPoints.toLocaleString()} puntos). Aumenta la simplificación o elimina ruido.`);
      }
    }
    const svg = loopsToSvg(loops, width, height);
    self.postMessage({ id, ok: true, result: { mask: cleaned, loops, svg, pointCount } }, [cleaned.buffer]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
};
