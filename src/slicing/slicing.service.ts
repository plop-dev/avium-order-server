import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { AppError } from '../middleware/error.js';
import { DEBUG_LOGGING } from '../index.js';
import type { SlicingSettings, SliceResult } from './models.js';

export async function sliceModel(
	file: Buffer,
	filename: string,
	settings: SlicingSettings,
	quoteId?: string,
): Promise<(SliceResult & { success: true }) | (AppError & { success: false })> {
	const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
	let workdir: string;
	let inPath: string;
	let outputDir: string;

	try {
		// Use quote ID if provided, otherwise fall back to random temp dir
		const tempDirName = quoteId ? `slice-${quoteId}` : 'slice-';
		workdir = quoteId ? path.join(os.tmpdir(), tempDirName) : await fs.mkdtemp(path.join(os.tmpdir(), tempDirName));

		if (quoteId) {
			await fs.mkdir(workdir, { recursive: true });
		}

		outputDir = path.join(workdir, 'output');
		await fs.mkdir(outputDir, { recursive: true });

		// Use the uploads directory as input and the quote ID as filename
		if (quoteId) {
			inPath = path.join(uploadDir, `${quoteId}-model.${filename.split('.').pop()}`);
			// Verify the file exists in uploads directory
			await fs.access(inPath);
		} else {
			// Fallback to temp directory for backwards compatibility
			const inputDir = path.join(workdir, 'input');
			await fs.mkdir(inputDir, { recursive: true });
			inPath = path.join(inputDir, filename);
			await fs.writeFile(inPath, file);
		}

		// Verify the input file exists and get stats
		const stats = await fs.stat(inPath);
		if (DEBUG_LOGGING) console.log(`Input file: ${inPath} (${stats.size} bytes)`);
	} catch (error) {
		return { ...new AppError(500, 'Failed to prepare slicing', error instanceof Error ? error.message : String(error)), success: false };
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
		const uploadedPresetPath = `${basePath}/presets/${settings.preset}.json`;
		const defaultPresetPath = `${process.env.PROCESS_PROFILES_FOLDER}/${settings.preset}.json`;

		let presetPath: string;
		try {
			await fs.access(uploadedPresetPath);
			presetPath = uploadedPresetPath;
			if (DEBUG_LOGGING) console.log(`Using uploaded preset: ${presetPath}`);
		} catch {
			try {
				await fs.access(defaultPresetPath);
				presetPath = defaultPresetPath;
				if (DEBUG_LOGGING) console.log(`Using default preset: ${presetPath}`);
			} catch {
				return { ...new AppError(400, 'Preset not found', `Preset ${settings.preset} not found for printer ${settings.printer}`), success: false };
			}
		}

		const printerPath = `${basePath}/printers/${settings.printer}.json`;
		try {
			await fs.access(printerPath);
			if (DEBUG_LOGGING) console.log(`Using printer: ${printerPath}`);
		} catch {
			return { ...new AppError(400, 'Printer not found', `Printer ${settings.printer} not found`), success: false };
		}

		const settingsArg = `${printerPath};${presetPath}`;
		args.push('--load-settings', settingsArg);
	}

	if (settings.filament) {
		const filamentPath = `${basePath}/filaments/${settings.filament}.json`;
		try {
			await fs.access(filamentPath);
			if (DEBUG_LOGGING) console.log(`Using filament: ${filamentPath}`);
			args.push('--load-filaments', filamentPath);
		} catch {
			return { ...new AppError(400, 'Filament not found', `Filament ${settings.filament} not found`), success: false };
		}
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
		return {
			...new AppError(500, 'Slicing is not configured properly on the server', 'ORCASLICER_PATH environment variable is not defined'),
			success: false,
		};
	}

	if (DEBUG_LOGGING) console.log(`Executing OrcaSlicer with args:`, args);

	try {
		const result = execFileSync(process.env.ORCASLICER_PATH, args, {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 300000, // 5 minute timeout
		});
		if (DEBUG_LOGGING) console.log(`OrcaSlicer completed successfully`);
		if (result && DEBUG_LOGGING) {
			console.log(`OrcaSlicer stdout:`, result);
		}
	} catch (err: any) {
		console.error(`OrcaSlicer failed with exit code: ${err.status}`);
		console.error(`OrcaSlicer stderr:`, err.stderr);
		console.error(`OrcaSlicer stdout:`, err.stdout);
		console.error(`OrcaSlicer error:`, err.message);

		// Check if the input file still exists
		const inputExists = await fs
			.access(inPath)
			.then(() => true)
			.catch(() => false);
		if (DEBUG_LOGGING) console.log(`Input file exists: ${inputExists}`);

		// Check if output directory exists and list contents
		const outputExists = await fs
			.access(outputDir)
			.then(() => true)
			.catch(() => false);
		if (outputExists && DEBUG_LOGGING) {
			const outputFiles = await fs.readdir(outputDir).catch(() => []);
			console.log(`Output directory contents:`, outputFiles);
		}

		await fs.rm(workdir, { recursive: true, force: true });
		return { ...new AppError(500, 'Failed to slice the model', `OrcaSlicer error: ${err.stderr || err.stdout || err.message}`), success: false };
	}

	const files = await fs.readdir(outputDir);
	if (DEBUG_LOGGING) console.log(`Output files generated:`, files);

	let resultFiles: string[];

	if (settings.exportType === '3mf') {
		resultFiles = files.filter(f => f.toLowerCase().endsWith('.3mf')).map(f => path.join(outputDir, f));
	} else {
		resultFiles = files.filter(f => f.toLowerCase().endsWith('.gcode')).map(f => path.join(outputDir, f));
	}

	if (resultFiles.length === 0) {
		await fs.rm(workdir, { recursive: true, force: true });
		return { ...new AppError(500, 'No output files generated by slicer'), success: false };
	}

	return { gcodes: resultFiles, workdir, success: true };
}
