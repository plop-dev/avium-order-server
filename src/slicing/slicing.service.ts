import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { AppError } from '../middleware/error.js';
import type { SlicingSettings, SliceResult } from './models.js';

export async function sliceModel(file: Buffer, filename: string, settings: SlicingSettings): Promise<SliceResult> {
	let workdir: string;
	let inPath: string;
	let outputDir: string;
	try {
		workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-'));
		const inputDir = path.join(workdir, 'input');
		outputDir = path.join(workdir, 'output');
		await fs.mkdir(inputDir, { recursive: true });
		await fs.mkdir(outputDir, { recursive: true });
		inPath = path.join(inputDir, filename);
		await fs.writeFile(inPath, file);
	} catch (error) {
		throw new AppError(500, 'Failed to prepare slicing', error instanceof Error ? error.message : String(error));
	}

	const basePath = process.env.DATA_PATH || path.join(process.cwd(), 'data');

	const args: string[] = [];

	if (settings.exportType === '3mf') {
		args.push('--export-3mf', 'result.3mf');
	}

	const sliceArg = settings.plate === undefined ? '1' : settings.plate;
	args.push('--slice', sliceArg);

	if (settings.arrange !== undefined) {
		args.push('--arrange', settings.arrange ? '1' : '0');
	}

	if (settings.orient !== undefined) {
		args.push('--orient', settings.orient ? '1' : '0');
	}

	if (settings.printer && settings.preset) {
		const settingsArg = `${basePath}/printers/${settings.printer}.json;${basePath}/presets/${settings.preset}.json`;
		args.push('--load-settings', settingsArg);
	}

	if (settings.filament) {
		args.push('--load-filaments', `${basePath}/filaments/${settings.filament}.json`);
	}

	if (settings.bedType) {
		args.push('--curr-bed-type', settings.bedType);
	}

	if (settings.multicolorOnePlate) {
		args.push('--allow-multicolor-oneplate');
	}

	args.push('--allow-newer-file');
	args.push('--outputdir', outputDir);

	args.push(inPath);

	if (!process.env.ORCASLICER_PATH) {
		throw new AppError(500, 'Slicing is not configured properly on the server', 'ORCASLICER_PATH environment variable is not defined');
	}

	try {
		execFileSync(process.env.ORCASLICER_PATH, args, {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (err) {
		await fs.rm(workdir, { recursive: true, force: true });
		throw new AppError(500, 'Failed to slice the model', err instanceof Error ? err.message : String(err));
	}

	const files = await fs.readdir(outputDir);
	let resultFiles: string[];

	if (settings.exportType === '3mf') {
		resultFiles = files.filter(f => f.toLowerCase().endsWith('.3mf')).map(f => path.join(outputDir, f));
	} else {
		resultFiles = files.filter(f => f.toLowerCase().endsWith('.gcode')).map(f => path.join(outputDir, f));
	}

	return { gcodes: resultFiles, workdir };
}
