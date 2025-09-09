import { Router } from 'express';
import { AppError } from '../middleware/error.js';
import type { SlicingSettings } from './models.js';
import { sliceModel } from './slicing.service.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { UploadChunk } from '../types.js';
import express from 'express';
import { DELETE_AFTER_SLICE_FAILURE } from '../index.ts';

const router: Router = Router();

const uploadDir = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');

// Keep track of upload sessions for slicing
const sliceUploadSessions = new Map<
	string,
	{
		chunks: Map<number, Buffer>;
		totalChunks: number;
		filetype: string;
		settings?: SlicingSettings;
	}
>();

const makeSignedUrl = (filename: string) => {
	const secret = process.env.DOWNLOAD_SECRET;
	if (!secret) throw new Error('DOWNLOAD_SECRET is required');
	const sig = crypto.createHmac('sha256', secret).update(filename).digest('hex');
	const base = process.env.ENV === 'development' ? `http://localhost:${process.env.PORT || 3000}` : process.env.PUBLIC_BASE_URL;
	return `${base}/file/${encodeURIComponent(filename)}?s=${sig}`;
};

async function extractSliceData(filePath: string) {
	const fileLines = (await fs.readFile(filePath, 'utf-8')).split('\n');
	const header = fileLines.slice(fileLines.indexOf('; HEADER_BLOCK_START'), fileLines.indexOf('; HEADER_BLOCK_END') + 1);
	const filamentInfo = fileLines.slice(fileLines.indexOf('; EXECUTABLE_BLOCK_END'), fileLines.length - 1);

	const timeLine = header.find(line => /^; model printing time: .+; total estimated time: .+$/.test(line));
	let modelTime: string = '',
		totalTime: string = '';
	if (timeLine) {
		const [, model, total] = timeLine.match(/^; model printing time: (.+); total estimated time: (.+)$/) || [];
		if (!model || !total) {
			throw new AppError(500, 'Failed to parse slicing times from G-code');
		}
		modelTime = model;
		totalTime = total;
	}
	if (!modelTime || !totalTime) {
		throw new AppError(500, 'Failed to parse slicing times from G-code');
	}
	const times = { model: modelTime, total: totalTime };

	type FilamentInfo = {
		used_mm?: string;
		used_cm3?: string;
		used_g?: string;
		cost?: string;
	};

	const keyMap: Record<string, keyof FilamentInfo> = {
		'used [mm]': 'used_mm',
		'used [cm3]': 'used_cm3',
		'used [g]': 'used_g',
		cost: 'cost',
	};

	const filament: FilamentInfo = {};
	filamentInfo.forEach(line => {
		const match = line.match(/^; filament (used \[mm\]|used \[cm3\]|used \[g\]|cost) = (.+)$/);
		if (match && match[1] && match[2]) {
			const mappedKey = keyMap[match[1]];
			if (mappedKey) {
				filament[mappedKey] = match[2];
			}
		}
	});

	return { times, filament };
}

// Single chunked upload and slice route
router.post('/', express.json({ limit: '10mb' }), (req, res) => {
	const chunk: UploadChunk = req.body;
	if (!chunk) return res.status(400).json({ error: 'No chunk data' });

	if (!chunk.id || chunk.currentChunk < 0 || chunk.totalChunks <= 0) {
		return res.status(400).json({ error: 'Invalid chunk data' });
	}

	// Validate file type for slicing
	const allowedTypes = ['stl', '3mf'];
	if (!allowedTypes.includes(chunk.filetype.toLowerCase())) {
		return res.status(400).json({ error: 'Invalid file type for slicing. Only STL, 3MF, and STEP files are allowed.' });
	}

	// Initialize session if first chunk
	if (!sliceUploadSessions.has(chunk.id)) {
		sliceUploadSessions.set(chunk.id, {
			chunks: new Map(),
			totalChunks: chunk.totalChunks,
			filetype: chunk.filetype,
			...(chunk.settings && { settings: chunk.settings }),
		});
	}

	const session = sliceUploadSessions.get(chunk.id)!;

	// Store chunk data
	const chunkBuffer = Buffer.from(chunk.data, 'base64');
	session.chunks.set(chunk.currentChunk, chunkBuffer);

	// Check if all chunks received
	if (session.chunks.size === session.totalChunks) {
		// Assemble file and slice
		(async () => {
			let workdir: string | undefined;
			let modelFilePath: string | undefined;
			try {
				const completeFile = Buffer.concat(
					Array.from(session.chunks.entries())
						.sort(([a], [b]) => a - b)
						.map(([, buffer]) => buffer),
				);
				const filename = `upload.${chunk.filetype.toLowerCase()}`;

				// Ensure uploads directory exists
				await fs.mkdir(uploadDir, { recursive: true });

				// Always save the uploaded model file first
				const modelFilename = `${chunk.id}-model.${chunk.filetype.toLowerCase()}`;
				modelFilePath = path.join(uploadDir, modelFilename);

				await fs.writeFile(modelFilePath, completeFile);

				const modelStats = await fs.stat(modelFilePath);
				const modelUrl = makeSignedUrl(modelFilename);

				// Now attempt slicing
				const settings = session.settings || {};

				// Pass the quote ID to sliceModel so it can use the file directly from uploads
				const { gcodes, workdir: sliceWorkdir } = await sliceModel(completeFile, filename, settings, chunk.id);
				workdir = sliceWorkdir;

				// Only handle single file case since spec says only one file at a time
				if (gcodes.length !== 1 || typeof gcodes[0] !== 'string') {
					throw new AppError(500, 'Expected exactly one output file from slicing');
				}

				const { times, filament } = await extractSliceData(gcodes[0]);

				// Save G-code file to uploads directory
				const gcodeOriginalFilename = path.basename(gcodes[0]);
				const gcodeFilename = `${chunk.id}-gcode-${gcodeOriginalFilename}`;
				const gcodeFilePath = path.join(uploadDir, gcodeFilename);

				await fs.copyFile(gcodes[0], gcodeFilePath);

				const gcodeStats = await fs.stat(gcodeFilePath);
				const gcodeUrl = makeSignedUrl(gcodeFilename);

				// Clean up temp directory
				if (workdir) {
					await fs.rm(workdir, { recursive: true, force: true });
				}
				sliceUploadSessions.delete(chunk.id);

				res.json({
					id: chunk.id,
					modelFilename,
					gcodeFilename,
					modelSize: modelStats.size,
					gcodeSize: gcodeStats.size,
					modelUrl,
					gcodeUrl,
					complete: true,
					times,
					filament,
				});
			} catch (error) {
				// Clean up everything on failure
				sliceUploadSessions.delete(chunk.id);

				if (workdir) {
					await fs.rm(workdir, { recursive: true, force: true }).catch(err => console.warn('Failed to cleanup workdir:', err));
				}

				if (DELETE_AFTER_SLICE_FAILURE) {
					// Delete uploaded model file if it exists
					if (modelFilePath) {
						await fs.unlink(modelFilePath).catch(err => console.warn('Failed to delete model file:', err));
					}

					// Only delete profile files if they were specifically created for this request
					const settings = session.settings;
					if (settings) {
						const basePath = process.env.DATA_PATH || path.join(process.cwd(), 'data');

						// Only delete preset if it looks like a generated/temporary one (contains the chunk ID)
						if (settings.preset && settings.preset.includes(chunk.id.replace(/-/g, ''))) {
							const presetPath = path.join(basePath, 'presets', `${settings.preset}.json`);
							await fs.unlink(presetPath).catch(err => console.warn(`Failed to delete preset ${settings.preset}:`, err));
						}

						// Only delete filament if it looks like a generated/temporary one (contains the chunk ID)
						if (settings.filament && settings.filament.includes(chunk.id.replace(/-/g, ''))) {
							const filamentPath = path.join(basePath, 'filaments', `${settings.filament}.json`);
							await fs.unlink(filamentPath).catch(err => console.warn(`Failed to delete filament ${settings.filament}:`, err));
						}
					}
				}

				console.error('Error during chunked slice processing:', error);
				res.status(500).json({
					error: 'Failed to process and slice file',
					details: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	} else {
		res.json({
			received: chunk.currentChunk + 1,
			total: chunk.totalChunks,
			complete: false,
		});
	}
});

router.delete('/:id', async (req, res) => {
	const id = req.params.id;

	if (!id) {
		return res.status(400).json({ error: 'Upload ID is required' });
	}

	// Check if session exists
	if (!sliceUploadSessions.has(id)) {
		return res.status(404).json({ error: 'Upload session not found' });
	}

	// Remove the session
	sliceUploadSessions.delete(id);

	// Clean up any files that match this ID pattern
	try {
		const files = await fs.readdir(uploadDir);
		const filesToDelete = files.filter(file => file.startsWith(`${id}-`));

		await Promise.all(filesToDelete.map(file => fs.unlink(path.join(uploadDir, file)).catch(err => console.warn(`Failed to delete file ${file}:`, err))));
	} catch (error) {
		console.warn('Failed to clean up files:', error);
	}

	res.status(204).send();
});

export default router;
