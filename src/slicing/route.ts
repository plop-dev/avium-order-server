import { Router } from 'express';
import { AppError } from '../middleware/error.js';
import type { SlicingSettings } from './models.js';
import { sliceModel } from './slicing.service.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { PricingFormula, UploadChunk } from '../types.js';
import express from 'express';
import { DELETE_AFTER_SLICE_FAILURE } from '../index.ts';
import { evaluate } from 'mathjs';

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
	if (!secret) {
		console.error('DOWNLOAD_SECRET is required for signed URLs');
		return null;
	}
	const sig = crypto.createHmac('sha256', secret).update(filename).digest('hex');
	const base = process.env.ENV === 'development' ? `http://localhost:${process.env.PORT || 3000}` : process.env.PUBLIC_BASE_URL;
	return `${base}/file/${encodeURIComponent(filename)}?s=${sig}`;
};

export function timeStringToSeconds(timeStr: string): number {
	const timeParts = timeStr.split(' ');
	let totalSeconds = 0;

	for (const part of timeParts) {
		if (part.endsWith('h')) {
			totalSeconds += parseInt(part.slice(0, -1)) * 3600;
		} else if (part.endsWith('m')) {
			totalSeconds += parseInt(part.slice(0, -1)) * 60;
		} else if (part.endsWith('s')) {
			totalSeconds += parseInt(part.slice(0, -1));
		}
	}

	return totalSeconds;
}

async function extractSliceData(filePath: string) {
	try {
		const fileLines = (await fs.readFile(filePath, 'utf-8')).split('\n');
		const header = fileLines.slice(fileLines.indexOf('; HEADER_BLOCK_START'), fileLines.indexOf('; HEADER_BLOCK_END') + 1);
		const filamentInfo = fileLines.slice(fileLines.indexOf('; EXECUTABLE_BLOCK_END'), fileLines.length - 1);

		const timeLine = header.find(line => /^; model printing time: .+; total estimated time: .+$/.test(line));
		let modelTime: string = '',
			totalTime: string = '';
		if (timeLine) {
			const [, model, total] = timeLine.match(/^; model printing time: (.+); total estimated time: (.+)$/) || [];
			if (!model || !total) {
				return { error: 'Failed to parse slicing times from G-code' };
			}
			modelTime = model;
			totalTime = total;
		}
		if (!modelTime || !totalTime) {
			return { error: 'Failed to parse slicing times from G-code' };
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
	} catch (error) {
		console.error('Error extracting slice data:', error);
		return { error: 'Failed to extract slice data from G-code' };
	}
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

	const payloadcmsUrl = process.env.ENV === 'development' ? 'http://localhost:3000' : process.env.PUBLIC_FRONTEND_URL;

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
				if (!modelUrl) {
					sliceUploadSessions.delete(chunk.id);
					return res.status(500).json({ error: 'Failed to generate download URL' });
				}

				// Now attempt slicing
				const settings = session.settings || {};

				// Pass the quote ID to sliceModel so it can use the file directly from uploads
				const sliceRes = await sliceModel(completeFile, filename, settings, chunk.id);
				if (!sliceRes.success) {
					sliceUploadSessions.delete(chunk.id);
					return res.status(sliceRes.status).json({
						error: sliceRes.message,
						details: sliceRes.causeMessage,
					});
				}
				const { gcodes, workdir } = sliceRes;

				// Only handle single file case since spec says only one file at a time
				if (gcodes.length !== 1 || typeof gcodes[0] !== 'string') {
					sliceUploadSessions.delete(chunk.id);
					return res.status(500).json({ error: 'Expected exactly one output file from slicing' });
				}

				const sliceData = await extractSliceData(gcodes[0]);
				if ('error' in sliceData) {
					sliceUploadSessions.delete(chunk.id);
					return res.status(500).json({ error: sliceData.error });
				}
				const { times, filament } = sliceData;

				// Save G-code file to uploads directory
				const gcodeOriginalFilename = path.basename(gcodes[0]);
				const gcodeFilename = `${chunk.id}-gcode-${gcodeOriginalFilename}`;
				const gcodeFilePath = path.join(uploadDir, gcodeFilename);

				await fs.copyFile(gcodes[0], gcodeFilePath);

				const gcodeStats = await fs.stat(gcodeFilePath);
				const gcodeUrl = makeSignedUrl(gcodeFilename);
				if (!gcodeUrl) {
					sliceUploadSessions.delete(chunk.id);
					return res.status(500).json({ error: 'Failed to generate G-code download URL' });
				}

				// Clean up temp directory
				if (workdir) {
					await fs.rm(workdir, { recursive: true, force: true });
				}

				// sliceUploadSessions.delete(chunk.id);

				//* upload to payloadcms from here
				const pricingFormulaRes = await fetch(`${payloadcmsUrl}/api/globals/pricing-formula`, {
					headers: {
						Cookie: req.headers.cookie || '',
					},
					credentials: 'include',
				});
				if (!pricingFormulaRes.ok) {
					res.status(500).json({ error: 'An error occurred fetching pricing formula. Please try again.' });
					return;
				}
				const pricingFormula = await pricingFormulaRes.json().then((res: PricingFormula) => res.pricingFormula);

				if (!pricingFormula) {
					res.status(500).json({ error: 'An error occurred fetching pricing formula. Please try again.' });
					return;
				}

				const cost = Number(filament.cost) || 0;
				console.log(`formula: ${pricingFormula}, weight: ${filament.used_g}g, time: ${timeStringToSeconds(times.total)}, cost: £${cost}`);
				const price = (
					evaluate(pricingFormula, {
						weight: filament.used_g,
						time: timeStringToSeconds(times.total),
						cost: cost,
					}) / 100
				).toFixed(2) as unknown as number;

				const patchReq = await fetch(`${payloadcmsUrl}/api/quotes/${chunk.id}`, {
					method: 'PATCH',
					credentials: 'include',
					headers: {
						'Content-Type': 'application/json',
						Cookie: req.headers.cookie || '',
					},
					body: JSON.stringify({
						price,
						model: {
							modelUrl: modelUrl,
							gcodeUrl: gcodeUrl,
						},
						time: times.total,
					}),
				});
				if (!patchReq.ok) {
					res.status(500).json({ error: `Error updating quote: ${patchReq.statusText}` });
					return;
				}

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
					price,
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
		// Check if upload directory exists before trying to read it
		await fs.access(uploadDir);
		const files = await fs.readdir(uploadDir);
		const filesToDelete = files.filter(file => file.startsWith(`${id}-`));

		if (filesToDelete.length > 0) {
			console.log(`Deleting ${filesToDelete.length} files for upload ID: ${id}`);
			await Promise.all(
				filesToDelete.map(async file => {
					const filePath = path.join(uploadDir, file);
					try {
						await fs.unlink(filePath);
						console.log(`Deleted file: ${file}`);
					} catch (err) {
						console.warn(`Failed to delete file ${file}:`, err);
					}
				}),
			);
		} else {
			console.log(`No files found to delete for upload ID: ${id}`);
		}
	} catch (error) {
		if ((error as any).code === 'ENOENT') {
			console.warn('Upload directory does not exist, skipping file cleanup');
		} else {
			console.warn('Failed to clean up files:', error);
		}
	}

	res.status(204).send();
});

export default router;
