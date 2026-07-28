export function applyLocalScaleTool(worldPos, item, ctx) {
  const { planePoint, localScaleDelta } = ctx;
  const falloff = item.effectiveFalloff;
  if (falloff <= 0 || !Number.isFinite(localScaleDelta)) return false;

  const amount = Math.max(-0.18, Math.min(0.18, localScaleDelta)) * falloff;
  const toPoint = worldPos.clone().sub(planePoint);
  worldPos.addScaledVector(toPoint, amount);
  return true;
}
