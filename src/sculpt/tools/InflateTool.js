export function applyInflateTool(mode, worldPos, item, ctx) {
  const { strength, radius, sign, planeNormal } = ctx;
  const falloff = item.effectiveFalloff;
  if (falloff <= 0) return false;

  // SculptGL Inflate usa normales de vértice y una escala radius * 0.1.
  // Solo mezclamos una mínima parte de la normal de área para evitar costuras.
  const normal = item.normal.clone();
  if (normal.lengthSq() < 1e-8) normal.copy(planeNormal);
  normal.normalize().lerp(planeNormal, 0.06).normalize();

  const modeSign = mode === 'deflate' ? -sign : sign;
  const amount = strength * radius * 0.105 * falloff;
  worldPos.addScaledVector(normal, modeSign * amount);
  return true;
}
