import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import profiles from './profiles/route.ts';
import slicing from './slicing/route.ts';
import generate from './generate/route.ts';

import multer from 'multer';
import fs from 'fs';
import crypto from 'crypto';
import type { UploadChunk } from './types.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const uploadDir = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

// keep track of upload sessions
const uploadSessions = new Map<
	string,
	{
		chunks: Map<number, Buffer>;
		totalChunks: number;
		filetype: string;
		originalName?: string;
	}
>();

app.use(
	cors({
		origin: process.env.ENV === 'development' ? `http://localhost:3000` : process.env.PUBLIC_FRONTEND_URL,
		methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
	}),
);
app.use(express.json({ limit: '10mb' }));

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

// const storage = multer.diskStorage({
// 	destination: (req, file, cb) => cb(null, uploadDir),
// 	filename: (req, file, cb) => {
// 		const ts = Date.now();
// 		const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
// 		cb(null, `${ts}-${safe}`);
// 	},
// });
// const uploader = multer({
// 	storage,
// 	limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
// });

app.get('/', (req, res) => {
	res.sendStatus(200);
});

app.post('/upload', express.json({ limit: '10mb' }), (req, res) => {
	const chunk: UploadChunk = req.body;
	if (!chunk) return res.status(400).json({ error: 'No chunk data' });

	console.log(`Received chunk ${chunk.currentChunk}/${chunk.totalChunks} for ID ${chunk.id}`);

	if (!chunk.id || chunk.currentChunk < 0 || chunk.totalChunks <= 0) {
		return res.status(400).json({ error: 'Invalid chunk data' });
	}

	// Initialize session if first chunk
	if (!uploadSessions.has(chunk.id)) {
		uploadSessions.set(chunk.id, {
			chunks: new Map(),
			totalChunks: chunk.totalChunks,
			filetype: chunk.filetype,
		});
	}

	const session = uploadSessions.get(chunk.id)!;

	// Store chunk data
	const chunkBuffer = Buffer.from(chunk.data, 'base64');
	session.chunks.set(chunk.currentChunk, chunkBuffer);

	// Check if all chunks received
	if (session.chunks.size === session.totalChunks) {
		console.log(`All chunks received for ID ${chunk.id}, assembling file...`);
		console.log(
			`Chunks: ${Array.from(session.chunks.keys())
				.sort((a, b) => a - b)
				.join(', ')}`,
		);

		try {
			// Assemble file
			const completeFile = Buffer.concat([...session.chunks.values()]);

			// Save assembled file
			const filename = `${Date.now()}-${chunk.id}.${chunk.filetype.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'}`;
			const filePath = path.join(uploadDir, filename);
			fs.writeFileSync(filePath, completeFile);

			// Clean up session
			uploadSessions.delete(chunk.id);

			console.log(`File assembled and saved as ${filename}`);
			return res.json({
				id: chunk.id,
				filename,
				size: completeFile.length,
				filetype: session.filetype,
				url: makeSignedUrl(filename),
				complete: true,
			});
		} catch (error) {
			uploadSessions.delete(chunk.id);
			console.error('Error assembling file:', error);
			return res.status(500).json({ error: 'Failed to assemble file' });
		}
	}

	res.json({
		received: chunk.currentChunk + 1,
		total: chunk.totalChunks,
		complete: false,
	});
});

// Protected file download (signed, permanent)
app.get('/file/:filename', (req, res) => {
	const filename = req.params.filename;
	const s = req.query.s as string | undefined;

	const secret = process.env.DOWNLOAD_SECRET;
	if (!secret || !filename || !s) return res.status(400).json({ error: 'Invalid link' });

	const expected = crypto.createHmac('sha256', secret).update(filename).digest('hex');
	// Constant-time compare
	if (s.length !== expected.length) return res.status(403).json({ error: 'Invalid signature' });
	const valid = crypto.timingSafeEqual(Buffer.from(s, 'utf8'), Buffer.from(expected, 'utf8'));
	if (!valid) return res.status(403).json({ error: 'Invalid signature' });

	// Prevent path traversal
	const filePath = path.resolve(uploadDir, filename);
	if (!filePath.startsWith(uploadDir)) return res.status(400).json({ error: 'Invalid path' });
	if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

	return res.sendFile(filePath);
});

// Multer error handling (e.g., file too large)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
	if (err instanceof multer.MulterError) {
		if (err.code === 'LIMIT_FILE_SIZE') {
			return res.status(413).json({ error: 'File too large. Max 500MB.' });
		}
		return res.status(400).json({ error: err.message });
	}
	return next(err);
});

// Fallback error handler
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
	console.error(err);
	res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}, environment: ${process.env.ENV || 'production'}`);
});
