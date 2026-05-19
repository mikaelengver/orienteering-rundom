import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const OMAPS_MAPS_URL = 'https://www.omaps.net/se/Home/LoadMaps';

async function loadOmapsPolygons(fetchFn: typeof fetch): Promise<Response> {
	try {
		const upstream = await fetchFn(OMAPS_MAPS_URL, {
			method: 'POST',
			headers: {
				accept: 'application/json, text/javascript, */*; q=0.01',
				'content-type': 'application/json',
				'x-requested-with': 'XMLHttpRequest',
				referer: 'https://www.omaps.net/se/Home'
			},
			body: '{}'
		});

		const body = await upstream.text();
		if (!upstream.ok) {
			return json(
				{ error: `Omaps upstream request failed (${upstream.status})`, details: body.slice(0, 500) },
				{ status: 502 }
			);
		}

		return new Response(body, {
			status: 200,
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'public, max-age=300'
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to load Omaps polygons';
		return json({ error: message }, { status: 502 });
	}
}

export const GET: RequestHandler = async ({ fetch }) => {
	return loadOmapsPolygons(fetch);
};

export const POST: RequestHandler = async ({ fetch }) => {
	return loadOmapsPolygons(fetch);
};
