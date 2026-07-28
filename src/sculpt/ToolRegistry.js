import { applyBrushTool } from './tools/BrushTool.js';
import { applyInflateTool } from './tools/InflateTool.js';
import { applyFlattenTool } from './tools/FlattenTool.js';
import { applySmoothTool } from './tools/SmoothTool.js';
import { applyPinchTool } from './tools/PinchTool.js';
import { applyCreaseTool } from './tools/CreaseTool.js';
import { applyDragTool } from './tools/DragTool.js';
import { applyTwistTool } from './tools/TwistTool.js';
import { applyLocalScaleTool } from './tools/LocalScaleTool.js';
import { applyNoiseTool } from './tools/NoiseTool.js';

export const SCULPT_TOOL_NAMES = Object.freeze([
  'brush',
  'inflate',
  'deflate',
  'flatten',
  'smooth',
  'pinch',
  'crease',
  'drag',
  'twist',
  'localScale',
  'noise'
]);

export function applySculptTool(mode, worldPos, item, ctx) {
  switch (mode) {
    case 'brush':
      return applyBrushTool(worldPos, item, ctx);
    case 'inflate':
    case 'deflate':
      return applyInflateTool(mode, worldPos, item, ctx);
    case 'flatten':
      return applyFlattenTool(worldPos, item, ctx);
    case 'smooth':
      return applySmoothTool(worldPos, item, ctx);
    case 'pinch':
      return applyPinchTool(worldPos, item, ctx);
    case 'crease':
      return applyCreaseTool(worldPos, item, ctx);
    case 'drag':
      return applyDragTool(worldPos, item, ctx);
    case 'twist':
      return applyTwistTool(worldPos, item, ctx);
    case 'localScale':
      return applyLocalScaleTool(worldPos, item, ctx);
    case 'noise':
      return applyNoiseTool(worldPos, item, ctx);
    default:
      return false;
  }
}
