// ==UserScript==
// @name         Mark All as Paid and Clean Quotes - Finplan
// @namespace    http://tampermonkey.net/
// @version      3.3
// @description  Sửa lỗi treo trang, tối ưu bộ nhớ cho SPA
// @author       Gemini AI
// @match        https://finplan.saigontechnology.vn/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /**
     * ============================================================================
     * MARK ALL AS PAID & CLEAN QUOTES
     * ============================================================================
     * File này gộp 2 tính năng độc lập, không liên quan nhau về mặt UI:
     *
     *   A) MARK ALL AS PAID: tự động tìm và lần lượt bấm nút "Paid" (hoặc "Cash Advanced"
     *      nếu dòng có tag "Tạm ứng") của mọi Payment Item đang hiển thị, kèm xác nhận modal,
     *      giúp xử lý hàng loạt mà không cần click thủ công từng dòng. Kiến trúc giống hệt
     *      Approve_All_Items.user.js / Approve_All_POs.user.js, chia làm 3 khối:
     *        1) TIẾN TRÌNH XỬ LÝ (findNextTarget / processSingleItem / startProcessing).
     *        2) NÚT NỔI - đăng ký qua Floating Button Manager dùng chung (unsafeWindow.FinplanUtils,
     *           nạp bởi Finplan_Shared_Library.user.js) - chỉ dùng để khởi chạy/mở lại dialog.
     *        3) FLOATING DIALOG TIẾN TRÌNH (renderDialog và các hàm build*) - bảng trạng thái
     *           từng item kèm nút Dừng lại / Ẩn cửa sổ / Đóng.
     *
     *   B) CLEAN QUOTES: 1 nút nhỏ chèn cạnh ô tìm kiếm để xoá dấu `"` thừa (thường gặp khi
     *      copy-paste mã Payment Item từ Excel/nguồn khác) rồi tự động kích hoạt lại search.
     *      Đây KHÔNG phải nút nổi góc dưới trái nên KHÔNG dùng Button Manager - giữ nguyên
     *      cách tự chèn DOM cạnh ô input như bản gốc.
     * ============================================================================
     */

    /* =========================================================================
     *  CẤU HÌNH
     * ========================================================================= */
    let utils = null; // Gán 1 lần trong bootstrap async ở cuối file (sau khi waitForFinplanUtils() resolve).
    const PAID_BUTTON_LABEL = 'Paid';
    const ADVANCE_BUTTON_LABEL = 'Cash Advanced';
    const ADVANCE_TAG = 'Tạm ứng';
    const MODAL_CONFIRM_SELECTOR = '.modal-footer .btn-primary, .button_dialog .btn-primary, .modal-content .btn-primary';
    // Chỉ hiển thị nút nổi + chạy tiến trình trên đúng các trang danh sách Payment Item này.
    const ALLOWED_URLS = [
        'https://finplan.saigontechnology.vn/purchase-orders/payment-items?status=0',
        'https://finplan.saigontechnology.vn/purchase-orders/payment-items'
    ];
    // Id cố định dùng để đăng ký/huỷ đăng ký nút nổi với Floating Button Manager dùng chung.
    const BUTTON_ID = 'mark-all-as-paid-cfo';
    // Key localStorage lưu vị trí (left/top) dialog sau khi user kéo, để dialog không "nhảy"
    // về vị trí mặc định mỗi lần render lại (mỗi khi có item mới được xử lý).
    const DIALOG_POSITION_KEY = 'map_dialog_position_v1';

    /* =========================================================================
     *  STATE
     * ========================================================================= */
    let isRunning = false;         // Đang có 1 lượt xử lý (startProcessing) chạy hay không.
    let buttonRegistered = false;  // Nút nổi "Mark All as Paid" đã đăng ký với Button Manager chưa.
    let cleanQuotesBtn = null;     // Nút "Xóa "" cạnh ô tìm kiếm (tính năng B, không qua Button Manager).

    /**
     * Danh sách item đã/đang xử lý trong LƯỢT CHẠY HIỆN TẠI (reset về [] mỗi khi bấm nút nổi
     * để bắt đầu lượt mới). Thay cho 2 mảng `paidItems`/`advancedItems` tách rời ở bản cũ - gộp
     * chung 1 danh sách để vừa loại trừ khi tìm item tiếp theo, vừa hiển thị bảng trong dialog.
     * Mỗi entry: { itemNumber: string, kind: 'paid'|'advance', status: 'processing'|'success'|'error', message: string }
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
     *  TIẾN TRÌNH XỬ LÝ (Mark All as Paid)
     * ========================================================================= */

    /**
     * Quét toàn trang, trả về nút "Paid" đầu tiên đang hiển thị (offsetParent !== null) mà
     * item tương ứng CHƯA có mặt trong `itemLog` (tức chưa được xử lý ở lượt chạy này).
     * Nếu dòng đó có tag "Tạm ứng" (ADVANCE_TAG), mục tiêu thực sự cần click là nút
     * "Cash Advanced" trong cùng dòng thay vì nút "Paid".
     *
     * @returns {{ targetBtn: HTMLElement|null, itemNumber: string, kind: 'paid'|'advance' } | null}
     */
    function findNextTarget() {
        const allButtons = document.querySelectorAll('button, a, .btn');
        for (const btn of allButtons) {
            if (btn.innerText?.trim() !== PAID_BUTTON_LABEL || btn.offsetParent === null) continue;

            const itemNumber = utils.findElementInSameRow(btn, '.cell-body-part .text-bold')?.textContent.trim();
            if (!itemNumber || itemLog.some((entry) => entry.itemNumber === itemNumber)) continue;

            const advanceTag = utils.findElementInSameRow(btn, 'div.lbl-tag__segment', (div) => div.innerText.includes(ADVANCE_TAG));
            if (advanceTag) {
                const advanceBtn = utils.findElementInSameRow(
                    btn, 'button, a, .btn',
                    (el) => el.innerText?.trim() === ADVANCE_BUTTON_LABEL && el.offsetParent !== null
                );
                return { targetBtn: advanceBtn, itemNumber, kind: 'advance' };
            }

            return { targetBtn: btn, itemNumber, kind: 'paid' };
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
     * Thực hiện thao tác xử lý cho 1 item: cuộn tới nút mục tiêu (Paid hoặc Cash Advanced tuỳ
     * `target.kind`), click, chờ + click nút xác nhận trên modal, rồi chờ dòng cũ biến mất khỏi
     * giao diện (tránh click trùng ở vòng lặp kế tiếp). `entry.status` được cập nhật ngay khi
     * có kết quả (success/error) và dialog được render lại sau mỗi bước quan trọng để bảng
     * trạng thái phản ánh đúng thời gian thực.
     *
     * Nếu user bấm "Dừng lại" (isRunning chuyển false) ngay giữa lúc đang xử lý, hàm dừng
     * ngay lập tức và đánh dấu item là lỗi "đã dừng theo yêu cầu" thay vì báo nhầm thành success.
     *
     * @param {{ targetBtn: HTMLElement|null, itemNumber: string, kind: 'paid'|'advance' }} target
     * @param {{ itemNumber: string, kind: string, status: string, message: string }} entry - Entry
     *        tương ứng trong `itemLog`, được cập nhật trực tiếp (theo reference).
     * @returns {Promise<void>}
     */
    async function processSingleItem(target, entry) {
        const { targetBtn, itemNumber } = target;
        try {
            // Cuộn tới mục tiêu (targetBtn có thể null nếu không tìm thấy nút Cash Advanced
            // tương ứng - trường hợp này sẽ ném lỗi ngay dưới đây và được ghi nhận vào entry).
            targetBtn.scrollIntoView({ behavior: 'auto', block: 'center' });

            if (!isRunning) return markStopped(entry);

            // Click "Paid" hoặc "Cash Advanced" tuỳ loại item.
            utils.simulateClick(targetBtn);

            // Nghỉ một chút để trang web bind event handler mới cho confirm dialog.
            await utils.sleep(500);
            const confirmBtn = await utils.waitForElement([MODAL_CONFIRM_SELECTOR]);

            if (!isRunning) return markStopped(entry);

            if (confirmBtn) {
                utils.simulateClick(confirmBtn);
                await utils.waitForElementsRemoved([targetBtn, confirmBtn]);
            }

            entry.status = 'success';
            renderDialog();

            // Nghỉ thêm giữa các dòng để tránh làm treo trình duyệt.
            await utils.sleep(500);
        } catch (err) {
            console.error('Lỗi thực thi:', err);
            entry.status = 'error';
            entry.message = err.message;
            renderDialog();
            await utils.sleep(1000);
        }
    }

    /**
     * Vòng lặp chính của 1 lượt chạy: liên tục tìm item tiếp theo (findNextTarget) và xử lý
     * (processSingleItem) cho tới khi hết item hoặc user bấm Dừng lại (isRunning = false).
     * Mỗi item được push vào `itemLog` NGAY khi tìm thấy (trước khi xử lý) để không bao giờ bị
     * chọn lại ở vòng lặp kế tiếp, kể cả khi bước xử lý bên dưới thất bại.
     */
    async function startProcessing() {
        console.log('🚀 Bắt đầu xử lý items...');

        while (isRunning) {
            const target = findNextTarget();

            if (!target) {
                console.log('🏁 Hoàn tất danh sách.');
                isRunning = false;
                renderDialog();
                break;
            }

            const entry = { itemNumber: target.itemNumber, kind: target.kind, status: 'processing', message: '' };
            itemLog.push(entry);
            renderDialog();

            await processSingleItem(target, entry);
        }

        isRunning = false;
        renderDialog();
    }

    /* =========================================================================
     *  NÚT NỔI "MARK ALL AS PAID" (Floating Button Manager dùng chung)
     *  Chỉ đóng vai trò khởi chạy lượt xử lý mới / mở lại dialog tiến trình đang ẩn.
     *  Việc dừng tiến trình và xem kết quả từng item thuộc về floating dialog bên dưới.
     * ========================================================================= */

    /** Đăng ký nút nổi với Button Manager dùng chung (idempotent - gọi lại sẽ update nếu đã tồn tại). */
    function registerLauncherButton() {
        utils.registerButton(BUTTON_ID, {
            icon: '⚡',
            text: 'Mark All as Paid',
            tooltip: 'Bấm để bắt đầu xử lý tự động. Nếu đang chạy, bấm lại để mở cửa sổ tiến trình.',
            onClick: onLauncherClick,
            order: 0
        });
        buttonRegistered = true;
    }

    /**
     * Handler khi user bấm nút nổi.
     * - Nếu đang chạy dở: KHÔNG bắt đầu lượt mới (tránh chạy song song nhiều vòng lặp cùng
     *   lúc tranh nhau 1 nút Paid/Cash Advanced) - chỉ mở lại dialog nếu nó đang bị ẩn.
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
     *  FLOATING DIALOG TIẾN TRÌNH (phỏng theo Approve_All_Items.user.js / Approve_All_POs.user.js)
     * ========================================================================= */

    /** Chèn CSS cho dialog vào <head>, chỉ chèn 1 lần (idempotent). */
    function injectStyles() {
        if (document.getElementById('map-style')) return;
        const style = document.createElement('style');
        style.id = 'map-style';
        style.textContent = `
            .map-modal {
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
            .map-modal--dragging { user-select: none; }
            .map-modal__header {
                padding: 14px 18px;
                border-bottom: 1px solid #ebedf2;
                display: flex; align-items: center; justify-content: space-between;
                cursor: move;
            }
            .map-modal__header h3 { margin: 0; font-size: 16px; }
            .map-modal__close { cursor: pointer; border: none; background: none; font-size: 18px; color: #888; }
            .map-modal__body { padding: 18px; overflow-y: auto; flex: 1; min-height: 0; }
            .map-modal__footer {
                padding: 12px 18px; border-top: 1px solid #ebedf2;
                display: flex; justify-content: flex-end; gap: 8px;
            }
            .map-btn {
                border: none; border-radius: 4px; padding: 8px 16px;
                font-size: 13px; font-weight: 600; cursor: pointer;
            }
            .map-btn--primary { background: #28a745; color: #fff; }
            .map-btn--primary:hover { background: #218838; }
            .map-btn--default { background: #ebedf2; color: #333; }
            .map-btn--danger { background: #dc3545; color: #fff; }
            .map-btn--danger:hover { background: #c82333; }
            .map-log {
                margin-top: 4px; max-height: 340px; overflow: auto;
                overscroll-behavior: contain;
                border: 1px solid #ebedf2; border-radius: 4px;
            }
            .map-table { width: 100%; border-collapse: collapse; font-size: 13px; }
            .map-table th, .map-table td { border-bottom: 1px solid #ebedf2; padding: 6px 8px; text-align: left; vertical-align: top; }
            .map-table thead th {
                position: sticky; top: 0; z-index: 1;
                background: #fff; box-shadow: inset 0 -1px 0 #ebedf2;
            }
            .map-status { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 12px; white-space: nowrap; }
            .map-status--processing { background: rgba(42,130,254,.15); color: #2a82fe; }
            .map-status--success { background: rgba(51,153,51,.15); color: #393; }
            .map-status--error { background: rgba(228,63,63,.2); color: #e43f3f; }
            .map-summary { font-size: 13px; margin-bottom: 10px; color: #333; }
            .map-error-msg { font-size: 11px; color: #666; margin-top: 4px; line-height: 1.4; }
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
        if (e.target.closest('.map-modal__close')) return;
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
        dialogRoot.classList.add('map-modal--dragging');
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
            dialogRoot.classList.remove('map-modal--dragging');
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

    /** Ánh xạ `kind` nội bộ sang nhãn hiển thị ở cột "Loại". */
    function kindLabel(kind) {
        return kind === 'advance' ? 'Cash Advanced' : 'Paid';
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
        header.className = 'map-modal__header';
        header.addEventListener('mousedown', onHeaderMouseDown);

        const title = document.createElement('h3');
        title.textContent = 'Mark All as Paid';
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'map-modal__close';
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
        summary.className = 'map-summary';
        summary.textContent = getSummaryText(doneCount);
        return summary;
    }

    /** Dựng 1 dòng của bảng trạng thái ứng với 1 entry trong `itemLog`. */
    function buildTableRow(entry) {
        const tr = document.createElement('tr');

        const tdId = document.createElement('td');
        tdId.textContent = entry.itemNumber;
        tr.appendChild(tdId);

        const tdKind = document.createElement('td');
        tdKind.textContent = kindLabel(entry.kind);
        tr.appendChild(tdKind);

        const tdStatus = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = `map-status map-status--${entry.status}`;
        badge.textContent = statusLabel(entry.status);
        tdStatus.appendChild(badge);
        if (entry.status === 'error' && entry.message) {
            const msg = document.createElement('div');
            msg.className = 'map-error-msg';
            msg.textContent = entry.message;
            tdStatus.appendChild(msg);
        }
        tr.appendChild(tdStatus);

        return tr;
    }

    /** Dựng bảng chi tiết trạng thái từng item, theo đúng thứ tự đã xử lý trong `itemLog`. */
    function buildTable() {
        const table = document.createElement('table');
        table.className = 'map-table';
        table.innerHTML = '<thead><tr><th>Item</th><th>Loại</th><th>Trạng thái</th></tr></thead>';

        const tbody = document.createElement('tbody');
        itemLog.forEach((entry) => tbody.appendChild(buildTableRow(entry)));
        table.appendChild(tbody);

        return table;
    }

    /** Dựng phần body: dòng tóm tắt + bảng chi tiết từng item (bảng có vùng cuộn riêng). */
    function buildBody() {
        const body = document.createElement('div');
        body.className = 'map-modal__body';
        body.appendChild(buildSummary());

        const logWrap = document.createElement('div');
        logWrap.className = 'map-log';
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
        btn.className = `map-btn ${variantClass}`;
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
        footer.className = 'map-modal__footer';

        if (isRunning) {
            footer.appendChild(buildButton('Dừng lại', 'map-btn--danger', onStopButtonClick));
            footer.appendChild(buildButton('Ẩn cửa sổ (vẫn tiếp tục chạy)', 'map-btn--default', hideDialog));
        } else {
            footer.appendChild(buildButton('Đóng', 'map-btn--default', hideDialog));
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
        modal.className = 'map-modal';
        applySavedPosition(modal);

        modal.appendChild(buildHeader());
        modal.appendChild(buildBody());
        modal.appendChild(buildFooter());

        document.body.appendChild(modal);
        dialogRoot = modal;

        // Modal đã vào DOM -> cuộn bảng log xuống dòng mới nhất để người dùng theo dõi item đang
        // xử lý. Bỏ qua nếu user đang cuộn lên đọc log cũ.
        const logEl = modal.querySelector('.map-log');
        if (logEl && progressStickToBottom) {
            logEl.scrollTop = logEl.scrollHeight;
        }
    }

    /* =========================================================================
     *  CLEAN QUOTES (tính năng độc lập - không dùng Button Manager)
     *  Nút nhỏ chèn cạnh ô tìm kiếm để xoá dấu " thừa (thường gặp khi copy-paste mã Payment
     *  Item từ Excel/nguồn khác), rồi tự động kích hoạt lại search trên trang.
     * ========================================================================= */

    /**
     * Xoá dấu `"` khỏi giá trị ô input rồi bắn lại các sự kiện cần thiết để framework của
     * trang (Angular) nhận biết giá trị đã đổi và tự chạy lại search.
     * @param {HTMLInputElement} inputField
     */
    function cleanQuotesInput(inputField) {
        if (!inputField) return;

        const originalValue = inputField.value;
        const cleanedValue = originalValue.replace(/"/g, '');

        // Chỉ xử lý nếu dữ liệu thực sự có thay đổi.
        if (originalValue === cleanedValue) return;

        inputField.value = cleanedValue;

        // 1. Kích hoạt sự kiện 'input' (quan trọng nhất cho Angular/Vue/React).
        inputField.dispatchEvent(new Event('input', { bubbles: true }));

        // 2. Kích hoạt sự kiện 'change'.
        inputField.dispatchEvent(new Event('change', { bubbles: true }));

        // 3. Mô phỏng phím bấm (keyup) để đảm bảo các hàm search gắn với phím được gọi.
        inputField.dispatchEvent(new KeyboardEvent('keyup', {
            bubbles: true,
            cancelable: true,
            key: 'Enter', // Hoặc một phím bất kỳ để trigger listener.
        }));

        // Focus lại vào ô input để người dùng có thể gõ tiếp.
        inputField.focus();
    }

    /** Tạo và chèn nút "Xóa "" ngay cạnh ô tìm kiếm của trang (idempotent, không gắn trùng). */
    function createCleanQuotesBtn() {
        // Tìm container chứa input dựa trên class đặc trưng của trang.
        const container = document.querySelector('.form-group.m-form__group.m-search');
        if (!container || container.querySelector('.btn-clean-quotes')) return;

        const input = container.querySelector('input');

        cleanQuotesBtn = document.createElement('button');
        cleanQuotesBtn.innerHTML = 'Xóa "';
        cleanQuotesBtn.className = 'btn-clean-quotes';
        cleanQuotesBtn.type = 'button';

        // Style cơ bản để nút trông gọn gàng.
        Object.assign(cleanQuotesBtn.style, {
            marginLeft: '5px',
            padding: '2px 8px',
            cursor: 'pointer',
            fontSize: '12px',
            borderRadius: '4px',
            border: '1px solid #ccc',
            backgroundColor: '#f8f9fa'
        });

        cleanQuotesBtn.addEventListener('click', (e) => {
            e.preventDefault();
            cleanQuotesInput(input);
        });

        container.appendChild(cleanQuotesBtn);
    }

    /* =========================================================================
     *  SPA URL WATCHER / KHỞI TẠO
     *  Trang là SPA (Angular) nên không có sự kiện load lại khi chuyển route - phải polling
     *  URL định kỳ để biết lúc nào cần đăng ký/huỷ đăng ký nút nổi + chèn nút Clean Quotes.
     * ========================================================================= */

    /**
     * Kiểm tra URL hiện tại có thuộc `ALLOWED_URLS` hay không, rồi đồng bộ trạng thái của cả
     * 2 tính năng: nút nổi "Mark All as Paid" (qua Button Manager) và nút "Xóa "" (tự quản lý DOM).
     */
    const checkUrl = () => {
        const currentUrl = window.location.href.split('#')[0];
        const isAllowed = ALLOWED_URLS.includes(currentUrl);

        if (isAllowed && !buttonRegistered) {
            registerLauncherButton();
        } else if (!isAllowed && buttonRegistered) {
            isRunning = false; // Dừng tiến trình nếu chuyển sang trang khác.
            hideDialog();
            utils.unregisterButton(BUTTON_ID);
            buttonRegistered = false;
        }

        if (isAllowed && !cleanQuotesBtn) {
            createCleanQuotesBtn();
        } else if (!isAllowed && cleanQuotesBtn) {
            cleanQuotesBtn.remove();
            cleanQuotesBtn = null;
        }
    };

    // Tampermonkey không đảm bảo thứ tự nạp giữa các userscript, nên chờ thư viện dùng chung
    // sẵn sàng (poll) rồi mới bắt đầu theo dõi URL / đăng ký nút nổi. Trước khi await resolve,
    // KHÔNG đoạn nào chạm tới `utils`.
    (async () => {
        try {
            utils = await waitForFinplanUtils();
        } catch (err) {
            console.error('[Mark All as Paid]', err.message);
            return;
        }
        // Kiểm tra URL mỗi 2 giây (thay vì dùng MutationObserver gây treo).
        setInterval(checkUrl, 2000);
        checkUrl();
    })();

})();
