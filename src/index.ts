import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';

import multer from 'multer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		cb(null, path.join(dirname(__dirname), 'uploads'));
	},
	filename: (req, file, cb) => {
		cb;
	},
});

app.get('/', (req, res) => {
	res.json({ message: 'Hello World!' });
});

app.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}`);
});
