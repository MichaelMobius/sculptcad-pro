const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

export const MATERIAL_PRESET_GROUPS = [
  {
    id: 'forged-chrome',
    label: 'Forged Chrome',
    presets: [
      { id: 'chrome-polished', label: 'Pulido', metalness: 0.98, roughness: 0.08, style: { kind: 'chrome', variant: 'polished' } },
      { id: 'chrome-soft', label: 'Satinado', metalness: 0.94, roughness: 0.24, style: { kind: 'chrome', variant: 'soft' } },
      { id: 'chrome-rough', label: 'Rugoso', metalness: 0.90, roughness: 0.52, style: { kind: 'chrome', variant: 'rough' } },
      { id: 'chrome-stripes', label: 'Franjas', metalness: 0.95, roughness: 0.20, style: { kind: 'chrome', variant: 'stripes' } },
      { id: 'chrome-grid', label: 'Grid', metalness: 0.93, roughness: 0.26, style: { kind: 'chrome', variant: 'grid' } }
    ]
  },
  {
    id: 'solar-gold',
    label: 'Solar Gold',
    presets: [
      { id: 'gold-polished', label: 'Pulido', metalness: 0.96, roughness: 0.10, style: { kind: 'gold', variant: 'polished' } },
      { id: 'gold-soft', label: 'Suave', metalness: 0.92, roughness: 0.27, style: { kind: 'gold', variant: 'soft' } },
      { id: 'gold-rugged', label: 'Rugged', metalness: 0.86, roughness: 0.46, style: { kind: 'gold', variant: 'rugged' } }
    ]
  },
  {
    id: 'cosmic-gradient',
    label: 'Cosmic Gradient',
    presets: [
      { id: 'cosmic-pink', label: 'Pink', metalness: 0.58, roughness: 0.22, style: { kind: 'cosmic', palette: ['#6927ff', '#ff3ca6', '#ffc25a'] } },
      { id: 'cosmic-teal', label: 'Teal', metalness: 0.54, roughness: 0.20, style: { kind: 'cosmic', palette: ['#08284d', '#00d9d0', '#b2ff75'] } },
      { id: 'cosmic-red', label: 'Red', metalness: 0.55, roughness: 0.23, style: { kind: 'cosmic', palette: ['#3c0716', '#ff2e5c', '#ff9a3d'] } },
      { id: 'cosmic-orange', label: 'Orange', metalness: 0.52, roughness: 0.24, style: { kind: 'cosmic', palette: ['#5a1832', '#ff6b1a', '#ffd34d'] } },
      { id: 'cosmic-blue', label: 'Blue', metalness: 0.58, roughness: 0.18, style: { kind: 'cosmic', palette: ['#09193d', '#245cff', '#43ecff'] } },
      { id: 'cosmic-green', label: 'Green', metalness: 0.50, roughness: 0.24, style: { kind: 'cosmic', palette: ['#082e2b', '#15bf70', '#c8ff56'] } }
    ]
  },
  {
    id: 'galactic-patterns',
    label: 'Galactic Patterns',
    presets: [
      { id: 'galactic-swirl', label: 'Swirl', metalness: 0.42, roughness: 0.30, style: { kind: 'galactic', variant: 'swirl' } },
      { id: 'galactic-blue', label: 'Nebula', metalness: 0.48, roughness: 0.26, style: { kind: 'galactic', variant: 'blue' } },
      { id: 'galactic-circuit', label: 'Circuit', metalness: 0.64, roughness: 0.22, style: { kind: 'galactic', variant: 'circuit' } },
      { id: 'galactic-grid', label: 'Grid', metalness: 0.56, roughness: 0.25, style: { kind: 'galactic', variant: 'grid' } }
    ]
  }
];

const PRESET_BY_ID = new Map(
  MATERIAL_PRESET_GROUPS.flatMap((group) => group.presets.map((preset) => [preset.id, preset]))
);

export function getMaterialPreset(id) {
  return PRESET_BY_ID.get(id) || null;
}

function seededRandom(seed = 1234567) {
  let value = seed >>> 0;
  return () => {
    value = (1664525 * value + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function fillGradient(ctx, w, h, colors, diagonal = true) {
  const gradient = diagonal
    ? ctx.createLinearGradient(0, h, w, 0)
    : ctx.createLinearGradient(0, 0, w, 0);
  colors.forEach((color, index) => gradient.addColorStop(index / Math.max(1, colors.length - 1), color));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

function drawMetalBands(ctx, w, h, colors) {
  const gradient = ctx.createLinearGradient(0, 0, w, 0);
  const stops = [0, .12, .26, .40, .54, .72, .86, 1];
  stops.forEach((stop, index) => gradient.addColorStop(stop, colors[index % colors.length]));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

function drawNoise(ctx, w, h, amount = .3, tint = '#ffffff', seed = 81, countScale = 1) {
  const rnd = seededRandom(seed);
  const count = Math.max(80, Math.round(520 * countScale));
  ctx.save();
  for (let i = 0; i < count; i++) {
    const alpha = (.025 + rnd() * .12) * amount;
    const radius = .4 + rnd() * Math.max(1, Math.min(w, h) * .008);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.arc(rnd() * w, rnd() * h, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBrushedLines(ctx, w, h, strength = .4, size = 1) {
  const spacing = Math.max(2, Math.round(5 / Math.max(.25, size)));
  ctx.save();
  ctx.lineWidth = Math.max(.5, size * .7);
  for (let y = 0; y < h; y += spacing) {
    ctx.strokeStyle = `rgba(255,255,255,${.035 * strength})`;
    ctx.beginPath();
    ctx.moveTo(0, y + .5);
    ctx.lineTo(w, y + .5);
    ctx.stroke();
    if ((y / spacing) % 3 === 0) {
      ctx.strokeStyle = `rgba(0,0,0,${.025 * strength})`;
      ctx.beginPath();
      ctx.moveTo(0, y + spacing * .45);
      ctx.lineTo(w, y + spacing * .45);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawStripes(ctx, w, h, strength = .45, size = 1, color = '#ffffff') {
  const stripe = Math.max(6, Math.round(34 / Math.max(.25, size)));
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 5);
  ctx.translate(-w / 2, -h / 2);
  for (let x = -h; x < w + h; x += stripe) {
    ctx.globalAlpha = .08 + .20 * strength;
    ctx.fillStyle = color;
    ctx.fillRect(x, -h, stripe * .42, h * 3);
  }
  ctx.restore();
}

function drawGrid(ctx, w, h, strength = .5, size = 1, color = '#d9f7ff') {
  const spacing = Math.max(10, Math.round(56 / Math.max(.25, size)));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = .08 + .18 * strength;
  ctx.lineWidth = Math.max(.6, size * .7);
  for (let x = 0; x <= w; x += spacing) {
    ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); ctx.stroke();
  }
  for (let y = 0; y <= h; y += spacing) {
    ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); ctx.stroke();
  }
  ctx.restore();
}

function drawCircuit(ctx, w, h) {
  const rnd = seededRandom(3901);
  ctx.save();
  ctx.strokeStyle = '#50e7ff';
  ctx.fillStyle = '#8ff6ff';
  ctx.shadowColor = '#33d7ff';
  ctx.shadowBlur = Math.max(1, w * .008);
  ctx.lineWidth = Math.max(1, w * .004);
  ctx.globalAlpha = .62;
  const step = Math.max(12, Math.round(w / 12));
  for (let row = 1; row < 10; row++) {
    let x = -step;
    let y = row * (h / 10);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 9; k++) {
      x += step * (1 + rnd() * .5);
      if (k % 2 === 0) y += (rnd() > .5 ? 1 : -1) * step * .45;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5, w * .007), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawSwirl(ctx, w, h) {
  fillGradient(ctx, w, h, ['#120c3d', '#3a1b85', '#101b55']);
  ctx.save();
  ctx.translate(w * .52, h * .52);
  ctx.lineCap = 'round';
  for (let arm = 0; arm < 5; arm++) {
    ctx.beginPath();
    for (let t = 0; t < Math.PI * 4.6; t += .11) {
      const radius = (Math.min(w, h) * .015) + t * Math.min(w, h) * .013;
      const angle = t + arm * (Math.PI * 2 / 5);
      const x = Math.cos(angle) * radius * 1.25;
      const y = Math.sin(angle) * radius * .65;
      if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = arm % 2 ? '#ff55d4' : '#51e7ff';
    ctx.globalAlpha = .18 + arm * .025;
    ctx.lineWidth = Math.max(2, Math.min(w, h) * .018);
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = Math.min(w, h) * .04;
    ctx.stroke();
  }
  ctx.restore();
  drawNoise(ctx, w, h, .7, '#ffffff', 1092, 1.4);
}

function drawNebula(ctx, w, h) {
  fillGradient(ctx, w, h, ['#030b25', '#0b2f72', '#291965']);
  const centers = [
    [w * .30, h * .48, '#2dcfff'],
    [w * .60, h * .40, '#6948ff'],
    [w * .74, h * .65, '#ff3fbb']
  ];
  ctx.save();
  for (const [x, y, color] of centers) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.min(w, h) * .46);
    g.addColorStop(0, `${color}b0`);
    g.addColorStop(.45, `${color}45`);
    g.addColorStop(1, `${color}00`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
  drawNoise(ctx, w, h, .85, '#ffffff', 172, 1.9);
}

function paintChrome(ctx, w, h, variant) {
  drawMetalBands(ctx, w, h, ['#1d2730', '#dbe9f4', '#637584', '#f6fbff', '#80909c', '#26333c']);
  if (variant === 'soft') drawBrushedLines(ctx, w, h, .65, 1.2);
  else if (variant === 'rough') {
    drawNoise(ctx, w, h, 1, '#ffffff', 291, 2.1);
    drawNoise(ctx, w, h, .8, '#000000', 817, 1.5);
  } else if (variant === 'stripes') drawStripes(ctx, w, h, .9, .9, '#e6f7ff');
  else if (variant === 'grid') drawGrid(ctx, w, h, .95, 1, '#e4f6ff');
  else {
    const shine = ctx.createLinearGradient(0, 0, 0, h);
    shine.addColorStop(0, 'rgba(255,255,255,.18)');
    shine.addColorStop(.45, 'rgba(255,255,255,.02)');
    shine.addColorStop(.6, 'rgba(0,0,0,.12)');
    shine.addColorStop(1, 'rgba(255,255,255,.08)');
    ctx.fillStyle = shine;
    ctx.fillRect(0, 0, w, h);
  }
}

function paintGold(ctx, w, h, variant) {
  drawMetalBands(ctx, w, h, ['#53310b', '#e7b632', '#fff1a2', '#b77416', '#f7d45e', '#6f410e']);
  const warm = ctx.createLinearGradient(0, 0, 0, h);
  warm.addColorStop(0, 'rgba(255,251,184,.20)');
  warm.addColorStop(1, 'rgba(92,36,0,.16)');
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, w, h);
  if (variant === 'soft') drawBrushedLines(ctx, w, h, .6, 1.1);
  if (variant === 'rugged') {
    drawNoise(ctx, w, h, .95, '#4d2500', 2917, 2.3);
    drawNoise(ctx, w, h, .55, '#fff2a0', 117, 1.4);
  }
}

function paintGalactic(ctx, w, h, variant) {
  if (variant === 'swirl') return drawSwirl(ctx, w, h);
  if (variant === 'blue') return drawNebula(ctx, w, h);
  fillGradient(ctx, w, h, variant === 'circuit' ? ['#020913', '#08273a', '#05111d'] : ['#100a33', '#241451', '#090b1f']);
  if (variant === 'circuit') drawCircuit(ctx, w, h);
  else {
    drawGrid(ctx, w, h, 1, .9, '#7a57ff');
    drawStripes(ctx, w, h, .52, .55, '#39dfff');
  }
}

export function paintMaterialPreset(canvas, presetId) {
  const preset = getMaterialPreset(presetId);
  if (!canvas || !preset) return null;
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  const style = preset.style || {};
  if (style.kind === 'chrome') paintChrome(ctx, w, h, style.variant);
  else if (style.kind === 'gold') paintGold(ctx, w, h, style.variant);
  else if (style.kind === 'cosmic') fillGradient(ctx, w, h, style.palette || ['#202040', '#ff50b8', '#65dcff']);
  else if (style.kind === 'galactic') paintGalactic(ctx, w, h, style.variant);
  else {
    ctx.fillStyle = '#c8d1da';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
  return preset;
}

function paintCustomTextureOverlay(ctx, w, h, type, strength, size) {
  const normalizedStrength = clamp01(strength);
  const normalizedSize = Math.max(.25, Math.min(4, Number(size) || 1));
  if (type === 'brushed') drawBrushedLines(ctx, w, h, normalizedStrength, normalizedSize);
  else if (type === 'hammered') {
    drawNoise(ctx, w, h, normalizedStrength, '#ffffff', 1831, 1.8 * normalizedSize);
    drawNoise(ctx, w, h, normalizedStrength * .75, '#000000', 7823, 1.3 * normalizedSize);
  } else if (type === 'stripes') drawStripes(ctx, w, h, normalizedStrength, normalizedSize, '#ffffff');
  else if (type === 'grid') drawGrid(ctx, w, h, normalizedStrength, normalizedSize, '#ffffff');
  else if (type === 'noise') drawNoise(ctx, w, h, normalizedStrength, '#ffffff', 5321, 2.2 * normalizedSize);
}

export function paintCustomMaterial(canvas, options = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const color = options.color || '#f5f0e7';
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  if (options.texture && options.texture !== 'none') {
    paintCustomTextureOverlay(ctx, w, h, options.texture, options.strength ?? .5, options.size ?? 1);
  }
  ctx.restore();
}
