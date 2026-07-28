export function applyPinchTool(worldPos, item, ctx) {
  const { planePoint, sign, strength } = ctx;
  const falloff = item.effectiveFalloff;
  if (falloff <= 0) return false;

  // SculptGL Pinch usa una ganancia pequeña: intensity * 0.05.
  // En nuestra escala UI equivale mejor a strength * ~1.25.
  const toCenter = planePoint.clone().sub(worldPos);
  const amount = Math.min(0.16, strength * 1.25) * falloff;
  worldPos.addScaledVector(toCenter, sign * amount);
  return true;
}
