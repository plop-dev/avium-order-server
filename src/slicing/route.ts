import { Router } from 'express';
import { uploadModel } from '../middleware/upload.js';
import { AppError } from '../middleware/error.js';
import type { SlicingSettings } from './models.js';
import { sliceModel } from './slicing.service.js';
import fs from 'fs/promises';
import path from 'path';
import archiver from 'archiver';

const router: Router = Router();

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

	const filament: Record<string, string> = {};
	filamentInfo.forEach(line => {
		const match = line.match(/^; filament (used \[mm\]|used \[cm3\]|used \[g\]|cost) = (.+)$/);
		if (match) {
			const key = match[1]?.replace(/ /g, '_').replace(/\[|\]/g, '').toLowerCase();
			if (key !== undefined && typeof match[2] === 'string') {
				filament[key] = match[2];
			}
		}
	});

	return { times, filament };
}

router.post('/', uploadModel.single('file'), async (req, res) => {
	if (!req.file) {
		throw new AppError(400, 'File is required for slicing');
	}

	const { gcodes, workdir } = await sliceModel(req.file.buffer, req.file.originalname, req.body as SlicingSettings);

	if (gcodes.length === 1 && typeof gcodes[0] === 'string') {
		try {
			const { times, filament } = await extractSliceData(gcodes[0]);

			const metaHeader = Buffer.from(JSON.stringify({ times, filament })).toString('base64');
			res.setHeader('X-Slice-Metadata', metaHeader);

			res.download(gcodes[0]);
		} finally {
			await fs.rm(workdir, { recursive: true, force: true });
		}
	} else if (gcodes.length > 1) {
		res.attachment('result.zip');
		const archive = archiver('zip', { zlib: { level: 9 } });

		archive.on('error', err => {
			throw new AppError(500, `Error creating archive: ${err.message}`);
		});

		res.on('finish', async () => {
			await fs.rm(workdir, { recursive: true, force: true });
		});

		// Build X-Slice-Metadata for multiple files
		const metadata: Record<string, { times: { model?: string; total?: string }; filament: Record<string, string> }> = {};
		for (const filePath of gcodes) {
			metadata[path.basename(filePath)] = await extractSliceData(filePath);
		}
		const metaHeader = Buffer.from(JSON.stringify(metadata)).toString('base64');
		res.setHeader('X-Slice-Metadata', metaHeader);

		archive.pipe(res);
		gcodes.forEach(filePath => {
			archive.file(filePath, { name: path.basename(filePath) });
		});

		await archive.finalize();
	} else {
		throw new AppError(500, 'No files generated during slicing');
	}
});

export default router;
