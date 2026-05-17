<script lang="ts">
	import { onMount } from 'svelte';
	import locationSvg from '$lib/assets/location-crosshairs-solid-full.svg?raw';
	import CoursePlannerModal from '$lib/CoursePlannerModal.svelte';
	import { generateCourse, isNearControl, type OrienteeringCourse } from '$lib/courseGenerator';

	let mapContainer: HTMLDivElement | undefined;
	let error: string | null = $state(null);
	let plannerModal: CoursePlannerModal | undefined;
	let activeCourse: OrienteeringCourse | null = $state(null);
	let foundControls: Set<number> = $state(new Set());
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

	let map: any = null;
	let drawCourse: (course: OrienteeringCourse) => void = () => {};

	// Handle plan event from modal - move outside onMount
	function handlePlanCourse(event: any) {
		const detail = event.detail || event;
		const { kilometers, controls } = detail;

		if (!userPosition) {
			error = 'Please enable location tracking first.';
			return;
		}

		try {
			activeCourse = generateCourse(map, userPosition.lat, userPosition.lng, kilometers, controls);
			foundControls = new Set();
			drawCourse(activeCourse);
			error = null;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to generate course';
		}
	}

	onMount(async () => {
		if (!mapContainer) return;

		try {
			// Dynamically import Leaflet
			const leaflet = await import('leaflet');
			const L = leaflet.default;

			// Import proj4 and proj4leaflet
			const proj4Module = await import('proj4');
			const proj4 = proj4Module.default;

			// Set globals for proj4leaflet
			(window as any).L = L;
			(window as any).proj4 = proj4;

			// Import proj4leaflet
			await import('proj4leaflet');

			// Get the extended L with Proj
			const LWithProj = L as any;

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
				crs: initialCrs
			}).setView([59.2754, 17.9819], 12);

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
			let locationWatchId: number | null = null;
			let userLocationMarker: any = null;
			let userAccuracyCircle: any = null;
			let isLocationTrackingActive = false;
			let locationButton: HTMLButtonElement | null = null;

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
						try { map.removeLayer(userLocationMarker); } catch {}
						userLocationMarker = null;
					}
					if (userAccuracyCircle) {
						try { map.removeLayer(userAccuracyCircle); } catch {}
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
					if (activeCourse && userPosition) {
						const checkProximity = () => {
							// Check start point
							if (
								!foundControls.has(0) &&
								isNearControl(
									userPosition.lat,
									userPosition.lng,
									activeCourse.startPoint.lat,
									activeCourse.startPoint.lng,
									20
								)
							) {
								foundControls.add(0);
								playCheckpointSound();
							}

							// Check controls
							for (const control of activeCourse.controls) {
								if (
									!foundControls.has(control.index) &&
									isNearControl(
										userPosition.lat,
										userPosition.lng,
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
							const goalIndex = activeCourse.goalPoint.index;
							if (
								!foundControls.has(goalIndex) &&
								isNearControl(
									userPosition.lat,
									userPosition.lng,
									activeCourse.goalPoint.lat,
									activeCourse.goalPoint.lng,
									20
								)
							) {
								foundControls.add(goalIndex);
								playCheckpointSound();
								error = 'Course completed! 🎉';
							}
						};

						checkProximity();
					}
				});
			}

			setupLocationTracking();


			// Handle layer switching
			map.on('baselayerchange', (event: any) => {
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
				const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
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
				// Remove existing course layers
				map.eachLayer((layer: any) => {
					if (layer instanceof L.Marker && (layer.options.className as string)?.includes('course')) {
						map.removeLayer(layer);
					}
					if (layer instanceof L.Polyline && (layer.options.className as string)?.includes('course-route')) {
						map.removeLayer(layer);
					}
				});

				// Draw route line
				const routeLine = L.polyline(course.route, {
					color: '#f59e0b',
					weight: 3,
					opacity: 0.7,
					dashArray: '5, 5',
					className: 'course-route'
				});
				routeLine.addTo(map);

				// Draw start point
				const startMarker = L.circleMarker([course.startPoint.lat, course.startPoint.lng], {
					radius: 8,
					color: '#10b981',
					fillColor: '#d1fae5',
					fillOpacity: 0.9,
					weight: 2,
					className: 'course-marker'
				});
				startMarker.bindPopup('Start');
				startMarker.addTo(map);

				// Draw control points
				for (const control of course.controls) {
					const isFound = foundControls.has(control.index);
					const marker = L.circleMarker([control.lat, control.lng], {
						radius: 6,
						color: isFound ? '#059669' : '#3b82f6',
						fillColor: isFound ? '#10b981' : '#93c5fd',
						fillOpacity: 0.9,
						weight: 2,
						className: 'course-marker'
					});
					marker.bindPopup(`${control.name}${isFound ? ' ✓' : ''}`);
					marker.addTo(map);
				}

				// Draw goal point
				const goalMarker = L.circleMarker([course.goalPoint.lat, course.goalPoint.lng], {
					radius: 8,
					color: foundControls.has(course.goalPoint.index) ? '#8b5cf6' : '#dc2626',
					fillColor: foundControls.has(course.goalPoint.index) ? '#ede9fe' : '#fecaca',
					fillOpacity: 0.9,
					weight: 2,
					className: 'course-marker'
				});
				goalMarker.bindPopup('Goal');
				goalMarker.addTo(map);
			};

			// Assign drawCourse to outer scope
			drawCourse = drawCourseImpl;

			// Setup location tracking
			setupLocationTracking();

			return () => {
				if (locationWatchId !== null) {
					navigator.geolocation.clearWatch(locationWatchId);
				}
				map.remove();
			};
		} catch (err) {
			error = err instanceof Error ? err.message : 'An unknown error occurred';
			console.error('Map initialization error:', err);
		}
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
</style>

