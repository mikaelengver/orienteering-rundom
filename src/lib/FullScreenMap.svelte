<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type {
		Circle,
		CircleMarker,
		ImageOverlay,
		Layer,
		LeafletEvent,
		Map as LeafletMap,
		Marker,
		Polyline
	} from 'leaflet';
	import locationSvg from '$lib/assets/location-crosshairs-solid-full.svg?raw';
	import CoursePlannerModal from '$lib/CoursePlannerModal.svelte';
	import { generateCourse, isNearControl, type OrienteeringCourse } from '$lib/courseGenerator';
	import { faCircleNodes } from '@fortawesome/free-solid-svg-icons';

	type TrailPoint = {
		lat: number;
		lng: number;
		timestamp: number;
	};

	type PendingControlEdit = {
		controlIndex: number;
		draftLat: number;
		draftLng: number;
	};

	type OMapsPolygon = {
		id: number;
		hasImage: boolean;
		area: number;
		largeThumbnailUrl: string;
		south: number;
		north: number;
		west: number;
		east: number;
	};

	let mapContainer: HTMLDivElement | undefined;
	let error: string | null = $state(null);
	let plannerModal: CoursePlannerModal | undefined;
	let activeCourse: OrienteeringCourse | null = $state(null);
	let foundControls: SvelteSet<number> = new SvelteSet<number>();
	let userPosition: { lat: number; lng: number } | null = $state(null);
	let isRecordingTrail = $state(false);
	let recordedTrail: TrailPoint[] = $state([]);
	let trailPolyline: Polyline | null = null;
	let gpxDownloadUrl: string | null = $state(null);
	let gpxDownloadName: string = $state('trail.gpx');
	let pendingControlEdit: PendingControlEdit | null = $state(null);
	let acceptControlEdit = $state<() => void>(() => {});
	let rejectControlEdit = $state<() => void>(() => {});


	const MAP_CONFIGS = {
		osm: {
			url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
			attribution: '&copy; OpenStreetMap contributors',
			name: 'OpenStreetMap'
		},
		cyclosm: {
			url: 'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
			attribution: '&copy; OpenStreetMap contributors | &copy; CyclOSM',
			name: 'CyclOSM'
		},
		gokartor: {
			url: 'https://kartor.gokartor.se/topo/{z}/{y}/{x}.png',
			attribution: '&copy; GoKartor AB',
			name: 'GoKartor'
		},
		stockholmGra: {
			url: 'https://kartor.stockholm.se/bios/wms/app/baggis/web/WMS_STHLM_STOCKHOLMSKARTA_GRA',
			attribution: 'Kartbakgrund: Stockholms stad (WMS)',
			name: 'Stockholm Karta'
		}
	};

	const LOCATION_MAX_AGE_MS = 5000;
	const LOCATION_TIMEOUT_MS = 10000;
	const TRAIL_LOG_INTERVAL_MS = 3000; // Log position every 3 seconds
	const OMAPS_REFRESH_DEBOUNCE_MS = 160;
	const OMAPS_HIGHRES_MIN_ZOOM = 15;
	const OMAPS_MAX_VISIBLE_OVERLAYS = 12;
	const OMAPS_LOWRES_OPACITY = 0.5;
	const OMAPS_HIGHRES_OPACITY = 1;
	const OMAPS_HIGHRES_IMAGE_BASE_URL = 'https://www.omaps.net/se/Home/MapImage';

	let map!: LeafletMap;
	let isMapReady = false;
	let drawCourse: (course: OrienteeringCourse) => void = () => {};
	let drawnCourseLayers: Layer[] = [];
	let lastTrailLogTime = 0;
	const planIconPath = String(faCircleNodes.icon[4]);
	const planIconWidth = Number(faCircleNodes.icon[0]);
	const planIconHeight = Number(faCircleNodes.icon[1]);

	type SerializedCourse = {
		v: 1;
		startPoint: OrienteeringCourse['startPoint'];
		controls: OrienteeringCourse['controls'];
		goalPoint: OrienteeringCourse['goalPoint'];
		totalDistance: number;
		route: [number, number][];
	};

	function serializeCourse(course: OrienteeringCourse): string {
		const fmt = (value: number) => Number(value.toFixed(6));
		const start = `${fmt(course.startPoint.lat)},${fmt(course.startPoint.lng)}`;
		const controls = course.controls
			.map(
				(control) =>
					`${control.index},${encodeURIComponent(control.name)},${fmt(control.lat)},${fmt(control.lng)}`
			)
			.join('~');
		const goal = `${course.goalPoint.index},${fmt(course.goalPoint.lat)},${fmt(course.goalPoint.lng)}`;
		const route = course.route.map(([lat, lng]) => `${fmt(lat)},${fmt(lng)}`).join('~');

		return `v=1|s=${start}|c=${controls}|g=${goal}|d=${Math.round(course.totalDistance)}|r=${route}`;
	}

	function deserializeCourse(serialized: string): OrienteeringCourse | null {
		if (serialized.startsWith('v=1|')) {
			try {
				const sections = serialized.split('|').reduce(
					(acc, part) => {
						const [key, ...rest] = part.split('=');
						if (key) {
							acc[key] = rest.join('=');
						}
						return acc;
					},
					{} as Record<string, string>
				);

				const [startLat, startLng] = (sections.s ?? '').split(',').map(Number);
				const controls = (sections.c ?? '')
					.split('~')
					.filter(Boolean)
					.map((entry) => {
						const [indexRaw, nameRaw, latRaw, lngRaw] = entry.split(',');
						return {
							index: Number(indexRaw),
							name: decodeURIComponent(nameRaw ?? ''),
							lat: Number(latRaw),
							lng: Number(lngRaw)
						};
					});
				const [goalIndex, goalLat, goalLng] = (sections.g ?? '').split(',').map(Number);
				const totalDistance = Number(sections.d ?? '0');
				const route = (sections.r ?? '')
					.split('~')
					.filter(Boolean)
					.map((entry) => {
						const [latRaw, lngRaw] = entry.split(',');
						return [Number(latRaw), Number(lngRaw)] as [number, number];
					});

				if (
					!Number.isFinite(startLat) ||
					!Number.isFinite(startLng) ||
					controls.some(
						(control) =>
							!Number.isFinite(control.index)
							|| !Number.isFinite(control.lat)
							|| !Number.isFinite(control.lng)
					) ||
					!Number.isFinite(goalIndex) ||
					!Number.isFinite(goalLat) ||
					!Number.isFinite(goalLng) ||
					!Number.isFinite(totalDistance) ||
					route.length === 0
				) {
					return null;
				}

				return {
					startPoint: { index: 0, name: 'Start', lat: startLat, lng: startLng },
					controls,
					goalPoint: { index: goalIndex, name: 'Goal', lat: goalLat, lng: goalLng },
					totalDistance,
					route
				};
			} catch {
				return null;
			}
		}

		// Legacy format fallback (base64url JSON)
		try {
			const padded = serialized + '==='.slice((serialized.length + 3) % 4);
			const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
			const parsed = JSON.parse(atob(base64)) as Partial<SerializedCourse>;

			if (
				parsed.v !== 1 ||
				!parsed.startPoint ||
				!Array.isArray(parsed.controls) ||
				!parsed.goalPoint ||
				typeof parsed.totalDistance !== 'number' ||
				!Array.isArray(parsed.route)
			) {
				return null;
			}

			return {
				startPoint: parsed.startPoint,
				controls: parsed.controls,
				goalPoint: parsed.goalPoint,
				totalDistance: parsed.totalDistance,
				route: parsed.route as [number, number][]
			};
		} catch {
			return null;
		}
	}

	function updateCourseInUrl(course: OrienteeringCourse): void {
		const url = new URL(window.location.href);
		url.searchParams.set('course', serializeCourse(course));
		window.history.replaceState({}, '', url);
	}

	function loadCourseFromUrl(): OrienteeringCourse | null {
		const url = new URL(window.location.href);
		const serialized = url.searchParams.get('course');
		if (!serialized) return null;
		return deserializeCourse(serialized);
	}

	function handlePlanCourse(event: CustomEvent<{ kilometers: number; controls: number }>) {
		if (!isMapReady) {
			error = 'Map is not ready yet.';
			return;
		}

		rejectControlEdit();

		const detail = event.detail;
		const { kilometers, controls } = detail;

		if (!userPosition) {
			error = 'Please enable location tracking first.';
			return;
		}

		try {
			activeCourse = generateCourse(map, userPosition.lat, userPosition.lng, kilometers, controls);
			foundControls = new SvelteSet<number>();
			drawCourse(activeCourse);
			updateCourseInUrl(activeCourse);
			error = null;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to generate course';
		}
	}

	function generateGPX(trail: TrailPoint[]): string {
		if (trail.length === 0) return '';

		const bounds = trail.reduce(
			(acc, point) => ({
				minLat: Math.min(acc.minLat, point.lat),
				maxLat: Math.max(acc.maxLat, point.lat),
				minLon: Math.min(acc.minLon, point.lng),
				maxLon: Math.max(acc.maxLon, point.lng)
			}),
			{ minLat: trail[0].lat, maxLat: trail[0].lat, minLon: trail[0].lng, maxLon: trail[0].lng }
		);

		const trkpts = trail
			.map(
				(point) =>
					`    <trkpt lat="${point.lat.toFixed(6)}" lon="${point.lng.toFixed(6)}">
      <time>${new Date(point.timestamp).toISOString()}</time>
    </trkpt>`
			)
			.join('\n');

		return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Orienteering Rundom"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1
                         http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>Trail Recording</name>
    <time>${new Date().toISOString()}</time>
    <bounds minlat="${bounds.minLat.toFixed(6)}" minlon="${bounds.minLon.toFixed(6)}" maxlat="${bounds.maxLat.toFixed(6)}" maxlon="${bounds.maxLon.toFixed(6)}" />
  </metadata>
  <trk>
    <name>Recorded Trail</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
	}

	function updateTrailVisualization(trail: TrailPoint[]): void {
		if (!isMapReady) return;

		// Remove old polyline
		if (trailPolyline) {
			map.removeLayer(trailPolyline);
		}

		// Create new polyline from trail points
		if (trail.length > 0) {
			const latLngs = trail.map((point) => [point.lat, point.lng] as [number, number]);
			// Access Leaflet dynamically to avoid UMD global reference
			import('leaflet').then((leaflet) => {
				const L = leaflet.default;
				trailPolyline = L.polyline(latLngs, {
					color: '#ffeb3b',
					weight: 1,
					opacity: 0.5,
					className: 'trail-line'
				}).addTo(map);
			});
		}
	}

	function setGpxDownloadFromTrail(trail: TrailPoint[]): void {
		if (gpxDownloadUrl) {
			URL.revokeObjectURL(gpxDownloadUrl);
			gpxDownloadUrl = null;
		}

		if (trail.length === 0) return;

		const gpxContent = generateGPX(trail);
		const blob = new Blob([gpxContent], { type: 'application/gpx+xml' });
		gpxDownloadUrl = URL.createObjectURL(blob);
		gpxDownloadName = `trail-${new Date().toISOString().slice(0, 10)}.gpx`;
	}

	function extractOmapsList(payload: unknown): unknown[] {
		if (Array.isArray(payload)) return payload;
		if (!payload || typeof payload !== 'object') return [];

		const source = payload as Record<string, unknown>;
		const keys = ['maps', 'items', 'data', 'result', 'value'];
		for (const key of keys) {
			if (Array.isArray(source[key])) {
				return source[key] as unknown[];
			}
		}

		return [];
	}

	function boundsOverlap(
		a: { south: number; north: number; west: number; east: number },
		b: { south: number; north: number; west: number; east: number }
	): boolean {
		return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
	}

	onMount(() => {
		let locationWatchId: number | null = null;
		let mountedMap: LeafletMap | null = null;
		let controlEditMarker: Marker | null = null;
		let omapsRefreshTimeout: ReturnType<typeof setTimeout> | null = null;

		const initializeMap = async () => {
			if (!mapContainer) return;

			try {
			// Dynamically import Leaflet
			const leaflet = await import('leaflet');
			const L = leaflet.default;

			const clearControlEditMarker = () => {
				if (controlEditMarker) {
					if (map.hasLayer(controlEditMarker)) {
						map.removeLayer(controlEditMarker);
					}
					controlEditMarker = null;
				}
			};

			rejectControlEdit = () => {
				clearControlEditMarker();
				pendingControlEdit = null;
				error = null;
				if (activeCourse) {
					drawCourse(activeCourse);
				}
			};

			acceptControlEdit = () => {
				const course = activeCourse;
				const edit = pendingControlEdit;
				if (!course || !edit) return;

				const control = course.controls.find((item) => item.index === edit.controlIndex);
				if (!control) {
					rejectControlEdit();
					return;
				}

				const oldLat = control.lat;
				const oldLng = control.lng;
				control.lat = edit.draftLat;
				control.lng = edit.draftLng;

				const routeIndexByControlIndex = control.index;
				if (routeIndexByControlIndex > 0 && routeIndexByControlIndex < course.route.length - 1) {
					course.route[routeIndexByControlIndex] = [edit.draftLat, edit.draftLng];
				} else {
					const fallbackRouteIndex = course.route.findIndex(
						([lat, lng], index) =>
							index > 0
							&& index < course.route.length - 1
							&& Math.abs(lat - oldLat) < 0.000001
							&& Math.abs(lng - oldLng) < 0.000001
					);
					if (fallbackRouteIndex !== -1) {
						course.route[fallbackRouteIndex] = [edit.draftLat, edit.draftLng];
					}
				}

				clearControlEditMarker();
				pendingControlEdit = null;
				drawCourse(course);
				updateCourseInUrl(course);
				error = null;
			};

			const beginControlEdit = (control: OrienteeringCourse['controls'][number]) => {
				if (!activeCourse) return;

				rejectControlEdit();

				const editIcon = L.divIcon({
					className: 'control-edit-drag-icon',
					html: '<div class="control-edit-drag-dot"></div>',
					iconSize: [30, 30],
					iconAnchor: [15, 15]
				});

				controlEditMarker = L.marker([control.lat, control.lng], {
					icon: editIcon,
					draggable: true,
					autoPan: true,
					keyboard: false
				}).addTo(map);

				const syncDraft = () => {
					if (!controlEditMarker) return;
					const draft = controlEditMarker.getLatLng();
					pendingControlEdit = {
						controlIndex: control.index,
						draftLat: draft.lat,
						draftLng: draft.lng
					};
				};

				syncDraft();
				controlEditMarker.on('drag dragend', syncDraft);
				error = 'Drag control and confirm with Accept or Reject.';
			};

			// Import proj4 and proj4leaflet
			const proj4Module = await import('proj4');
			const proj4 = proj4Module.default;

			// Set globals for proj4leaflet
			const projWindow = window as Window & { L?: typeof L; proj4?: typeof proj4 };
			projWindow.L = L;
			projWindow.proj4 = proj4;

			// Import proj4leaflet
			await import('proj4leaflet');

			// Get the extended L with Proj
			const LWithProj = L as typeof L & {
				Proj?: {
					CRS: new (
						code: string,
						proj4def: string,
						options: { resolutions: number[]; origin: [number, number] }
					) => LeafletMap['options']['crs'];
				};
			};

			// Create GoKartor CRS if proj4leaflet is available
			let goKartorCrs = null;
			if (LWithProj.Proj) {
				goKartorCrs = new LWithProj.Proj.CRS(
					'EPSG:3006',
					'+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
					{
						resolutions: [16384, 8192, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1, 0.5],
						origin: [265000, 7680000]
					}
				);
			}

			const defaultCrs = L.CRS.EPSG3857;
			const initialCrs = goKartorCrs ?? defaultCrs;
			const initialMaxZoom = goKartorCrs ? 15 : 19;
			let isOmapsLayerActive = false;
			let omapsPolygons: OMapsPolygon[] | null = null;
			let omapsPolygonsRequest: Promise<OMapsPolygon[]> | null = null;
			const omapsOverlaysById = new SvelteMap<number, ImageOverlay>();
			const omapsOverlayUrls = new SvelteMap<number, string>();

			// Initialize map centered on the requested location in Älvsjö
			map = L.map(mapContainer, {
				zoomControl: true,
				minZoom: 4,
				maxZoom: initialMaxZoom,
				crs: initialCrs,
				zoomAnimation: false,
				markerZoomAnimation: false
			}).setView([59.2754, 17.9819], 12);
			isMapReady = true;

			let usingGoKartorCrs = !!goKartorCrs;
			if (usingGoKartorCrs) {
				map.setMaxZoom(14);
			}

			map.whenReady(() => {
				map.invalidateSize();
			});

			// Create base layers
			const osmLayer = L.tileLayer(MAP_CONFIGS.osm.url, {
				attribution: MAP_CONFIGS.osm.attribution,
				maxZoom: 19
			});

			const cyclosmLayer = L.tileLayer(MAP_CONFIGS.cyclosm.url, {
				attribution: MAP_CONFIGS.cyclosm.attribution,
				maxZoom: 19
			});

			const goKartorLayer = L.tileLayer(MAP_CONFIGS.gokartor.url, {
				attribution: MAP_CONFIGS.gokartor.attribution,
				maxZoom: 14
			});

			const omapsBackgroundLayer = L.tileLayer(MAP_CONFIGS.osm.url, {
				attribution: MAP_CONFIGS.osm.attribution,
				maxZoom: 19
			});
			const omapsOverlayGroup = L.layerGroup();
			const omapsCompositeLayer = L.layerGroup([omapsBackgroundLayer, omapsOverlayGroup]);

			const stockholmLayer = L.tileLayer.wms(MAP_CONFIGS.stockholmGra.url, {
				format: 'image/png',
				transparent: false,
				version: '1.1.1',
				attribution: MAP_CONFIGS.stockholmGra.attribution,
				maxZoom: 19
			});

			// Add GoKartor as default layer
			goKartorLayer.addTo(map);
			map.invalidateSize();

			const clearOmapsOverlays = () => {
				for (const overlay of omapsOverlaysById.values()) {
					omapsOverlayGroup.removeLayer(overlay);
				}
				omapsOverlaysById.clear();
				omapsOverlayUrls.clear();
				if (omapsRefreshTimeout) {
					clearTimeout(omapsRefreshTimeout);
					omapsRefreshTimeout = null;
				}
			};

			const loadOmapsPolygons = async (): Promise<OMapsPolygon[]> => {
				if (omapsPolygons) return omapsPolygons;
				if (omapsPolygonsRequest) return omapsPolygonsRequest;

				omapsPolygonsRequest = (async () => {
					const response = await fetch('/api/omaps/polygons');
					if (!response.ok) {
						throw new Error(`Omaps polygon request failed (${response.status})`);
					}

					const payload = (await response.json()) as unknown;
					const polygons = extractOmapsList(payload)
						.map((entry) => {
							if (!entry || typeof entry !== 'object') return null;
							const source = entry as Record<string, unknown>;
							const polygon: OMapsPolygon = {
								id: Number(source.id),
								hasImage: Boolean(source.hasImage),
								area: Number(source.area ?? 0),
								largeThumbnailUrl: String(source.largeThumbnailUrl ?? ''),
								south: Number(source.south),
								north: Number(source.north),
								west: Number(source.west),
								east: Number(source.east)
							};
							if (
								!Number.isFinite(polygon.id)
								|| !Number.isFinite(polygon.south)
								|| !Number.isFinite(polygon.north)
								|| !Number.isFinite(polygon.west)
								|| !Number.isFinite(polygon.east)
							) {
								return null;
							}
							return polygon;
						})
						.filter((polygon): polygon is OMapsPolygon => polygon !== null);

					omapsPolygons = polygons;
					return polygons;
				})().finally(() => {
					omapsPolygonsRequest = null;
				});

				return omapsPolygonsRequest;
			};

			const refreshOmapsOverlays = async () => {
				if (!isOmapsLayerActive) return;

				const mapBounds = map.getBounds();
				const viewport = {
					south: mapBounds.getSouth(),
					north: mapBounds.getNorth(),
					west: mapBounds.getWest(),
					east: mapBounds.getEast()
				};

				try {
					const zoom = map.getZoom();
					const polygons = await loadOmapsPolygons();
					const visiblePolygons = polygons
						.filter((polygon) => polygon.hasImage && boundsOverlap(viewport, polygon))
						.sort((a, b) => a.area - b.area)
						.slice(0, OMAPS_MAX_VISIBLE_OVERLAYS);

					const visibleIds = new SvelteSet<number>();
					for (const polygon of visiblePolygons) {
						visibleIds.add(polygon.id);
						const useHighRes = zoom >= OMAPS_HIGHRES_MIN_ZOOM;
						const imageUrl =
							useHighRes
								? `${OMAPS_HIGHRES_IMAGE_BASE_URL}/${polygon.id}`
								: polygon.largeThumbnailUrl;
						const imageBounds = L.latLngBounds(
							[polygon.south, polygon.west],
							[polygon.north, polygon.east]
						);

						const existing = omapsOverlaysById.get(polygon.id);
						if (existing) {
							if (omapsOverlayUrls.get(polygon.id) !== imageUrl) {
								existing.setUrl(imageUrl);
								omapsOverlayUrls.set(polygon.id, imageUrl);
							}
							existing.setBounds(imageBounds);
							existing.setOpacity(useHighRes ? OMAPS_HIGHRES_OPACITY : OMAPS_LOWRES_OPACITY);
							continue;
						}

						const overlay = L.imageOverlay(imageUrl, imageBounds, {
							opacity: useHighRes ? OMAPS_HIGHRES_OPACITY : OMAPS_LOWRES_OPACITY,
							interactive: false,
							className: 'omaps-image-overlay'
						});
						overlay.addTo(omapsOverlayGroup);
						omapsOverlaysById.set(polygon.id, overlay);
						omapsOverlayUrls.set(polygon.id, imageUrl);
					}

					for (const [id, overlay] of omapsOverlaysById) {
						if (visibleIds.has(id)) continue;
						omapsOverlayGroup.removeLayer(overlay);
						omapsOverlaysById.delete(id);
						omapsOverlayUrls.delete(id);
					}
				} catch {
					if (!error) {
						error = 'Could not load Omaps overlays.';
					}
				}
			};

			const scheduleOmapsOverlayRefresh = () => {
				if (!isOmapsLayerActive) return;
				if (omapsRefreshTimeout) {
					clearTimeout(omapsRefreshTimeout);
				}
				omapsRefreshTimeout = setTimeout(() => {
					void refreshOmapsOverlays();
				}, OMAPS_REFRESH_DEBOUNCE_MS);
			};

			// Create layer control
			const baseLayers = {
				GoKartor: goKartorLayer,
				Omaps: omapsCompositeLayer,
				OpenStreetMap: osmLayer,
				CyclOSM: cyclosmLayer,
				Stockholm: stockholmLayer
			};

			const layerControl = L.control.layers(baseLayers, {}, { position: 'topleft' });
			layerControl.addTo(map);

			// Location tracking state
			let userLocationMarker: CircleMarker | null = null;
			let userAccuracyCircle: Circle | null = null;
			let isLocationTrackingActive = false;
			let locationButton: HTMLButtonElement | null = null;
			mountedMap = map;

			const updateUserPosition = (position: GeolocationPosition) => {
				const { latitude, longitude, accuracy } = position.coords;
				const latLng = L.latLng(latitude, longitude);

				if (!userLocationMarker) {
					userLocationMarker = L.circleMarker(latLng, {
						radius: 8,
						color: '#1d4ed8',
						fillColor: '#3b82f6',
						fillOpacity: 0.9,
						weight: 2
					}).addTo(map);
				} else {
					userLocationMarker.setLatLng(latLng);
				}

				if (!userAccuracyCircle) {
					userAccuracyCircle = L.circle(latLng, {
						radius: accuracy,
						color: '#60a5fa',
						fillColor: '#93c5fd',
						fillOpacity: 0.2,
						weight: 1
					}).addTo(map);
				} else {
					userAccuracyCircle.setLatLng(latLng);
					userAccuracyCircle.setRadius(accuracy);
				}

				if (isLocationTrackingActive) {
					const targetZoom = Math.min(map.getMaxZoom(), 15);
					map.flyTo(latLng, targetZoom, { duration: 1 });
				}
			};

			const startLocationWatch = () => {
				if (!isLocationTrackingActive && 'geolocation' in navigator) {
					isLocationTrackingActive = true;
					if (locationButton) {
						locationButton.classList.add('active');
					}

					locationWatchId = navigator.geolocation.watchPosition(
						updateUserPosition,
						(locationError) => {
							const message =
								locationError.code === locationError.PERMISSION_DENIED
									? 'Location permission denied. Enable location access to show your position.'
									: locationError.code === locationError.POSITION_UNAVAILABLE
										? 'Your position could not be found. Check location settings and try again.'
										: 'Could not fetch your position right now.';
							error = message;
						},
						{
							enableHighAccuracy: true,
							maximumAge: LOCATION_MAX_AGE_MS,
							timeout: LOCATION_TIMEOUT_MS
						}
						);
					}
				};

				const stopLocationWatch = () => {
					if (!isLocationTrackingActive) return;
					isLocationTrackingActive = false;
					if (locationButton) {
						locationButton.classList.remove('active');
						locationButton.title = 'Show and follow my position';
						locationButton.setAttribute('aria-pressed', 'false');
					}
					if (locationWatchId !== null) {
						navigator.geolocation.clearWatch(locationWatchId);
						locationWatchId = null;
					}
					if (userLocationMarker) {
						try {
							map.removeLayer(userLocationMarker);
						} catch {
							// Ignore if marker has already been removed
						}
						userLocationMarker = null;
					}
					if (userAccuracyCircle) {
						try {
							map.removeLayer(userAccuracyCircle);
						} catch {
							// Ignore if circle has already been removed
						}
						userAccuracyCircle = null;
					}
				};

			// Create location control with toggle behavior and crosshair icon
			const LocationControl = L.Control.extend({
				onAdd: () => {
					const container = L.DomUtil.create('div', 'leaflet-bar');
					locationButton = L.DomUtil.create('button', 'map-location-button', container) as HTMLButtonElement;
					locationButton.type = 'button';
					locationButton.title = 'Show and follow my position';
					locationButton.setAttribute('aria-label', 'Toggle follow my position');
					locationButton.setAttribute('aria-pressed', 'false');
locationButton.innerHTML = locationSvg.replace('<svg', '<svg width="18" height="18" fill="currentColor"');

					L.DomEvent.disableClickPropagation(container);
					const onLocationButtonClick = () => {
						if (!isLocationTrackingActive) {
							startLocationWatch();
							if (locationButton) {
								locationButton.title = 'Stop following my position';
								locationButton.setAttribute('aria-pressed', 'true');
							}
						} else {
							stopLocationWatch();
						}
					};
					L.DomEvent.on(locationButton, 'click', onLocationButtonClick);

					return container;
				}
			});

			const locationControl = new LocationControl({ position: 'topright' });
			locationControl.addTo(map);

			// Create planner control button
			const PlannerControl = L.Control.extend({
				onAdd: () => {
					const container = L.DomUtil.create('div', 'leaflet-bar');
					const planButton = L.DomUtil.create(
						'button',
						'map-planner-button',
						container
					) as HTMLButtonElement;
					planButton.type = 'button';
					planButton.title = 'Plan orienteering course';
					planButton.setAttribute('aria-label', 'Plan course');
					planButton.innerHTML =
						`<svg viewBox="0 0 ${planIconWidth} ${planIconHeight}" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${planIconPath}"/></svg>`;

					L.DomEvent.disableClickPropagation(container);
					L.DomEvent.on(planButton, 'click', () => {
						plannerModal?.openModal();
					});

					return container;
				}
			});

			const plannerControl = new PlannerControl({ position: 'topright' });
			plannerControl.addTo(map);

				// Create trail recording control button
				const TrailControl = L.Control.extend({
					onAdd: () => {
						const container = L.DomUtil.create('div', 'leaflet-bar');
						const trailButton = L.DomUtil.create(
							'button',
							'map-trail-button',
							container
						) as HTMLButtonElement;
						trailButton.type = 'button';
						trailButton.title = 'Toggle trail recording';
						trailButton.setAttribute('aria-label', 'Toggle trail recording');
						trailButton.setAttribute('aria-pressed', 'false');
						trailButton.innerHTML =
							'<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">'
							+ '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm0-14c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6z"/>'
							+ '</svg>';

						L.DomEvent.disableClickPropagation(container);
						L.DomEvent.on(trailButton, 'click', () => {
							isRecordingTrail = !isRecordingTrail;
							trailButton.setAttribute('aria-pressed', String(isRecordingTrail));
							if (isRecordingTrail) {
								if (gpxDownloadUrl) {
									URL.revokeObjectURL(gpxDownloadUrl);
									gpxDownloadUrl = null;
								}
								recordedTrail = [];
								lastTrailLogTime = 0;
								trailButton.classList.add('active');
							} else {
								trailButton.classList.remove('active');
								setGpxDownloadFromTrail(recordedTrail);
							}
						});

						return container;
					}
				});

				const trailControl = new TrailControl({ position: 'topright' });
				trailControl.addTo(map);



			map.on('baselayerchange', (event: LeafletEvent & { layer: Layer }) => {
				const currentZoom = map.getZoom();
				const center = map.getCenter();
				const nextLayerUsesGoKartorProjection = event.layer === goKartorLayer;

				if (nextLayerUsesGoKartorProjection && !usingGoKartorCrs && goKartorCrs) {
					const nextZoom = Math.max(6, Math.min(15, currentZoom - 3));
					map.options.crs = goKartorCrs;
					map.setView(center, nextZoom, { animate: false });
					map.invalidateSize(false);
					map.setMaxZoom(14);
					usingGoKartorCrs = true;
				} else if (nextLayerUsesGoKartorProjection && !goKartorCrs) {
					error = 'GoKartor displayed without projection (Proj4Leaflet not available).';
				} else if (usingGoKartorCrs && !nextLayerUsesGoKartorProjection) {
					const nextZoom = Math.max(3, Math.min(19, currentZoom + 3));
					map.options.crs = defaultCrs;
					map.setView(center, nextZoom, { animate: false });
					map.invalidateSize(false);
					map.setMaxZoom(19);
					usingGoKartorCrs = false;
				}

				isOmapsLayerActive = event.layer === omapsCompositeLayer;
				if (isOmapsLayerActive) {
					scheduleOmapsOverlayRefresh();
				} else {
					clearOmapsOverlays();
				}
			});

			// Play checkpoint found sound
			function playCheckpointSound() {
				const AudioContextCtor = window.AudioContext || (window as Window & {
					webkitAudioContext?: typeof AudioContext;
				}).webkitAudioContext;
				if (!AudioContextCtor) return;

				const audioContext = new AudioContextCtor();
				const now = audioContext.currentTime;

				// Create a beeping sound
				const osc = audioContext.createOscillator();
				const gain = audioContext.createGain();

				osc.connect(gain);
				gain.connect(audioContext.destination);

				osc.frequency.value = 800;
				osc.type = 'sine';

				gain.gain.setValueAtTime(0.3, now);
				gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);

				osc.start(now);
				osc.stop(now + 0.2);
			}

			// Draw course on map
			const drawCourseImpl = (course: OrienteeringCourse) => {
				// Remove previously drawn course layers only
				for (const layer of drawnCourseLayers) {
					if (map.hasLayer(layer)) {
						map.removeLayer(layer);
					}
				}
				drawnCourseLayers = [];

				// Draw route as clipped segments so lines touch marker borders, not centers.
				const getRoutePointRadiusPx = (index: number) => {
					if (index === 0) return 14; // Start triangle approximate half-size
					if (index === course.route.length - 1) return 20; // Goal outer circle radius
					return 12; // Control circle radius
				};

				for (let i = 0; i < course.route.length - 1; i += 1) {
					const from = L.latLng(course.route[i][0], course.route[i][1]);
					const to = L.latLng(course.route[i + 1][0], course.route[i + 1][1]);
					const fromPt = map.latLngToLayerPoint(from);
					const toPt = map.latLngToLayerPoint(to);
					const dx = toPt.x - fromPt.x;
					const dy = toPt.y - fromPt.y;
					const dist = Math.hypot(dx, dy);

					if (dist <= 0) continue;

					const fromRadius = getRoutePointRadiusPx(i);
					const toRadius = getRoutePointRadiusPx(i + 1);
					const ux = dx / dist;
					const uy = dy / dist;

					const clippedFrom = L.point(fromPt.x + ux * fromRadius, fromPt.y + uy * fromRadius);
					const clippedTo = L.point(toPt.x - ux * toRadius, toPt.y - uy * toRadius);

					const segment = L.polyline(
						[map.layerPointToLatLng(clippedFrom), map.layerPointToLatLng(clippedTo)],
						{
							color: '#ec4899',
							weight: 5,
							opacity: 0.9,
							dashArray: '',
							className: 'course-route'
						}
					);

					segment.addTo(map);
					drawnCourseLayers.push(segment);
				}

				// Draw start point as an outlined equilateral triangle icon
				const startIcon = L.divIcon({
					className: 'course-start-icon',
					html: '<svg viewBox="0 0 100 87" width="32" height="29" aria-hidden="true"><polygon points="50,4 96,83 4,83" fill="none" stroke="#ec4899" stroke-width="10" stroke-linejoin="round"/></svg>',
					iconSize: [32, 29],
					iconAnchor: [16, 14]
				});
				const startMarker = L.marker([course.startPoint.lat, course.startPoint.lng], {
					icon: startIcon,
					interactive: false,
					keyboard: false
				});
				startMarker.bindPopup('Start');
				startMarker.addTo(map);
				drawnCourseLayers.push(startMarker);

				// Draw control points
				for (const control of course.controls) {
					const isFound = foundControls.has(control.index);
					const marker = L.circleMarker([control.lat, control.lng], {
						radius: 12,
						color: '#ec4899',
						fillColor: 'transparent',
						fillOpacity: 0,
						weight: 3,
						className: 'course-marker',
						interactive: true,
						bubblingMouseEvents: false
					});
					marker.bindPopup(`${control.name}${isFound ? ' ✓' : ''}`);
					marker.bindTooltip(String(control.index), {
						permanent: true,
						direction: 'right',
						offset: [18, 0],
						className: 'course-control-label',
						interactive: false
					});
					marker.addTo(map);
					marker.on('dblclick', (event) => {
						L.DomEvent.stop(event);
						beginControlEdit(control);
					});
					drawnCourseLayers.push(marker);
				}

				// Draw goal point as double circle
				const outerCircle = L.circleMarker([course.goalPoint.lat, course.goalPoint.lng], {
					radius: 20,
					color: '#ec4899',
					fillColor: 'transparent',
					fillOpacity: 0,
					weight: 3,
					className: 'course-marker',
					interactive: false,
					bubblingMouseEvents: false
				});
				outerCircle.bindPopup('Goal');
				outerCircle.addTo(map);
				drawnCourseLayers.push(outerCircle);

				const innerCircle = L.circleMarker([course.goalPoint.lat, course.goalPoint.lng], {
					radius: 10,
					color: '#ec4899',
					fillColor: 'transparent',
					fillOpacity: 0,
					weight: 3,
					className: 'course-marker',
					interactive: false,
					bubblingMouseEvents: false
				});
				innerCircle.bindPopup('Goal');
				innerCircle.addTo(map);
				drawnCourseLayers.push(innerCircle);
			};

			// Assign drawCourse to outer scope
			drawCourse = drawCourseImpl;

			// Keep control rendering locked to map coordinates after map movements
			map.on('zoomend moveend', () => {
				if (activeCourse) {
					drawCourse(activeCourse);
				}
				if (isOmapsLayerActive) {
					scheduleOmapsOverlayRefresh();
				}
			});

			// Load and draw a shared course from URL if present
			const sharedCourse = loadCourseFromUrl();
			if (sharedCourse) {
				activeCourse = sharedCourse;
				foundControls = new SvelteSet<number>();
				drawCourse(sharedCourse);
			}

			// Trail logging from location updates
				if (locationWatchId !== null) {
					navigator.geolocation.clearWatch(locationWatchId);
				}

				locationWatchId = navigator.geolocation.watchPosition(
					(position) => {
						const { latitude, longitude } = position.coords;
						userPosition = { lat: latitude, lng: longitude };

						// Log position to trail if recording
						const now = Date.now();
						if (isRecordingTrail && now - lastTrailLogTime >= TRAIL_LOG_INTERVAL_MS) {
							recordedTrail.push({
								lat: latitude,
								lng: longitude,
								timestamp: now
							});
							lastTrailLogTime = now;
							updateTrailVisualization(recordedTrail);
						}

						// Check proximity to controls (from original setupLocationTracking)
						const currentCourse = activeCourse;
						const currentPosition = userPosition;
						if (!currentCourse || !currentPosition) return;

						// Check start point
						if (
							!foundControls.has(0) &&
							isNearControl(
								currentPosition.lat,
								currentPosition.lng,
								currentCourse.startPoint.lat,
								currentCourse.startPoint.lng,
								20
							)
						) {
							foundControls.add(0);
							playCheckpointSound();
						}

						// Check controls
						for (const control of currentCourse.controls) {
							if (
								!foundControls.has(control.index) &&
								isNearControl(
									currentPosition.lat,
									currentPosition.lng,
									control.lat,
									control.lng,
									20
								)
							) {
								foundControls.add(control.index);
								playCheckpointSound();
							}
						}

						// Check goal
						const goalIndex = currentCourse.goalPoint.index;
						if (
							!foundControls.has(goalIndex) &&
							isNearControl(
								currentPosition.lat,
								currentPosition.lng,
								currentCourse.goalPoint.lat,
								currentCourse.goalPoint.lng,
								20
							)
						) {
							foundControls.add(goalIndex);
							playCheckpointSound();
							error = 'Course completed! 🎉';
						}
					},
					(locationError) => {
						const message =
							locationError.code === locationError.PERMISSION_DENIED
								? 'Location permission denied. Enable location access to show your position.'
								: locationError.code === locationError.POSITION_UNAVAILABLE
									? 'Your position could not be found. Check location settings and try again.'
									: 'Could not fetch your position right now.';
						error = message;
					},
					{
						enableHighAccuracy: true,
						maximumAge: LOCATION_MAX_AGE_MS,
						timeout: LOCATION_TIMEOUT_MS
					}
				);

			} catch (err) {
				error = err instanceof Error ? err.message : 'An unknown error occurred';
				console.error('Map initialization error:', err);
			}
		};

		void initializeMap();

		return () => {
			if (omapsRefreshTimeout) {
				clearTimeout(omapsRefreshTimeout);
			}
			if (gpxDownloadUrl) {
				URL.revokeObjectURL(gpxDownloadUrl);
			}
			if (controlEditMarker && mountedMap && mountedMap.hasLayer(controlEditMarker)) {
				mountedMap.removeLayer(controlEditMarker);
			}
			pendingControlEdit = null;
			acceptControlEdit = () => {};
			rejectControlEdit = () => {};
			if (locationWatchId !== null) {
				navigator.geolocation.clearWatch(locationWatchId);
			}
			if (mountedMap) {
				mountedMap.remove();
				isMapReady = false;
			}
		};
	});
</script>

<CoursePlannerModal bind:this={plannerModal} on:plan={handlePlanCourse} />

<div bind:this={mapContainer} class="h-screen w-screen"></div>
{#if pendingControlEdit}
	<div class="absolute bottom-16 left-1/2 z-[1001] flex -translate-x-1/2 gap-2 rounded-lg bg-white/95 p-2 shadow-lg backdrop-blur-sm">
		<button
			type="button"
			onclick={acceptControlEdit}
			class="rounded bg-green-600 px-3 py-1 text-sm font-semibold text-white hover:bg-green-700"
		>
			Accept
		</button>
		<button
			type="button"
			onclick={rejectControlEdit}
			class="rounded bg-gray-500 px-3 py-1 text-sm font-semibold text-white hover:bg-gray-600"
		>
			Reject
		</button>
	</div>
{/if}
{#if gpxDownloadUrl && !isRecordingTrail}
	<div class="absolute bottom-4 left-1/2 z-[1000] -translate-x-1/2 rounded-lg bg-white/95 px-4 py-2 shadow-lg backdrop-blur-sm">
		<a
			href={gpxDownloadUrl}
			download={gpxDownloadName}
			class="text-sm font-semibold text-blue-700 underline decoration-2 underline-offset-2 hover:text-blue-800"
		>
			Download GPX trail
		</a>
	</div>
{/if}
{#if error}
	<div class="absolute bottom-4 left-4 rounded-lg bg-red-600 px-4 py-2 text-white shadow-lg">
		{error}
	</div>
{/if}

<style>
	:global(html),
	:global(body) {
		margin: 0;
		padding: 0;
		overflow: hidden;
	}

	:global(.leaflet-container) {
		font-family: inherit;
	}

	:global(.leaflet-popup-content-wrapper) {
		border-radius: 8px;
	}

	:global(.leaflet-control-layers) {
		background: white;
		border-radius: 4px;
		box-shadow: 0 1px 5px rgba(0, 0, 0, 0.65);
	}

	:global(.leaflet-bar) {
		border-radius: 4px;
		overflow: hidden;
	}

	:global(.leaflet-bar a) {
		background-color: white;
		color: #333;
		border-bottom: none;
		width: 36px;
		height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	:global(.leaflet-bar a:hover) {
		background-color: #f5f5f5;
	}

	:global(.map-location-button) {
		background-color: white;
		border: none;
		width: 36px;
		height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		color: #333;
		transition: background-color 0.2s;
	}

	:global(.map-location-button:hover) {
		background-color: #f5f5f5;
	}

	:global(.map-location-button.active) {
		background-color: #3b82f6;
		color: white;
	}

	:global(.map-location-button svg) {
		width: 18px;
		height: 18px;
	}

	:global(.map-planner-button) {
		background-color: white;
		border: none;
		width: 36px;
		height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		color: #333;
		transition: background-color 0.2s;
	}

	:global(.map-planner-button:hover) {
		background-color: #f5f5f5;
	}

	:global(.map-planner-button svg) {
		width: 18px;
		height: 18px;
	}

	:global(.map-trail-button) {
		background-color: white;
		border: none;
		width: 36px;
		height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		color: #333;
		transition: background-color 0.2s;
	}

	:global(.map-trail-button:hover) {
		background-color: #f5f5f5;
	}

	:global(.map-trail-button.active) {
		background-color: #ef4444;
		color: white;
	}

	:global(.map-trail-button svg) {
		width: 18px;
		height: 18px;
	}

	:global(.trail-line) {
		z-index: 100;
	}

	:global(.control-edit-drag-icon) {
		background: transparent;
		border: none;
	}

	:global(.control-edit-drag-dot) {
		width: 26px;
		height: 26px;
		border: 3px solid #ec4899;
		border-radius: 9999px;
		background: rgba(236, 72, 153, 0.2);
		box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9);
	}

	:global(.leaflet-tooltip.course-control-label) {
		background: transparent;
		border: none;
		box-shadow: none;
		color: #ec4899;
		font-size: 20px;
		font-weight: 700;
		padding: 0;
		line-height: 1;
		text-shadow: 0 0 2px #ffffff, 0 0 6px #ffffff;
	}

	:global(.leaflet-tooltip.course-control-label::before) {
		display: none;
	}
</style>

