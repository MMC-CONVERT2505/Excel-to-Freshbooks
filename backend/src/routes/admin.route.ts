import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { listUsers, createUser, deleteUser, updateUser, getActivity, getStats } from '../controllers/admin.controller.js';

const router = Router();
router.use(requireAdmin);

router.get('/stats',         getStats);
router.get('/users',         listUsers);
router.post('/users',        createUser);
router.put('/users/:id',     updateUser);
router.delete('/users/:id',  deleteUser);
router.get('/activity',      getActivity);

export default router;
