import { Router } from 'express';
import { uploadJson } from '../middleware/upload.js';
import type { Category } from '../slicing/models.ts';
import { saveSetting, listSettings, getSetting, deleteSetting } from './settings.service.js';

const router: Router = Router();

router.post('/:category', uploadJson.single('file'), async (req, res) => {
	try {
		const name = req.body.name;

		if (!validateNameNotEmpty(name)) {
			return res.status(400).json({ error: 'Name cannot be empty' });
		}

		if (!/^[a-zA-Z0-9]+$/.test(name)) {
			return res.status(400).json({ error: 'Name must only contain letters and numbers' });
		}

		if (!req.file) {
			return res.status(400).json({ error: 'File is required' });
		}

		if (!validateCategory(req.params.category ?? '')) {
			return res.status(400).json({ error: 'Invalid or missing category' });
		}

		let content;
		try {
			content = JSON.parse(req.file.buffer.toString('utf8'));
		} catch (parseError) {
			return res.status(400).json({ error: 'Invalid JSON file' });
		}

		await saveSetting(req.params.category as Category, name, content);

		res.status(201).json({ name });
	} catch (error) {
		console.error('Error in POST /:category:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

router.get('/:category', async (req, res) => {
	try {
		if (!validateCategory(req.params.category ?? '')) {
			return res.status(400).json({ error: 'Invalid or missing category' });
		}

		const settings = await listSettings(req.params.category as Category);

		res.status(200).json(settings);
	} catch (error) {
		console.error('Error in GET /:category:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

router.get('/:category/:name', async (req, res) => {
	try {
		if (!validateCategory(req.params.category ?? '')) {
			return res.status(400).json({ error: 'Invalid or missing category' });
		}

		if (!validateNameNotEmpty(req.params.name)) {
			return res.status(400).json({ error: 'Name cannot be empty' });
		}

		const setting = await getSetting(req.params.category as Category, req.params.name);

		res.status(200).json(setting);
	} catch (error) {
		console.error('Error in GET /:category/:name:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

router.delete('/:category/:name', async (req, res) => {
	try {
		if (!validateCategory(req.params.category ?? '')) {
			return res.status(400).json({ error: 'Invalid or missing category' });
		}

		if (!validateNameNotEmpty(req.params.name)) {
			return res.status(400).json({ error: 'Name cannot be empty' });
		}

		await deleteSetting(req.params.category as Category, req.params.name);

		res.status(204).send();
	} catch (error) {
		console.error('Error in DELETE /:category/:name:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

function validateNameNotEmpty(name: string): boolean {
	return !(!name || typeof name !== 'string' || name.trim().length === 0);
}

export function validateCategory(category: string): boolean {
	if (!category || !['printers', 'presets', 'filaments'].includes(category)) {
		console.debug(`[validateCategory] Validation failed - invalid category: ${category}`);
		return false;
	}
	return true;
}

export default router;
