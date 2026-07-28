export function applyCreaseTool(worldPos, item, ctx) {
  const {
    brushCenter,
    planeNormal,
    negative,
    strength,
    radius,
    creasePinch = 1,
    creaseDepth = 1
  } = ctx;

  const falloff = item.effectiveFalloff;
  if (falloff <= 0) return false;

  // SculptGL define Crease como una combinación de Pinch y Brush. Usamos la
  // posición de referencia del sello para que el pinzado no se vuelva inestable
  // al acumular varios stamps dentro del mismo trazo.
  const reference = item.refWorld || worldPos;
  const toCenter = brushCenter.clone().sub(reference);
  const pinchAmount = Math.min(0.24, strength * 1.75 * creasePinch) * falloff;
  worldPos.addScaledVector(toCenter, pinchAmount);

  // En SculptGL el desplazamiento normal usa intensity * 0.07 * radius. La UI
  // de SculptCAD trabaja en 0.001..0.12, por eso necesita una conversión mayor
  // que la versión anterior (0.075), que hacía el surco casi imperceptible.
  const depthFalloff = Math.pow(falloff, 5);
  const signedDepth = Math.min(radius * 0.14, strength * radius * 1.65 * creaseDepth) * depthFalloff;
  worldPos.addScaledVector(planeNormal, negative ? signedDepth : -signedDepth);
  return true;
}
