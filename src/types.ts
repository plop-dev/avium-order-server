import type { SlicingSettings } from './slicing/models.js';

export type UploadChunk = {
	id: string;
	chunkIndex: number;
	currentChunk: number;
	totalChunks: number;
	filetype: string;
	data: string; // base64
	settings?: SlicingSettings; // For slicing settings when used with slice upload
};

export type UploadedChunkResponse = {
	received: number;
	total: number;
	complete: boolean;
};

export type FilamentInfo = {
	used_mm?: string;
	used_cm3?: string;
	used_g?: string;
	cost?: string;
};

export type SlicingResult = {
	id: string;
	modelFilename: string;
	gcodeFilename: string;
	modelSize: number;
	gcodeSize: number;
	modelUrl: string;
	gcodeUrl: string;
	complete: boolean;
	times: {
		model: string;
		total: string;
	};
	filament: FilamentInfo;
};

export interface PricingFormula {
	id: string;
	pricingFormula: string;
	updatedAt?: string | null;
	createdAt?: string | null;
}
