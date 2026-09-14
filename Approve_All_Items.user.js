// ==UserScript==
// @name         Approve all Items (CFO)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Duyệt tự động toàn bộ Item, hỗ trợ SPA và chống treo trang
// @author       Gemini AI
// @match        https://finplan.saigontechnology.vn/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /**
     * ============================================================================
     * APPROVE ALL ITEMS (CFO)
     * ============================================================================
     * Tự động tìm và lần lượt bấm mọi nút "Approve" đang hiển thị trên trang danh sách
     * Payment Items (kèm xác nhận modal nếu trang yêu cầu), giúp duyệt hàng loạt item mà
     * không cần click thủ công từng dòng.
     *
     * Code được chia làm 3 khối chính:
     *   1) TIẾN TRÌNH XỬ LÝ (findNextApproveTarget / approveSingleItem / startProcessing):
     *      vòng lặp chính - mỗi lượt tìm 1 item chưa xử lý rồi approve + confirm item đó.
     *   2) NÚT NỔI - đăng ký qua Floating Button Manager dùng chung
     *      (unsafeWindow.FinplanUtils, nạp bởi Finplan_Shared_Library.user.js). Nút chỉ có
     *      vai trò khởi chạy 1 lượt xử lý mới, hoặc mở lại dialog tiến trình nếu đang ẩn -
     *      không tự đổi màu/label theo trạng thái chạy/dừng như bản cũ.
     *   3) FLOATING DIALOG TIẾN TRÌNH (renderDialog và các hàm build*): hộp thoại kéo-thả
     *      được, hiển thị bảng trạng thái từng item (Đang xử lý/Success/Lỗi) kèm nút
     *      Dừng lại / Ẩn cửa sổ / Đóng, phỏng theo đúng mô hình dialog đã dùng trong
     *      Mark_Auto-Charge_Items_Paid.user.js để đồng bộ trải nghiệm giữa các tool.
     * ============================================================================
     */

    /* =========================================================================
     *  CẤU HÌNH
     * ========================================================================= */
    let utils = null; // Gán 1 lần trong bootstrap async ở cuối file (sau khi waitForFinplanUtils() resolve).
    const APPROVE_BUTTON_LABEL = 'Approve';
    const MODAL_CONFIRM_SELECTOR = '.button_dialog .btn-primary, .modal-footer .btn-primary, .modal-content .btn-primary';
    // Chỉ hiển thị nút nổi + chạy tiến trình trên đúng các trang danh sách Payment Item này.
    const ALLOWED_URLS = [
        'https://finplan.saigontechnology.vn/purchase-orders/payment-items?status=2',
        'https://finplan.saigontechnology.vn/purchase-orders/payment-items?status=0',
        'https://finplan.saigontechnology.vn/purchase-orders/payment-items'
    ];
    // Id cố định dùng để đăng ký/huỷ đăng ký nút nổi với Floating Button Manager dùng chung.
    const BUTTON_ID = 'approve-all-items-cfo';
    // Key localStorage lưu vị trí (left/top) dialog sau khi user kéo, để dialog không "nhảy"
    // về vị trí mặc định mỗi lần render lại (mỗi khi có item mới được xử lý).
    const DIALOG_POSITION_KEY = 'aai_dialog_position_v1';

    /* =========================================================================
     *  STATE
     * ========================================================================= */
    let isRunning = false;         // Đang có 1 lượt xử lý (startProcessing) chạy hay không.
    let buttonRegistered = false;  // Nút nổi đã được đăng ký với Button Manager hay chưa.

    /**
     * Danh sách item đã/đang xử lý trong LƯỢT CHẠY HIỆN TẠI (reset về [] mỗi khi bấm nút
     * nổi để bắt đầu lượt mới). Dùng cho 2 mục đích:
     *   - Hiển thị bảng trạng thái trong dialog.
     *   - Loại trừ khi tìm item Approve tiếp theo (không bao giờ chọn lại 1 item đã có mặt
     *     trong danh sách này, kể cả khi item đó vừa xử lý lỗi).
     * Mỗi entry: { itemNumber: string, status: 'processing'|'success'|'error', message: string }
     */
    let itemLog = [];

    let dialogRoot = null;      // Element DOM của dialog đang hiển thị (null nếu đang ẩn/đóng).
    let dialogHidden = true;    // true = không vẽ dialog dù có log/đang chạy (user bấm "Ẩn cửa sổ").
    let dialogPosition = loadDialogPosition(); // Vị trí đã lưu từ lần kéo gần nhất (nếu có).
    // true = tự cuộn bảng log xuống dòng mới nhất mỗi lần renderDialog(). Tắt tạm khi user cuộn
    // lên đọc log cũ, bật lại khi cuộn về sát đáy. Reset về true khi bắt đầu lượt chạy mới.
    let progressStickToBottom = true;

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
            // Bỏ qua nếu không lưu được (ví dụ localStorage đầy) - không ảnh hưởng chức năng chính.
        }
    }

    /* =========================================================================
     *  TIẾN TRÌNH XỬ LÝ
     * ========================================================================= */

    /**
     * Quét toàn trang, trả về nút "Approve" đầu tiên đang hiển thị (offsetParent !== null)
     * mà item tương ứng CHƯA có mặt trong `itemLog` (tức chưa được xử lý ở lượt chạy này).
     *
     * @returns {{ approveBtn: HTMLElement, itemNumber: string } | null}
     */
    function findNextApproveTarget() {
        const allButtons = document.querySelectorAll('button, a, input, .btn');
        for (const btn of allButtons) {
            if (btn.innerText?.trim() !== APPROVE_BUTTON_LABEL || btn.offsetParent === null) continue;
            const itemNumber = utils.findElementInSameRow(btn, '.cell-body-part .text-bold')?.textContent.trim();
            if (itemNumber && !itemLog.some((entry) => entry.itemNumber === itemNumber)) {
                return { approveBtn: btn, itemNumber };
            }
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
     * Thực hiện toàn bộ thao tác approve cho 1 item: cuộn tới nút Approve, click, chờ +
     * click nút xác nhận trên modal (nếu có), rồi chờ trang xử lý xong (loading box biến
     * mất). `entry.status` được cập nhật ngay khi có kết quả (success/error) và dialog được
     * render lại sau mỗi bước quan trọng để bảng trạng thái phản ánh đúng thời gian thực.
     *
     * Nếu user bấm "Dừng lại" (isRunning chuyển false) ngay giữa lúc đang xử lý, hàm dừng
     * ngay lập tức và đánh dấu item là lỗi "đã dừng theo yêu cầu" thay vì báo nhầm thành
     * success (vì bước confirm có thể chưa thực sự xảy ra).
     *
     * @param {HTMLElement} approveBtn - Nút Approve cần click, lấy từ findNextApproveTarget().
     * @param {{ itemNumber: string, status: string, message: string }} entry - Entry tương
     *        ứng trong `itemLog`, được cập nhật trực tiếp (theo reference).
     * @returns {Promise<void>}
     */
    async function approveSingleItem(approveBtn, entry) {
        try {
            // Cuộn tới mục tiêu (auto để tránh lag GPU).
            approveBtn.scrollIntoView({ behavior: 'auto', block: 'center' });
            await utils.sleep(500);

            if (!isRunning) return markStopped(entry);

            // Click Approve.
            utils.simulateClick(approveBtn);
            console.log(`Approved item: ${entry.itemNumber}`);

            // Nghỉ một chút để trang web bind event handler mới cho confirm dialog.
            await utils.sleep(500);
            const confirmBtn = await utils.waitForElement([MODAL_CONFIRM_SELECTOR]);

            if (!isRunning) return markStopped(entry);

            if (confirmBtn) {
                utils.simulateClick(confirmBtn);
                console.log(`Confirmed item: ${entry.itemNumber}`);
                await utils.waitForLoadingToComplete();
            }

            entry.status = 'success';
            renderDialog();
        } catch (err) {
            console.error('💥 Lỗi:', err);
            entry.status = 'error';
            entry.message = err.message;
            renderDialog();
            // Nghỉ 1s trước khi thử item tiếp theo, tránh vòng lặp lỗi dồn dập gây treo trang.
            await utils.sleep(1000);
        }
    }

    /**
     * Vòng lặp chính của 1 lượt chạy: liên tục tìm item Approve tiếp theo (findNextApproveTarget)
     * và xử lý (approveSingleItem) cho tới khi hết item hoặc user bấm Dừng lại (isRunning = false).
     * Mỗi item được push vào `itemLog` NGAY khi tìm thấy (trước khi xử lý) để không bao giờ bị
     * chọn lại ở vòng lặp kế tiếp, kể cả khi bước approve/confirm bên dưới thất bại.
     */
    async function startProcessing() {
        console.log('🚀 Bắt đầu duyệt Items...');

        while (isRunning) {
            const target = findNextApproveTarget();

            if (!target) {
                console.log('🏁 Hoàn tất danh sách Items.');
                isRunning = false;
                renderDialog();
                break;
            }
            console.log(`Found item: ${target.itemNumber}`);

            const entry = { itemNumber: target.itemNumber, status: 'processing', message: '' };
            itemLog.push(entry);
            renderDialog();

            await approveSingleItem(target.approveBtn, entry);
        }

        isRunning = false;
        renderDialog();
    }

    /* =========================================================================
     *  NÚT NỔI (Floating Button Manager dùng chung)
     *  Chỉ đóng vai trò khởi chạy lượt xử lý mới / mở lại dialog tiến trình đang ẩn.
     *  Việc dừng tiến trình và xem kết quả từng item thuộc về floating dialog bên dưới.
     * ========================================================================= */

    /** Đăng ký nút nổi với Button Manager dùng chung (idempotent - gọi lại sẽ update nếu đã tồn tại). */
    function registerLauncherButton() {
        utils.registerButton(BUTTON_ID, {
            icon: '⚡',
            text: 'Approve All Items (CFO)',
            tooltip: 'Bấm để bắt đầu duyệt tự động. Nếu đang chạy, bấm lại để mở cửa sổ tiến trình.',
            onClick: onLauncherClick,
            order: 0
        });
        buttonRegistered = true;
    }

    /**
     * Handler khi user bấm nút nổi.
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
        itemLog = [];
        progressStickToBottom = true;
        isRunning = true;
        dialogHidden = false;
        renderDialog();
        startProcessing();
    }

    /* =========================================================================
     *  FLOATING DIALOG TIẾN TRÌNH (phỏng theo Mark_Auto-Charge_Items_Paid.user.js)
     * ========================================================================= */

    /** Chèn CSS cho dialog vào <head>, chỉ chèn 1 lần (idempotent). */
    function injectStyles() {
        if (document.getElementById('aai-style')) return;
        const style = document.createElement('style');
        style.id = 'aai-style';
        style.textContent = `
            .aai-modal {
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
            .aai-modal--dragging { user-select: none; }
            .aai-modal__header {
                padding: 14px 18px;
                border-bottom: 1px solid #ebedf2;
                display: flex; align-items: center; justify-content: space-between;
                cursor: move;
            }
            .aai-modal__header h3 { margin: 0; font-size: 16px; }
            .aai-modal__close { cursor: pointer; border: none; background: none; font-size: 18px; color: #888; }
            .aai-modal__body { padding: 18px; overflow-y: auto; flex: 1; min-height: 0; }
            .aai-modal__footer {
                padding: 12px 18px; border-top: 1px solid #ebedf2;
                display: flex; justify-content: flex-end; gap: 8px;
            }
            .aai-btn {
                border: none; border-radius: 4px; padding: 8px 16px;
                font-size: 13px; font-weight: 600; cursor: pointer;
            }
            .aai-btn--primary { background: #28a745; color: #fff; }
            .aai-btn--primary:hover { background: #218838; }
            .aai-btn--default { background: #ebedf2; color: #333; }
            .aai-btn--danger { background: #dc3545; color: #fff; }
            .aai-btn--danger:hover { background: #c82333; }
            .aai-log {
                margin-top: 4px; max-height: 340px; overflow: auto;
                overscroll-behavior: contain;
                border: 1px solid #ebedf2; border-radius: 4px;
            }
            .aai-table { width: 100%; border-collapse: collapse; font-size: 13px; }
            .aai-table th, .aai-table td { border-bottom: 1px solid #ebedf2; padding: 6px 8px; text-align: left; vertical-align: top; }
            .aai-table thead th {
                position: sticky; top: 0; z-index: 1;
                background: #fff; box-shadow: inset 0 -1px 0 #ebedf2;
            }
            .aai-status { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 12px; white-space: nowrap; }
            .aai-status--processing { background: rgba(42,130,254,.15); color: #2a82fe; }
            .aai-status--success { background: rgba(51,153,51,.15); color: #393; }
            .aai-status--error { background: rgba(228,63,63,.2); color: #e43f3f; }
            .aai-summary { font-size: 13px; margin-bottom: 10px; color: #333; }
            .aai-error-msg { font-size: 11px; color: #666; margin-top: 4px; line-height: 1.4; }
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
        if (e.target.closest('.aai-modal__close')) return;
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
        dialogRoot.classList.add('aai-modal--dragging');
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
            dialogRoot.classList.remove('aai-modal--dragging');
            const rect = dialogRoot.getBoundingClientRect();
            saveDialogPosition({ left: rect.left, top: rect.top });
        }
    }

    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', onDocumentMouseUp);

    /** Gỡ dialog khỏi DOM (nếu có), không đụng tới `itemLog`/`isRunning`. */
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
        header.className = 'aai-modal__header';
        header.addEventListener('mousedown', onHeaderMouseDown);

        const title = document.createElement('h3');
        title.textContent = 'Approve All Items (CFO)';
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'aai-modal__close';
        closeBtn.type = 'button';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', onCloseButtonClick);
        header.appendChild(closeBtn);

        return header;
    }

    /** Sinh dòng tóm tắt tiến trình, tuỳ theo đang chạy / chưa xử lý gì / đã dừng. */
    function getSummaryText(doneCount) {
        if (isRunning) {
            return `Đang xử lý ${doneCount}/${itemLog.length} mục... (đang tìm/duyệt các mục tiếp theo)`;
        }
        if (itemLog.length === 0) {
            return 'Chưa xử lý mục nào.';
        }
        const successCount = itemLog.filter((e) => e.status === 'success').length;
        const errorCount = itemLog.filter((e) => e.status === 'error').length;
        return `Đã dừng. Hoàn tất ${doneCount}/${itemLog.length} mục — Thành công: ${successCount}, Lỗi: ${errorCount}.`;
    }

    /** Dựng dòng tóm tắt (số lượng đã xử lý / kết quả) hiển thị phía trên bảng. */
    function buildSummary() {
        const doneCount = itemLog.filter((e) => e.status !== 'processing').length;
        const summary = document.createElement('div');
        summary.className = 'aai-summary';
        summary.textContent = getSummaryText(doneCount);
        return summary;
    }

    /** Dựng 1 dòng của bảng trạng thái ứng với 1 entry trong `itemLog`. */
    function buildTableRow(entry) {
        const tr = document.createElement('tr');

        const tdId = document.createElement('td');
        tdId.textContent = entry.itemNumber;
        tr.appendChild(tdId);

        const tdStatus = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = `aai-status aai-status--${entry.status}`;
        badge.textContent = statusLabel(entry.status);
        tdStatus.appendChild(badge);
        if (entry.status === 'error' && entry.message) {
            const msg = document.createElement('div');
            msg.className = 'aai-error-msg';
            msg.textContent = entry.message;
            tdStatus.appendChild(msg);
        }
        tr.appendChild(tdStatus);

        return tr;
    }

    /** Dựng bảng chi tiết trạng thái từng item, theo đúng thứ tự đã xử lý trong `itemLog`. */
    function buildTable() {
        const table = document.createElement('table');
        table.className = 'aai-table';
        table.innerHTML = '<thead><tr><th>Item</th><th>Trạng thái</th></tr></thead>';

        const tbody = document.createElement('tbody');
        itemLog.forEach((entry) => tbody.appendChild(buildTableRow(entry)));
        table.appendChild(tbody);

        return table;
    }

    /** Dựng phần body: dòng tóm tắt + bảng chi tiết từng item (bảng có vùng cuộn riêng). */
    function buildBody() {
        const body = document.createElement('div');
        body.className = 'aai-modal__body';
        body.appendChild(buildSummary());

        const logWrap = document.createElement('div');
        logWrap.className = 'aai-log';
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
        btn.className = `aai-btn ${variantClass}`;
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    }

    /** Xử lý bấm "Dừng lại": vòng lặp trong startProcessing() sẽ tự thoát sau khi item hiện tại xử lý xong. */
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
        footer.className = 'aai-modal__footer';

        if (isRunning) {
            footer.appendChild(buildButton('Dừng lại', 'aai-btn--danger', onStopButtonClick));
            footer.appendChild(buildButton('Ẩn cửa sổ (vẫn tiếp tục chạy)', 'aai-btn--default', hideDialog));
        } else {
            footer.appendChild(buildButton('Đóng', 'aai-btn--default', hideDialog));
        }

        return footer;
    }

    /**
     * Vẽ lại dialog từ đầu dựa theo `itemLog` và `isRunning` hiện tại. Được gọi lại mỗi khi
     * cần cập nhật UI (bắt đầu lượt chạy mới, sau mỗi bước xử lý item, khi user bấm nút...).
     * Nếu `dialogHidden === true` thì không tạo DOM (job vẫn chạy ngầm bình thường, chỉ là
     * không hiển thị UI - user có thể mở lại bằng cách bấm nút nổi).
     */
    function renderDialog() {
        closeDialogDom();
        if (dialogHidden) return;

        injectStyles();

        const modal = document.createElement('div');
        modal.className = 'aai-modal';
        applySavedPosition(modal);

        modal.appendChild(buildHeader());
        modal.appendChild(buildBody());
        modal.appendChild(buildFooter());

        document.body.appendChild(modal);
        dialogRoot = modal;

        // Modal đã vào DOM -> cuộn bảng log xuống dòng mới nhất để người dùng theo dõi item đang
        // xử lý. Bỏ qua nếu user đang cuộn lên đọc log cũ.
        const logEl = modal.querySelector('.aai-log');
        if (logEl && progressStickToBottom) {
            logEl.scrollTop = logEl.scrollHeight;
        }
    }

    /* =========================================================================
     *  SPA URL WATCHER / KHỞI TẠO
     *  Trang là SPA (Angular) nên không có sự kiện load lại khi chuyển route - phải polling
     *  URL định kỳ để biết lúc nào cần đăng ký/huỷ đăng ký nút nổi.
     * ========================================================================= */

    /**
     * Kiểm tra URL hiện tại có thuộc `ALLOWED_URLS` hay không, rồi đồng bộ trạng thái nút nổi:
     * đăng ký khi vừa vào trang cho phép, huỷ đăng ký (kèm dừng job + đóng dialog) khi rời đi.
     */
    const checkUrl = () => {
        const currentUrl = window.location.href.split('#')[0];
        const isAllowed = ALLOWED_URLS.includes(currentUrl);

        if (isAllowed && !buttonRegistered) {
            registerLauncherButton();
        } else if (!isAllowed && buttonRegistered) {
            isRunning = false; // Dừng nếu chuyển sang trang khác.
            hideDialog();
            utils.unregisterButton(BUTTON_ID);
            buttonRegistered = false;
        }
    };

    // Tampermonkey không đảm bảo thứ tự nạp giữa các userscript, nên chờ thư viện dùng chung
    // sẵn sàng (poll) rồi mới bắt đầu theo dõi URL / đăng ký nút nổi. Trước khi await resolve,
    // KHÔNG đoạn nào chạm tới `utils`.
    (async () => {
        try {
            utils = await waitForFinplanUtils();
        } catch (err) {
            console.error('[Approve All Items (CFO)]', err.message);
            return;
        }
        // Kiểm tra URL mỗi 2 giây (SPA Safe Polling).
        setInterval(checkUrl, 2000);
        checkUrl();
    })();

})();
