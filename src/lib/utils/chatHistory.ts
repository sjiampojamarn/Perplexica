import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, ne } from 'drizzle-orm';
import { ChatTurnMessage, TextBlock } from '@/lib/types';

type UserTurn = Extract<ChatTurnMessage, { role: 'user' }>;

/**
 * Loads the full past conversation (user queries + assistant text responses)
 * for a chat from the database, excluding the message currently being
 * processed. This makes follow-up questions see prior responses even when the
 * client-side history is incomplete or stale.
 */
export const loadChatHistory = async (
  chatId: string,
  excludeMessageId: string,
): Promise<ChatTurnMessage[]> => {
  const pastMessages = await db.query.messages.findMany({
    where: and(
      eq(messages.chatId, chatId),
      ne(messages.messageId, excludeMessageId),
    ),
    orderBy: (m, { asc }) => [asc(m.id)],
  });

  const history: ChatTurnMessage[] = [];

  pastMessages.forEach((msg) => {
    if (msg.status !== 'completed') return;

    history.push({
      role: 'user',
      content: msg.query,
    });

    const text = (msg.responseBlocks ?? [])
      .filter(
        (block): block is TextBlock & { type: 'text' } =>
          block.type === 'text',
      )
      .map((block) => block.data)
      .join('\n');

    if (text) {
      history.push({
        role: 'assistant',
        content: text,
      });
    }
  });

  return history;
};

const isUserTurn = (m: ChatTurnMessage): m is UserTurn => m.role === 'user';

/**
 * Combines authoritative DB history with any client-side turns that have not
 * been persisted to the database yet (e.g. in-flight responses). Tries to
 * avoid duplicating turns already present in the server history.
 */
export const mergeHistories = (
  server: ChatTurnMessage[],
  client: ChatTurnMessage[],
): ChatTurnMessage[] => {
  if (server.length === 0) return client;

  const serverUserQueries = new Set(
    server.filter(isUserTurn).map((m) => m.content),
  );

  let takeFrom = 0;

  for (let i = 0; i < client.length; i++) {
    const m = client[i];

    if (isUserTurn(m) && !serverUserQueries.has(m.content)) {
      takeFrom = i;
      break;
    }
  }

  if (takeFrom === 0) return server;

  return [...server, ...client.slice(takeFrom)];
};