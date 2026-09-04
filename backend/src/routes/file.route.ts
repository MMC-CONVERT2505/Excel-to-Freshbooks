import { Router } from 'express';
import { requireAppAuth } from '../middleware/requireAppAuth.js';
import {
  listFiles,
  createFile,
  getFile,
  connectFile,
  getFileHistory,
  deleteFile,
} from '../controllers/file.controller.js';

const router = Router();

// Every route here is per-user. requireAppAuth populates req.appUser, and each
// handler scopes its query by that user's id — a file id from another account
// simply does not resolve.
router.use(requireAppAuth);

router.get('/',             listFiles);
router.post('/',            createFile);
router.get('/:id',          getFile);
router.get('/:id/history',  getFileHistory);
router.put('/:id/connect',  connectFile);
router.delete('/:id',       deleteFile);

export default router;
