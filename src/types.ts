export type UploadChunk = {
	id: string;
	chunkIndex: number;
	currentChunk: number;
	totalChunks: number;
	filetype: string;
	data: string; // base64
};

export type UploadedChunkResponse = {
	received: number;
	total: number;
	complete: boolean;
};

export type UploadedFileResponse = {
	id: string;
	filename: string;
	size: number;
	mimetype: string;
	url: string;
	complete: boolean;
};
