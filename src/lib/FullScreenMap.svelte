<script lang="ts">
	import { onMount } from 'svelte';

	let mapContainer: HTMLDivElement | undefined;
	let error: string | null = null;

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
			const map = L.map(mapContainer, {
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

			// Create location control
			const LocationControl = L.Control.extend({
				onAdd: () => {
					const container = L.DomUtil.create('div', 'leaflet-bar');
					locationButton = L.DomUtil.create(
						'button',
						'map-location-button',
						container
					) as HTMLButtonElement;
					locationButton.type = 'button';
					locationButton.title = 'Show and follow my position';
					locationButton.setAttribute('aria-label', 'Show and follow my position');
					locationButton.innerHTML =
						'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"></circle><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m5.08 5.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m5.08-5.08l4.24-4.24"></path></svg>';

					L.DomEvent.disableClickPropagation(container);
					const onLocationButtonClick = () => {
						startLocationWatch();
					};
					L.DomEvent.on(locationButton, 'click', onLocationButtonClick);

					return container;
				}
			});

			const locationControl = new LocationControl({ position: 'topright' });
			locationControl.addTo(map);

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

<div bind:this={mapContainer} class="h-screen w-screen" />
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
</style>

