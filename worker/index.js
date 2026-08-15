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
import * as bluemap from './routes/bluemap.js';
import * as banking from './routes/banking.js';
import * as bankingAdmin from './routes/banking-admin.js';
import * as bankingCC from './routes/banking-cc.js';
import * as exchange from './routes/exchange.js';
import * as exchangeAdmin from './routes/exchange-admin.js';
import * as exchangeCC from './routes/exchange-cc.js';
import * as ballistics from './routes/ballistics.js';
import * as ballisticsCC from './routes/ballistics-cc.js';
import { runMarketTick, syncFundamentalsFromBank } from './lib/market-engine.js';
import * as store from './lib/store.js';

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

async function doDividendPayments(db) {
  const now = new Date().toISOString().split('T')[0];
  const { results: dividends } = await db.prepare(
    "SELECT * FROM fdx_dividends WHERE status = 'pending' AND pay_date <= ?"
  ).bind(now).all();

  for (const div of (dividends || [])) {
    const { results: holders } = await db.prepare(
      'SELECT account_id, quantity FROM fdx_portfolios WHERE company_id = ? AND quantity > 0'
    ).bind(div.company_id).all();

    let totalPaid = 0;
    for (const holder of (holders || [])) {
      const amount = Math.round(holder.quantity * div.dividend_per_share * 100) / 100;
      if (amount <= 0) continue;

      // Credit the holder's banking account
      const account = await db.prepare(
        'SELECT balance FROM banking_accounts WHERE key = ?'
      ).bind(holder.account_id).first();
      if (!account) continue;

      const newBalance = Math.round((account.balance + amount) * 100) / 100;
      try {
        await db.batch([
          db.prepare('UPDATE banking_accounts SET balance = ?, updated_at = ? WHERE key = ?')
            .bind(newBalance, new Date().toISOString(), holder.account_id),
          db.prepare(
            'INSERT INTO banking_transactions (from_key, to_key, amount, from_balance_after, to_balance_after, description, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind('__dividends__', holder.account_id, amount, 0, newBalance, 'DIVIDEND: ' + div.dividend_per_share + '/share',
                 'system:cron', new Date().toISOString()),
        ]);
        totalPaid = Math.round((totalPaid + amount) * 100) / 100;
      } catch (err) {
        console.error('Dividend payment error for', holder.account_id, err.message);
      }
    }

    await db.prepare(
      "UPDATE fdx_dividends SET status = 'paid', total_paid = ? WHERE id = ?"
    ).bind(totalPaid, div.id).run();
  }
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

        if (pathname === '/api/legal/drafts' && method === 'GET') return await legal.listDrafts(request, env);
        if (pathname === '/api/legal/drafts' && method === 'POST') return await legal.createDraft(request, env);

        m = pathname.match(/^\/api\/legal\/drafts\/(\d+)$/);
        if (m && method === 'PUT') return await legal.updateDraft(request, env, m[1]);
        if (m && method === 'DELETE') return await legal.deleteDraft(request, env, m[1]);

        m = pathname.match(/^\/api\/legal\/drafts\/(\d+)\/request-changes$/);
        if (m && method === 'POST') return await legal.requestChangesDraft(request, env, m[1]);

        m = pathname.match(/^\/api\/legal\/drafts\/(\d+)\/publish$/);
        if (m && method === 'POST') return await legal.publishDraft(request, env, m[1]);

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

        // ---- Fiducia Exchange (Public) ----
        if (pathname === '/api/exchange/market' && method === 'GET') return await exchange.getMarket(request, env);
        if (pathname === '/api/exchange/index' && method === 'GET') return await exchange.getIndex(request, env);
        if (pathname === '/api/exchange/sectors' && method === 'GET') return await exchange.getSectors(request, env);
        if (pathname === '/api/exchange/orders' && method === 'GET') return await exchange.getMyOrders(request, env);
        if (pathname === '/api/exchange/orders' && method === 'POST') return await exchange.placeOrder(request, env);
        if (pathname === '/api/exchange/trades' && method === 'GET') return await exchange.getMyTrades(request, env);
        if (pathname === '/api/exchange/portfolio' && method === 'GET') return await exchange.getMyPortfolio(request, env);
        if (pathname === '/api/exchange/watchlist' && method === 'GET') return await exchange.getWatchlist(request, env);

        m = pathname.match(/^\/api\/exchange\/companies\/([A-Z]+)$/);
        if (m && method === 'GET') return await exchange.getCompany(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/companies\/([A-Z]+)\/candles$/);
        if (m && method === 'GET') return await exchange.getCompanyCandles(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/companies\/([A-Z]+)\/orderbook$/);
        if (m && method === 'GET') return await exchange.getOrderBook(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/companies\/([A-Z]+)\/trades$/);
        if (m && method === 'GET') return await exchange.getCompanyTrades(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/companies\/([A-Z]+)\/shareholders$/);
        if (m && method === 'GET') return await exchange.getCompanyShareholders(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/companies\/([A-Z]+)\/reports$/);
        if (m && method === 'GET') return await exchange.getCompanyReports(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/orders\/(\d+)$/);
        if (m && method === 'DELETE') return await exchange.cancelOrder(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/watchlist\/([A-Z]+)$/);
        if (m && method === 'POST') return await exchange.addToWatchlist(request, env, m[1]);
        if (m && method === 'DELETE') return await exchange.removeFromWatchlist(request, env, m[1]);

        // ---- Fiducia Exchange: Offerings ----
        if (pathname === '/api/exchange/ipo' && method === 'GET') return await exchange.listIpos(request, env);
        if (pathname === '/api/exchange/ipo/my' && method === 'GET') return await exchange.getMyIpoSubscriptions(request, env);

        m = pathname.match(/^\/api\/exchange\/ipo\/(\d+)\/subscribe$/);
        if (m && method === 'POST') return await exchange.subscribeToIpo(request, env, m[1]);
        if (m && method === 'DELETE') return await exchange.cancelIpoSubscription(request, env, m[1]);

        // ---- Fiducia Exchange: News Feed ----
        if (pathname === '/api/exchange/news-feed' && method === 'GET') return await exchangeAdmin.getNewsFeed(request, env);

        // ---- Fiducia Exchange (Admin) ----
        if (pathname === '/api/exchange/admin/companies' && method === 'GET') return await exchangeAdmin.listAllCompanies(request, env);
        if (pathname === '/api/exchange/admin/dividends' && method === 'POST') return await exchangeAdmin.declareDividend(request, env);
        if (pathname === '/api/exchange/admin/dividends' && method === 'GET') return await exchangeAdmin.listDividends(request, env);
        if (pathname === '/api/exchange/admin/audit' && method === 'GET') return await exchangeAdmin.getAuditLog(request, env);
        if (pathname === '/api/exchange/admin/halts' && method === 'GET') return await exchangeAdmin.getHaltHistory(request, env);
        if (pathname === '/api/exchange/admin/flagged/orders' && method === 'GET') return await exchangeAdmin.getFlaggedOrders(request, env);
        if (pathname === '/api/exchange/admin/flagged/trades' && method === 'GET') return await exchangeAdmin.getFlaggedTrades(request, env);
        if (pathname === '/api/exchange/admin/settings' && method === 'GET') return await exchangeAdmin.getSettings(request, env);
        if (pathname === '/api/exchange/admin/settings' && method === 'PUT') return await exchangeAdmin.updateSettings(request, env);
        if (pathname === '/api/exchange/admin/reports' && method === 'GET') return await exchangeAdmin.getReports(request, env);
        if (pathname === '/api/exchange/admin/reports' && method === 'POST') return await exchangeAdmin.createReport(request, env);
        if (pathname === '/api/exchange/admin/halt' && method === 'POST') return await exchangeAdmin.globalHalt(request, env);
        if (pathname === '/api/exchange/admin/resume' && method === 'POST') return await exchangeAdmin.globalResume(request, env);

        m = pathname.match(/^\/api\/exchange\/admin\/reports\/(\d+)$/);
        if (m && method === 'PUT') return await exchangeAdmin.updateReport(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/company\/([A-Z]+)$/);
        if (m && method === 'GET') return await exchangeAdmin.getCompanyByTicker(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)$/);
        if (m && method === 'PUT') return await exchangeAdmin.updateCompany(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/fundamentals$/);
        if (m && method === 'PUT') return await exchangeAdmin.updateFundamentals(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/halt$/);
        if (m && method === 'POST') return await exchangeAdmin.haltCompany(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/resume$/);
        if (m && method === 'POST') return await exchangeAdmin.resumeCompany(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/shares\/issue$/);
        if (m && method === 'POST') return await exchangeAdmin.issueShares(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/shares\/buyback$/);
        if (m && method === 'POST') return await exchangeAdmin.buybackShares(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/split$/);
        if (m && method === 'POST') return await exchangeAdmin.stockSplit(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/delist$/);
        if (m && method === 'POST') return await exchangeAdmin.delistCompany(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/ipo\/subscriptions$/);
        if (m && method === 'GET') return await exchangeAdmin.getIpoSubscriptions(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/ipo\/allocate$/);
        if (m && method === 'POST') return await exchangeAdmin.allocateIpo(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/ipo\/cancel$/);
        if (m && method === 'POST') return await exchangeAdmin.cancelIpo(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/companies\/(\d+)\/offering$/);
        if (m && method === 'POST') return await exchangeAdmin.openIpo(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/dividends\/(\d+)$/);
        if (m && method === 'DELETE') return await exchangeAdmin.cancelDividend(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/flagged\/orders\/(\d+)\/dismiss$/);
        if (m && method === 'POST') return await exchangeAdmin.dismissFlaggedOrder(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/admin\/flagged\/trades\/(\d+)\/dismiss$/);
        if (m && method === 'POST') return await exchangeAdmin.dismissFlaggedTrade(request, env, m[1]);

        // ---- Fiducia Exchange: ComputerCraft Bridge ----
        if (pathname === '/api/exchange/cc/market' && method === 'GET') return await exchangeCC.ccMarket(request, env);
        if (pathname === '/api/exchange/cc/index' && method === 'GET') return await exchangeCC.ccIndex(request, env);
        if (pathname === '/api/exchange/cc/portfolio' && method === 'POST') return await exchangeCC.ccPortfolio(request, env);
        if (pathname === '/api/exchange/cc/orders' && method === 'POST') return await exchangeCC.ccPlaceOrder(request, env);
        if (pathname === '/api/exchange/cc/orders/list' && method === 'POST') return await exchangeCC.ccMyOrders(request, env);
        if (pathname === '/api/exchange/cc/orders/cancel' && method === 'POST') return await exchangeCC.ccCancelOrder(request, env);
        if (pathname === '/api/exchange/cc/trades' && method === 'POST') return await exchangeCC.ccMyTrades(request, env);

        m = pathname.match(/^\/api\/exchange\/cc\/quote\/([A-Z]+)$/);
        if (m && method === 'GET') return await exchangeCC.ccQuote(request, env, m[1]);

        m = pathname.match(/^\/api\/exchange\/cc\/orderbook\/([A-Z]+)$/);
        if (m && method === 'GET') return await exchangeCC.ccOrderBook(request, env, m[1]);

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

        // ---- Ballistic Calculator: static cannon registry + CC bridge ----
        if (pathname === '/api/ballistics/cannons' && method === 'GET') return await ballistics.listCannons(request, env);
        if (pathname === '/api/ballistics/cc/poll' && method === 'POST') return await ballisticsCC.ccPoll(request, env);

        m = pathname.match(/^\/api\/ballistics\/cannons\/(\d+)\/accept$/);
        if (m && method === 'POST') return await ballistics.acceptCannon(request, env, m[1]);

        m = pathname.match(/^\/api\/ballistics\/cannons\/(\d+)\/fire$/);
        if (m && method === 'POST') return await ballistics.fireCannon(request, env, m[1]);

        m = pathname.match(/^\/api\/ballistics\/cannons\/(\d+)$/);
        if (m && method === 'PUT') return await ballistics.updateCannon(request, env, m[1]);
        if (m && method === 'DELETE') return await ballistics.deleteCannon(request, env, m[1]);

        // ---- Ballistic Calculator / Land Registry: BlueMap proxy ----
        if (pathname === '/api/bluemap-config' && method === 'GET') return await bluemap.getConfig(request, env);
        if (pathname === '/api/maptile' && method === 'GET') return await bluemap.getTile(request, env);

        return json({ error: 'Not found.' }, { status: 404 });
      } catch (err) {
        console.error('API error:', err);
        return json({ error: 'Server error.' }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const cron = event.cron;
    const now = new Date();

    if (cron === '*/5 * * * *') {
      // 5-minute market tick
      try {
        await runMarketTick(env.DB);
      } catch (err) {
        console.error('Market tick error:', err);
      }
    }

    if (cron === '0 * * * *') {
      // Hourly fundamental sync
      try {
        await syncFundamentalsFromBank(env.DB);
      } catch (err) {
        console.error('Fundamental sync error:', err);
      }
    }

    if (cron === '0 20 * * *') {
      // End-of-day settlement
      try {
        const now = new Date().toISOString();
        // Expire ALL DAY orders (buy and sell). No fund release needed:
        // reservations are virtual — getAvailableBalance subtracts open order
        // costs from balance; when an order expires, the reservation
        // disappears automatically.
        await env.DB.prepare(
          `UPDATE fdx_orders SET status = 'expired', cancelled_at = ?
           WHERE time_in_force = 'DAY' AND status IN ('open','partial')`
        ).bind(now).run();

        // Store prev_close, reset day stats for all active companies
        await env.DB.prepare(
          `UPDATE fdx_companies SET prev_close_price = current_price,
             day_high = NULL, day_low = NULL, day_volume = 0,
             updated_at = ?
           WHERE status = 'active'`
        ).bind(now).run();

        // Pay any dividends due today
        await doDividendPayments(env.DB);
      } catch (err) {
        console.error('EOD settlement error:', err);
      }
    }

    if (cron === '0 8 * * *') {
      // Market open — close previous day's 1d candles and open fresh ones
      try {
        const now = new Date();
        const { results: companies } = await env.DB.prepare(
          "SELECT * FROM fdx_companies WHERE status = 'active'"
        ).all();

        for (const co of (companies || [])) {
          const price = co.current_price || co.ipo_price || 0;
          if (price <= 0) continue;

          // Insert a new 1d candle using today's market-open time as open_time
          const today = new Date(now);
          today.setUTCHours(8, 0, 0, 0);
          const openTime = today.toISOString();

          // Only insert if no candle exists for this open time
          const existing = await env.DB.prepare(
            "SELECT id FROM fdx_candles WHERE company_id = ? AND interval = '1d' AND open_time = ?"
          ).bind(co.id, openTime).first();

          if (!existing) {
            await env.DB.prepare(
              `INSERT INTO fdx_candles (company_id, interval, open_time, open, high, low, close, volume, trade_count)
               VALUES (?, '1d', ?, ?, ?, ?, ?, 0, 0)`
            ).bind(co.id, openTime, price, price, price, price).run();
          }
        }

        console.log('Market open at 08:00 UTC — new 1d candles created');
      } catch (err) {
        console.error('Market open error:', err);
      }
    }

    // Always run tax check on any cron trigger
    try {
      const settings = await store.getBankingSettings(env);
      if (settings.tax_enabled) {
        const lastRun = settings.tax_last_run_at ? new Date(settings.tax_last_run_at) : new Date(0);
        const msPerDay = 86400000;
        const dueAt = new Date(lastRun.getTime() + settings.tax_period_days * msPerDay);
        if (now >= dueAt) {
          await store.applyTaxes(env, 'system:cron');
        }
      }
    } catch (err) {
      console.error('Tax check error:', err);
    }

    // Insert value history snapshots for all companies
    try {
      const companies = await store.listBankingAccounts(env, { type: 'company' });
      for (const co of companies) {
        await store.insertCompanyValueSnapshot(env, co.key, co.balance);
      }
    } catch (err) {
      console.error('Value snapshot error:', err);
    }
  },
};
