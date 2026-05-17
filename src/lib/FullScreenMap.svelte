<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { Circle, CircleMarker, Layer, LeafletEvent, Map as LeafletMap } from 'leaflet';
	import locationSvg from '$lib/assets/location-crosshairs-solid-full.svg?raw';
	import CoursePlannerModal from '$lib/CoursePlannerModal.svelte';
	import { generateCourse, isNearControl, type OrienteeringCourse } from '$lib/courseGenerator';

	let mapContainer: HTMLDivElement | undefined;
	let error: string | null = $state(null);
	let plannerModal: CoursePlannerModal | undefined;
	let activeCourse: OrienteeringCourse | null = $state(null);
	let foundControls: SvelteSet<number> = new SvelteSet<number>();
	let userPosition: { lat: number; lng: number } | null = $state(null);


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

	let map!: LeafletMap;
	let isMapReady = false;
	let drawCourse: (course: OrienteeringCourse) => void = () => {};
	let drawnCourseLayers: Layer[] = [];

	type SerializedCourse = {
		v: 1;
		startPoint: OrienteeringCourse['startPoint'];
		controls: OrienteeringCourse['controls'];
		goalPoint: OrienteeringCourse['goalPoint'];
		totalDistance: number;
		route: [number, number][];
	};

	function serializeCourse(course: OrienteeringCourse): string {
		const payload: SerializedCourse = {
			v: 1,
			startPoint: course.startPoint,
			controls: course.controls,
			goalPoint: course.goalPoint,
			totalDistance: course.totalDistance,
			route: course.route
		};
		const base64 = btoa(JSON.stringify(payload));
		return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
	}

	function deserializeCourse(serialized: string): OrienteeringCourse | null {
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

	// Handle plan event from modal - move outside onMount
	function handlePlanCourse(event: CustomEvent<{ kilometers: number; controls: number }>) {
		if (!isMapReady) {
			error = 'Map is not ready yet.';
			return;
		}

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

	onMount(() => {
		let locationWatchId: number | null = null;
		let mountedMap: LeafletMap | null = null;

		const initializeMap = async () => {
			if (!mapContainer) return;

			try {
			// Dynamically import Leaflet
			const leaflet = await import('leaflet');
			const L = leaflet.default;

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

			// Create layer control
			const baseLayers = {
				GoKartor: goKartorLayer,
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
						'<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">'
						+ '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/>'
						+ '</svg>';

					L.DomEvent.disableClickPropagation(container);
					L.DomEvent.on(planButton, 'click', () => {
						plannerModal?.openModal();
					});

					return container;
				}
			});

			const plannerControl = new PlannerControl({ position: 'topright' });
			plannerControl.addTo(map);

			// Handle course planning
			function setupLocationTracking() {
				if (!('geolocation' in navigator)) return;

				navigator.geolocation.watchPosition((position) => {
					userPosition = {
						lat: position.coords.latitude,
						lng: position.coords.longitude
					};

					// Check proximity to controls
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
				});
			}

			setupLocationTracking();


			// Handle layer switching
			map.on('baselayerchange', (event: LeafletEvent & { layer: Layer }) => {
				const currentZoom = map.getZoom();
				const center = map.getCenter();

				if (event.layer === goKartorLayer && !usingGoKartorCrs && goKartorCrs) {
					const nextZoom = Math.max(6, Math.min(15, currentZoom - 3));
					map.options.crs = goKartorCrs;
					map.setView(center, nextZoom, { animate: false });
					map.invalidateSize(false);
					map.setMaxZoom(14);
					usingGoKartorCrs = true;
				} else if (event.layer === goKartorLayer && !goKartorCrs) {
					error = 'GoKartor displayed without projection (Proj4Leaflet not available).';
				} else if (usingGoKartorCrs && event.layer !== goKartorLayer) {
					const nextZoom = Math.max(3, Math.min(19, currentZoom + 3));
					map.options.crs = defaultCrs;
					map.setView(center, nextZoom, { animate: false });
					map.invalidateSize(false);
					map.setMaxZoom(19);
					usingGoKartorCrs = false;
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

				// Draw route line
				const routeLine = L.polyline(course.route, {
					color: '#ec4899',
					weight: 6,
					opacity: 0.9,
					dashArray: '',
					className: 'course-route'
				});
				routeLine.addTo(map);
				drawnCourseLayers.push(routeLine);

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
						interactive: false,
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
					fillColor: '#ec4899',
					fillOpacity: foundControls.has(course.goalPoint.index) ? 0.5 : 0.9,
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
			});

			// Load and draw a shared course from URL if present
			const sharedCourse = loadCourseFromUrl();
			if (sharedCourse) {
				activeCourse = sharedCourse;
				foundControls = new SvelteSet<number>();
				drawCourse(sharedCourse);
			}

			// Setup location tracking
			setupLocationTracking();

			} catch (err) {
				error = err instanceof Error ? err.message : 'An unknown error occurred';
				console.error('Map initialization error:', err);
			}
		};

		void initializeMap();

		return () => {
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

