import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Proxies the Omaps `LoadMapPolygons` endpoint, which returns a binary blob
 * containing the actual map polygon vertices (not just the bbox). The format is:
 *   - 4 bytes: total map count (Int32 LE)
 *   - per map:
 *     - 8 bytes: map id (Int64 LE, only low 32 bits used in practice)
 *     - 4 bytes: vertex count (Int32 LE)
 *     - per vertex: 4 bytes lat×1e6 (Int32 LE), 4 bytes lng×1e6 (Int32 LE)
 *
 * The response is several hundred KB and is heavily cached upstream-side.
 */
const OMAPS_POLYGONS_URL = 'https://www.omaps.net/se/Home/LoadMapPolygons';

async function loadOmapsPolygonShapes(fetchFn: typeof fetch): Promise<Response> {
	const upstream = await fetchFn(OMAPS_POLYGONS_URL, {
		method: 'POST',
		headers: {
			accept: '*/*',
			'content-type': 'application/json',
			'x-requested-with': 'XMLHttpRequest',
			referer: 'https://www.omaps.net/se/Home'
		},
		body: '{}'
	});

	if (!upstream.ok) {
		throw error(502, `Omaps polygon-shapes request failed (${upstream.status})`);
	}

	const buffer = await upstream.arrayBuffer();
	return new Response(buffer, {
		status: 200,
		headers: {
			'content-type': 'application/octet-stream',
			'cache-control': 'public, max-age=3600'
		}
	});
}

export const GET: RequestHandler = async ({ fetch }) => loadOmapsPolygonShapes(fetch);
export const POST: RequestHandler = async ({ fetch }) => loadOmapsPolygonShapes(fetch);
