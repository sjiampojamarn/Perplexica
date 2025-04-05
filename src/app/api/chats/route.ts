import db from '@/lib/db';
import { chats } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export const GET = async (req: Request) => {
  try {
    // get header from request
    const headers = await req.headers;
    let userSessionId = headers.get('user-session-id')?.toString() ?? '';

    console.error('userSessionId: ', userSessionId);
    // let userSessionId = req.headers['user-session-id'] ? req.headers['user-session-id'].toString() : '';
    if (userSessionId == '') {
      return Response.json({ chats: {} }, { status: 200 });
    }
    
    let chatsRes = await db.query.chats.findMany({
      where: eq(chats.userSessionId, userSessionId),
    });
    
    chatsRes = chatsRes.reverse();
    return Response.json({ chats: chatsRes }, { status: 200 });
  } catch (err) {
    console.error('Error in getting chats: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
