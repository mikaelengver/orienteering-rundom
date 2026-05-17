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
 * Detect if a pixel color is blue (water/sea areas)
 * Blue is roughly RGB(0-150, 100-200, 200-255)
 */
function isBlue(r: number, g: number, b: number): boolean {
	return r <= 150 && g >= 100 && g <= 200 && b >= 200;
}

/**
 * Detect if a pixel color is brown (contours/earth features)
 * Brown is roughly RGB(110-190, 70-140, 20-90)
 */
function isBrown(r: number, g: number, b: number): boolean {
	return r >= 110 && r <= 190 && g >= 70 && g <= 140 && b >= 20 && b <= 90;
}

/**
 * Detect if a pixel color is pink (course overlays/symbols)
 * Pink is roughly RGB(180-255, 60-180, 120-255)
 */
function isPink(r: number, g: number, b: number): boolean {
	return r >= 180 && r <= 255 && g >= 60 && g <= 180 && b >= 120 && b <= 255;
}

/**
 * Detect if a pixel color is turquoise/cyan
 * Turquoise is roughly RGB(40-140, 130-255, 130-255)
 */
function isTurquoise(r: number, g: number, b: number): boolean {
	return r >= 40 && r <= 140 && g >= 130 && g <= 255 && b >= 130 && b <= 255;
}

/**
 * Detect if a pixel color is black (buildings/houses)
 */
function isBlack(r: number, g: number, b: number): boolean {
	// Treat very dark gray as black too, since map symbols/buildings are not pure #000
	const isVeryDark = r < 90 && g < 90 && b < 90;
	const lowBrightness = r + g + b < 210;
	return isVeryDark && lowBrightness;
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

		// Check if any sampled pixels are olive green, blue, brown, or black
		for (let i = 0; i < data.length; i += 4) {
			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];
			const a = data[i + 3];

			if (a > 200) {
				// Only check non-transparent pixels
				if (
					isOliveGreen(r, g, b) ||
					isBlack(r, g, b) ||
					isBlue(r, g, b) ||
					isBrown(r, g, b) ||
					isPink(r, g, b) ||
					isTurquoise(r, g, b)
				) {
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

function getOrientation(
	a: [number, number],
	b: [number, number],
	c: [number, number]
): number {
	const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
	if (Math.abs(value) < 1e-12) return 0;
	return value > 0 ? 1 : 2;
}

function isPointOnSegment(
	a: [number, number],
	b: [number, number],
	c: [number, number]
): boolean {
	return (
		b[0] <= Math.max(a[0], c[0]) &&
		b[0] >= Math.min(a[0], c[0]) &&
		b[1] <= Math.max(a[1], c[1]) &&
		b[1] >= Math.min(a[1], c[1])
	);
}

function segmentsIntersect(
	p1: [number, number],
	q1: [number, number],
	p2: [number, number],
	q2: [number, number]
): boolean {
	const o1 = getOrientation(p1, q1, p2);
	const o2 = getOrientation(p1, q1, q2);
	const o3 = getOrientation(p2, q2, p1);
	const o4 = getOrientation(p2, q2, q1);

	if (o1 !== o2 && o3 !== o4) {
		return true;
	}

	if (o1 === 0 && isPointOnSegment(p1, p2, q1)) return true;
	if (o2 === 0 && isPointOnSegment(p1, q2, q1)) return true;
	if (o3 === 0 && isPointOnSegment(p2, p1, q2)) return true;
	if (o4 === 0 && isPointOnSegment(p2, q1, q2)) return true;

	return false;
}

function createsRouteOverlap(
	routePoints: [number, number][],
	candidate: [number, number]
): boolean {
	if (routePoints.length < 3) return false;

	const lastPoint = routePoints[routePoints.length - 1];
	for (let i = 0; i < routePoints.length - 2; i++) {
		if (segmentsIntersect(routePoints[i], routePoints[i + 1], lastPoint, candidate)) {
			return true;
		}
	}

	return false;
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

	const MIN_CONTROL_DISTANCE = 300; // Minimum 300 meters between controls

	for (let i = 0; i < numControls && attempts < maxAttempts; i++) {
		let foundValid = false;
		for (let attempt = 0; attempt < 20; attempt++) {
			const [nextLat, nextLng] = generateRandomPoint(currentLat, currentLng, maxDistanceMeters);
			const candidatePoint: [number, number] = [nextLat, nextLng];
			const routePoints: [number, number][] = [
				[startPoint.lat, startPoint.lng],
				...controlPoints.map((control) => [control.lat, control.lng] as [number, number])
			];

			// Check if distance is at least 300 meters
			const distance = getDistance(currentLat, currentLng, nextLat, nextLng);
			if (
				distance >= MIN_CONTROL_DISTANCE &&
				isValidLocation(map, nextLat, nextLng) &&
				!createsRouteOverlap(routePoints, candidatePoint)
			) {
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

		if (!foundValid && attempts < maxAttempts - 1) {
			attempts++;
			i--; // Retry this control
			continue;
		}

		attempts++;
	}

	// Goal point is at the user's GPS location
	const goalPoint: ControlPoint = {
		lat: userLat,
		lng: userLng,
		name: 'Goal',
		index: numControls + 1
	};

	// Calculate total distance
	let totalDistance = 0;
	const route: [number, number][] = [[startPoint.lat, startPoint.lng]];

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
