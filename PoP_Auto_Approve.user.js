// ==UserScript==
// @name         PoP Auto Approve
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Tự động duyệt (Approve) các PoP có tất cả invoice ở trạng thái "Paid": chờ loading, xác nhận "Yes" trên hộp thoại, điều khiển qua nút nổi
// @author       Gemini AI
// @match        https://pop.saigontechnology.vn/pop-reports*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /**
     * ============================================================================
     * PoP AUTO APPROVE
     * ============================================================================
     * Tự động tìm và lần lượt duyệt (Approve) mọi PoP (Proof of Payment report) mà
     * TẤT CẢ invoice liên quan đã ở trạng thái "Paid", kèm xác nhận hộp thoại "Yes",
     * giúp duyệt hàng loạt mà không cần click thủ công từng dòng.
     *
     * Script này chạy trên domain riêng (pop.saigontechnology.vn, khác với
     * finplan.saigontechnology.vn của các script Approve_All_*), nhưng vẫn dùng chung
     * `unsafeWindow.FinplanUtils` do Finplan_Shared_Library.user.js nạp (script đó cũng
     * match domain này) - vì vậy vẫn chủ động chờ (`waitForFinplanUtils`) thay vì giả định
     * `FinplanUtils` đã sẵn sàng ngay từ đầu.
     *
     * Code chia làm 3 khối chính, cùng kiến trúc với Approve_All_Items.user.js /
     * Approve_All_POs.user.js / Mark_All_as_Paid_Clean_Quotes.user.js:
     *   1) TIẾN TRÌNH XỬ LÝ (findNextApproveTarget / processSinglePoP / startProcessing).
     *   2) NÚT NỔI - đăng ký qua Floating Button Manager dùng chung, chỉ dùng để khởi
     *      chạy 1 lượt xử lý mới hoặc mở lại dialog tiến trình nếu đang ẩn. Vì `@match`
     *      của file này đã giới hạn chặt vào đúng trang pop-reports, không cần polling
     *      URL như các script kia (đăng ký nút đúng 1 lần lúc khởi tạo).
     *   3) FLOATING DIALOG TIẾN TRÌNH (renderDialog và các hàm build*) - bảng trạng thái
     *      từng PoP kèm nút Dừng lại / Ẩn cửa sổ / Đóng.
     * ============================================================================
     */

    /* =========================================================================
     *  CẤU HÌNH
     * ========================================================================= */
    const CONFIG = {
        // Selector của bảng PoP.
        TABLE_BODY_SELECTOR: 'table.m-datatable__table tbody',
        // Selector của từng dòng PoP trong bảng.
        ROW_SELECTOR: 'tr.m-datatable__row',
        // Selector các thẻ <a> chứa trạng thái invoice trong cột "Client Payments".
        INVOICE_LINK_SELECTOR: '.list-group .payment-link-item a',
        // Trạng thái được coi là "đã thanh toán".
        PAID_STATUS_TEXT: 'Paid',
        // Nếu true: PoP không có invoice nào cũng được coi là "không đủ điều kiện" (an toàn hơn).
        // Nếu false: PoP không có invoice nào sẽ được coi là đủ điều kiện (theo đúng nghĩa đen
        // "tất cả đều Paid" khi tập rỗng).
        SKIP_IF_NO_INVOICE: true,
        // id cố định dùng để đăng ký/huỷ đăng ký nút nổi với Floating Button Manager dùng chung.
        BUTTON_ID: 'finplan-auto-approve-fab',
        // Selector nút "Yes" bên trong hộp thoại xác nhận "Approve Confirm".
        CONFIRM_MODAL_YES_SELECTOR: 'app-confirm-modal .button_dialog button.btn-primary',
        // Thời gian chờ tối đa (ms) cho hộp thoại xác nhận xuất hiện.
        CONFIRM_MODAL_TIMEOUT: 8000,
        // Key localStorage lưu vị trí (left/top) dialog sau khi user kéo.
        DIALOG_POSITION_KEY: 'ppa_dialog_position_v1',
    };

    /* =========================================================================
     *  STATE
     * ========================================================================= */
    let utils = null;      // Gán 1 lần sau khi waitForFinplanUtils() resolve, dùng xuyên suốt file.
    let isRunning = false; // Đang có 1 lượt xử lý (startProcessing) chạy hay không.

    /**
     * Danh sách PoP đã/đang xử lý trong LƯỢT CHẠY HIỆN TẠI (reset về [] mỗi khi bấm nút nổi
     * để bắt đầu lượt mới). Dùng cho 2 mục đích:
     *   - Hiển thị bảng trạng thái trong dialog.
     *   - Loại trừ khi tìm PoP tiếp theo (không bao giờ chọn lại 1 PoP đã có mặt trong danh
     *     sách này, kể cả khi PoP đó vừa xử lý lỗi).
     * Mỗi entry: { reportName: string, status: 'processing'|'success'|'error', message: string }
     */
    let reportLog = [];

    // Số PoP đủ điều kiện (invoice đều Paid) nhưng không còn nút Approve (đã được duyệt qua
    // đường khác) - chỉ dùng cho dòng tóm tắt cuối, không tạo dòng riêng trong bảng vì chưa
    // từng thực sự "thử" xử lý.
    let skippedCount = 0;

    let dialogRoot = null;      // Element DOM của dialog đang hiển thị (null nếu đang ẩn/đóng).
    let dialogHidden = true;    // true = không vẽ dialog dù có log/đang chạy (user bấm "Ẩn cửa sổ").
    let dialogPosition = loadDialogPosition(); // Vị trí đã lưu từ lần kéo gần nhất (nếu có).
    // true = tự cuộn bảng log xuống dòng mới nhất mỗi lần renderDialog(). Tắt tạm khi user cuộn
    // lên đọc log cũ, bật lại khi cuộn về sát đáy. Reset về true khi bắt đầu lượt chạy mới.
    let progressStickToBottom = true;

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
            const raw = localStorage.getItem(CONFIG.DIALOG_POSITION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    /** Lưu vị trí dialog (left/top tính theo px so với viewport) vào localStorage. */
    function saveDialogPosition(pos) {
        dialogPosition = pos;
        try {
            localStorage.setItem(CONFIG.DIALOG_POSITION_KEY, JSON.stringify(pos));
        } catch (e) {
            // Bỏ qua nếu không lưu được (ví dụ localStorage đầy) - không ảnh hưởng chức năng chính.
        }
    }

    /* =========================================================================
     *  TIẾN TRÌNH XỬ LÝ
     * ========================================================================= */

    /**
     * Lấy danh sách trạng thái invoice (đã trim) của một dòng PoP.
     * @param {HTMLElement} row - phần tử <tr> của PoP.
     * @returns {string[]}
     */
    function getInvoiceStatuses(row) {
        const links = row.querySelectorAll(CONFIG.INVOICE_LINK_SELECTOR);
        return Array.from(links).map((a) => a.textContent.trim());
    }

    /**
     * Kiểm tra một dòng PoP có đủ điều kiện để duyệt hay không:
     * tất cả invoice liên quan đều ở trạng thái "Paid".
     * @param {HTMLElement} row
     * @returns {boolean}
     */
    function isRowEligibleForApproval(row) {
        const statuses = getInvoiceStatuses(row);

        if (statuses.length === 0) {
            // Không có invoice nào -> tuỳ theo cấu hình mà coi là đủ/không đủ điều kiện.
            return !CONFIG.SKIP_IF_NO_INVOICE;
        }

        return statuses.every((status) => status === CONFIG.PAID_STATUS_TEXT);
    }

    /**
     * Tìm nút "Approve" trong cùng dòng PoP (nếu có).
     * Một số dòng chỉ còn nút "Cancel" (đã duyệt/đang chờ ở bước khác) -> không có nút Approve.
     * @param {HTMLElement} row
     * @returns {HTMLElement|null}
     */
    function findApproveButton(row) {
        const buttons = row.querySelectorAll('.btn-row button');
        return Array.from(buttons).find((btn) => btn.textContent.trim() === 'Approve') || null;
    }

    /**
     * Lấy tên report của dòng PoP, dùng để log/hiển thị trong bảng.
     * @param {HTMLElement} row
     * @returns {string}
     */
    function getReportName(row) {
        const nameEl = row.querySelector('a.report-name');
        return nameEl ? nameEl.textContent.trim() : '(không xác định)';
    }

    /**
     * Quét lại toàn bộ bảng (luôn truy vấn DOM mới nhất, vì trang có thể re-render sau mỗi lần
     * approve), trả về dòng PoP khả thi ĐẦU TIÊN: đủ điều kiện (invoice đều Paid), còn nút
     * Approve, và CHƯA có mặt trong `reportLog` (chưa từng thử xử lý ở lượt chạy này).
     * Dòng đủ điều kiện nhưng hết nút Approve (đã được duyệt qua đường khác) được tính vào
     * `skippedCount` rồi bỏ qua, không trả về.
     *
     * @returns {{ approveBtn: HTMLElement, reportName: string } | null}
     */
    function findNextApproveTarget() {
        const rows = document.querySelectorAll(`${CONFIG.TABLE_BODY_SELECTOR} ${CONFIG.ROW_SELECTOR}`);

        for (const row of rows) {
            if (!isRowEligibleForApproval(row)) continue;

            const reportName = getReportName(row);
            const approveBtn = findApproveButton(row);

            if (!approveBtn) {
                // Đủ điều kiện nhưng không còn nút Approve -> không tính là lỗi, chỉ đếm để báo cáo.
                skippedCount++;
                continue;
            }

            if (reportLog.some((entry) => entry.reportName === reportName)) continue;

            return { approveBtn, reportName };
        }
        return null;
    }

    /** Đánh dấu 1 entry là "đã dừng theo yêu cầu" (user bấm Dừng lại giữa chừng) và render lại dialog. */
    function markStopped(entry) {
        entry.status = 'error';
        entry.message = 'Đã dừng theo yêu cầu trước khi hoàn tất.';
        renderDialog();
    }

    /**
     * Thực hiện toàn bộ thao tác duyệt cho 1 PoP: click Approve (hệ thống sẽ hiện loading box
     * trước, sau đó tới hộp thoại "Approve Confirm"), chờ + click nút "Yes" trong hộp thoại xác
     * nhận, rồi chờ phản hồi từ server. `entry.status` được cập nhật ngay khi có kết quả
     * (success/error) và dialog được render lại sau mỗi bước quan trọng để bảng trạng thái phản
     * ánh đúng thời gian thực.
     *
     * Toàn bộ thao tác được bọc trong 1 try/catch duy nhất (kể cả bước click Approve ban đầu)
     * để 1 PoP lỗi không làm hỏng cả lượt chạy - khác bản gốc chỉ bọc try/catch quanh đoạn chờ
     * hộp thoại xác nhận.
     *
     * Nếu user bấm "Dừng lại" (isRunning chuyển false) ngay giữa lúc đang xử lý, hàm dừng
     * ngay lập tức và đánh dấu PoP là lỗi "đã dừng theo yêu cầu" thay vì báo nhầm thành success.
     *
     * @param {{ approveBtn: HTMLElement, reportName: string }} target
     * @param {{ reportName: string, status: string, message: string }} entry - Entry tương ứng
     *        trong `reportLog`, được cập nhật trực tiếp (theo reference).
     * @returns {Promise<void>}
     */
    async function processSinglePoP(target, entry) {
        const { approveBtn, reportName } = target;
        try {
            // Giả lập click vào nút Approve.
            utils.simulateClick(approveBtn);

            // Chờ hộp thoại xác nhận xuất hiện.
            const yesBtn = await utils.waitForElement([CONFIG.CONFIRM_MODAL_YES_SELECTOR], CONFIG.CONFIRM_MODAL_TIMEOUT);

            // Nghỉ một chút để trang web bind event handler mới cho confirm dialog.
            await utils.sleep(500);

            if (!isRunning) return markStopped(entry);

            // Bấm "Yes" để hoàn tất duyệt.
            utils.simulateClick(yesBtn);
            await utils.waitForServerResponse();

            entry.status = 'success';
            renderDialog();

            // Nghỉ một chút trước khi xử lý PoP tiếp theo để tránh thao tác quá nhanh.
            await utils.sleep(300);
        } catch (err) {
            console.warn(`[Finplan Auto Approve] Không xử lý được "${reportName}": ${err.message}`);
            entry.status = 'error';
            entry.message = err.message;
            renderDialog();
            await utils.sleep(300);
        }
    }

    /**
     * Vòng lặp chính của 1 lượt chạy: liên tục tìm PoP tiếp theo (findNextApproveTarget) và
     * xử lý (processSinglePoP) cho tới khi hết PoP khả thi hoặc user bấm Dừng lại
     * (isRunning = false). Mỗi PoP được push vào `reportLog` NGAY khi tìm thấy (trước khi xử
     * lý) để không bao giờ bị chọn lại ở vòng lặp kế tiếp, kể cả khi xử lý thất bại.
     */
    async function startProcessing() {
        console.log('[Finplan Auto Approve] Bắt đầu quy trình duyệt tự động...');

        // Đảm bảo bảng đã render xong trước khi bắt đầu xử lý.
        await utils.waitForElement([CONFIG.TABLE_BODY_SELECTOR]);

        while (isRunning) {
            const target = findNextApproveTarget();

            if (!target) {
                console.log('[Finplan Auto Approve] Hoàn tất danh sách.');
                isRunning = false;
                renderDialog();
                break;
            }

            const entry = { reportName: target.reportName, status: 'processing', message: '' };
            reportLog.push(entry);
            renderDialog();

            await processSinglePoP(target, entry);
        }

        isRunning = false;
        renderDialog();
    }

    /* =========================================================================
     *  NÚT NỔI (Floating Button Manager dùng chung)
     *  Chỉ đóng vai trò khởi chạy lượt xử lý mới / mở lại dialog tiến trình đang ẩn.
     *  Việc dừng tiến trình và xem kết quả từng PoP thuộc về floating dialog bên dưới.
     *  Khác Approve_All_*.user.js: không cần polling URL vì @match đã giới hạn đúng
     *  phạm vi trang pop-reports, nên chỉ đăng ký nút đúng 1 lần lúc khởi tạo (xem init()).
     * ========================================================================= */

    /** Đăng ký nút nổi với Button Manager dùng chung. */
    function registerLauncherButton() {
        utils.registerButton(CONFIG.BUTTON_ID, {
            icon: '🚀',
            text: 'Duyệt tự động PoP',
            tooltip: 'Bấm để bắt đầu duyệt tự động. Nếu đang chạy, bấm lại để mở cửa sổ tiến trình.',
            onClick: onLauncherClick,
            order: 0
        });
    }

    /**
     * Handler khi user bấm nút nổi (hoặc gọi `window.runFinplanAutoApprove()` từ Console).
     * - Nếu đang chạy dở: KHÔNG bắt đầu lượt mới (tránh chạy song song nhiều vòng lặp cùng
     *   lúc tranh nhau 1 nút Approve) - chỉ mở lại dialog trong trường hợp nó đang bị ẩn.
     * - Nếu chưa chạy: reset log và bắt đầu 1 lượt xử lý hoàn toàn mới.
     */
    function onLauncherClick() {
        if (isRunning) {
            dialogHidden = false;
            renderDialog();
            return;
        }
        reportLog = [];
        skippedCount = 0;
        progressStickToBottom = true;
        isRunning = true;
        dialogHidden = false;
        renderDialog();
        startProcessing();
    }

    /* =========================================================================
     *  FLOATING DIALOG TIẾN TRÌNH (phỏng theo Approve_All_POs.user.js)
     * ========================================================================= */

    /** Chèn CSS cho dialog vào <head>, chỉ chèn 1 lần (idempotent). */
    function injectStyles() {
        if (document.getElementById('ppa-style')) return;
        const style = document.createElement('style');
        style.id = 'ppa-style';
        style.textContent = `
            .ppa-modal {
                position: fixed;
                top: 12vh;
                left: 50%;
                transform: translateX(-50%);
                background: #fff;
                border-radius: 8px;
                width: 620px;
                max-width: 92vw;
                max-height: 80vh;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                font-family: Arial, sans-serif;
                box-shadow: 0 8px 30px rgba(0,0,0,.35);
                z-index: 999999;
            }
            .ppa-modal--dragging { user-select: none; }
            .ppa-modal__header {
                padding: 14px 18px;
                border-bottom: 1px solid #ebedf2;
                display: flex; align-items: center; justify-content: space-between;
                cursor: move;
            }
            .ppa-modal__header h3 { margin: 0; font-size: 16px; }
            .ppa-modal__close { cursor: pointer; border: none; background: none; font-size: 18px; color: #888; }
            .ppa-modal__body { padding: 18px; overflow-y: auto; flex: 1; min-height: 0; }
            .ppa-modal__footer {
                padding: 12px 18px; border-top: 1px solid #ebedf2;
                display: flex; justify-content: flex-end; gap: 8px;
            }
            .ppa-btn {
                border: none; border-radius: 4px; padding: 8px 16px;
                font-size: 13px; font-weight: 600; cursor: pointer;
            }
            .ppa-btn--primary { background: #5867dd; color: #fff; }
            .ppa-btn--primary:hover { background: #4654c0; }
            .ppa-btn--default { background: #ebedf2; color: #333; }
            .ppa-btn--danger { background: #e64c3c; color: #fff; }
            .ppa-btn--danger:hover { background: #cf4534; }
            .ppa-log {
                margin-top: 4px; max-height: 340px; overflow: auto;
                overscroll-behavior: contain;
                border: 1px solid #ebedf2; border-radius: 4px;
            }
            .ppa-table { width: 100%; border-collapse: collapse; font-size: 13px; }
            .ppa-table th, .ppa-table td { border-bottom: 1px solid #ebedf2; padding: 6px 8px; text-align: left; vertical-align: top; }
            .ppa-table thead th {
                position: sticky; top: 0; z-index: 1;
                background: #fff; box-shadow: inset 0 -1px 0 #ebedf2;
            }
            .ppa-status { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 12px; white-space: nowrap; }
            .ppa-status--processing { background: rgba(42,130,254,.15); color: #2a82fe; }
            .ppa-status--success { background: rgba(51,153,51,.15); color: #393; }
            .ppa-status--error { background: rgba(228,63,63,.2); color: #e43f3f; }
            .ppa-summary { font-size: 13px; margin-bottom: 10px; color: #333; }
            .ppa-error-msg { font-size: 11px; color: #666; margin-top: 4px; line-height: 1.4; }
        `;
        document.head.appendChild(style);
    }

    /* ---- Kéo (drag) dialog bằng vùng header ----
     * Cơ chế: mousedown trên header -> ghi nhận vị trí bắt đầu kéo; mousemove trên toàn document ->
     * tính toán vị trí mới theo độ lệch chuột, có giới hạn (clamp) để dialog không bị kéo ra ngoài
     * khung nhìn; mouseup -> kết thúc kéo và lưu vị trí cuối cùng vào localStorage.
     * Listener được gắn ở cấp document (không phải trên dialog) để vẫn nhận mousemove/mouseup
     * ngay cả khi con trỏ chuột di chuyển ra ngoài phạm vi dialog trong lúc đang kéo.
     */
    const dragState = { active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 };

    /** Bắt đầu kéo dialog khi mousedown trên header (trừ khi bấm đúng vào nút đóng). */
    function onHeaderMouseDown(e) {
        if (e.target.closest('.ppa-modal__close')) return;
        if (!dialogRoot) return;
        const rect = dialogRoot.getBoundingClientRect();
        dragState.active = true;
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dragState.startLeft = rect.left;
        dragState.startTop = rect.top;
        // Chuyển từ định vị bằng transform (căn giữa mặc định) sang định vị bằng left/top tuyệt đối,
        // để có thể set trực tiếp toạ độ trong lúc kéo.
        dialogRoot.style.left = rect.left + 'px';
        dialogRoot.style.top = rect.top + 'px';
        dialogRoot.style.transform = 'none';
        dialogRoot.classList.add('ppa-modal--dragging');
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
            dialogRoot.classList.remove('ppa-modal--dragging');
            const rect = dialogRoot.getBoundingClientRect();
            saveDialogPosition({ left: rect.left, top: rect.top });
        }
    }

    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', onDocumentMouseUp);

    /** Gỡ dialog khỏi DOM (nếu có), không đụng tới `reportLog`/`isRunning`. */
    function closeDialogDom() {
        if (dialogRoot) {
            dialogRoot.remove();
            dialogRoot = null;
        }
    }

    /** Ẩn dialog: job (nếu đang chạy) vẫn tiếp tục chạy ngầm, chỉ là không hiển thị UI. */
    function hideDialog() {
        dialogHidden = true;
        closeDialogDom();
    }

    /** Ánh xạ giá trị status nội bộ sang nhãn hiển thị trên badge trạng thái của từng dòng. */
    function statusLabel(status) {
        switch (status) {
            case 'processing': return 'Đang xử lý';
            case 'success': return 'Success';
            case 'error': return 'Lỗi';
            default: return status;
        }
    }

    /** Áp lại vị trí đã lưu (nếu có) lên dialog, để nó không bị "nhảy" về giữa màn hình sau mỗi lần render lại. */
    function applySavedPosition(modal) {
        if (!dialogPosition) return;
        modal.style.left = dialogPosition.left + 'px';
        modal.style.top = dialogPosition.top + 'px';
        modal.style.transform = 'none';
    }

    /** Xử lý bấm nút đóng (×) ở header: xác nhận trước nếu job đang chạy dở, rồi ẩn dialog. */
    function onCloseButtonClick() {
        if (isRunning) {
            if (!confirm('Đang xử lý dở danh sách. Dừng lại và đóng?')) return;
            isRunning = false;
        }
        hideDialog();
    }

    /** Dựng phần header: tiêu đề (kéo được) + nút đóng. */
    function buildHeader() {
        const header = document.createElement('div');
        header.className = 'ppa-modal__header';
        header.addEventListener('mousedown', onHeaderMouseDown);

        const title = document.createElement('h3');
        title.textContent = 'PoP Auto Approve';
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'ppa-modal__close';
        closeBtn.type = 'button';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', onCloseButtonClick);
        header.appendChild(closeBtn);

        return header;
    }

    /** Sinh dòng tóm tắt tiến trình, tuỳ theo đang chạy / chưa xử lý gì / đã dừng. */
    function getSummaryText(doneCount) {
        if (isRunning) {
            return `Đang xử lý ${doneCount}/${reportLog.length} PoP... (đang tìm/duyệt các PoP tiếp theo)`;
        }
        if (reportLog.length === 0 && skippedCount === 0) {
            return 'Chưa xử lý PoP nào.';
        }
        const successCount = reportLog.filter((e) => e.status === 'success').length;
        const errorCount = reportLog.filter((e) => e.status === 'error').length;
        return `Đã dừng. Hoàn tất ${doneCount}/${reportLog.length} PoP — Thành công: ${successCount}, Lỗi: ${errorCount}. Bỏ qua (không có nút Approve): ${skippedCount}.`;
    }

    /** Dựng dòng tóm tắt (số lượng đã xử lý / kết quả) hiển thị phía trên bảng. */
    function buildSummary() {
        const doneCount = reportLog.filter((e) => e.status !== 'processing').length;
        const summary = document.createElement('div');
        summary.className = 'ppa-summary';
        summary.textContent = getSummaryText(doneCount);
        return summary;
    }

    /** Dựng 1 dòng của bảng trạng thái ứng với 1 entry trong `reportLog`. */
    function buildTableRow(entry) {
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        tdName.textContent = entry.reportName;
        tr.appendChild(tdName);

        const tdStatus = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = `ppa-status ppa-status--${entry.status}`;
        badge.textContent = statusLabel(entry.status);
        tdStatus.appendChild(badge);
        if (entry.status === 'error' && entry.message) {
            const msg = document.createElement('div');
            msg.className = 'ppa-error-msg';
            msg.textContent = entry.message;
            tdStatus.appendChild(msg);
        }
        tr.appendChild(tdStatus);

        return tr;
    }

    /** Dựng bảng chi tiết trạng thái từng PoP, theo đúng thứ tự đã xử lý trong `reportLog`. */
    function buildTable() {
        const table = document.createElement('table');
        table.className = 'ppa-table';
        table.innerHTML = '<thead><tr><th>PoP</th><th>Trạng thái</th></tr></thead>';

        const tbody = document.createElement('tbody');
        reportLog.forEach((entry) => tbody.appendChild(buildTableRow(entry)));
        table.appendChild(tbody);

        return table;
    }

    /** Dựng phần body: dòng tóm tắt + bảng chi tiết từng PoP (bảng có vùng cuộn riêng). */
    function buildBody() {
        const body = document.createElement('div');
        body.className = 'ppa-modal__body';
        body.appendChild(buildSummary());

        const logWrap = document.createElement('div');
        logWrap.className = 'ppa-log';
        logWrap.appendChild(buildTable());
        // User cuộn lên đọc log cũ -> tạm ngừng bám đáy; cuộn lại sát đáy -> bật lại.
        logWrap.addEventListener('scroll', () => {
            progressStickToBottom =
                logWrap.scrollHeight - logWrap.scrollTop - logWrap.clientHeight <= 8;
        });
        body.appendChild(logWrap);

        return body;
    }

    /** Tạo 1 nút bấm dùng chung cho footer (tránh lặp lại boilerplate className/type/listener). */
    function buildButton(label, variantClass, onClick) {
        const btn = document.createElement('button');
        btn.className = `ppa-btn ${variantClass}`;
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    }

    /** Xử lý bấm "Dừng lại": vòng lặp trong startProcessing() sẽ tự thoát sau khi PoP hiện tại xử lý xong. */
    function onStopButtonClick() {
        isRunning = false;
        renderDialog();
    }

    /**
     * Dựng phần footer, tuỳ theo trạng thái:
     * - Đang chạy: "Dừng lại" (yêu cầu dừng) + "Ẩn cửa sổ" (ẩn UI, job vẫn chạy ngầm).
     * - Đã dừng/hoàn tất: "Đóng".
     */
    function buildFooter() {
        const footer = document.createElement('div');
        footer.className = 'ppa-modal__footer';

        if (isRunning) {
            footer.appendChild(buildButton('Dừng lại', 'ppa-btn--danger', onStopButtonClick));
            footer.appendChild(buildButton('Ẩn cửa sổ (vẫn tiếp tục chạy)', 'ppa-btn--default', hideDialog));
        } else {
            footer.appendChild(buildButton('Đóng', 'ppa-btn--default', hideDialog));
        }

        return footer;
    }

    /**
     * Vẽ lại dialog từ đầu dựa theo `reportLog` và `isRunning` hiện tại. Được gọi lại mỗi khi
     * cần cập nhật UI (bắt đầu lượt chạy mới, sau mỗi bước xử lý PoP, khi user bấm nút...).
     * Nếu `dialogHidden === true` thì không tạo DOM (job vẫn chạy ngầm bình thường, chỉ là
     * không hiển thị UI - user có thể mở lại bằng cách bấm nút nổi).
     */
    function renderDialog() {
        closeDialogDom();
        if (dialogHidden) return;

        injectStyles();

        const modal = document.createElement('div');
        modal.className = 'ppa-modal';
        applySavedPosition(modal);

        modal.appendChild(buildHeader());
        modal.appendChild(buildBody());
        modal.appendChild(buildFooter());

        document.body.appendChild(modal);
        dialogRoot = modal;

        // Modal đã vào DOM -> cuộn bảng log xuống dòng mới nhất để người dùng theo dõi PoP đang
        // xử lý. Bỏ qua nếu user đang cuộn lên đọc log cũ.
        const logEl = modal.querySelector('.ppa-log');
        if (logEl && progressStickToBottom) {
            logEl.scrollTop = logEl.scrollHeight;
        }
    }

    /* =========================================================================
     *  KHỞI TẠO
     * ========================================================================= */

    /**
     * Chờ FinplanUtils sẵn sàng rồi đăng ký nút nổi. Không cần polling URL như các script
     * Approve_All_* vì `@match` của file này đã giới hạn đúng phạm vi trang pop-reports.
     */
    async function init() {
        try {
            utils = await waitForFinplanUtils();
        } catch (err) {
            console.error('[Finplan Auto Approve]', err.message);
            return;
        }
        registerLauncherButton();
    }

    init();

    // Đồng thời expose ra global để có thể gọi thủ công từ Console nếu cần, tương đương bấm
    // nút nổi: ví dụ window.runFinplanAutoApprove()
    unsafeWindow.runFinplanAutoApprove = onLauncherClick;
})();
