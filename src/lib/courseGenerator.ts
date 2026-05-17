import type L from 'leaflet';

export interface ControlPoint {
	lat: number;
	lng: number;
	name: string;
	index: number;
}

export interface OrienteeringCourse {
	startPoint: ControlPoint;
	controls: ControlPoint[];
	goalPoint: ControlPoint;
	totalDistance: number;
	route: [number, number][];
}

/**
 * Detect if a pixel color is olive green (private areas on GoKartor)
 * Olive green is roughly RGB(128-140, 136-145, 64-96)
 */
function isOliveGreen(r: number, g: number, b: number): boolean {
	return r >= 110 && r <= 150 && g >= 120 && g <= 160 && b >= 50 && b <= 100;
}

/**
 * Detect if a pixel color is black (buildings/houses)
 */
function isBlack(r: number, g: number, b: number): boolean {
	return r < 50 && g < 50 && b < 50;
}

/**
 * Check if a location is valid (not olive green, not black houses in olive areas)
 * Uses the map canvas to sample pixel colors
 */
function isValidLocation(
	map: L.Map,
	lat: number,
	lng: number,
	sampleSize: number = 3
): boolean {
	try {
		const point = map.latLngToContainerPoint([lat, lng]);
		const canvas = (map.getPane('tilePane') as HTMLElement).querySelector('canvas');

		if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
			// If canvas not available, assume location is valid
			return true;
		}

		const ctx = canvas.getContext('2d');
		if (!ctx) return true;

		// Sample a small area around the point
		const imageData = ctx.getImageData(
			Math.max(0, point.x - sampleSize),
			Math.max(0, point.y - sampleSize),
			sampleSize * 2,
			sampleSize * 2
		);

		const data = imageData.data;

		// Check if any sampled pixels are olive green or black
		for (let i = 0; i < data.length; i += 4) {
			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];
			const a = data[i + 3];

			if (a > 200) {
				// Only check non-transparent pixels
				if (isOliveGreen(r, g, b) || isBlack(r, g, b)) {
					return false;
				}
			}
		}

		return true;
	} catch (err) {
		// If color detection fails, assume location is valid
		console.warn('Color detection failed, assuming location is valid', err);
		return true;
	}
}

/**
 * Calculate distance between two lat/lng points in meters
 */
function getDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const R = 6371000; // Earth's radius in meters
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLng = ((lng2 - lng1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos((lat1 * Math.PI) / 180) *
			Math.cos((lat2 * Math.PI) / 180) *
			Math.sin(dLng / 2) *
			Math.sin(dLng / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

/**
 * Generate a random point within a specified distance from a center point
 */
function generateRandomPoint(
	centerLat: number,
	centerLng: number,
	maxDistanceMeters: number
): [number, number] {
	const earthRadius = 6371000; // meters
	const angle = Math.random() * 2 * Math.PI;
	const distance = Math.random() * maxDistanceMeters;

	const lat =
		centerLat + (Math.cos(angle) * distance) / earthRadius * (180 / Math.PI);
	const lng =
		centerLng +
		(Math.sin(angle) * distance) / (earthRadius * Math.cos((centerLat * Math.PI) / 180)) *
			(180 / Math.PI);

	return [lat, lng];
}

/**
 * Generate an orienteering course with specified parameters
 */
export function generateCourse(
	map: L.Map,
	userLat: number,
	userLng: number,
	distanceKm: number,
	numControls: number
): OrienteeringCourse {
	const controlPoints: ControlPoint[] = [];
	const maxDistanceMeters = (distanceKm * 1000) / (numControls + 1); // Distribute distance across all legs
	const maxSearchRadius = Math.min(distanceKm * 1000, 5000); // Max 5km search radius

	let attempts = 0;
	const maxAttempts = 100;

	// Generate start point (50m from user location)
	let startLat = userLat;
	let startLng = userLng;
	let startAttempts = 0;
	while (startAttempts < 20) {
		[startLat, startLng] = generateRandomPoint(userLat, userLng, 50);
		if (isValidLocation(map, startLat, startLng)) break;
		startAttempts++;
	}

	const startPoint: ControlPoint = {
		lat: startLat,
		lng: startLng,
		name: 'Start',
		index: 0
	};

	// Generate control points
	let currentLat = startLat;
	let currentLng = startLng;

	for (let i = 0; i < numControls && attempts < maxAttempts; i++) {
		let foundValid = false;
		for (let attempt = 0; attempt < 10; attempt++) {
			const [nextLat, nextLng] = generateRandomPoint(currentLat, currentLng, maxDistanceMeters);

			if (isValidLocation(map, nextLat, nextLng)) {
				controlPoints.push({
					lat: nextLat,
					lng: nextLng,
					name: `Control ${i + 1}`,
					index: i + 1
				});
				currentLat = nextLat;
				currentLng = nextLng;
				foundValid = true;
				break;
			}
		}

		if (!foundValid) {
			// Fall back to generate point without validation
			const [nextLat, nextLng] = generateRandomPoint(currentLat, currentLng, maxDistanceMeters);
			controlPoints.push({
				lat: nextLat,
				lng: nextLng,
				name: `Control ${i + 1}`,
				index: i + 1
			});
			currentLat = nextLat;
			currentLng = nextLng;
		}

		attempts++;
	}

	// Generate goal point (50m from last control)
	let goalLat = currentLat;
	let goalLng = currentLng;
	let goalAttempts = 0;
	while (goalAttempts < 20) {
		[goalLat, goalLng] = generateRandomPoint(currentLat, currentLng, 50);
		if (isValidLocation(map, goalLat, goalLng)) break;
		goalAttempts++;
	}

	const goalPoint: ControlPoint = {
		lat: goalLat,
		lng: goalLng,
		name: 'Goal',
		index: numControls + 1
	};

	// Calculate total distance
	let totalDistance = 0;
	let route: [number, number][] = [[startPoint.lat, startPoint.lng]];

	for (const control of controlPoints) {
		const dist = getDistance(route[route.length - 1][0], route[route.length - 1][1], control.lat, control.lng);
		totalDistance += dist;
		route.push([control.lat, control.lng]);
	}

	const finalDist = getDistance(route[route.length - 1][0], route[route.length - 1][1], goalPoint.lat, goalPoint.lng);
	totalDistance += finalDist;
	route.push([goalPoint.lat, goalPoint.lng]);

	return {
		startPoint,
		controls: controlPoints,
		goalPoint,
		totalDistance,
		route
	};
}

/**
 * Check if user is within distance of a control point
 */
export function isNearControl(
	userLat: number,
	userLng: number,
	controlLat: number,
	controlLng: number,
	thresholdMeters: number = 20
): boolean {
	const distance = getDistance(userLat, userLng, controlLat, controlLng);
	return distance <= thresholdMeters;
}
