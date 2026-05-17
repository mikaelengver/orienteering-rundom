<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	let isOpen = $state(false);
	let kilometers = $state(5);
	let controls = $state(10);

	const dispatch = createEventDispatcher();

	export function openModal() {
		isOpen = true;
	}

	export function closeModal() {
		isOpen = false;
	}

	function handlePlan() {
		dispatch('plan', { kilometers, controls });
		closeModal();
	}
</script>

{#if isOpen}
	<div class="modal-overlay" role="dialog" onmousedown={closeModal} onkeydown={(e) => e.key === 'Escape' && closeModal()}>
		<div 
			class="modal-content" 
			onmousedown={(e) => e.stopPropagation()}
			onclick={(e) => e.stopPropagation()}
		>
			<div class="modal-header">
				<h2>Plan Your Orienteering Course</h2>
				<button class="close-button" type="button" onclick={closeModal} aria-label="Close modal">×</button>
			</div>

			<div class="modal-body">
				<div class="control-group">
					<label for="kilometers">Distance: <strong>{kilometers} km</strong></label>
					<input
						id="kilometers"
						type="range"
						min="1"
						max="20"
						bind:value={kilometers}
						class="slider"
					/>
					<div class="range-labels">
						<span>1 km</span>
						<span>20 km</span>
					</div>
				</div>

				<div class="control-group">
					<label for="controls">Number of Controls: <strong>{controls}</strong></label>
					<input
						id="controls"
						type="range"
						min="5"
						max="20"
						bind:value={controls}
						class="slider"
					/>
					<div class="range-labels">
						<span>5 controls</span>
						<span>20 controls</span>
					</div>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn-cancel" type="button" onclick={closeModal}>Cancel</button>
				<button class="btn-plan" type="button" onclick={handlePlan}>Plan Course</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal-content {
		background: white;
		border-radius: 12px;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
		max-width: 400px;
		width: 90%;
		overflow: hidden;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 24px;
		border-bottom: 1px solid #e5e7eb;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.25rem;
		color: #1f2937;
	}

	.close-button {
		background: none;
		border: none;
		font-size: 28px;
		color: #6b7280;
		cursor: pointer;
		padding: 0;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.close-button:hover {
		color: #1f2937;
	}

	.modal-body {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.control-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.control-group label {
		font-weight: 500;
		color: #374151;
		font-size: 0.95rem;
	}

	.slider {
		width: 100%;
		height: 6px;
		border-radius: 3px;
		background: #d1d5db;
		outline: none;
		-webkit-appearance: none;
	}

	.slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: #3b82f6;
		cursor: pointer;
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
	}

	.slider::-moz-range-thumb {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: #3b82f6;
		cursor: pointer;
		border: none;
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
	}

	.range-labels {
		display: flex;
		justify-content: space-between;
		font-size: 0.75rem;
		color: #9ca3af;
	}

	.modal-footer {
		display: flex;
		gap: 12px;
		padding: 24px;
		border-top: 1px solid #e5e7eb;
		justify-content: flex-end;
	}

	.btn-cancel {
		padding: 10px 20px;
		background: #e5e7eb;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-weight: 500;
		color: #374151;
		transition: background-color 0.2s;
	}

	.btn-cancel:hover {
		background: #d1d5db;
	}

	.btn-plan {
		padding: 10px 24px;
		background: #3b82f6;
		color: white;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-weight: 500;
		transition: background-color 0.2s;
	}

	.btn-plan:hover {
		background: #2563eb;
	}
</style>
