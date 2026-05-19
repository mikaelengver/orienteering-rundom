import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const OMAPS_IMAGE_BASE_URL = 'https://www.omaps.net/se/Home/MapImage';

export const GET: RequestHandler = async ({ params, fetch }) => {
	const id = params.id?.trim() ?? '';
	if (!/^\d+$/.test(id)) {
		return json({ error: 'Invalid map id' }, { status: 400 });
	}

	try {
		const upstream = await fetch(`${OMAPS_IMAGE_BASE_URL}/${encodeURIComponent(id)}`, {
			headers: {
				accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
			}
		});

		const body = await upstream.arrayBuffer();

		return new Response(body, {
			status: upstream.status,
			headers: {
				'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
				'cache-control': 'public, max-age=3600'
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to load Omaps map image';
		return json({ error: message }, { status: 502 });
	}
};
