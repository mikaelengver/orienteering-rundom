import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const OMAPS_MAP_DETAILS_BASE_URL = 'https://www.omaps.net/se/Data/Map';

export const GET: RequestHandler = async ({ params, fetch }) => {
	const id = params.id?.trim() ?? '';
	if (!/^\d+$/.test(id)) {
		return json({ error: 'Invalid map id' }, { status: 400 });
	}

	try {
		const upstream = await fetch(`${OMAPS_MAP_DETAILS_BASE_URL}/${encodeURIComponent(id)}`, {
			method: 'POST',
			headers: {
				accept: 'application/json, text/javascript, */*; q=0.01',
				'content-type': 'application/json',
				'x-requested-with': 'XMLHttpRequest',
				referer: 'https://www.omaps.net/se/Home'
			}
		});

		const body = await upstream.text();
		if (!upstream.ok) {
			return json(
				{ error: `Omaps map details request failed (${upstream.status})`, details: body.slice(0, 500) },
				{ status: 502 }
			);
		}

		return new Response(body, {
			status: 200,
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'public, max-age=600'
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to load Omaps map details';
		return json({ error: message }, { status: 502 });
	}
};