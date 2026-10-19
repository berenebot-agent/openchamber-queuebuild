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
const parkSchema = createSchema.extend({ sessionId: nonempty });
const updateSchema = z.object({
  text: z.string().optional(), attachments: z.array(attachmentSchema).optional(),
  sessionId: nonempty.optional(), stage: z.enum(['todo', 'plan']).optional(),
  expectedUpdatedAt: z.number().finite().optional(),
  removeBrief: z.literal(true).optional(),
});
const cardSchema = z.object({
  id: nonempty, directory: nonempty, text: z.string(), attachments: z.array(attachmentSchema),
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
  completedAt: z.number().finite().optional(), viewedAt: z.number().finite().optional(), sessionId: nonempty.optional(),
  // When the user placed the card on the board by hand. Later session activity
  // outranks it; nothing else writes it.
  placementAt: z.number().finite().optional(),
  // The card a dropped card now sits in front of, inside its lane; null is the
  // end of the lane. Only the card the user moved carries it, so every other
  // card keeps the lane's own order.
  placementBefore: z.string().trim().min(1).nullable().optional(),
  // Retired: the whole-lane arrangement an older build stamped on every card of a
  // lane. Kept in the schema so existing files stay readable, and dropped on read
  // so it is never written again.
  placementOrder: z.number().finite().optional(),
  stage: z.enum(['todo', 'plan', 'done']),
  briefRemoved: z.literal(true).optional(),
}).refine(value => value.stage !== 'plan' || value.sessionId, 'Plan card requires a session')
  .refine(value => value.briefRemoved
    ? value.sessionId && value.text === '' && value.attachments.length === 0
    : value.text.trim() || value.attachments.length, 'Card has no content');
const storedSchema = z.object({ version: z.literal(1), cards: z.array(cardSchema) })
  .refine(value => new Set(value.cards.map(card => card.id)).size === value.cards.length, 'Duplicate card ids');

const invalid = (error) => Object.assign(new TypeError(error.message), { status: 400 });

/**
 * A card of a version-1 file from before per-card placement: its `placementOrder`
 * was the whole lane's arrangement, which froze that lane's own order. Drop it, so
 * a read hands back only the fields the board acts on and the next write clears it
 * from the file.
 */
function withoutRetiredOrder(card) {
  if (card.placementOrder === undefined) return card;
  const next = { ...card };
  delete next.placementOrder;
  return next;
}

export function createWorkBoardStore({ dataDir, fs = fsPromises, now = Date.now, id = crypto.randomUUID }) {
  const filePath = path.join(dataDir, FILE_NAME);
  let queue = Promise.resolve();
  const serialized = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  /**
   * The parsed card list of the last successful read. The whole file is
   * re-parsed on every request otherwise, attachments included, and a card list
   * can approach 50 MiB. Only this store process writes the file, so a
   * successful read stays valid until a write replaces it.
   */
  let cachedCards;
  const read = async () => {
    if (cachedCards !== undefined) return cachedCards;
    let raw;
    try { raw = await fs.readFile(filePath, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') { cachedCards = []; return cachedCards; } throw error; }
    const stored = storedSchema.safeParse(JSON.parse(raw));
    if (!stored.success) {
      // Malformed data is a read failure, and a later write must not replace it
      // with a board built from a guess. Do not let a retry see a cached list.
      cachedCards = undefined;
      throw new Error('Invalid persisted work board');
    }
    cachedCards = stored.data.cards.map(withoutRetiredOrder);
    return cachedCards;
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
    // The rename is the commit point: the new list is durable now, so it is the
    // list every later read must see.
    cachedCards = cards;
  };
  return {
    list: (directory, sessionId) => serialized(async () => (await read()).filter(card =>
      (directory === undefined || card.directory === directory) && (sessionId === undefined || card.sessionId === sessionId))),
    complete: input => serialized(async () => {
      const target = z.object({ directory: nonempty, id: nonempty, updatedAt: z.number().finite(), sessionId: nonempty.optional(), text: z.string() }).parse(input);
      const cards = await read();
      const current = cards.find(card => card.id === target.id);
      const conflict = () => Object.assign(new Error('Card changed. Refresh the board before moving it to Done.'), { status: 409 });
      if (current && (current.directory !== target.directory || current.updatedAt !== target.updatedAt || current.sessionId !== target.sessionId)) throw conflict();
      if (!current && (target.id !== `session:${target.sessionId}` || !target.sessionId
        || cards.some(card => card.directory === target.directory && card.sessionId === target.sessionId))) throw conflict();
      const at = Math.max(now(), (current?.updatedAt ?? 0) + 1);
      // Like its first placement, the completion that creates an inherited
      // card's record stores it with no brief: its text is the session's title.
      const created = { id: id(), directory: target.directory, text: '', attachments: [],
        briefRemoved: true, sessionId: target.sessionId, createdAt: at };
      const card = cardSchema.parse({ ...(current ?? created),
        stage: 'done', completedAt: at, updatedAt: at });
      await write(current ? cards.map(entry => entry.id === current.id ? card : entry) : [...cards, card]);
      return card;
    }),
    // Acknowledges the completion the user just looked at. The mark is scoped to
    // one completion: a later Done writes a newer `completedAt`, which shows the
    // mark again without any reset. `updatedAt` is deliberately untouched so the
    // board's stale-completion check still compares against the last real change.
    viewed: cardId => serialized(async () => {
      const cards = await read();
      const index = cards.findIndex(card => card.id === cardId);
      if (index < 0) throw Object.assign(new Error('Work board card not found'), { status: 404 });
      const current = cards[index];
      if (current.completedAt === undefined || current.viewedAt !== undefined && current.viewedAt >= current.completedAt) return current;
      const next = { ...current, viewedAt: current.completedAt };
      const updated = [...cards]; updated[index] = next;
      await write(updated);
      return next;
    }),
    parkSession: input => serialized(async () => {
      const parsed = parkSchema.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error);
      const { directory, sessionId, text, attachments } = parsed.data;
      const cards = await read();
      const index = cards.findIndex(card => card.directory === directory && card.sessionId === sessionId);
      const current = cards[index];
      const previousText = current?.text ?? '';
      if (current?.briefRemoved && !text.trim() && !attachments.length) {
        const card = { id: current.id, directory, sessionId, text: '', attachments: [], briefRemoved: true,
          stage: 'todo', createdAt: current.createdAt, updatedAt: Math.max(now(), current.updatedAt + 1) };
        await write(cards.map(entry => entry.id === current.id ? card : entry));
        return card;
      }
      const alreadySaved = previousText === text || previousText.endsWith(`\n\n${text}`);
      const mergedText = !text.trim() || alreadySaved ? previousText
        : [previousText, text].filter(value => value.trim()).join('\n\n');
      const mergedFiles = new Map((current?.attachments ?? []).map(file => [file.id, file]));
      for (const file of attachments) mergedFiles.set(file.id, file);
      const content = contentSchema.safeParse({ text: mergedText, attachments: [...mergedFiles.values()] });
      if (!content.success) throw invalid(content.error);
      const at = now();
      const card = { id: current?.id ?? id(), directory, ...content.data, sessionId,
        stage: 'todo', createdAt: current?.createdAt ?? at, updatedAt: current ? Math.max(at, current.updatedAt + 1) : at };
      const next = [...cards];
      if (index < 0) next.push(card);
      else next[index] = card;
      await write(next);
      return card;
    }),
    // A drag on the board writes the user's own placement: the lane, and the card
    // it was dropped in front of. `placementAt` is the server's own clock: a
    // device with a wrong clock must not pin a card
    // against later activity, and two devices must order by one source. It is
    // the boundary later session activity has to pass. `updatedAt` deliberately
    // stays put: it is the boundary a parked To-do and the stale-completion
    // check compare against.
    placement: (cardId, input) => serialized(async () => {
      const target = z.object({ lane: z.enum(['todo', 'plan', 'build', 'done']),
        expectedUpdatedAt: z.number().finite().optional(),
        before: z.string().min(1).nullable().optional(), directory: nonempty.optional(),
        sessionId: nonempty.optional(), text: z.string().optional() }).parse(input);
      const cards = await read();
      const index = cards.findIndex(card => card.id === cardId);
      // A card the board derives from a linked session has no stored record
      // until the user does something with it. A drag is that something, so the
      // first placement of an inherited card creates it, exactly as its first
      // completion does.
      const inherited = index < 0 && cardId === `session:${target.sessionId}` && target.sessionId !== undefined
        && target.directory !== undefined
        && !cards.some(card => card.directory === target.directory && card.sessionId === target.sessionId);
      if (index < 0 && !inherited) throw Object.assign(new Error('Work board card not found'), { status: 404 });
      const at = now();
      // An inherited card carries the session's title as its text, a label the
      // projection adds. Its first placement stores the linked card with no
      // brief, so the board keeps showing that title and never opens it as a
      // saved to-do.
      const created = { id: id(), directory: target.directory, text: '', attachments: [],
        briefRemoved: true, sessionId: target.sessionId, stage: 'todo', createdAt: at, updatedAt: at };
      const current = index < 0 ? created : cards[index];
      // Another device changed the card since this one read the board. The
      // check is inside the serialized write, so it cannot race a write that
      // lands between a client's read and this placement.
      if (index >= 0 && target.expectedUpdatedAt !== undefined && current.updatedAt !== target.expectedUpdatedAt) {
        throw Object.assign(new Error('Card changed. Refresh the board before moving it.'), { status: 409 });
      }
      // A bulk move names one project's board; a card from another one is not
      // this request's to place, even though the id exists.
      if (target.directory !== undefined && current.directory !== target.directory) {
        throw Object.assign(new Error('Card changed. Refresh the board before moving it.'), { status: 409 });
      }
      const placed = { ...current,
        stage: target.lane === 'plan' ? 'plan' : target.lane === 'todo' ? 'todo' : 'done',
        placementAt: at };
      // Only a card the user actually dropped carries a place: `before` names the
      // card it now sits in front of, and `null` the end of the lane. A move that
      // names no place — the completion check, a drop on the lane itself, a bulk
      // move — clears any earlier one, so the card takes the lane's own order.
      if (target.before !== undefined) placed.placementBefore = target.before;
      else delete placed.placementBefore;
      // Only the first arrival in Done stamps a completion; the acknowledgement
      // stays until the completion is acknowledged on its own.
      if (target.lane === 'done' && current.completedAt === undefined) placed.completedAt = at;
      const next = cardSchema.parse(placed);
      const updated = index < 0 ? [...cards, next] : cards.map(card => card.id === next.id ? next : card);
      await write(updated);
      return next;
    }),
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
      if (changes.expectedUpdatedAt !== undefined && changes.expectedUpdatedAt !== current.updatedAt) {
        throw Object.assign(new Error('Card changed. Choose which version to keep.'), { status: 409 });
      }
      if (current.sessionId && changes.sessionId && current.sessionId !== changes.sessionId) {
        throw Object.assign(new Error('Work board card is already linked to another session'), { status: 409 });
      }
      if (changes.removeBrief) {
        if (!current.sessionId || changes.text !== undefined || changes.attachments !== undefined
          || changes.sessionId !== undefined || changes.stage !== undefined) {
          throw Object.assign(new Error('Removing a brief requires a linked session and no other changes'), { status: 400 });
        }
        // Placement uses updatedAt as its parking boundary. Removing content
        // leaves that boundary, stage and completion acknowledgement untouched.
        const next = { ...current, text: '', attachments: [], briefRemoved: true };
        await write(cards.map(card => card.id === cardId ? next : card));
        return next;
      }
      // A stale editor must never restore content erased by another client.
      // Parking the session again is the explicit way to create a new brief.
      if (current.briefRemoved && (changes.text !== undefined || changes.attachments !== undefined)) {
        throw Object.assign(new Error('This saved brief was removed. Save a new to-do to replace it.'), { status: 409 });
      }
      if (current.briefRemoved) {
        const next = cardSchema.parse({ ...current, stage: changes.stage ?? current.stage,
          updatedAt: Math.max(now(), current.updatedAt + 1) });
        await write(cards.map(card => card.id === cardId ? next : card));
        return next;
      }
      const content = contentSchema.safeParse({ text: changes.text ?? current.text, attachments: changes.attachments ?? current.attachments });
      if (!content.success) throw invalid(content.error);
      const next = { ...current, ...content.data, sessionId: changes.sessionId ?? current.sessionId,
        stage: changes.stage ?? current.stage, updatedAt: Math.max(now(), current.updatedAt + 1) };
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
    // A card whose session OpenCode no longer has can never settle again: the
    // board prunes it instead of leaving a card nothing can move. Only ids the
    // caller proved absent are accepted, and only that directory's own cards, so
    // a failed read elsewhere can never delete a live card. Returns the session
    // ids it pruned, which is how the caller drops their cards from its response.
    pruneMissing: (directory, sessionIds) => serialized(async () => {
      const gone = new Set(sessionIds);
      if (!gone.size) return [];
      const cards = await read();
      const removed = cards.filter(card => card.directory === directory && card.sessionId && gone.has(card.sessionId));
      if (!removed.length) return [];
      const removedIds = new Set(removed.map(card => card.id));
      await write(cards.filter(card => !removedIds.has(card.id)));
      return removed.map(card => card.sessionId);
    }),
  };
}
