import { Router, type Request } from 'express';
import { uploadJson } from '../middleware/upload.js';
import type { Category } from '../slicing/models.ts';
import { AppError } from '../middleware/error.js';
import { validateCategory } from '../profiles/route.ts';
import { generatePreset } from './utils.ts';

const router: Router = Router();

router.post('/presets', async (req, res) => {
	const { name, layerHeight, infill } = req.body;

	try {
		await generatePreset(layerHeight, infill, name);
	} catch (error) {
		console.error('Error generating preset:', error);
		throw new AppError(500, 'Failed to generate preset');
	} finally {
		res.sendStatus(200);
	}
});

export default router;
