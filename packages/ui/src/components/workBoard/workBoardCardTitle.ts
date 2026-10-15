/** A compact board card uses only the first non-empty line of the brief. */
export function workBoardCardTitle(text: string, attachments: readonly { filename: string }[]): string {
  return text.trim().split(/\r?\n/, 1)[0]?.trim() || attachments[0]?.filename || 'Untitled';
}
