// ==UserScript==
// @name         Push to Money Keeper - Finplan
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Đẩy các Payment Item có tag "Nhật thanh toán ► ..." lên MISA MoneyKeeper dưới dạng giao dịch chuyển khoản giữa 2 wallet
// @author       Claude
// @match        https://finplan.saigontechnology.vn/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      moneykeeperapp.misa.vn
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /**
     * ============================================================================
     * PUSH TO MONEY KEEPER
     * ============================================================================
     * Quét bảng Payment Item đang hiển thị (trang danh sách /purchase-orders/payment-items hoặc
     * bảng Payment Item trong trang /purchase-orders/update/{id}), lấy các dòng có tag "Nhật thanh toán ► XXXX",
     * hiển thị trong dialog để user chọn/sửa From Wallet, To Wallet, Description, rồi đẩy mỗi
     * dòng lên MISA MoneyKeeper thành 1 giao dịch chuyển khoản (transactionType 2).
     * Tham khảo API: MONEYKEEPER_API.md.
     *
     * Cấu trúc file:
     *   1) CẤU HÌNH MONEYKEEPER - token + extra headers lưu bằng GM_setValue, sửa qua menu
     *      Tampermonkey "Cấu hình MoneyKeeper" (hoặc tự bật khi chưa có token).
     *   2) GỌI API - mkRequest() bọc GM_xmlhttpRequest (API khác domain nên không dùng fetch).
     *   3) ĐỌC BẢNG + CHỌN WALLET MẶC ĐỊNH - parse từng dòng, đoán From/To Wallet. Trang danh sách
     *      đọc theo class cell-body-*; trang PO update (td không có class) đọc theo index cột lấy từ
     *      class cell-head-* của thead, Supplier / PO No lấy từ form của PO.
     *   4) TIẾN TRÌNH PUSH - startPushing() đẩy tuần tự từng dòng được tick "Process".
     *   5) FLOATING BUTTON + DIALOG - nút nổi qua Button Manager dùng chung, dialog kéo được
     *      dựng lại từ đầu mỗi lần đổi trạng thái (renderDialog + build*).
     * ============================================================================
     */

    /* =========================================================================
     *  CONFIG
     * ========================================================================= */
    let utils = null; // Gán 1 lần trong bootstrap async ở cuối file (sau khi waitForFinplanUtils() resolve).
    const PAGE_LIST_PATH = '/purchase-orders/payment-items';
    const PO_UPDATE_REGEX = /^\/purchase-orders\/update\/\d+$/;
    const BUTTON_ID = 'push-to-money-keeper';
    const DIALOG_POSITION_KEY = 'mk_dialog_position_v1';
    const TOKEN_KEY = 'mk_token';                 // GM storage: Bearer token (không kèm chữ "Bearer ").
    const EXTRA_HEADERS_KEY = 'mk_extra_headers'; // GM storage: chuỗi JSON object các header phụ.
    const WALLETS_CACHE_KEY = 'mk_wallets_cache'; // GM storage: { wallets, fetchedAt } - wallet ít thay đổi nên cache lại.
    // GM storage: { [itemNumber]: pushedAt(ms) } - item đã push thành công, lần sau không tự tick để tránh push trùng.
    // Chỉ có tác dụng trên cùng browser/máy. Entry cũ hơn PUSHED_ITEMS_RETENTION_DAYS ngày tự bị xoá.
    const PUSHED_ITEMS_KEY = 'mk_pushed_items';
    const PUSHED_ITEMS_RETENTION_DAYS = 180;
    // Token hết hạn: HTTP 401 + ErrorCode này (xem MONEYKEEPER_API.md mục 1). Retry với cùng token sẽ lỗi mãi.
    const TOKEN_EXPIRED_CODE = 'auth:11001';
    const TOKEN_EXPIRED_MESSAGE = 'Token MoneyKeeper đã hết hạn (auth:11001). Hãy cập nhật token mới.';
    const TOKEN_EXPIRY_WARN_MS = 60 * 60 * 1000; // Còn dưới 1 giờ thì cảnh báo "sắp hết hạn".
    const MK_BASE = 'https://moneykeeperapp.misa.vn/g1/api/business/api/v1';
    const MK_WALLETS_URL = `${MK_BASE}/wallets/addtransaction`;
    const MK_TRANSACTIONS_URL = `${MK_BASE}/transactions/`;
    // Tag có dạng "Nhật thanh toán ► XXXX"; XXXX dùng để đoán From Wallet.
    const PAY_TAG_REGEX = /^Nhật thanh toán\s*►\s*(.+)$/;
    const TO_WALLET_VND = 'STS';
    const TO_WALLET_FOREIGN = 'Processing Foreign Transaction';
    // Nghỉ ngẫu nhiên giữa 2 lần POST để không gửi dồn dập lên API không chính thức của MoneyKeeper.
    const PUSH_DELAY_MIN_MS = 2000;
    const PUSH_DELAY_MAX_MS = 5000;
    const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

    /* =========================================================================
     *  STATE
     * ========================================================================= */
    let isRunning = false;         // Đang đẩy giao dịch (startPushing) hay không.
    let buttonRegistered = false;  // Nút nổi đã đăng ký với Button Manager chưa.

    /**
     * Trạng thái của lượt hiện tại (reset mỗi khi bấm nút nổi lúc không chạy):
     * - phase: 'loading' (đang tải wallet) | 'loadError' | 'ready'
     * - wallets: mảng wallet từ MoneyKeeper { walletId, walletName, currencyCode, walletType }
     * - walletsFetchedAt: thời điểm (ms) tải danh sách wallet đang dùng (từ cache hoặc vừa gọi API)
     * - refreshingWallets / refreshError: trạng thái của nút "Refresh Wallet List"
     * - waitingSeconds: > 0 khi startPushing() đang nghỉ giữa 2 lần POST (hiển thị ở dòng tóm tắt)
     * - tokenExpired: true khi API vừa trả lỗi token hết hạn (auth:11001); reset khi lưu token mới
     * - rows: mỗi phần tử { itemNumber, detailUrl, supplier, poNo, dateText, transactionDate, original, equivalent,
     *         payTag, fromWalletId, toWalletId, description, process, pushedAt (ms, 0 = chưa push), status: 'idle'|'processing'|'success'|'error', message }
     */
    let session = createEmptySession();

    let dialogRoot = null;      // Element DOM của dialog đang hiển thị (null nếu đang ẩn/đóng).
    let dialogHidden = true;    // true = không vẽ dialog (user bấm "Ẩn cửa sổ"/"Đóng").
    let dialogPosition = loadDialogPosition(); // Vị trí đã lưu từ lần kéo gần nhất (nếu có).
    let configRoot = null;      // Element DOM của dialog cấu hình MoneyKeeper (nếu đang mở).

    /* =========================================================================
     *  CHỜ THƯ VIỆN DÙNG CHUNG (unsafeWindow.FinplanUtils)
     * ========================================================================= */

    /**
     * Chờ cho tới khi unsafeWindow.FinplanUtils (thư viện dùng chung, nạp bởi
     * Finplan_Shared_Library.user.js) sẵn sàng. Tampermonkey không đảm bảo thứ tự
     * chạy giữa các userscript nên ta chủ động poll thay vì giả định thứ tự nạp.
     * @param {number} timeout - thời gian chờ tối đa (ms)
     * @returns {Promise<object>} đối tượng FinplanUtils
     */
    function waitForFinplanUtils(timeout = 15000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const u = unsafeWindow && unsafeWindow.FinplanUtils;
                if (u) return resolve(u);
                if (Date.now() - start > timeout) {
                    return reject(new Error('Không tìm thấy FinplanUtils (Finplan_Shared_Library chưa được nạp hoặc đang tắt).'));
                }
                setTimeout(check, 100);
            };
            check();
        });
    }

    /* =========================================================================
     *  LƯU/ĐỌC VỊ TRÍ DIALOG (localStorage)
     * ========================================================================= */

    /** Đọc vị trí dialog đã lưu (nếu có) từ localStorage. */
    function loadDialogPosition() {
        try {
            const raw = localStorage.getItem(DIALOG_POSITION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    /** Lưu vị trí dialog (left/top tính theo px so với viewport) vào localStorage. */
    function saveDialogPosition(pos) {
        dialogPosition = pos;
        try {
            localStorage.setItem(DIALOG_POSITION_KEY, JSON.stringify(pos));
        } catch (e) {
            // Bỏ qua nếu không lưu được - không ảnh hưởng chức năng chính.
        }
    }

    /* =========================================================================
     *  CẤU HÌNH MONEYKEEPER (token + extra headers)
     * ========================================================================= */

    function getToken() {
        return (GM_getValue(TOKEN_KEY, '') || '').trim();
    }

    /** Đọc extra headers đã lưu; chuỗi JSON lỗi thì coi như không có header phụ. */
    function getExtraHeaders() {
        try {
            const obj = JSON.parse(GM_getValue(EXTRA_HEADERS_KEY, '') || '{}');
            return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
        } catch (e) {
            return {};
        }
    }

    /**
     * Đọc giờ hết hạn (ms) từ claim `exp` của token JWT (phần giữa, base64url) - không cần secret.
     * Token không phải JWT / không đọc được -> null.
     */
    function getTokenExpiry(token = getToken()) {
        const parts = (token || '').split('.');
        if (parts.length !== 3) return null;
        try {
            const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
            return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
        } catch (e) {
            return null;
        }
    }

    /** Token đã hết hạn theo claim `exp` (không biết giờ hết hạn -> false). */
    function isTokenExpiredByJwt() {
        const exp = getTokenExpiry();
        return exp !== null && exp <= Date.now();
    }

    function isTokenExpiredError(err) {
        return !!(err && err.tokenExpired);
    }

    /** Mô tả giờ hết hạn của 1 token cho hộp cấu hình. */
    function describeTokenExpiry(token) {
        const exp = getTokenExpiry(token);
        if (exp === null) return { text: token ? 'Không đọc được giờ hết hạn (token không phải JWT).' : '', level: '' };
        if (exp <= Date.now()) return { text: `Token này đã hết hạn lúc ${formatDateTime(exp)}.`, level: 'error' };
        return { text: `Token hết hạn lúc ${formatDateTime(exp)}.`, level: exp - Date.now() < TOKEN_EXPIRY_WARN_MS ? 'warn' : '' };
    }

    function closeConfigDialog() {
        if (configRoot) {
            configRoot.remove();
            configRoot = null;
        }
    }

    /**
     * Mở dialog nhập Bearer token + extra headers (JSON). Lưu xong gọi `onSaved` (nếu có) - dùng
     * khi user bấm nút nổi mà chưa có token / token hết hạn: lưu xong thì chạy tiếp luôn.
     * `notice` (tuỳ chọn): thông báo đỏ hiển thị ở đầu dialog (vd. lý do phải nhập lại token).
     */
    function openConfigDialog(onSaved, notice) {
        closeConfigDialog();
        injectStyles();

        const overlay = document.createElement('div');
        overlay.className = 'mkp-config-overlay';

        const box = document.createElement('div');
        box.className = 'mkp-config';
        box.innerHTML = `
            <h3>Cấu hình MoneyKeeper</h3>
            <div class="mkp-config__notice"></div>
            <label>Bearer token</label>
            <textarea class="mkp-config__token" rows="4" placeholder="Dán token (có hoặc không có chữ Bearer)"></textarea>
            <div class="mkp-config__expiry"></div>
            <label>Extra headers</label>
            <div class="mkp-headers">
                <table class="mkp-headers__table">
                    <thead><tr><th>Tên header</th><th>Giá trị</th><th></th></tr></thead>
                    <tbody></tbody>
                </table>
            </div>
            <div class="mkp-config__hint">Lấy từ DevTools &gt; Network của web app MISA MoneyKeeper (copy các request header lạ ngoài Authorization).</div>
            <div class="mkp-config__error"></div>
        `;
        const tokenInput = box.querySelector('.mkp-config__token');
        const headersBody = box.querySelector('.mkp-headers__table tbody');
        const errorEl = box.querySelector('.mkp-config__error');
        tokenInput.value = getToken();

        // Bảng extra headers: luôn giữ đúng 1 dòng trống ở cuối (không có nút Xoá). Gõ vào dòng trống
        // cuối -> nút Xoá của dòng đó hiện ra + sinh dòng trống mới bên dưới; xoá trắng lại -> gộp về.
        const isRowEmpty = (tr) => Array.from(tr.querySelectorAll('input')).every((i) => !i.value.trim());
        const syncRemoveButtons = () => {
            for (const tr of headersBody.children) {
                const isTrailingEmpty = tr === headersBody.lastElementChild && isRowEmpty(tr);
                tr.querySelector('.mkp-headers__remove').style.visibility = isTrailingEmpty ? 'hidden' : '';
            }
        };
        const ensureTrailingEmptyRow = () => {
            const last = headersBody.lastElementChild;
            if (!last || !isRowEmpty(last)) addHeaderRow('', '');
            syncRemoveButtons();
        };
        const addHeaderRow = (name, value) => {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td><input type="text" class="mkp-headers__name" placeholder="vd: X-MISA-ClientId"></td>'
                + '<td><input type="text" class="mkp-headers__value"></td>'
                + '<td><button type="button" class="mkp-headers__remove">Xoá</button></td>';
            tr.querySelector('.mkp-headers__name').value = name;
            tr.querySelector('.mkp-headers__value').value = value;
            tr.addEventListener('input', () => {
                const last = headersBody.lastElementChild;
                // User xoá trắng lại dòng ngay trên dòng trống cuối -> bỏ dòng trống thừa để chỉ còn 1.
                if (isRowEmpty(tr) && tr.nextElementSibling === last && isRowEmpty(last)) last.remove();
                ensureTrailingEmptyRow();
            });
            tr.querySelector('.mkp-headers__remove').addEventListener('click', () => {
                tr.remove();
                ensureTrailingEmptyRow();
            });
            headersBody.appendChild(tr);
        };
        Object.entries(getExtraHeaders()).forEach(([name, value]) => addHeaderRow(name, String(value)));
        ensureTrailingEmptyRow();

        /** Gom các dòng thành object header; dữ liệu sai -> { error }. Dòng trống hoàn toàn bị bỏ qua. */
        const collectHeaders = () => {
            const headers = {};
            for (const tr of headersBody.children) {
                const name = tr.querySelector('.mkp-headers__name').value.trim();
                const value = tr.querySelector('.mkp-headers__value').value.trim();
                if (!name && !value) continue;
                if (!name) return { error: `Thiếu tên header cho giá trị "${value}".` };
                if (!value) return { error: `Thiếu giá trị cho header "${name}".` };
                // Tên header hợp lệ theo chuẩn HTTP (token): không khoảng trắng, không dấu ":"...
                if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return { error: `Tên header "${name}" chứa ký tự không hợp lệ.` };
                if (Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase())) {
                    return { error: `Header "${name}" bị trùng.` };
                }
                headers[name] = value;
            }
            return { headers };
        };
        box.querySelector('.mkp-config__notice').textContent = notice || '';

        // Hiện ngay giờ hết hạn của token đang nhập để user biết token mới còn hạn tới khi nào.
        const expiryEl = box.querySelector('.mkp-config__expiry');
        const updateExpiry = () => {
            const { text, level } = describeTokenExpiry(tokenInput.value.trim().replace(/^Bearer\s+/i, ''));
            expiryEl.textContent = text;
            expiryEl.className = `mkp-config__expiry${level ? ` mkp-config__expiry--${level}` : ''}`;
        };
        tokenInput.addEventListener('input', updateExpiry);
        updateExpiry();

        const footer = document.createElement('div');
        footer.className = 'mkp-modal__footer';
        footer.appendChild(buildButton('Huỷ', 'mkp-btn--default', closeConfigDialog));
        footer.appendChild(buildButton('Lưu', 'mkp-btn--primary', () => {
            const token = tokenInput.value.trim().replace(/^Bearer\s+/i, '');
            if (!token) {
                errorEl.textContent = 'Chưa nhập token.';
                return;
            }
            const { headers, error } = collectHeaders();
            if (error) {
                errorEl.textContent = error;
                return;
            }
            GM_setValue(TOKEN_KEY, token);
            // Vẫn lưu dạng chuỗi JSON như trước để tương thích dữ liệu cũ.
            GM_setValue(EXTRA_HEADERS_KEY, Object.keys(headers).length ? JSON.stringify(headers) : '');
            closeConfigDialog();
            session.tokenExpired = false;
            renderDialog();
            if (onSaved) onSaved();
        }));
        box.appendChild(footer);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
        configRoot = overlay;
        tokenInput.focus();
    }

    /* =========================================================================
     *  GỌI API MONEYKEEPER
     * ========================================================================= */

    /**
     * Gọi API MoneyKeeper qua GM_xmlhttpRequest. Mọi lỗi (mạng, timeout, HTTP không phải 2xx)
     * đều reject bằng 1 Error chung, kèm nguyên văn body response để dễ tìm nguyên nhân
     * (thiếu header, sai field...). Resolve với JSON đã parse, hoặc text gốc nếu không phải JSON.
     */
    function mkRequest(method, url, body) {
        const headers = Object.assign(
            { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
            getExtraHeaders()
        );
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                headers,
                data: body === undefined ? undefined : JSON.stringify(body),
                timeout: 30000,
                onload: (res) => {
                    const text = res.responseText || '';
                    if (res.status === 401 && parseErrorCode(text) === TOKEN_EXPIRED_CODE) {
                        const err = new Error(TOKEN_EXPIRED_MESSAGE);
                        err.tokenExpired = true;
                        return reject(err);
                    }
                    if (res.status < 200 || res.status >= 300) {
                        return reject(new Error(`HTTP ${res.status}: ${text.slice(0, 500) || res.statusText}`));
                    }
                    try {
                        resolve(text ? JSON.parse(text) : null);
                    } catch (e) {
                        resolve(text);
                    }
                },
                onerror: () => reject(new Error('Lỗi mạng khi gọi MoneyKeeper.')),
                ontimeout: () => reject(new Error('Hết thời gian chờ MoneyKeeper phản hồi.'))
            });
        });
    }

    /** Lấy `ErrorCode` từ body lỗi dạng {"ErrorCode": "...", "Message": "..."}; không có -> null. */
    function parseErrorCode(text) {
        try {
            return JSON.parse(text).ErrorCode || null;
        } catch (e) {
            return null;
        }
    }

    async function fetchWallets() {
        const data = await mkRequest('GET', MK_WALLETS_URL);
        if (!Array.isArray(data)) throw new Error('Danh sách wallet trả về không đúng định dạng (không phải mảng).');
        return data;
    }

    /** Đọc danh sách wallet đã cache; không có/hỏng -> null. */
    function loadWalletCache() {
        const cache = GM_getValue(WALLETS_CACHE_KEY, null);
        return cache && Array.isArray(cache.wallets) && cache.wallets.length > 0 ? cache : null;
    }

    /** Gọi API lấy danh sách wallet rồi ghi đè cache. */
    async function fetchAndCacheWallets() {
        const cache = { wallets: await fetchWallets(), fetchedAt: Date.now() };
        GM_setValue(WALLETS_CACHE_KEY, cache);
        return cache;
    }

    /** Đọc danh sách item đã push (bỏ các entry quá hạn lưu). */
    function loadPushedItems() {
        const raw = GM_getValue(PUSHED_ITEMS_KEY, null);
        const minTime = Date.now() - PUSHED_ITEMS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const result = {};
        if (raw && typeof raw === 'object') {
            Object.keys(raw).forEach((id) => {
                if (typeof raw[id] === 'number' && raw[id] >= minTime) result[id] = raw[id];
            });
        }
        return result;
    }

    /** Ghi nhận 1 item vừa push thành công (đọc lại storage mỗi lần để không đè dữ liệu từ tab khác). */
    function markItemPushed(itemNumber, pushedAt) {
        const items = loadPushedItems();
        items[itemNumber] = pushedAt;
        GM_setValue(PUSHED_ITEMS_KEY, items);
    }

    /* =========================================================================
     *  ĐỌC BẢNG PAYMENT ITEM
     * ========================================================================= */

    function normalizeText(s) {
        return (s || '').replace(/\s+/g, ' ').trim();
    }

    /** "1,250.00 USD" -> { value: 1250, currency: 'USD', text: '1,250.00 USD' }; không parse được -> null. */
    function parseAmount(text) {
        const t = normalizeText(text);
        const m = t.match(/^([\d,]+(?:\.\d+)?)\s*([A-Z]{3})$/);
        if (!m) return null;
        return { value: parseFloat(m[1].replace(/,/g, '')), currency: m[2], text: t };
    }

    /** "25 Sep 2026" -> "2026-09-25T00:00:00"; không parse được -> null. */
    function parseDate(text) {
        const m = normalizeText(text).match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
        if (!m || !MONTHS[m[2]]) return null;
        const pad = (n) => String(n).padStart(2, '0');
        return `${m[3]}-${pad(MONTHS[m[2]])}-${pad(m[1])}T00:00:00`;
    }

    /** Trả về phần XXXX của tag "Nhật thanh toán ► XXXX" đầu tiên trong ô Tags, hoặc null. */
    function findPayTag(tagsCell) {
        if (!tagsCell) return null;
        for (const tag of tagsCell.querySelectorAll('.lbl-tag')) {
            const text = normalizeText(Array.from(tag.querySelectorAll('.lbl-tag__segment')).map((s) => s.textContent).join(' '));
            const m = text.match(PAY_TAG_REGEX);
            if (m) return m[1].trim();
        }
        return null;
    }

    /** Path hiện tại (bỏ "/" cuối). */
    function currentPath() {
        return window.location.pathname.replace(/\/+$/, '');
    }

    function isPoUpdatePage() {
        return PO_UPDATE_REGEX.test(currentPath());
    }

    /** Quét bảng đang hiển thị, trả về dữ liệu thô của các dòng có tag "Nhật thanh toán ► XXXX". */
    function scanTableRows() {
        return isPoUpdatePage() ? scanPoUpdateRows() : scanListRows();
    }

    /** Trang danh sách /purchase-orders/payment-items: td có class cell-body-*. */
    function scanListRows() {
        const result = [];
        document.querySelectorAll('table.m-datatable__table tbody tr.m-datatable__row').forEach((tr) => {
            const payTag = findPayTag(tr.querySelector('.cell-body-tags'));
            if (!payTag) return;

            const amountCells = tr.querySelectorAll('td.cell-body-amount');
            const amountText = (td) => td?.querySelector(':scope > span.text-bold')?.textContent || '';

            const dateText = normalizeText(tr.querySelector('.cell-body-estimateDate span')?.textContent);
            result.push({
                itemNumber: normalizeText(tr.querySelector('.cell-body-part .text-bold')?.textContent),
                detailUrl: tr.querySelector('a[href*="/purchase-orders/payment-items/"]')?.href || null,
                supplier: normalizeText(tr.querySelector('.cell-body-supplier a span')?.textContent).replace(/\s*-$/, ''),
                poNo: normalizeText(tr.querySelector('.cell-body-purchase-order-no span')?.textContent),
                dateText,
                transactionDate: parseDate(dateText),
                original: parseAmount(amountText(amountCells[0])),
                equivalent: parseAmount(amountText(amountCells[1])),
                payTag
            });
        });
        return result;
    }

    /**
     * Trang /purchase-orders/update/{id}: td không có class nên lấy index cột từ class cell-head-*
     * của thead. Supplier / PO No không có trong bảng -> đọc 1 lần từ form của PO.
     */
    function scanPoUpdateRows() {
        const result = [];
        const supplierLabel = Array.from(document.querySelectorAll('label.form-control-label'))
            .find((l) => normalizeText(l.textContent).replace(/\*$/, '') === 'Supplier');
        const supplier = normalizeText(
            supplierLabel?.parentElement?.querySelector('app-sts-dropdown-list .input .left span')?.textContent
        );
        const poNo = normalizeText(document.querySelector('input[formcontrolname="purchaseOrderNo"]')?.value);

        document.querySelectorAll('table.m-datatable__table').forEach((table) => {
            const ths = Array.from(table.querySelectorAll('thead th'));
            const colIndex = (cls) => ths.findIndex((th) => th.classList.contains(cls));
            const idx = {
                part: colIndex('cell-head-part'),
                date: colIndex('cell-head-estimated'),
                original: ths.findIndex((th) => th.classList.contains('cell-head-amount') && !th.classList.contains('cell-head-equivalent')),
                equivalent: colIndex('cell-head-equivalent'),
                tags: colIndex('cell-head-tags')
            };
            if (idx.part < 0 || idx.tags < 0) return; // Không phải bảng Payment Item.

            table.querySelectorAll('tbody tr.m-datatable__row').forEach((tr) => {
                const cells = tr.children;
                const payTag = findPayTag(cells[idx.tags]);
                if (!payTag) return;

                const dateText = normalizeText(cells[idx.date]?.textContent);
                result.push({
                    itemNumber: normalizeText(cells[idx.part]?.querySelector(':scope > span.text-bold')?.textContent),
                    detailUrl: tr.querySelector('a[href*="/purchase-orders/payment-items/"]')?.href || null,
                    supplier,
                    poNo,
                    dateText,
                    transactionDate: parseDate(dateText),
                    original: parseAmount(cells[idx.original]?.textContent),
                    equivalent: parseAmount(cells[idx.equivalent]?.textContent),
                    payTag
                });
            });
        });
        return result;
    }

    /* =========================================================================
     *  CHỌN WALLET MẶC ĐỊNH
     * ========================================================================= */

    /** Số ký tự trùng nhau tính từ cuối chuỗi lên (không phân biệt hoa thường). */
    function commonSuffixLength(a, b) {
        const x = normalizeText(a).toLowerCase().normalize('NFC');
        const y = normalizeText(b).toLowerCase().normalize('NFC');
        let n = 0;
        while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++;
        return n;
    }

    /** Wallet có tên trùng hậu tố dài nhất với XXXX (hoà -> wallet đứng trước). Không trùng ký tự nào -> ''. */
    function guessFromWalletId(payTag, wallets) {
        let bestId = '';
        let bestLen = 0;
        wallets.forEach((w) => {
            const len = commonSuffixLength(w.walletName, payTag);
            if (len > bestLen) {
                bestLen = len;
                bestId = w.walletId;
            }
        });
        return bestId;
    }

    function findWalletIdByName(name, wallets) {
        const target = normalizeText(name).toLowerCase();
        return wallets.find((w) => normalizeText(w.walletName).toLowerCase() === target)?.walletId || '';
    }

    /* =========================================================================
     *  DỰNG DỮ LIỆU CÁC DÒNG + KIỂM TRA HỢP LỆ
     * ========================================================================= */

    function isVnd(row) {
        return row.original?.currency === 'VND';
    }

    /** Ngày thanh toán (transactionDate) trước hôm nay theo giờ máy. Không có ngày -> false (validateRow chặn riêng). */
    function isPastDate(row) {
        if (!row.transactionDate) return false;
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        return row.transactionDate.slice(0, 10) < today;
    }

    /** Trả về thông báo lỗi nếu dòng chưa đủ dữ liệu để push, ngược lại null. */
    function validateRow(row) {
        if (!row.original) return 'Không đọc được Original Amount.';
        if (!row.transactionDate) return 'Không đọc được Expected Payment Date.';
        if (!isVnd(row) && !row.equivalent) return 'Thiếu Equivalent Amount (item ngoại tệ).';
        if (!row.fromWalletId) return 'Chưa chọn From Wallet.';
        if (!row.toWalletId) return 'Chưa chọn To Wallet.';
        if (row.fromWalletId === row.toWalletId) return 'From Wallet và To Wallet trùng nhau.';
        return null;
    }

    function defaultToWalletId(row, wallets) {
        return findWalletIdByName(isVnd(row) ? TO_WALLET_VND : TO_WALLET_FOREIGN, wallets);
    }

    function buildRows(rawRows, wallets) {
        const pushedItems = loadPushedItems();
        return rawRows.map((raw) => {
            const row = Object.assign({}, raw, {
                fromWalletId: guessFromWalletId(raw.payTag, wallets),
                toWalletId: defaultToWalletId(raw, wallets),
                description: `${raw.supplier} ${raw.poNo} (${raw.original ? raw.original.text : ''}) ${raw.itemNumber} ?!`,
                pushedAt: pushedItems[raw.itemNumber] || 0,
                status: 'idle',
                message: ''
            });
            // Dòng chưa hợp lệ, đã push ở lượt trước hoặc có ngày thanh toán đã qua thì mặc định không tick
            // (user vẫn tick tay được).
            row.process = !validateRow(row) && !row.pushedAt && !isPastDate(row);
            return row;
        });
    }

    /* =========================================================================
     *  TIẾN TRÌNH PUSH
     * ========================================================================= */

    /** Body POST cho 1 dòng: VND -> amount = fcAmount = Original; ngoại tệ -> amount = Equivalent, fcAmount = Original. */
    function buildTransaction(row) {
        const amount = isVnd(row) ? row.original.value : row.equivalent.value;
        return {
            transactionType: 2,
            amount,
            walletId: row.fromWalletId,
            transactionDate: row.transactionDate,
            moreInfo: { excludeReport: false, description: row.description },
            transfer: { toWalletId: row.toWalletId, fcAmount: row.original.value }
        };
    }

    /**
     * Đẩy tuần tự từng dòng đang tick "Process". Dòng đẩy thành công được bỏ tick và khoá lại để
     * bấm Proceed lần nữa không bị đẩy trùng. `isRunning` là cờ dừng, kiểm tra trước mỗi dòng.
     * Giữa 2 lần POST nghỉ ngẫu nhiên PUSH_DELAY_MIN_MS..PUSH_DELAY_MAX_MS (không nghỉ trước POST đầu tiên).
     */
    async function startPushing() {
        // Token đã hết hạn theo JWT -> không push (chắc chắn lỗi), báo user cập nhật token.
        if (isTokenExpiredByJwt()) {
            session.tokenExpired = true;
            renderDialog();
            return;
        }
        isRunning = true;
        renderDialog();
        let hasPosted = false;

        for (const row of session.rows) {
            if (!isRunning) break;
            if (!row.process || row.status === 'success') continue;

            const invalid = validateRow(row);
            if (invalid) {
                row.status = 'error';
                row.message = invalid;
                renderDialog();
                continue;
            }

            if (hasPosted) {
                const delay = PUSH_DELAY_MIN_MS + Math.random() * (PUSH_DELAY_MAX_MS - PUSH_DELAY_MIN_MS);
                session.waitingSeconds = Math.round(delay / 1000);
                renderDialog();
                await utils.sleep(delay);
                session.waitingSeconds = 0;
                if (!isRunning) break; // User bấm "Dừng lại" trong lúc nghỉ.
            }
            hasPosted = true;

            row.status = 'processing';
            row.message = '';
            renderDialog();
            try {
                await mkRequest('POST', MK_TRANSACTIONS_URL, [buildTransaction(row)]);
                row.status = 'success';
                row.message = '';
                row.process = false;
                row.pushedAt = Date.now();
                markItemPushed(row.itemNumber, row.pushedAt);
            } catch (err) {
                row.status = 'error';
                row.message = (err && err.message) || String(err);
                // Token hết hạn: các dòng còn lại chắc chắn cũng lỗi -> dừng ngay, giữ nguyên tick để chạy lại.
                if (isTokenExpiredError(err)) {
                    session.tokenExpired = true;
                    isRunning = false;
                }
            }
            renderDialog();
        }

        isRunning = false;
        session.waitingSeconds = 0;
        renderDialog();
    }

    function createEmptySession() {
        return { phase: 'loading', loadError: '', wallets: [], walletsFetchedAt: 0, refreshingWallets: false, refreshError: '', waitingSeconds: 0, tokenExpired: false, rows: [] };
    }

    /**
     * Quét bảng + lấy danh sách wallet (ưu tiên cache, chỉ gọi API khi chưa có cache hoặc
     * `forceFetch`) rồi dựng dữ liệu các dòng cho lượt hiện tại.
     */
    async function loadSession(forceFetch = false) {
        session = createEmptySession();
        renderDialog();
        const rawRows = scanTableRows();
        let cache = forceFetch ? null : loadWalletCache();
        if (!cache) {
            try {
                cache = await fetchAndCacheWallets();
            } catch (err) {
                session.phase = 'loadError';
                session.loadError = (err && err.message) || String(err);
                session.tokenExpired = isTokenExpiredError(err);
                renderDialog();
                return;
            }
        }
        session.wallets = cache.wallets;
        session.walletsFetchedAt = cache.fetchedAt;
        session.rows = buildRows(rawRows, session.wallets);
        session.phase = 'ready';
        renderDialog();
    }

    /**
     * Nút "Refresh Wallet List": gọi lại API, cập nhật cache. Dòng nào đang chọn wallet vẫn còn
     * trong danh sách mới thì giữ nguyên, wallet đã biến mất thì chọn lại theo quy tắc mặc định.
     * Lỗi -> giữ danh sách cũ, báo lỗi ở dòng tóm tắt.
     */
    async function refreshWallets() {
        session.refreshingWallets = true;
        session.refreshError = '';
        renderDialog();
        try {
            const cache = await fetchAndCacheWallets();
            session.wallets = cache.wallets;
            session.walletsFetchedAt = cache.fetchedAt;
            const exists = (id) => cache.wallets.some((w) => w.walletId === id);
            session.rows.forEach((row) => {
                if (row.status === 'success') return;
                if (!exists(row.fromWalletId)) row.fromWalletId = guessFromWalletId(row.payTag, cache.wallets);
                if (!exists(row.toWalletId)) row.toWalletId = defaultToWalletId(row, cache.wallets);
            });
        } catch (err) {
            session.refreshError = (err && err.message) || String(err);
            if (isTokenExpiredError(err)) session.tokenExpired = true;
        }
        session.refreshingWallets = false;
        renderDialog();
    }

    /* =========================================================================
     *  FLOATING BUTTON (đăng ký qua Button Manager dùng chung)
     * ========================================================================= */

    function registerLauncherButton() {
        utils.registerButton(BUTTON_ID, {
            icon: '💸',
            text: 'Push to Money Keeper',
            tooltip: 'Đẩy các item có tag "Nhật thanh toán ► ..." lên MISA MoneyKeeper. Nếu đang chạy, bấm lại để mở cửa sổ tiến trình.',
            onClick: onLauncherClick,
            order: 0
        });
        buttonRegistered = true;
    }

    /**
     * Handler khi user bấm nút nổi.
     * - Đang chạy dở: chỉ mở lại dialog.
     * - Chưa có token: mở dialog cấu hình, lưu xong thì bắt đầu luôn.
     * - Còn lại: quét lại bảng + tải wallet cho 1 lượt mới.
     */
    function onLauncherClick() {
        if (isRunning) {
            dialogHidden = false;
            renderDialog();
            return;
        }
        const start = () => {
            dialogHidden = false;
            loadSession();
        };
        if (!getToken()) {
            openConfigDialog(start);
            return;
        }
        if (isTokenExpiredByJwt()) {
            openConfigDialog(start, `Token đã hết hạn lúc ${formatDateTime(getTokenExpiry())}. Hãy dán token mới.`);
            return;
        }
        start();
    }

    /* =========================================================================
     *  FLOATING DIALOG
     * ========================================================================= */

    /** Chèn CSS cho dialog vào <head>, chỉ chèn 1 lần (idempotent). */
    function injectStyles() {
        if (document.getElementById('mkp-style')) return;
        const style = document.createElement('style');
        style.id = 'mkp-style';
        style.textContent = `
            .mkp-modal {
                position: fixed;
                top: 8vh;
                left: 50%;
                transform: translateX(-50%);
                background: #fff;
                border-radius: 8px;
                width: 1150px;
                max-width: 96vw;
                max-height: 84vh;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                font-family: Arial, sans-serif;
                box-shadow: 0 8px 30px rgba(0,0,0,.35);
                z-index: 999999;
            }
            .mkp-modal--dragging { user-select: none; }
            .mkp-modal__header {
                padding: 14px 18px;
                border-bottom: 1px solid #ebedf2;
                display: flex; align-items: center; justify-content: space-between;
                cursor: move;
            }
            .mkp-modal__header h3 { margin: 0; font-size: 16px; }
            .mkp-modal__close { cursor: pointer; border: none; background: none; font-size: 18px; color: #888; }
            .mkp-modal__actions { display: flex; align-items: center; gap: 4px; }
            .mkp-modal__settings { cursor: pointer; border: none; background: none; font-size: 15px; color: #888; padding: 2px 6px; }
            .mkp-modal__settings:hover:not(:disabled), .mkp-modal__close:hover { color: #333; }
            .mkp-modal__settings:disabled { opacity: .4; cursor: not-allowed; }
            .mkp-modal__body { padding: 18px; overflow-y: auto; flex: 1; min-height: 0; }
            .mkp-modal__footer {
                padding: 12px 18px; border-top: 1px solid #ebedf2;
                display: flex; justify-content: flex-end; gap: 8px;
            }
            .mkp-btn {
                border: none; border-radius: 4px; padding: 8px 16px;
                font-size: 13px; font-weight: 600; cursor: pointer;
            }
            .mkp-btn:disabled { opacity: .5; cursor: not-allowed; }
            .mkp-btn--primary { background: #28a745; color: #fff; }
            .mkp-btn--primary:hover:not(:disabled) { background: #218838; }
            .mkp-btn--default { background: #ebedf2; color: #333; }
            .mkp-btn--danger { background: #dc3545; color: #fff; }
            .mkp-btn--danger:hover { background: #c82333; }
            .mkp-log {
                margin-top: 4px; max-height: 56vh; overflow: auto;
                overscroll-behavior: contain;
                border: 1px solid #ebedf2; border-radius: 4px;
            }
            .mkp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
            .mkp-table th, .mkp-table td { border-bottom: 1px solid #ebedf2; padding: 6px 8px; text-align: left; vertical-align: top; }
            .mkp-table thead th {
                position: sticky; top: 0; z-index: 1;
                background: #fff; box-shadow: inset 0 -1px 0 #ebedf2; white-space: nowrap;
            }
            .mkp-table select { width: 190px; font-size: 12px; padding: 3px; }
            .mkp-desc {
                display: block; width: 100%; min-width: 260px; box-sizing: border-box;
                font: 12px/1.4 Arial, sans-serif; color: #333; padding: 4px 6px;
                border: 1px solid #ebedf2; border-radius: 3px; background: #fff;
                box-shadow: none; outline: none; resize: none; overflow: hidden;
                white-space: pre-wrap; word-break: break-word;
            }
            .mkp-desc:focus { border-color: #2a82fe; }
            .mkp-desc:disabled { background: #f7f8fa; color: #666; }
            .mkp-center { text-align: center !important; }
            .mkp-nowrap { white-space: nowrap; }
            .mkp-sub { font-size: 11px; color: #666; margin-top: 2px; }
            .mkp-status { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 12px; white-space: nowrap; }
            .mkp-status--processing { background: rgba(42,130,254,.15); color: #2a82fe; }
            .mkp-status--success { background: rgba(51,153,51,.15); color: #393; }
            .mkp-status--error { background: rgba(228,63,63,.2); color: #e43f3f; }
            .mkp-warn { font-size: 11px; color: #c77c00; line-height: 1.4; }
            .mkp-error-msg { font-size: 11px; color: #666; margin-top: 4px; line-height: 1.4; word-break: break-word; max-width: 260px; }
            .mkp-summary { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
            .mkp-summary__text { font-size: 13px; color: #333; }
            .mkp-summary__error { font-size: 11px; color: #e43f3f; margin-top: 2px; word-break: break-word; }
            .mkp-btn--small { padding: 5px 10px; font-size: 12px; white-space: nowrap; flex-shrink: 0; }
            .mkp-token { font-size: 12px; margin-top: 2px; font-weight: 600; }
            .mkp-token--error { color: #e43f3f; }
            .mkp-token-status { font-size: 12px; color: #888; margin-right: 6px; white-space: nowrap; }
            .mkp-token-status--warn { color: #c77c00; font-weight: 600; }
            .mkp-token-status--error { color: #e43f3f; font-weight: 600; }
            .mkp-config__notice { font-size: 12px; color: #e43f3f; font-weight: 600; }
            .mkp-config__notice:empty { display: none; }
            .mkp-config__expiry { font-size: 11px; color: #666; margin-top: 4px; }
            .mkp-config__expiry--warn { color: #c77c00; }
            .mkp-config__expiry--error { color: #e43f3f; font-weight: 600; }
            .mkp-load-error { color: #e43f3f; font-size: 13px; word-break: break-word; }
            .mkp-config-overlay {
                position: fixed; inset: 0; background: rgba(0,0,0,.35);
                display: flex; align-items: center; justify-content: center; z-index: 1000000;
            }
            .mkp-config {
                background: #fff; border-radius: 8px; width: 580px; max-width: 92vw;
                font-family: Arial, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.35);
                padding: 18px 18px 0;
            }
            .mkp-config h3 { margin: 0 0 12px; font-size: 16px; }
            .mkp-config label { display: block; font-size: 13px; font-weight: 600; margin: 10px 0 4px; }
            .mkp-config textarea { width: 100%; box-sizing: border-box; font-family: monospace; font-size: 12px; padding: 6px; }
            .mkp-headers { max-height: 200px; overflow: auto; border: 1px solid #ebedf2; border-radius: 4px; }
            .mkp-headers__table { width: 100%; border-collapse: collapse; font-size: 12px; }
            .mkp-headers__table th {
                position: sticky; top: 0; background: #f7f8fa; text-align: left; font-weight: 600;
                padding: 5px 6px; border-bottom: 1px solid #ebedf2; color: #555;
            }
            .mkp-headers__table td { padding: 3px 6px; border-bottom: 1px solid #f1f2f5; }
            .mkp-headers__table th:last-child, .mkp-headers__table td:last-child { width: 1%; }
            .mkp-headers__table input {
                width: 100%; box-sizing: border-box; font: 12px monospace; padding: 4px 6px;
                border: 1px solid #ebedf2; border-radius: 3px; outline: none; box-shadow: none;
            }
            .mkp-headers__table input:focus { border-color: #2a82fe; }
            .mkp-headers__remove {
                border: none; background: none; color: #e43f3f; font-size: 12px; cursor: pointer; padding: 2px 4px;
            }
            .mkp-headers__remove:hover { text-decoration: underline; }
            .mkp-config__hint { font-size: 11px; color: #666; margin-top: 6px; }
            .mkp-config__error { font-size: 12px; color: #e43f3f; min-height: 16px; margin: 6px 0; }
            .mkp-config .mkp-modal__footer { margin: 0 -18px; }
        `;
        document.head.appendChild(style);
    }

    /* ---- Kéo (drag) dialog bằng vùng header ----
     * mousedown trên header -> ghi nhận vị trí bắt đầu; mousemove trên document -> cập nhật vị
     * trí (clamp trong viewport); mouseup -> kết thúc kéo và lưu vị trí vào localStorage.
     */
    const dragState = { active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 };

    /** Bắt đầu kéo dialog khi mousedown trên header (trừ khi bấm đúng vào nút cấu hình/đóng). */
    function onHeaderMouseDown(e) {
        if (e.target.closest('.mkp-modal__close, .mkp-modal__settings')) return;
        if (!dialogRoot) return;
        const rect = dialogRoot.getBoundingClientRect();
        dragState.active = true;
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dragState.startLeft = rect.left;
        dragState.startTop = rect.top;
        // Chuyển từ định vị bằng transform (căn giữa mặc định) sang left/top tuyệt đối.
        dialogRoot.style.left = rect.left + 'px';
        dialogRoot.style.top = rect.top + 'px';
        dialogRoot.style.transform = 'none';
        dialogRoot.classList.add('mkp-modal--dragging');
        e.preventDefault();
    }

    /** Cập nhật vị trí dialog theo vị trí chuột trong lúc đang kéo, giới hạn trong viewport. */
    function onDocumentMouseMove(e) {
        if (!dragState.active || !dialogRoot) return;
        const rect = dialogRoot.getBoundingClientRect();
        const maxLeft = Math.max(window.innerWidth - rect.width, 0);
        const maxTop = Math.max(window.innerHeight - rect.height, 0);
        let newLeft = dragState.startLeft + (e.clientX - dragState.startX);
        let newTop = dragState.startTop + (e.clientY - dragState.startY);
        newLeft = Math.min(Math.max(newLeft, 0), maxLeft);
        newTop = Math.min(Math.max(newTop, 0), maxTop);
        dialogRoot.style.left = newLeft + 'px';
        dialogRoot.style.top = newTop + 'px';
    }

    /** Kết thúc kéo dialog (mouseup) và lưu lại vị trí cuối cùng. */
    function onDocumentMouseUp() {
        if (!dragState.active) return;
        dragState.active = false;
        if (dialogRoot) {
            dialogRoot.classList.remove('mkp-modal--dragging');
            const rect = dialogRoot.getBoundingClientRect();
            saveDialogPosition({ left: rect.left, top: rect.top });
        }
    }

    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', onDocumentMouseUp);

    /** Gỡ dialog khỏi DOM (nếu có), không đụng tới `session`/`isRunning`. */
    function closeDialogDom() {
        if (dialogRoot) {
            dialogRoot.remove();
            dialogRoot = null;
        }
    }

    /** Ẩn dialog: nếu đang chạy thì vẫn tiếp tục chạy ngầm, chỉ là không hiển thị UI. */
    function hideDialog() {
        dialogHidden = true;
        closeDialogDom();
    }

    /** Áp lại vị trí đã lưu (nếu có) lên dialog, để nó không bị "nhảy" về giữa màn hình sau mỗi lần render lại. */
    function applySavedPosition(modal) {
        if (!dialogPosition) return;
        modal.style.left = dialogPosition.left + 'px';
        modal.style.top = dialogPosition.top + 'px';
        modal.style.transform = 'none';
    }

    /** Xử lý bấm nút đóng (×) ở header: xác nhận trước nếu đang chạy dở, rồi ẩn dialog. */
    function onCloseButtonClick() {
        if (isRunning) {
            if (!confirm('Đang đẩy dở danh sách. Dừng lại và đóng?')) return;
            isRunning = false;
        }
        hideDialog();
    }

    /**
     * Nút ⚙️ ở header: mở dialog cấu hình. Lưu xong, nếu đang lỗi tải wallet thì tự tải lại;
     * ngược lại giữ nguyên bảng và các lựa chọn hiện tại.
     */
    function onSettingsButtonClick() {
        openConfigDialog(() => {
            if (session.phase === 'loadError') loadSession(true);
        });
    }

    /** Dựng phần header: tiêu đề (kéo được) + trạng thái token + nút cấu hình + nút đóng. */
    function buildHeader() {
        const header = document.createElement('div');
        header.className = 'mkp-modal__header';
        header.addEventListener('mousedown', onHeaderMouseDown);

        const title = document.createElement('h3');
        title.textContent = 'Push to Money Keeper';
        header.appendChild(title);

        const actions = document.createElement('div');
        actions.className = 'mkp-modal__actions';

        actions.appendChild(buildTokenStatus());

        const settingsBtn = document.createElement('button');
        settingsBtn.className = 'mkp-modal__settings';
        settingsBtn.type = 'button';
        settingsBtn.title = 'Cấu hình MoneyKeeper';
        settingsBtn.textContent = '⚙️';
        settingsBtn.disabled = isRunning; // Không đổi token giữa lúc đang push.
        settingsBtn.addEventListener('click', onSettingsButtonClick);
        actions.appendChild(settingsBtn);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'mkp-modal__close';
        closeBtn.type = 'button';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', onCloseButtonClick);
        actions.appendChild(closeBtn);

        header.appendChild(actions);

        return header;
    }

    /** Sinh dòng tóm tắt, tuỳ theo đang chạy / chưa chạy / đã chạy xong. */
    function getSummaryText() {
        const rows = session.rows;
        const successCount = rows.filter((r) => r.status === 'success').length;
        const errorCount = rows.filter((r) => r.status === 'error').length;
        const checkedCount = rows.filter((r) => r.process).length;
        if (isRunning) {
            const doneCount = rows.filter((r) => r.status === 'success' || r.status === 'error').length;
            const waiting = session.waitingSeconds ? ` Đang nghỉ ~${session.waitingSeconds}s trước dòng tiếp theo...` : '';
            return `Đang đẩy lên MoneyKeeper... Đã xử lý ${doneCount} dòng — Thành công: ${successCount}, Lỗi: ${errorCount}.${waiting}`;
        }
        if (successCount + errorCount === 0) {
            const pushedCount = rows.filter((r) => r.pushedAt).length;
            const pastCount = rows.filter((r) => !r.pushedAt && isPastDate(r)).length;
            const notes = [];
            if (pushedCount) notes.push(`${pushedCount} item đã push trước đó`);
            if (pastCount) notes.push(`${pastCount} item có ngày thanh toán đã qua`);
            const skippedNote = notes.length ? ` (${notes.join(', ')}, không tự chọn)` : '';
            return `Tìm thấy ${rows.length} item có tag "Nhật thanh toán ► ...", đang chọn ${checkedCount} dòng để đẩy.${skippedNote}`;
        }
        return `Đã xong. Thành công: ${successCount}, Lỗi: ${errorCount}. Còn ${checkedCount} dòng đang được chọn.`;
    }

    /** Định dạng thời điểm (ms) thành "dd/MM/yyyy HH:mm". */
    function formatDateTime(ms) {
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /**
     * Trạng thái token ở header dialog (luôn hiện, mọi phase): đỏ nếu đã hết hạn (theo API hoặc JWT),
     * cam nếu còn dưới 1 giờ, xám nếu còn hạn hoặc không đọc được giờ hết hạn (token không phải JWT).
     */
    function buildTokenStatus() {
        const exp = getTokenExpiry();
        const el = document.createElement('span');
        el.className = 'mkp-token-status';
        if (session.tokenExpired || (exp !== null && exp <= Date.now())) {
            el.classList.add('mkp-token-status--error');
            el.textContent = 'Token đã hết hạn';
            el.title = 'Bấm ⚙️ để cập nhật token mới.';
        } else if (exp === null) {
            el.textContent = 'Không rõ giờ hết hạn token';
        } else if (exp - Date.now() < TOKEN_EXPIRY_WARN_MS) {
            el.classList.add('mkp-token-status--warn');
            el.textContent = `Token còn ~${Math.max(1, Math.round((exp - Date.now()) / 60000))} phút`;
            el.title = `Token hết hạn lúc ${formatDateTime(exp)}`;
        } else {
            el.textContent = `Token hết hạn lúc ${formatDateTime(exp)}`;
        }
        return el;
    }

    /** Hàng trên bảng: tóm tắt + thời điểm cập nhật wallet (trái), nút "Refresh Wallet List" (phải). */
    function buildSummary() {
        const summary = document.createElement('div');
        summary.className = 'mkp-summary';

        const left = document.createElement('div');
        const text = document.createElement('div');
        text.className = 'mkp-summary__text';
        text.textContent = getSummaryText();
        left.appendChild(text);
        const fetched = document.createElement('div');
        fetched.className = 'mkp-sub';
        fetched.textContent = `Danh sách wallet cập nhật lúc ${formatDateTime(session.walletsFetchedAt)}`;
        left.appendChild(fetched);
        if (session.refreshError) {
            const err = document.createElement('div');
            err.className = 'mkp-summary__error';
            err.textContent = `Không tải lại được danh sách wallet: ${session.refreshError}`;
            left.appendChild(err);
        }
        summary.appendChild(left);

        const refreshBtn = buildButton(
            session.refreshingWallets ? 'Đang tải wallet...' : 'Refresh Wallet List',
            'mkp-btn--default mkp-btn--small',
            refreshWallets
        );
        refreshBtn.disabled = isRunning || session.refreshingWallets;
        summary.appendChild(refreshBtn);
        return summary;
    }

    /** Dựng 1 <select> wallet; giá trị chọn được ghi thẳng vào `row[field]`. */
    function buildWalletSelect(row, field) {
        const select = document.createElement('select');
        select.disabled = isRunning || row.status === 'success';

        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '-- Chọn wallet --';
        select.appendChild(empty);

        session.wallets.forEach((w) => {
            const opt = document.createElement('option');
            opt.value = w.walletId;
            opt.textContent = w.currencyCode ? `${w.walletName} (${w.currencyCode})` : w.walletName;
            select.appendChild(opt);
        });
        select.value = row[field] || '';
        select.addEventListener('change', () => {
            row[field] = select.value;
            renderDialog();
        });
        return select;
    }

    /** Ô Result: badge trạng thái sau khi push, hoặc cảnh báo dữ liệu thiếu khi chưa push. */
    function buildResultCell(row) {
        const td = document.createElement('td');
        if (row.status === 'idle') {
            if (row.pushedAt) {
                const pushed = document.createElement('div');
                pushed.className = 'mkp-sub';
                pushed.textContent = `Đã push lúc ${formatDateTime(row.pushedAt)}`;
                td.appendChild(pushed);
            }
            const invalid = validateRow(row);
            if (invalid) {
                const warn = document.createElement('div');
                warn.className = 'mkp-warn';
                warn.textContent = invalid;
                td.appendChild(warn);
            }
            return td;
        }
        const badge = document.createElement('span');
        badge.className = `mkp-status mkp-status--${row.status}`;
        badge.textContent = { processing: 'Đang đẩy', success: 'Success', error: 'Lỗi' }[row.status] || row.status;
        td.appendChild(badge);
        if (row.status === 'error' && row.message) {
            const msg = document.createElement('div');
            msg.className = 'mkp-error-msg';
            msg.textContent = row.message;
            td.appendChild(msg);
        }
        return td;
    }

    /** Dựng 1 dòng của bảng ứng với 1 phần tử trong `session.rows`. */
    function buildTableRow(row) {
        const tr = document.createElement('tr');
        const locked = isRunning || row.status === 'success';

        const tdId = document.createElement('td');
        tdId.className = 'mkp-nowrap';
        if (row.detailUrl) {
            const link = document.createElement('a');
            link.href = row.detailUrl;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = row.itemNumber;
            tdId.appendChild(link);
        } else {
            tdId.textContent = row.itemNumber;
        }
        const tagSub = document.createElement('div');
        tagSub.className = 'mkp-sub';
        tagSub.textContent = row.payTag;
        tdId.appendChild(tagSub);
        tr.appendChild(tdId);

        const tdDate = document.createElement('td');
        tdDate.className = 'mkp-nowrap';
        tdDate.textContent = row.dateText || '-/-';
        if (isPastDate(row)) {
            const past = document.createElement('div');
            past.className = 'mkp-sub';
            past.textContent = 'Ngày đã qua';
            tdDate.appendChild(past);
        }
        tr.appendChild(tdDate);

        const tdFrom = document.createElement('td');
        tdFrom.appendChild(buildWalletSelect(row, 'fromWalletId'));
        tr.appendChild(tdFrom);

        const tdTo = document.createElement('td');
        tdTo.appendChild(buildWalletSelect(row, 'toWalletId'));
        tr.appendChild(tdTo);

        const tdAmount = document.createElement('td');
        tdAmount.className = 'mkp-nowrap';
        tdAmount.textContent = row.original ? row.original.text : '-/-';
        if (row.original && !isVnd(row)) {
            const eq = document.createElement('div');
            eq.className = 'mkp-sub';
            eq.textContent = row.equivalent ? `≈ ${row.equivalent.text}` : 'Chưa có Equivalent Amount';
            tdAmount.appendChild(eq);
        }
        tr.appendChild(tdAmount);

        const tdDesc = document.createElement('td');
        const descInput = document.createElement('textarea');
        descInput.className = 'mkp-desc';
        descInput.rows = 1;
        descInput.value = row.description;
        descInput.disabled = locked;
        // Ghi thẳng vào state, không render lại để không mất focus khi đang gõ; chỉ giãn lại chiều cao.
        descInput.addEventListener('input', () => {
            row.description = descInput.value;
            autoGrow(descInput);
        });
        tdDesc.appendChild(descInput);
        tr.appendChild(tdDesc);

        const tdProcess = document.createElement('td');
        tdProcess.className = 'mkp-center';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!row.process;
        checkbox.disabled = locked;
        checkbox.addEventListener('change', () => {
            row.process = checkbox.checked;
            renderDialog();
        });
        tdProcess.appendChild(checkbox);
        tr.appendChild(tdProcess);

        tr.appendChild(buildResultCell(row));
        return tr;
    }

    /** Giãn chiều cao textarea theo nội dung (chỉ đo được khi element đã nằm trong DOM). */
    function autoGrow(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 2 + 'px';
    }

    function buildTable() {
        const table = document.createElement('table');
        table.className = 'mkp-table';
        table.innerHTML = '<thead><tr><th>Item #</th><th>Ngày giao dịch</th><th>From Wallet</th><th>To Wallet</th><th>Original Amount</th>'
            + '<th>Description</th><th class="mkp-center">Process</th><th>Result</th></tr></thead>';

        const tbody = document.createElement('tbody');
        session.rows.forEach((row) => tbody.appendChild(buildTableRow(row)));
        table.appendChild(tbody);
        return table;
    }

    /** Dựng phần body theo `session.phase`. */
    function buildBody() {
        const body = document.createElement('div');
        body.className = 'mkp-modal__body';

        if (session.phase === 'loading') {
            body.textContent = 'Đang tải danh sách wallet từ MoneyKeeper...';
            return body;
        }
        if (session.phase === 'loadError') {
            const err = document.createElement('div');
            err.className = 'mkp-load-error';
            err.textContent = `Không tải được danh sách wallet: ${session.loadError}`;
            body.appendChild(err);
            if (session.tokenExpired) {
                const hint = document.createElement('div');
                hint.className = 'mkp-token mkp-token--error';
                hint.textContent = 'Bấm ⚙️ hoặc "Cấu hình MoneyKeeper" để cập nhật token mới.';
                body.appendChild(hint);
            }
            return body;
        }
        if (session.rows.length === 0) {
            body.textContent = 'Không có item nào có tag "Nhật thanh toán ► ..." trong bảng đang hiển thị.';
            return body;
        }

        body.appendChild(buildSummary());

        const logWrap = document.createElement('div');
        logWrap.className = 'mkp-log';
        logWrap.appendChild(buildTable());
        body.appendChild(logWrap);
        return body;
    }

    /** Tạo 1 nút bấm dùng chung (tránh lặp lại boilerplate className/type/listener). */
    function buildButton(label, variantClass, onClick) {
        const btn = document.createElement('button');
        btn.className = `mkp-btn ${variantClass}`;
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    }

    /** Xử lý bấm "Dừng lại": vòng lặp trong startPushing() tự thoát sau khi dòng hiện tại xong. */
    function onStopButtonClick() {
        isRunning = false;
        renderDialog();
    }

    /**
     * Dựng footer, tuỳ trạng thái:
     * - Đang chạy: "Dừng lại" + "Ẩn cửa sổ".
     * - Lỗi tải wallet: "Cấu hình MoneyKeeper" + "Tải lại" + "Đóng".
     * - Sẵn sàng: "Proceed" (khoá nếu không có dòng nào được chọn) + "Đóng".
     */
    function buildFooter() {
        const footer = document.createElement('div');
        footer.className = 'mkp-modal__footer';

        if (isRunning) {
            footer.appendChild(buildButton('Dừng lại', 'mkp-btn--danger', onStopButtonClick));
            footer.appendChild(buildButton('Ẩn cửa sổ (vẫn tiếp tục chạy)', 'mkp-btn--default', hideDialog));
            return footer;
        }
        if (session.phase === 'loadError') {
            footer.appendChild(buildButton('Cấu hình MoneyKeeper', 'mkp-btn--default', () => openConfigDialog(() => loadSession(true))));
            footer.appendChild(buildButton('Tải lại', 'mkp-btn--default', () => loadSession(true)));
        }
        if (session.phase === 'ready' && session.rows.length > 0) {
            const proceedBtn = buildButton('Proceed', 'mkp-btn--primary', startPushing);
            proceedBtn.disabled = session.refreshingWallets || !session.rows.some((r) => r.process);
            footer.appendChild(proceedBtn);
        }
        footer.appendChild(buildButton('Đóng', 'mkp-btn--default', hideDialog));
        return footer;
    }

    /**
     * Vẽ lại dialog từ đầu dựa theo `session` và `isRunning` hiện tại. Giữ lại vị trí cuộn của
     * bảng để không bị nhảy về đầu mỗi lần 1 dòng đổi trạng thái.
     */
    function renderDialog() {
        const prevScroll = dialogRoot?.querySelector('.mkp-log')?.scrollTop || 0;
        closeDialogDom();
        if (dialogHidden) return;

        injectStyles();

        const modal = document.createElement('div');
        modal.className = 'mkp-modal';
        applySavedPosition(modal);

        modal.appendChild(buildHeader());
        modal.appendChild(buildBody());
        modal.appendChild(buildFooter());

        document.body.appendChild(modal);
        dialogRoot = modal;

        modal.querySelectorAll('.mkp-desc').forEach(autoGrow);
        const log = modal.querySelector('.mkp-log');
        if (log) log.scrollTop = prevScroll;
    }

    /* =========================================================================
     *  SPA URL WATCHER / KHỞI TẠO
     * ========================================================================= */

    let lastPath = null; // Path ở lần checkUrl trước, để phát hiện chuyển từ PO này sang PO khác.

    /** Đăng ký/huỷ nút nổi theo URL hiện tại (SPA không load lại trang khi đổi route). */
    const checkUrl = () => {
        const path = currentPath();
        const isAllowed = path === PAGE_LIST_PATH || PO_UPDATE_REGEX.test(path);
        const pathChanged = lastPath !== null && path !== lastPath;
        lastPath = path;

        if (isAllowed && buttonRegistered && pathChanged) {
            // Vẫn ở trang hợp lệ nhưng đổi route (vd. PO khác): dữ liệu trong dialog đã cũ.
            isRunning = false;
            hideDialog();
        }

        if (isAllowed && !buttonRegistered) {
            registerLauncherButton();
        } else if (!isAllowed && buttonRegistered) {
            isRunning = false; // Dừng tiến trình nếu chuyển sang trang khác.
            hideDialog();
            utils.unregisterButton(BUTTON_ID);
            buttonRegistered = false;
        }
    };

    GM_registerMenuCommand('Cấu hình MoneyKeeper', () => openConfigDialog());

    // Chờ thư viện dùng chung sẵn sàng rồi mới theo dõi URL / đăng ký nút nổi. Trước khi await
    // resolve, KHÔNG đoạn nào chạm tới `utils`.
    (async () => {
        try {
            utils = await waitForFinplanUtils();
        } catch (err) {
            console.error('[Push to Money Keeper]', err.message);
            return;
        }
        setInterval(checkUrl, 2000);
        checkUrl();
    })();

})();
