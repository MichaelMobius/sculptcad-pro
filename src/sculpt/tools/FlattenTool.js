export function applyFlattenTool(worldPos, item, ctx) {
  const { planePoint, planeNormal, flattenStrength, negative } = ctx;
  const falloff = item.effectiveFalloff;
  if (falloff <= 0) return false;

  const planeDist = worldPos.clone().sub(planePoint).dot(planeNormal);
  const comp = negative ? -1 : 1;

  // Como SculptGL, Flatten actúa desde un lado del plano local. Esto evita que
  // un solo sello colapse ambos lados de un pliegue o genere superficies gomosas.
  if (planeDist * comp > 0) return false;

  const amount = Math.min(0.92, flattenStrength * 0.9) * falloff;
  worldPos.addScaledVector(planeNormal, -planeDist * amount);
  return true;
}
