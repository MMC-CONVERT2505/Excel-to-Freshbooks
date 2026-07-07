import { Router } from 'express';
import { redirectToFreshBooks, selectBusiness, getAuthStatus, getCompanies, switchCompany, updateCompanyLabel } from '../controllers/auth.controller.js';
import { appLogin, appMe, appLogout } from '../controllers/appAuth.controller.js';

const router = Router();

// App-level auth (JWT)
router.post('/app/login',  appLogin);
router.get('/app/me',      appMe);
router.post('/app/logout', appLogout);

// FreshBooks OAuth
router.get('/login',                      redirectToFreshBooks);
router.get('/select-business/:index',     selectBusiness);
router.post('/select-business/:index',    selectBusiness);
router.get('/status',                     getAuthStatus);
router.get('/companies',                  getCompanies);
router.post('/switch/:tokenId',           switchCompany);
router.put('/companies/:tokenId/label',   updateCompanyLabel);

export default router;
