import { Router } from 'express';
import { uploadJson } from '../middleware/upload.js';
import type { Category } from '../slicing/models.ts';
import { saveSetting, listSettings, getSetting } from './settings.service.js';
import { AppError } from '../middleware/error.js';

const router: Router = Router();

router.post('/:category', uploadJson.single('file'), async (req, res) => {
	const name = req.body.name;

	validateNameNotEmpty(name);

	if (!/^[a-zA-Z0-9]+$/.test(name)) {
		throw new AppError(400, 'Name must only contain letters and numbers');
	}

	if (!req.file) {
		throw new AppError(400, 'File is required');
	}

	validateCategory(req.params.category ?? '');

	const content = JSON.parse(req.file.buffer.toString('utf8'));
	await saveSetting(req.params.category as Category, name, content);
	res.status(201).json({ name });
});

router.get('/:category', async (req, res) => {
	validateCategory(req.params.category ?? '');

	const settings = await listSettings(req.params.category as Category);
	res.status(200).json(settings);
});

router.get('/:category/:name', async (req, res) => {
	validateCategory(req.params.category ?? '');
	validateNameNotEmpty(req.params.name);

	const setting = await getSetting(req.params.category as Category, req.params.name);
	res.status(200).json(setting);
});

function validateNameNotEmpty(name: string) {
	if (!name || typeof name !== 'string' || name.trim().length === 0) {
		throw new AppError(400, 'Name cannot be empty');
	}
}

function validateCategory(category: string) {
	if (!category || !['printers', 'presets', 'filaments'].includes(category)) {
		throw new AppError(400, 'Invalid or missing category');
	}
}

export default router;
