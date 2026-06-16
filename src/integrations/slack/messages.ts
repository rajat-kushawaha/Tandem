/**
 * Pure formatting for Slack clarification messages. Kept separate from the
 * Slack client so the wording is unit-testable without a live workspace.
 */

export interface ClarificationRequest {
  readonly ticketKey: string;
  readonly ticketUrl: string;
  readonly questions: readonly string[];
}

export function formatClarificationMessage(
  request: ClarificationRequest,
): string {
  if (request.questions.length === 0) {
    throw new Error('Refusing to post an empty clarification request.');
  }
  const numbered = request.questions
    .map((question, index) => `${index + 1}. ${question}`)
    .join('\n');
  return [
    `:mag: *Refinement questions for <${request.ticketUrl}|${request.ticketKey}>*`,
    '',
    numbered,
    '',
    '_Reply in this thread and the BA agent will refine the ticket._',
  ].join('\n');
}
