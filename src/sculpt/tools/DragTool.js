export function applyDragTool(worldPos, item, ctx) {
  const { dragDelta, radius } = ctx;
  const falloff = item.effectiveFalloff;
  if (falloff <= 0 || !dragDelta) return false;

  // Drag es incremental, pero limitamos cada sello para evitar tirones cuando el
  // navegador pierde frames o el mouse salta varios píxeles.
  const delta = dragDelta.clone();
  const maxStep = Math.max(0.0001, radius * 0.45);
  if (delta.length() > maxStep) delta.setLength(maxStep);
  worldPos.addScaledVector(delta, falloff);
  return true;
}
