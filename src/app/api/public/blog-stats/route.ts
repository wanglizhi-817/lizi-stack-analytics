import prisma from '@/lib/prisma';
import { getWebsiteStats, type WebsiteStatsData } from '@/queries/sql';

const DEFAULT_DOMAIN = 'lizistack.cn';
const ALLOWED_ORIGINS = new Set([
  'https://lizistack.cn',
  'https://www.lizistack.cn',
  'http://127.0.0.1:4321',
  'http://localhost:4321',
]);

function responseHeaders(origin = '') {
  return {
    'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
    'content-type': 'application/json; charset=utf-8',
    ...(origin
      ? {
          'access-control-allow-origin': origin,
          vary: 'Origin',
        }
      : {}),
  };
}

function parseOrigin(request: Request) {
  const origin = request.headers.get('origin') ?? '';

  if (!origin) return '';
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function toPublicStats(stats: WebsiteStatsData | undefined) {
  const pv = Number(stats?.pageviews ?? 0);
  const uv = Number(stats?.visitors ?? 0);

  if (!Number.isSafeInteger(pv) || !Number.isSafeInteger(uv) || pv < 0 || uv < 0 || uv > pv) {
    throw new Error('Invalid statistics result');
  }

  return { pv, uv };
}

async function readStats(websiteId: string, startDate: Date, path?: string) {
  return getWebsiteStats(websiteId, {
    startDate,
    endDate: new Date(),
    ...(path ? { path } : {}),
  }) as unknown as Promise<WebsiteStatsData>;
}

export async function GET(request: Request) {
  const origin = parseOrigin(request);

  if (origin === null) {
    return Response.json(
      { error: 'Origin not allowed' },
      { status: 403, headers: responseHeaders() },
    );
  }

  const url = new URL(request.url);
  const path = url.searchParams.get('path')?.trim() || '';

  if (path && (!path.startsWith('/') || path.length > 300)) {
    return Response.json(
      { error: 'Invalid path' },
      { status: 400, headers: responseHeaders(origin) },
    );
  }

  const domain = process.env.PUBLIC_STATS_DOMAIN?.trim() || DEFAULT_DOMAIN;
  const website = await prisma.client.website.findFirst({
    where: { domain, deletedAt: null },
    select: { id: true, createdAt: true, resetAt: true },
  });

  if (!website) {
    return Response.json(
      { error: 'Statistics are not initialized' },
      { status: 503, headers: responseHeaders(origin) },
    );
  }

  try {
    const startDate = website.resetAt ?? website.createdAt ?? new Date(0);
    const [siteStats, pageStats] = await Promise.all([
      readStats(website.id, startDate),
      path ? readStats(website.id, startDate, path) : Promise.resolve(undefined),
    ]);

    return Response.json(
      {
        source: 'umami-self-hosted',
        site: toPublicStats(siteStats),
        page: pageStats ? toPublicStats(pageStats) : null,
      },
      { headers: responseHeaders(origin) },
    );
  } catch {
    return Response.json(
      { error: 'Statistics temporarily unavailable' },
      { status: 503, headers: responseHeaders(origin) },
    );
  }
}
