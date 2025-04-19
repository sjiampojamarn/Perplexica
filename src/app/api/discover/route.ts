import { searchSearxng } from '@/lib/searxng';

const articleWebsites = [
  'yahoo.com',
  'businessinsider.com',
  'wired.com',
  'theverge.com',
  'sfgate.com',
  'nbcbayarea.com',
];

const topics = [' ', 'tech', 'business']; /* TODO: Add UI to customize this */

export const GET = async (req: Request) => {
  try {
    const data = (
      await Promise.all([
        ...new Array(articleWebsites.length * topics.length)
          .fill(0)
          .map(async (_, i) => {
            return (
              await searchSearxng(
                `site:${articleWebsites[i % articleWebsites.length]} ${
                  topics[i % topics.length]
                }`,
                {
                  engines: ['bing news'],
                  pageno: 1,
                },
              )
            ).results;
          }),
      ])
    )
      .map((result) => result)
      .flat()
      .sort(() => Math.random() - 0.5);

    return Response.json(
      {
        blogs: data,
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error(`An error occurred in discover route: ${err}`);
    return Response.json(
      {
        message: 'An error has occurred',
      },
      {
        status: 500,
      },
    );
  }
};
