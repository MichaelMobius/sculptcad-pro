export function applyNoiseTool(worldPos, item, ctx) {
  const { strength, radius, sign, planeNormal, pseudoNoise } = ctx;
  const falloff = item.effectiveFalloff;
  if (falloff <= 0) return false;

  // Ruido fractal simple: tres octavas reducen el patrón repetitivo del ruido
  // anterior sin añadir dependencias externas.
  const x = worldPos.x;
  const y = worldPos.y;
  const z = worldPos.z;
  const n1 = pseudoNoise(x * 3.7, y * 3.7, z * 3.7);
  const n2 = pseudoNoise(x * 8.1 + 13.2, y * 8.1 - 7.4, z * 8.1 + 3.8);
  const n3 = pseudoNoise(x * 17.0 - 5.1, y * 17.0 + 11.7, z * 17.0 - 2.9);
  const noise = (n1 * 0.55 + n2 * 0.30 + n3 * 0.15) - 0.5;

  const normal = item.normal.clone();
  if (normal.lengthSq() < 1e-8) normal.copy(planeNormal);
  normal.normalize();

  const amount = sign * noise * strength * radius * 0.55 * falloff;
  worldPos.addScaledVector(normal, amount);
  return true;
}
