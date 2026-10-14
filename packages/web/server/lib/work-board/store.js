import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

const FILE_NAME = 'work-board.json';
export const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;
const nonempty = z.string().trim().min(1);
const attachmentSchema = z.object({
  id: nonempty.optional().default(() => crypto.randomUUID()),
  filename: nonempty,
  mimeType: nonempty,
  size: z.number().int().positive(),
  dataUrl: nonempty.max(MAX_PAYLOAD_BYTES),
}).refine(entry => {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(entry.dataUrl);
  if (!match || match[1].toLowerCase() !== entry.mimeType.toLowerCase()) return false;
  const decoded = Buffer.from(match[2], 'base64');
  return decoded.length === entry.size && decoded.toString('base64') === match[2];
}, 'Attachment size, MIME type or base64 data is invalid');

const contentSchema = z.object({ text: z.string().default(''), attachments: z.array(attachmentSchema).default([]) })
  .refine(value => value.text.trim() || value.attachments.length, 'Text or attachments are required')
  .refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_PAYLOAD_BYTES, 'Work board payload exceeds 50 MiB');
const createSchema = z.object({ directory: nonempty, text: z.string().default(''), attachments: z.array(attachmentSchema).default([]) });
const updateSchema = z.object({
  text: z.string().optional(), attachments: z.array(attachmentSchema).optional(),
  sessionId: nonempty.optional(), stage: z.enum(['todo', 'plan']).optional(),
});
const cardSchema = z.object({
  id: nonempty, directory: nonempty, text: z.string(), attachments: z.array(attachmentSchema),
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
  sessionId: nonempty.optional(), stage: z.enum(['todo', 'plan']),
}).refine(value => value.stage !== 'plan' || value.sessionId, 'Plan card requires a session')
  .refine(value => value.text.trim() || value.attachments.length, 'Card has no content');
const storedSchema = z.object({ version: z.literal(1), cards: z.array(cardSchema) })
  .refine(value => new Set(value.cards.map(card => card.id)).size === value.cards.length, 'Duplicate card ids');

const invalid = (error) => Object.assign(new TypeError(error.message), { status: 400 });

export function createWorkBoardStore({ dataDir, fs = fsPromises, now = Date.now, id = crypto.randomUUID }) {
  const filePath = path.join(dataDir, FILE_NAME);
  let queue = Promise.resolve();
  const serialized = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const read = async () => {
    let raw;
    try { raw = await fs.readFile(filePath, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const stored = storedSchema.safeParse(JSON.parse(raw));
    if (!stored.success) throw new Error('Invalid persisted work board');
    return stored.data.cards;
  };
  const write = async cards => {
    await fs.mkdir(dataDir, { recursive: true });
    const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, cards }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fs.rename(temp, filePath);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  };
  return {
    list: directory => serialized(async () => (await read()).filter(card => directory === undefined || card.directory === directory)),
    create: input => serialized(async () => {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error);
      const content = contentSchema.safeParse(parsed.data);
      if (!content.success) throw invalid(content.error);
      const at = now();
      const card = { id: id(), directory: parsed.data.directory, ...content.data, createdAt: at, updatedAt: at, stage: 'todo' };
      const cards = await read();
      await write([...cards, card]);
      return card;
    }),
    update: (cardId, input) => serialized(async () => {
      const parsed = updateSchema.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error);
      const cards = await read();
      const index = cards.findIndex(card => card.id === cardId);
      if (index < 0) throw Object.assign(new Error('Work board card not found'), { status: 404 });
      const current = cards[index];
      const changes = parsed.data;
      const content = contentSchema.safeParse({ text: changes.text ?? current.text, attachments: changes.attachments ?? current.attachments });
      if (!content.success) throw invalid(content.error);
      if (current.sessionId && changes.sessionId && current.sessionId !== changes.sessionId) {
        throw Object.assign(new Error('Work board card is already linked to another session'), { status: 409 });
      }
      const next = { ...current, ...content.data, sessionId: changes.sessionId ?? current.sessionId,
        stage: changes.stage ?? current.stage, updatedAt: now() };
      if (next.stage === 'plan' && !next.sessionId) throw Object.assign(new Error('A card must be linked before promotion'), { status: 409 });
      const updated = [...cards]; updated[index] = next;
      await write(updated);
      return next;
    }),
    delete: cardId => serialized(async () => {
      const cards = await read();
      const remaining = cards.filter(card => card.id !== cardId);
      if (remaining.length === cards.length) return false;
      await write(remaining);
      return true;
    }),
  };
}
