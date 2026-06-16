import { baRefinementWorkflow } from './workflows/ba.js';
import { devWorkflow } from './workflows/dev.js';
import { mergedWorkflow } from './workflows/merged.js';
import { reviewerOutcomeWorkflow } from './workflows/reviewer.js';

/** Every Inngest workflow the orchestrator serves. */
export const functions = [
  baRefinementWorkflow,
  devWorkflow,
  reviewerOutcomeWorkflow,
  mergedWorkflow,
];
