export function applyBrushTool(worldPos, item, ctx) {
  const { ui, strength, radius, sign, planeNormal, planePoint } = ctx;
  const falloff = item.effectiveFalloff;
  if (falloff <= 0) return false;

  // SculptGL Brush deforma con una ganancia proporcional a radius * 0.1.
  // Mantener esa escala evita que la brocha levante facetas duras o mesetas.
  const brushLift = strength * radius * 0.105;

  if (ui.clay?.checked) {
    // Clay en SculptGL: desplaza suavemente un plano local y aproxima la zona
    // hacia ese plano. Lo hacemos de manera one-sided para no aplastar ambos
    // lados de la superficie ni generar bordes duros.
    const clayPlane = planePoint.clone().addScaledVector(planeNormal, sign * radius * 0.10);
    const planeDist = worldPos.clone().sub(clayPlane).dot(planeNormal);
    const clayStrength = Math.min(0.82, strength * 5.8);

    if (planeDist * sign < 0) {
      worldPos.addScaledVector(planeNormal, -planeDist * falloff * clayStrength);
    }

    // Pequeño lift adicional en el centro para que el material se sienta como
    // arcilla, no como un plano geométrico.
    worldPos.addScaledVector(planeNormal, sign * brushLift * 0.18 * Math.pow(falloff, 1.25));
  } else {
    // Brush clásico: todos los puntos del sello avanzan por la normal media de
    // la zona, no por normales individuales demasiado facetadas.
    worldPos.addScaledVector(planeNormal, sign * brushLift * falloff);
  }
  return true;
}
