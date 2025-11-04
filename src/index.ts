import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import profiles from './profiles/route.ts';
import slicing from './slicing/route.ts';
import generate from './generate/route.ts';
import cookieParser from 'cookie-parser';

import multer from 'multer';
import fs from 'fs';
import crypto from 'crypto';
import type { UploadChunk } from './types.js';

// Configuration constants
export const DELETE_AFTER_SLICE_FAILURE = false;
export const DEBUG_LOGGING = false;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const uploadDir = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

if (DEBUG_LOGGING) console.log(`Upload directory: ${uploadDir}`); // Add logging to verify path

app.use(
	cors({
		origin: process.env.ENV === 'development' ? `http://localhost:3000` : process.env.PUBLIC_FRONTEND_URL,
		methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
		credentials: true,
	}),
);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

app.use('/profiles', profiles);
app.use('/slice', slicing);
app.use('/generate', generate);

const makeSignedUrl = (filename: string) => {
	const secret = process.env.DOWNLOAD_SECRET;
	if (!secret) throw new Error('DOWNLOAD_SECRET is required');
	const sig = crypto.createHmac('sha256', secret).update(filename).digest('hex');
	const base = process.env.ENV === 'development' ? `http://localhost:${PORT}` : process.env.PUBLIC_BASE_URL;
	return `${base}/file/${encodeURIComponent(filename)}?s=${sig}`;
};

app.get('/', (req, res) => {
	res.sendStatus(200);
});

// Protected file download (signed, permanent)
app.get('/file/:filename', (req, res) => {
	try {
		const filename = req.params.filename;
		const s = req.query.s as string | undefined;

		const secret = process.env.DOWNLOAD_SECRET;
		if (!secret || !filename || !s) {
			return res.status(400).json({ error: 'Invalid link' });
		}

		const expected = crypto.createHmac('sha256', secret).update(filename).digest('hex');
		// Constant-time compare
		if (s.length !== expected.length) {
			return res.status(403).json({ error: 'Invalid signature' });
		}
		const valid = crypto.timingSafeEqual(Buffer.from(s, 'utf8'), Buffer.from(expected, 'utf8'));
		if (!valid) {
			return res.status(403).json({ error: 'Invalid signature' });
		}

		// Prevent path traversal
		const filePath = path.resolve(uploadDir, filename);
		if (!filePath.startsWith(uploadDir)) {
			return res.status(400).json({ error: 'Invalid path' });
		}
		if (!fs.existsSync(filePath)) {
			return res.status(404).json({ error: 'Not found' });
		}

		return res.sendFile(filePath);
	} catch (error) {
		console.error('Error in file download:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

app.get('/products/:filename', (req, res) => {
	try {
		const filename = req.params.filename;
		// Prevent path traversal
		const productsDir = process.env.PRODUCTS_DIR || path.resolve(process.cwd(), 'products');
		const filePath = path.resolve(productsDir, filename);
		if (!filePath.startsWith(productsDir)) {
			return res.status(400).json({ error: 'Invalid path' });
		}
		if (!fs.existsSync(filePath)) {
			return res.status(404).json({ error: 'Not found' });
		}

		return res.sendFile(filePath);
	} catch (error) {
		console.error('Error in product file download:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Fallback error handler
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
	console.error(`[${new Date().toISOString()}] Unhandled error:`, err);
	if (!res.headersSent) {
		res.status(500).json({ error: 'Internal server error' });
	}
});

app.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}, environment: ${process.env.ENV || 'production'}`);
});
