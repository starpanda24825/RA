/* ============================================================
   Regnum Aeternum — Worker entry point
   This is the Worker referenced by wrangler.jsonc's "main" field.
   It does two jobs:
     1. Handle /api/* with real logic, backed by D1.
     2. Hand everything else to the static assets binding (the
        regnum-aeternum/ directory) — same behaviour as before,
        just explicit now instead of being the *only* thing that ran.
   ============================================================ */

import { handleRegister, handleLogin, handleLogout, handleMe, handleChangeUsername, handleChangePassword } from './routes/auth.js';
import { listUsersRoute, createUserRoute, updateUserRoute, deleteUserRoute } from './routes/admin.js';
import * as news from './routes/news.js';
import * as legal from './routes/legal.js';
import * as landregistry from './routes/landregistry.js';
import * as dynmap from './routes/dynmap.js';
import * as banking from './routes/banking.js';
import * as bankingAdmin from './routes/banking-admin.js';
import * as bankingCC from './routes/banking-cc.js';
import * as store from './lib/store.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname.startsWith('/api/')) {
      try {
        // ---- auth ----
        if (pathname === '/api/auth/register' && method === 'POST') return await handleRegister(request, env);
        if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(request, env);
        if (pathname === '/api/auth/logout' && method === 'POST') return await handleLogout(request, env);
        if (pathname === '/api/auth/me' && method === 'GET') return await handleMe(request, env);
        if (pathname === '/api/auth/username' && method === 'PUT') return await handleChangeUsername(request, env);
        if (pathname === '/api/auth/password' && method === 'PUT') return await handleChangePassword(request, env);

        // ---- admin: account management ----
        if (pathname === '/api/admin/users' && method === 'GET') return await listUsersRoute(request, env);
        if (pathname === '/api/admin/users' && method === 'POST') return await createUserRoute(request, env);

        let m = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
        if (m && method === 'PUT') return await updateUserRoute(request, env, m[1]);
        if (m && method === 'DELETE') return await deleteUserRoute(request, env, m[1]);

        // ---- Times of Regnum ----
        if (pathname === '/api/news/articles' && method === 'GET') return await news.listPublished(request, env);
        if (pathname === '/api/news/articles/all' && method === 'GET') return await news.listAll(request, env);
        if (pathname === '/api/news/articles' && method === 'POST') return await news.create(request, env);

        m = pathname.match(/^\/api\/news\/articles\/(\d+)$/);
        if (m && method === 'GET') return await news.getOne(request, env, m[1]);
        if (m && method === 'PUT') return await news.update(request, env, m[1]);
        if (m && method === 'DELETE') return await news.remove(request, env, m[1]);

        m = pathname.match(/^\/api\/news\/articles\/(\d+)\/publish$/);
        if (m && method === 'PUT') return await news.publish(request, env, m[1]);

        m = pathname.match(/^\/api\/news\/articles\/(\d+)\/unpublish$/);
        if (m && method === 'PUT') return await news.unpublish(request, env, m[1]);

        // ---- Times of Regnum: Newspapers ----
        if (pathname === '/api/news/newspapers' && method === 'GET') return await news.listNewspapersPublished(request, env);
        if (pathname === '/api/news/newspapers/all' && method === 'GET') return await news.listNewspapersAll(request, env);
        if (pathname === '/api/news/newspapers' && method === 'POST') return await news.createNewspaper(request, env);

        m = pathname.match(/^\/api\/news\/newspapers\/(\d+)$/);
        if (m && method === 'GET') return await news.getNewspaper(request, env, m[1]);
        if (m && method === 'PUT') return await news.updateNewspaper(request, env, m[1]);
        if (m && method === 'DELETE') return await news.removeNewspaper(request, env, m[1]);

        m = pathname.match(/^\/api\/news\/newspapers\/(\d+)\/publish$/);
        if (m && method === 'PUT') return await news.publishNewspaper(request, env, m[1]);

        m = pathname.match(/^\/api\/news\/newspapers\/(\d+)\/unpublish$/);
        if (m && method === 'PUT') return await news.unpublishNewspaper(request, env, m[1]);

        // ---- Legal Information System ----
        if (pathname === '/api/legal/data' && method === 'GET') return await legal.getPublicData(request, env);

        if (pathname === '/api/legal/acts' && method === 'GET') return await legal.listActsAdmin(request, env);
        if (pathname === '/api/legal/acts' && method === 'POST') return await legal.createAct(request, env);

        m = pathname.match(/^\/api\/legal\/acts\/([a-z0-9-]+)$/);
        if (m && method === 'PUT') return await legal.updateAct(request, env, m[1]);
        if (m && method === 'DELETE') return await legal.deleteAct(request, env, m[1]);

        if (pathname === '/api/legal/case-law' && method === 'GET') return await legal.listCaseLawAdmin(request, env);
        if (pathname === '/api/legal/case-law' && method === 'POST') return await legal.createCase(request, env);

        m = pathname.match(/^\/api\/legal\/case-law\/([a-z0-9-]+)$/);
        if (m && method === 'PUT') return await legal.updateCase(request, env, m[1]);
        if (m && method === 'DELETE') return await legal.deleteCase(request, env, m[1]);

        // ---- Land Registry System ----
        if (pathname === '/api/landregistry/data' && method === 'GET') return await landregistry.getPublicData(request, env);
        if (pathname === '/api/landregistry/plots' && method === 'GET') return await landregistry.listPlotsAdmin(request, env);
        if (pathname === '/api/landregistry/plots' && method === 'POST') return await landregistry.createPlot(request, env);
        if (pathname === '/api/landregistry/next-book-number' && method === 'GET') return await landregistry.nextBookNumber(request, env);

        m = pathname.match(/^\/api\/landregistry\/plots\/([^/]+)$/);
        if (m && method === 'GET') return await landregistry.getOnePublic(request, env, decodeURIComponent(m[1]));
        if (m && method === 'PUT') return await landregistry.updatePlot(request, env, decodeURIComponent(m[1]));
        if (m && method === 'DELETE') return await landregistry.deletePlot(request, env, decodeURIComponent(m[1]));

        // ---- Banking: Citizen Portal ----
        if (pathname === '/api/banking/me' && method === 'GET') return await banking.getMe(request, env);
        if (pathname === '/api/banking/me/transactions' && method === 'GET') return await banking.getMyTransactions(request, env);
        if (pathname === '/api/banking/me/portfolio' && method === 'GET') return await banking.getMyPortfolio(request, env);
        if (pathname === '/api/banking/transfer' && method === 'POST') return await banking.transfer(request, env);
        if (pathname === '/api/banking/accounts/search' && method === 'GET') return await banking.searchAccounts(request, env);
        if (pathname === '/api/banking/company/issue-shares' && method === 'POST') return await banking.issueCompanyShares(request, env);
        if (pathname === '/api/banking/companies' && method === 'GET') return await banking.listCompanies(request, env);
        if (pathname === '/api/banking/companies/top' && method === 'GET') return await banking.getTopCompanies(request, env);

        m = pathname.match(/^\/api\/banking\/companies\/([^/]+)\/shareholders$/);
        if (m && method === 'GET') return await banking.getCompanyShareholders(request, env, m[1]);

        // ---- Banking: Admin/Banker Panel ----
        if (pathname === '/api/banking/admin/accounts' && method === 'GET') return await bankingAdmin.listAccounts(request, env);
        if (pathname === '/api/banking/admin/accounts' && method === 'POST') return await bankingAdmin.createAccount(request, env);
        if (pathname === '/api/banking/admin/transaction' && method === 'POST') return await bankingAdmin.adminTransfer(request, env);
        if (pathname === '/api/banking/admin/fine' && method === 'POST') return await bankingAdmin.adminFine(request, env);
        if (pathname === '/api/banking/admin/settings' && method === 'GET') return await bankingAdmin.getSettings(request, env);
        if (pathname === '/api/banking/admin/settings' && method === 'PUT') return await bankingAdmin.updateSettings(request, env);
        if (pathname === '/api/banking/admin/treasuries' && method === 'GET') return await bankingAdmin.listTreasuries(request, env);
        if (pathname === '/api/banking/admin/treasuries' && method === 'POST') return await bankingAdmin.createTreasury(request, env);
        if (pathname === '/api/banking/admin/banker-assignments' && method === 'GET') return await bankingAdmin.listBankerAssignmentsRoute(request, env);
        if (pathname === '/api/banking/admin/taxes/run' && method === 'POST') return await bankingAdmin.runTaxes(request, env);
        if (pathname === '/api/banking/admin/companies' && method === 'GET') return await bankingAdmin.listCompaniesAdmin(request, env);
        if (pathname === '/api/banking/admin/shares/issue' && method === 'POST') return await bankingAdmin.issueSharesAdmin(request, env);
        if (pathname === '/api/banking/admin/cc-tokens' && method === 'GET') return await bankingAdmin.listCCTokens(request, env);
        if (pathname === '/api/banking/admin/cc-tokens' && method === 'POST') return await bankingAdmin.issueCCToken(request, env);

        m = pathname.match(/^\/api\/banking\/admin\/accounts\/([^/]+)$/);
        if (m && method === 'GET') return await bankingAdmin.getAccount(request, env, m[1]);
        if (m && method === 'PUT') return await bankingAdmin.updateAccount(request, env, m[1]);
        if (m && method === 'DELETE') return await bankingAdmin.deleteAccount(request, env, m[1]);

        m = pathname.match(/^\/api\/banking\/admin\/accounts\/([^/]+)\/freeze$/);
        if (m && method === 'PUT') return await bankingAdmin.freezeAccount(request, env, m[1]);

        m = pathname.match(/^\/api\/banking\/admin\/accounts\/([^/]+)\/password-reset$/);
        if (m && method === 'PUT') return await bankingAdmin.resetPasswordAdmin(request, env, m[1]);

        m = pathname.match(/^\/api\/banking\/admin\/accounts\/([^/]+)\/log$/);
        if (m && method === 'GET') return await bankingAdmin.getAccountLog(request, env, m[1]);

        m = pathname.match(/^\/api\/banking\/admin\/accounts\/([^/]+)\/link-user$/);
        if (m && method === 'PUT') return await bankingAdmin.linkUser(request, env, m[1]);
        if (m && method === 'DELETE') return await bankingAdmin.unlinkUser(request, env, m[1]);

        m = pathname.match(/^\/api\/banking\/admin\/accounts\/([^/]+)\/cards$/);
        if (m && method === 'GET') return await bankingAdmin.listCards(request, env, m[1]);
        if (m && method === 'POST') return await bankingAdmin.issueCard(request, env, m[1]);

        m = pathname.match(/^\/api\/banking\/admin\/accounts\/([^/]+)\/cards\/([^/]+)\/cancel$/);
        if (m && method === 'PUT') return await bankingAdmin.cancelCard(request, env, m[1], m[2]);

        m = pathname.match(/^\/api\/banking\/admin\/accounts\/([^/]+)\/cards\/([^/]+)$/);
        if (m && method === 'DELETE') return await bankingAdmin.deleteCard(request, env, m[1], m[2]);

        m = pathname.match(/^\/api\/banking\/admin\/treasuries\/([^/]+)$/);
        if (m && method === 'PUT') return await bankingAdmin.updateTreasury(request, env, m[1]);
        if (m && method === 'DELETE') return await bankingAdmin.deleteTreasury(request, env, m[1]);

        m = pathname.match(/^\/api\/banking\/admin\/banker-assignments\/(\d+)$/);
        if (m && method === 'PUT') return await bankingAdmin.upsertBankerAssignmentRoute(request, env, m[1]);
        if (m && method === 'DELETE') return await bankingAdmin.deleteBankerAssignmentRoute(request, env, m[1]);

        m = pathname.match(/^\/api\/banking\/admin\/companies\/([^/]+)\/shareholders$/);
        if (m && method === 'GET') return await bankingAdmin.getCompanyShareholdersAdmin(request, env, m[1]);

        m = pathname.match(/^\/api\/banking\/admin\/cc-tokens\/(\d+)$/);
        if (m && method === 'DELETE') return await bankingAdmin.revokeCCToken(request, env, m[1]);

        // ---- Banking: ComputerCraft Bridge ----
        if (pathname === '/api/banking/cc/server-data' && method === 'POST') return await bankingCC.ccServerData(request, env);
        if (pathname === '/api/banking/cc/client-data' && method === 'POST') return await bankingCC.ccClientData(request, env);
        if (pathname === '/api/banking/cc/transaction' && method === 'POST') return await bankingCC.ccTransaction(request, env);
        if (pathname === '/api/banking/cc/deposit' && method === 'POST') return await bankingCC.ccDeposit(request, env);
        if (pathname === '/api/banking/cc/withdraw' && method === 'POST') return await bankingCC.ccWithdraw(request, env);
        if (pathname === '/api/banking/cc/transaction-log' && method === 'POST') return await bankingCC.ccTransactionLog(request, env);
        if (pathname === '/api/banking/cc/validate-card' && method === 'POST') return await bankingCC.ccValidateCard(request, env);
        if (pathname === '/api/banking/cc/register-card' && method === 'POST') return await bankingCC.ccRegisterCard(request, env);
        if (pathname === '/api/banking/cc/cancel-card' && method === 'POST') return await bankingCC.ccCancelCard(request, env);
        if (pathname === '/api/banking/cc/list-cards' && method === 'POST') return await bankingCC.ccListCards(request, env);
        if (pathname === '/api/banking/cc/new-account' && method === 'POST') return await bankingCC.ccNewAccount(request, env);
        if (pathname === '/api/banking/cc/new-company' && method === 'POST') return await bankingCC.ccNewCompany(request, env);
        if (pathname === '/api/banking/cc/delete-account' && method === 'POST') return await bankingCC.ccDeleteAccount(request, env);
        if (pathname === '/api/banking/cc/set-password' && method === 'POST') return await bankingCC.ccSetPassword(request, env);
        if (pathname === '/api/banking/cc/change-password' && method === 'POST') return await bankingCC.ccChangePassword(request, env);
        if (pathname === '/api/banking/cc/reset-password' && method === 'POST') return await bankingCC.ccResetPassword(request, env);
        if (pathname === '/api/banking/cc/freeze-account' && method === 'POST') return await bankingCC.ccFreezeAccount(request, env);
        if (pathname === '/api/banking/cc/list-shareholders' && method === 'POST') return await bankingCC.ccListShareholders(request, env);
        if (pathname === '/api/banking/cc/issue-shares' && method === 'POST') return await bankingCC.ccIssueShares(request, env);
        if (pathname === '/api/banking/cc/get-portfolio' && method === 'POST') return await bankingCC.ccGetPortfolio(request, env);
        if (pathname === '/api/banking/cc/top-companies' && method === 'POST') return await bankingCC.ccTopCompanies(request, env);
        if (pathname === '/api/banking/cc/apply-taxes' && method === 'POST') return await bankingCC.ccApplyTaxes(request, env);

        // ---- Ballistic Calculator: DynMap proxy ----
        if (pathname === '/api/dynmap-config' && method === 'GET') return await dynmap.getConfig(request, env);
        if (pathname === '/api/maptile' && method === 'GET') return await dynmap.getTile(request, env);

        return json({ error: 'Not found.' }, { status: 404 });
      } catch (err) {
        console.error('API error:', err);
        return json({ error: 'Server error.' }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // Check if taxes are due; apply if so
    const settings = await store.getBankingSettings(env);
    if (!settings.tax_enabled) return;

    const lastRun = settings.tax_last_run_at ? new Date(settings.tax_last_run_at) : new Date(0);
    const msPerDay = 86400000;
    const dueAt = new Date(lastRun.getTime() + settings.tax_period_days * msPerDay);

    if (new Date() >= dueAt) {
      await store.applyTaxes(env, 'system:cron');
    }

    // Insert value history snapshots for all companies
    const companies = await store.listBankingAccounts(env, { type: 'company' });
    for (const co of companies) {
      await store.insertCompanyValueSnapshot(env, co.key, co.balance);
    }
  },
};
