// ==UserScript==
// @name         Mark Items Completed
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Tự động bấm Paid / Post Check Done hàng loạt cho danh sách Payment Item; có tuỳ chọn chỉ áp dụng cho item đang có tag "Ready for Auto Charge" (kèm đổi tag sang "Ready for Auto Charge ► Checked") hoặc áp dụng cho mọi item bất kể tag.
// @author       Gemini AI
// @match        https://finplan.saigontechnology.vn/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================================
     *  CONFIG
     *  - BASE_URL: gốc URL của hệ thống Finplan, dùng để build link tới từng Payment Item.
     *  - JOB_STORAGE_KEY: key localStorage lưu trạng thái job đang chạy (danh sách id,
     *    vị trí đang xử lý, log kết quả từng item). Nhờ lưu ở localStorage nên job có thể
     *    "sống sót" qua nhiều lần trang reload (khi script tự chuyển sang item kế tiếp).
     *  - MODAL_POSITION_KEY: key localStorage lưu vị trí (left/top) hộp thoại sau khi user
     *    kéo, để hộp thoại không bị "nhảy" về vị trí mặc định mỗi lần trang tự tải lại.
     *  - TAG_SOURCE / TAG_TARGET: tên chính xác (đã chuẩn hoá khoảng trắng) của 2 tag cần
     *    thao tác. Phải khớp tuyệt đối với text hiển thị trong dropdown Tags trên form.
     * ========================================================================= */
    const BASE_URL = 'https://finplan.saigontechnology.vn';
    const JOB_STORAGE_KEY = 'fpmp_autocharge_job_v1';
    const MODAL_POSITION_KEY = 'fpmp_modal_position_v1';
    const TAG_SOURCE = 'Ready for Auto Charge';
    const TAG_TARGET = 'Ready for Auto Charge ► Checked';

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

    // Đối tượng thư viện dùng chung; gán 1 lần trong init() sau khi waitForFinplanUtils() resolve.
    let utils = null;

    /* =========================================================================
     *  Job state (localStorage) - dùng để "sống sót" qua các lần reload trang
     *  { ids: string[], index: number, stopped: boolean, createdAt: number,
     *    autoChargeOnly: boolean,  // giá trị checkbox "Auto-Charge Item only" lúc bấm "Bắt đầu".
     *      true (mặc định)  = giữ nguyên hành vi gốc: item không có tag TAG_SOURCE (hoặc giai đoạn
     *                         1 lỗi) thì giai đoạn 2 (Paid) và 3 (Post Check Done) bị skip theo.
     *      false            = giai đoạn 2, 3 LUÔN được chạy cho mọi item, bất kể item có tag
     *                         TAG_SOURCE hay không, và bất kể giai đoạn 1 skip/lỗi hay thành công.
     *    log: [{
     *      id: string,
     *      status: 'pending'|'processing'|'success'|'skipped'|'error',  // trạng thái tổng của item
     *      stages: {
     *        tag:       { status: 'pending'|'skipped'|'success'|'error', message: string },
     *        paid:      { status: 'pending'|'skipped'|'success'|'error', message: string },
     *        postCheck: { status: 'pending'|'skipped'|'success'|'error', message: string },
     *      }
     *    }] }
     *  Mỗi item có 3 giai đoạn xử lý độc lập (tag & save, paid, post check done), mỗi giai đoạn
     *  được ghi kết quả riêng trong `stages`. `status` ở cấp item là tổng hợp: 'error' nếu có ít
     *  nhất 1 giai đoạn lỗi, 'skipped' nếu giai đoạn 1 (tag) bị bỏ qua, còn lại là 'success'.
     * ========================================================================= */

    /** Đọc job đang lưu trong localStorage (nếu có). Trả về null nếu không có/parse lỗi. */
    function loadJob() {
        try {
            const raw = localStorage.getItem(JOB_STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Ghi đè toàn bộ job hiện tại vào localStorage.
     *
     * `stopped` (và `stopMode`) được xử lý như cờ MỘT CHIỀU: vòng xử lý item đang chạy giữ một
     * tham chiếu `job` cũ trong bộ nhớ và gọi saveJob() nhiều lần; nếu trong lúc đó người dùng
     * bấm "Dừng lại" (handler đọc job qua loadJob() KHÁC, set stopped=true rồi lưu), các lần
     * saveJob() sau của vòng xử lý sẽ ghi đè stopped về false và job không bao giờ dừng. Vì vậy
     * trước khi ghi, đọc lại bản trong localStorage: nếu bản đó đã stopped thì ép job.stopped =
     * true (và giữ luôn stopMode). Cờ chỉ được gỡ khi clearJob() (bắt đầu job mới).
     */
    function saveJob(job) {
        try {
            const raw = localStorage.getItem(JOB_STORAGE_KEY);
            if (raw) {
                const prev = JSON.parse(raw);
                if (prev && prev.stopped) {
                    job.stopped = true;
                    if (prev.stopMode) job.stopMode = prev.stopMode;
                }
            }
        } catch (e) {
            // Bỏ qua lỗi đọc/parse - vẫn ghi bản job mới bên dưới.
        }
        localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(job));
    }

    /** Xoá job khỏi localStorage (dùng khi user đóng job đã hoàn tất hoặc bắt đầu job mới). */
    function clearJob() {
        localStorage.removeItem(JOB_STORAGE_KEY);
    }

    /**
     * Kiểm tra job đã kết thúc hay chưa: hết danh sách id để xử lý, hoặc user đã bấm "Dừng lại".
     * Job null cũng được coi là "đã kết thúc" để các nơi gọi hàm này không cần check null riêng.
     */
    function isJobFinished(job) {
        return !job || job.index >= job.ids.length || job.stopped;
    }

    /* =========================================================================
     *  Helpers
     * ========================================================================= */

    /**
     * Parse chuỗi free-text người dùng nhập thành danh sách payment item id (chuỗi số, không trùng).
     * - Loại bỏ ký tự " thừa trước khi tách.
     * - Nhận diện các cụm dạng #<số> (cho phép có khoảng trắng giữa # và số).
     * - Giữ nguyên thứ tự xuất hiện đầu tiên, loại bỏ id trùng lặp.
     * Ví dụ: `#1234 #2345 "#4746 #789"` => ['1234', '2345', '4746', '789']
     */
    function parseIds(rawText) {
        const cleaned = (rawText || '').replace(/"/g, '');
        const matches = cleaned.match(/#\s*(\d+)/g) || [];
        const ids = [];
        const seen = new Set();
        matches.forEach((m) => {
            const id = m.replace(/[^\d]/g, '');
            if (id && !seen.has(id)) {
                seen.add(id);
                ids.push(id);
            }
        });
        return ids;
    }

    /** Build URL trang edit của 1 payment item từ id. */
    function getExpectedUrl(id) {
        return `${BASE_URL}/purchase-orders/payment-items/${id}`;
    }

    /** Lấy payment item id từ URL hiện tại (null nếu trang hiện tại không phải trang edit item). */
    function getCurrentItemIdFromUrl() {
        const m = location.pathname.match(/\/purchase-orders\/payment-items\/(\d+)/);
        return m ? m[1] : null;
    }

    /** Chuẩn hoá text: gộp mọi khoảng trắng/xuống dòng liên tiếp thành 1 space rồi trim 2 đầu. */
    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    /* =========================================================================
     *  Xử lý DOM của form Payment Item / Tags dropdown
     * ========================================================================= */

    /** Lấy element gốc (.sts-dropdown) của dropdown Tags trên form (không phải dropdown Owner). */
    function getTagsDropdownRoot() {
        return document.querySelector('app-sts-dropdown-list[placeholder="Select Tags"] .sts-dropdown');
    }

    /**
     * Đọc danh sách tên tag đang được chọn, thông qua phần tóm tắt `.sts-dropdown__selected-items`
     * (phần chip hiển thị ngay cả khi dropdown đang đóng) - không cần mở dropdown để đọc.
     * Dùng để quyết định nhanh: item này có cần xử lý hay không, trước khi tốn công mở dropdown.
     */
    function getSelectedTagTexts(dropdownRoot) {
        const container = dropdownRoot.querySelector('.sts-dropdown__selected-items');
        if (!container) return [];
        return Array.from(container.querySelectorAll('span'))
            .map((el) => normalizeText(el.textContent).replace(/,$/, '').trim())
            .filter(Boolean);
    }

    /**
     * Bật/tắt trạng thái chọn của 1 tag bằng cách click trực tiếp vào checkbox trong danh sách
     * đầy đủ `.select-list li` (chỉ tồn tại khi dropdown đang MỞ). Đây là cách thao tác đáng tin
     * cậy nhất: gọi `checkbox.click()` (thông qua utils.simulateClick) sẽ dùng đúng cơ chế
     * toggle mặc định của trình duyệt cho input[type=checkbox], thay vì bấm vào icon "x" ở khu vực
     * tóm tắt (cách này từng bị phát hiện không đáng tin cậy trong thực tế).
     *
     * @param {Element} dropdownRoot - element .sts-dropdown (dropdown Tags đang mở)
     * @param {string} exactText - tên tag cần khớp chính xác (đã normalize)
     * @param {boolean} desiredChecked - trạng thái checked mong muốn sau khi gọi hàm
     * @returns {boolean} true nếu tìm thấy tag trong danh sách (bất kể có cần click hay không)
     */
    function setTagChecked(dropdownRoot, exactText, desiredChecked) {
        const items = dropdownRoot.querySelectorAll('.content .select-list li label');
        for (const label of items) {
            const text = normalizeText(label.textContent);
            if (text === exactText) {
                const checkbox = label.querySelector('input[type="checkbox"]');
                if (checkbox) {
                    // Chỉ click khi trạng thái hiện tại khác mong muốn, tránh click nhầm làm toggle ngược lại.
                    if (checkbox.checked !== desiredChecked) {
                        utils.simulateClick(checkbox);
                    }
                    return true;
                }
            }
        }
        return false;
    }

    /** Tìm nút "Save" (không phải "Save & Close") trong form payment item, dựa theo text hiển thị. */
    function findSaveButton() {
        const buttons = document.querySelectorAll('app-payment-item-form button.btn.btn-primary');
        for (const btn of buttons) {
            if (normalizeText(btn.textContent) === 'Save') return btn;
        }
        return null;
    }

    /**
     * Tìm 1 nút bấm trong 1 hộp thoại xác nhận, so khớp CHÍNH XÁC text hiển thị (đã trim).
     * Hệ thống dùng NHIỀU component modal khác nhau cho từng loại xác nhận khác nhau, ví dụ:
     *   - `app-sts-confirm-modal` (hộp thoại "Update Confirm" sau khi bấm Save) - nút "Yes".
     *   - `app-change-status-payment-modal` (hộp thoại "Change Status To Paid" sau khi bấm nút
     *     "Paid") - nút "Confirm".
     * Vì vậy hàm này nhận thêm `rootSelector` để biết tìm trong modal nào, KHÔNG được gộp chung
     * một selector cố định cho mọi loại modal.
     *
     * @param {string} rootSelector - selector của component modal (ví dụ 'app-sts-confirm-modal')
     * @param {string} exactText - text hiển thị cần khớp chính xác trên nút (ví dụ 'Yes', 'Confirm')
     */
    function findConfirmModalButton(rootSelector, exactText) {
        const buttons = document.querySelectorAll(`${rootSelector} button.btn.btn-primary`);
        for (const btn of buttons) {
            if (normalizeText(btn.textContent) === exactText) return btn;
        }
        return null;
    }

    /**
     * Tìm nút "Paid" trên form payment item (xuất hiện ở khu vực trạng thái, phía trên phần Detail,
     * cùng hàng với các nút "Reverse To..."). Nút này CHỈ xuất hiện tuỳ theo trạng thái hiện tại của
     * item, nên hàm này có thể trả về null một cách hợp lệ (không phải lỗi) - nơi gọi phải tự kiểm
     * tra null để quyết định có bấm "Paid" hay không.
     */
    function findPaidButton() {
        const buttons = document.querySelectorAll('app-payment-item-form button.btn.btn-primary.btn-ops');
        for (const btn of buttons) {
            if (normalizeText(btn.textContent) === 'Paid') return btn;
        }
        return null;
    }

    /**
     * Tìm nút "Post Check Done" trên form payment item. Cũng giống nút "Paid", nút này chỉ xuất
     * hiện tuỳ theo trạng thái hiện tại của item nên hàm có thể trả về null hợp lệ (không phải lỗi).
     */
    function findPostCheckDoneButton() {
        const buttons = document.querySelectorAll('app-payment-item-form button.btn.btn-success.btn-ops');
        for (const btn of buttons) {
            if (normalizeText(btn.textContent) === 'Post Check Done') return btn;
        }
        return null;
    }

    /* =========================================================================
     *  Xử lý 1 Payment Item (trang hiện tại)
     * ========================================================================= */

    /**
     * Hàm xử lý chính cho MỘT payment item, chạy trên trang edit của item đó (item đang được
     * job trỏ tới, tức job.ids[job.index]). Quá trình xử lý gồm 3 GIAI ĐOẠN TÁCH BIỆT, mỗi giai
     * đoạn được ghi log kết quả riêng vào `entry.stages.<tên giai đoạn>` với status là một trong
     * `'pending' | 'skipped' | 'success' | 'error'` kèm message cụ thể:
     *
     *   1. `tag`       - Đọc trạng thái tag hiện tại (không cần mở dropdown). Nếu KHÔNG có tag
     *                    "Ready for Auto Charge" -> 'skipped'. Nếu CÓ -> mở dropdown, bỏ chọn
     *                    tag nguồn, chọn tag đích (nếu chưa có), đóng dropdown, bấm Save, xử lý hộp
     *                    thoại "Update Confirm" (nút "Yes"), rồi đọc kết quả từ toast.
     *   2. `paid`      - Tìm nút "Paid" trên form; không thấy -> 'skipped' (hợp lệ, tuỳ trạng thái
     *                    item). Thấy -> bấm, xử lý hộp thoại "Change Status To Paid" (nút "Confirm"),
     *                    đọc kết quả.
     *   3. `postCheck` - Tìm nút "Post Check Done"; không thấy -> 'skipped'. Thấy -> bấm, xử lý hộp
     *                    thoại xác nhận CÙNG LOẠI với bước Paid (`app-change-status-payment-modal`,
     *                    nút "Confirm" - KHÁC với modal "Update Confirm" của bước Save), đọc kết quả.
     *
     * `job.autoChargeOnly` (checkbox "Auto-Charge Item only" lúc bắt đầu job) quyết định giai đoạn
     * 2, 3 có bị GATE theo kết quả giai đoạn 1 hay không:
     *   - `true` (mặc định) - nguyên tắc "chuỗi domino": nếu item không có tag nguồn, hoặc giai
     *     đoạn 1 kết thúc 'error', thì giai đoạn 2 và 3 bị đánh dấu 'skipped' theo, KHÔNG chạy, và
     *     hàm return sớm (không tìm nút Paid / Post Check Done).
     *   - `false` - giai đoạn 2, 3 LUÔN được chạy tiếp, bất kể item có tag nguồn hay không và bất
     *     kể giai đoạn 1 'skipped'/'error'/'success'. Logic xử lý DOM của giai đoạn 1 khi item CÓ
     *     tag nguồn không đổi - chỉ bỏ phần gate chặn giai đoạn sau.
     *
     * Dù giai đoạn nào lỗi, hàm KHÔNG throw ra ngoài - job vẫn luôn tiếp tục sang item kế tiếp
     * thông qua advanceJob() ở cuối hàm. `entry.status` tổng hợp từ cả 3 `entry.stages` sau khi xử
     * lý xong: 'error' nếu có bất kỳ giai đoạn nào lỗi, 'skipped' nếu CẢ 3 đều skip, còn lại 'success'.
     */
    async function processCurrentItem() {
        const job = loadJob();
        if (!job || isJobFinished(job)) return;

        const id = job.ids[job.index];
        const entry = job.log.find((e) => e.id === id);
        // true (mặc định) = giữ nguyên hành vi gốc: item không có tag nguồn / giai đoạn 1 lỗi thì
        // giai đoạn 2, 3 bị skip theo. false = luôn chạy giai đoạn 2, 3 bất kể giai đoạn 1.
        const requireAutoChargeTag = job.autoChargeOnly !== false;
        entry.status = 'processing';
        saveJob(job);
        renderModal();

        // Helper ghi kết quả 1 giai đoạn (mutate trực tiếp lên entry đang giữ tham chiếu).
        const setStage = (stageKey, status, message) => {
            entry.stages[stageKey] = { status, message: message || '' };
        };
        // Helper lưu job + vẽ lại modal - gọi sau mỗi lần cập nhật đáng kể để UI phản hồi kịp thời.
        const persist = () => {
            saveJob(job);
            renderModal();
        };

        // "Dừng ngay": user đã bấm Dừng lại và chọn chế độ 'now' -> bỏ dở item hiện tại.
        const isStopNow = () => {
            const j = loadJob();
            return !!(j && j.stopped && j.stopMode === 'now');
        };
        // Đánh dấu các giai đoạn chưa chạy là 'skipped' rồi persist. KHÔNG gọi advanceJob ->
        // job.index không tăng, không điều hướng sang item kế (job coi như đã dừng qua isJobFinished).
        const bailStopNow = () => {
            Object.keys(entry.stages).forEach((key) => {
                const st = entry.stages[key];
                if (!st || st.status === 'pending') {
                    entry.stages[key] = { status: 'skipped', message: 'Đã dừng ngay theo yêu cầu, chưa xử lý.' };
                }
            });
            if (!entry.status || entry.status === 'processing') entry.status = 'skipped';
            persist();
        };

        // Người dùng có thể đã bấm "Dừng lại" + "dừng ngay" ngay khi trang này vừa mở.
        if (isStopNow()) { bailStopNow(); return; }

        // ================= GIAI ĐOẠN 1: Tìm, xử lý tag và bấm Save ================= //
        let tagOk = false; // true nếu giai đoạn 1 kết thúc 'success' hoặc 'skipped' (không phải 'error')
        let hasSourceTag = false; // item có tag nguồn hay không (dùng để chọn message ở bước gate bên dưới)
        try {
            // Khoảng nghỉ nhỏ để Angular kịp hoàn tất render ban đầu sau khi trang vừa load.
            await utils.sleep(400);
            if (isStopNow()) { bailStopNow(); return; }

            const dropdownRootSelector = 'app-sts-dropdown-list[placeholder="Select Tags"] .sts-dropdown';
            await utils.waitForElement([dropdownRootSelector], 25000);
            const dropdownRoot = getTagsDropdownRoot();
            if (!dropdownRoot) throw new Error('Không tìm thấy khu vực Tags trên form.');

            // Đọc nhanh trạng thái tag hiện tại từ phần tóm tắt, không cần mở dropdown.
            const selectedTexts = getSelectedTagTexts(dropdownRoot);
            const hasSource = selectedTexts.includes(TAG_SOURCE);
            const hasTargetAlready = selectedTexts.includes(TAG_TARGET);
            hasSourceTag = hasSource;

            if (!hasSource) {
                // Không có tag nguồn -> không có gì để đổi ở giai đoạn 1. Việc này có chặn giai đoạn
                // 2, 3 hay không do khối gate bên dưới (sau try/catch) quyết định dựa trên
                // requireAutoChargeTag, KHÔNG return ở đây để còn rơi xuống giai đoạn 2, 3 khi cần.
                setStage('tag', 'skipped', `Không có tag "${TAG_SOURCE}" nên bỏ qua.`);
                tagOk = true; // Không phải lỗi - chỉ là không áp dụng cho item này.
            } else {
                // Mở dropdown Tags để có thể thao tác trên checkbox bên trong.
                const control = dropdownRoot.querySelector('.control');
                utils.simulateClick(control);
                await utils.waitForElement([`${dropdownRootSelector} .content .selected`], 10000);
                await utils.sleep(250);

                // Bỏ chọn tag nguồn ("Ready for Auto Charge").
                const removed = setTagChecked(dropdownRoot, TAG_SOURCE, false);
                if (!removed) throw new Error(`Không tìm thấy tag "${TAG_SOURCE}" để bỏ chọn (dropdown).`);
                await utils.sleep(300);

                // Chọn tag đích ("Ready for Auto Charge ► Checked"), chỉ khi chưa có sẵn.
                if (!hasTargetAlready) {
                    const checked = setTagChecked(dropdownRoot, TAG_TARGET, true);
                    if (!checked) throw new Error(`Không tìm thấy tag "${TAG_TARGET}" để chọn.`);
                    await utils.sleep(300);
                }

                // Đóng dropdown (bấm lại vào .control để toggle đóng).
                utils.simulateClick(control);
                await utils.sleep(300);

                // Bấm nút Save (không phải Save & Close).
                const saveBtn = findSaveButton();
                if (!saveBtn) throw new Error('Không tìm thấy nút Save.');
                utils.simulateClick(saveBtn);

                // Mỗi lần Save đều hiện hộp thoại xác nhận "Update Confirm" -> chờ nó xuất hiện.
                await utils.waitForElement(['app-sts-confirm-modal'], 15000);

                // Nghỉ ~500ms trước khi bấm nút xác nhận, đảm bảo trang có đủ thời gian bind xong
                // event handler cho các nút trong hộp thoại (tránh trường hợp bấm quá sớm, ngay khi
                // modal vừa hiện ra nhưng Angular chưa kịp gắn (click) handler cho nút "Yes").
                await utils.sleep(500);

                const yesBtn = findConfirmModalButton('app-sts-confirm-modal', 'Yes');
                if (!yesBtn) throw new Error('Không tìm thấy nút "Yes" trong hộp thoại xác nhận.');
                utils.simulateClick(yesBtn);

                // Chờ hộp thoại xác nhận biến mất. Không coi timeout ở đây là lỗi fatal (không throw) vì
                // trên thực tế đã ghi nhận trường hợp modal không được phát hiện là "đã đóng" dù server
                // đã xử lý Save thành công - tín hiệu đáng tin cậy hơn là toast Success/Error bên dưới.
                let confirmModalNote = '';
                await utils.waitForElementToDisappear(['app-sts-confirm-modal'], 15000).catch(() => {
                    confirmModalNote = ' (Lưu ý: hộp thoại xác nhận không phát hiện đã đóng, nhưng vẫn tiếp tục theo dõi kết quả lưu.)';
                });

                // Chờ overlay loading (nếu có) biến mất - không fatal nếu không phát hiện được.
                await utils.waitForLoadingToComplete('.box-loading', 30000).catch(() => {});

                // Đọc kết quả từ toast Success/Error do hệ thống hiển thị sau khi lưu.
                let tagStatus = 'success';
                let tagMessage = 'Đã lưu thành công.';
                try {
                    const respEl = await utils.waitForServerResponse(15000);
                    const isError = respEl.classList.contains('toast-error');
                    const text = normalizeText(respEl.querySelector('.toast-message')?.textContent)
                        || normalizeText(respEl.querySelector('.toast-title')?.textContent);
                    tagMessage = text || tagMessage;
                    if (isError) tagStatus = 'error';
                    await utils.sleep(500);
                } catch (e) {
                    // Không phát hiện được toast trong thời gian chờ - không coi là lỗi, chỉ ghi chú lại.
                    tagMessage = 'Đã bấm Save nhưng không phát hiện thông báo phản hồi (giả định thành công).';
                }

                setStage('tag', tagStatus, tagMessage + confirmModalNote);
                tagOk = tagStatus !== 'error';
            }
        } catch (err) {
            setStage('tag', 'error', (err && err.message) || String(err));
            tagOk = false;
        }
        persist();

        // ================= GATE: giai đoạn 2, 3 có bị chặn theo kết quả giai đoạn 1 hay không ================= //
        // Chỉ áp dụng khi requireAutoChargeTag (checkbox "Auto-Charge Item only" đang được check).
        // Khi không check, giai đoạn 2, 3 LUÔN chạy tiếp bất kể giai đoạn 1 skip/lỗi/thành công.
        if (requireAutoChargeTag && !tagOk) {
            // Tới đây chắc chắn là do LỖI thật (trường hợp !hasSource đã set tagOk = true ở trên).
            setStage('paid', 'skipped', 'Bỏ qua vì giai đoạn 1 (Tag & Save) bị lỗi.');
            setStage('postCheck', 'skipped', 'Bỏ qua vì giai đoạn 1 (Tag & Save) bị lỗi.');
            entry.status = 'error';
            persist();
            advanceJob(job);
            return;
        }
        if (requireAutoChargeTag && !hasSourceTag) {
            // Không có tag nguồn -> không áp dụng cho item này, bỏ qua toàn bộ (hành vi gốc).
            setStage('paid', 'skipped', 'Bỏ qua vì giai đoạn 1 (Tag & Save) đã bỏ qua.');
            setStage('postCheck', 'skipped', 'Bỏ qua vì giai đoạn 1 (Tag & Save) đã bỏ qua.');
            entry.status = 'skipped';
            persist();
            advanceJob(job);
            return;
        }

        if (isStopNow()) { bailStopNow(); return; }

        // ================= GIAI ĐOẠN 2: Tìm và bấm nút Paid ================= //
        let paidOk = true; // true = không lỗi (có thể là 'success' hoặc 'skipped')
        try {
            const paidBtn = findPaidButton();
            if (!paidBtn) {
                // Nút "Paid" không tồn tại tuỳ theo trạng thái hiện tại của item - đây là skip hợp lệ.
                setStage('paid', 'skipped', 'Không tìm thấy nút "Paid" trên form.');
            } else {
                // Selector riêng cho modal xác nhận của bước Paid - đây là MỘT COMPONENT KHÁC với
                // modal "Update Confirm" ở giai đoạn 1 (đã xác nhận qua HTML thực tế: modal này tên
                // "Change Status To Paid", thẻ component là app-change-status-payment-modal).
                const paidModalSelector = 'app-change-status-payment-modal';

                utils.simulateClick(paidBtn);

                // Hộp thoại xác nhận luôn xuất hiện sau khi bấm Paid -> không thấy = lỗi thực sự.
                await utils.waitForElement([paidModalSelector], 15000);

                // Cùng nguyên tắc nghỉ 500ms trước khi bấm nút xác nhận như ở giai đoạn 1.
                await utils.sleep(500);

                const confirmBtn = findConfirmModalButton(paidModalSelector, 'Confirm');
                if (!confirmBtn) throw new Error('Không tìm thấy nút "Confirm" trong hộp thoại xác nhận Paid.');
                utils.simulateClick(confirmBtn);

                // Không coi timeout đóng modal là lỗi fatal, tương tự giai đoạn 1.
                let paidConfirmModalNote = '';
                await utils.waitForElementToDisappear([paidModalSelector], 15000).catch(() => {
                    paidConfirmModalNote = ' (Lưu ý: hộp thoại xác nhận không phát hiện đã đóng, nhưng vẫn tiếp tục theo dõi kết quả.)';
                });

                await utils.waitForLoadingToComplete('.box-loading', 30000).catch(() => {});

                // Chờ toast kết quả của hành động Paid. Nếu toast báo Error -> throw để giai đoạn
                // này (và cả item) bị đánh dấu lỗi, theo đúng yêu cầu nghiệp vụ.
                let paidToastEl = null;
                try {
                    paidToastEl = await utils.waitForServerResponse(15000);
                } catch (e) {
                    paidToastEl = null; // Không phát hiện toast trong timeout - không coi là lỗi.
                }

                let paidMessage;
                if (paidToastEl) {
                    const isError = paidToastEl.classList.contains('toast-error');
                    paidMessage = normalizeText(paidToastEl.querySelector('.toast-message')?.textContent)
                        || normalizeText(paidToastEl.querySelector('.toast-title')?.textContent)
                        || 'Đã bấm Paid & Confirm.';
                    if (isError) {
                        throw new Error(`Bấm Paid thất bại: ${paidMessage}`);
                    }
                    await utils.sleep(500);
                } else {
                    paidMessage = 'Đã bấm Paid & Confirm nhưng không phát hiện thông báo phản hồi (giả định thành công).';
                }

                setStage('paid', 'success', paidMessage + paidConfirmModalNote);
            }
        } catch (err) {
            setStage('paid', 'error', (err && err.message) || String(err));
            paidOk = false;
        }
        persist();

        if (!paidOk) {
            setStage('postCheck', 'skipped', 'Bỏ qua vì giai đoạn 2 (Paid) bị lỗi.');
            entry.status = 'error';
            persist();
            advanceJob(job);
            return;
        }

        if (isStopNow()) { bailStopNow(); return; }

        // ================= GIAI ĐOẠN 3: Tìm và bấm nút Post Check Done ================= //
        try {
            const postCheckBtn = findPostCheckDoneButton();
            if (!postCheckBtn) {
                // Cũng như "Paid", nút này không phải lúc nào cũng có - skip hợp lệ.
                setStage('postCheck', 'skipped', 'Không tìm thấy nút "Post Check Done" trên form.');
            } else {
                utils.simulateClick(postCheckBtn);

                // Theo xác nhận của người dùng: hộp thoại xác nhận của "Post Check Done" GIỐNG hộp
                // thoại của "Paid" (cùng component app-change-status-payment-modal, cùng nút
                // "Confirm") - KHÁC với hộp thoại "Update Confirm" của bước Save (app-sts-confirm-modal,
                // nút "Yes").
                const postCheckModalSelector = 'app-change-status-payment-modal';

                await utils.waitForElement([postCheckModalSelector], 15000);

                // Cùng nguyên tắc nghỉ 500ms trước khi bấm nút xác nhận.
                await utils.sleep(500);

                const confirmBtn = findConfirmModalButton(postCheckModalSelector, 'Confirm');
                if (!confirmBtn) throw new Error('Không tìm thấy nút "Confirm" trong hộp thoại xác nhận Post Check Done.');
                utils.simulateClick(confirmBtn);

                let postCheckModalNote = '';
                await utils.waitForElementToDisappear([postCheckModalSelector], 15000).catch(() => {
                    postCheckModalNote = ' (Lưu ý: hộp thoại xác nhận không phát hiện đã đóng, nhưng vẫn tiếp tục theo dõi kết quả.)';
                });

                await utils.waitForLoadingToComplete('.box-loading', 30000).catch(() => {});

                let postCheckToastEl = null;
                try {
                    postCheckToastEl = await utils.waitForServerResponse(15000);
                } catch (e) {
                    postCheckToastEl = null;
                }

                let postCheckMessage;
                if (postCheckToastEl) {
                    const isError = postCheckToastEl.classList.contains('toast-error');
                    postCheckMessage = normalizeText(postCheckToastEl.querySelector('.toast-message')?.textContent)
                        || normalizeText(postCheckToastEl.querySelector('.toast-title')?.textContent)
                        || 'Đã bấm Post Check Done.';
                    if (isError) {
                        throw new Error(`Bấm Post Check Done thất bại: ${postCheckMessage}`);
                    }
                    await utils.sleep(500);
                } else {
                    postCheckMessage = 'Đã bấm Post Check Done nhưng không phát hiện thông báo phản hồi (giả định thành công).';
                }

                setStage('postCheck', 'success', postCheckMessage + postCheckModalNote);
            }
        } catch (err) {
            setStage('postCheck', 'error', (err && err.message) || String(err));
        }

        // Tổng hợp trạng thái item từ cả 3 giai đoạn: 'error' nếu có bất kỳ giai đoạn nào lỗi,
        // 'skipped' nếu CẢ 3 đều skip (ví dụ: không có tag nguồn + không tìm thấy Paid/Post Check
        // Done khi requireAutoChargeTag = false), còn lại là 'success'.
        const stageStatuses = Object.values(entry.stages).map((s) => s.status);
        entry.status = stageStatuses.includes('error')
            ? 'error'
            : stageStatuses.every((s) => s === 'skipped')
                ? 'skipped'
                : 'success';
        persist();

        advanceJob(job);
    }

    /**
     * Tăng index của job lên 1 (đánh dấu item hiện tại đã xử lý xong) rồi:
     * - Nếu đã hết danh sách hoặc job bị dừng -> render modal ở chế độ tổng kết, không điều hướng.
     * - Nếu còn item tiếp theo -> điều hướng (reload trang thật) sang URL edit của item đó sau
     *   một khoảng nghỉ ngắn, để job tiếp tục được xử lý bởi init() ở lần load trang kế tiếp.
     */
    function advanceJob(job) {
        job.index += 1;
        saveJob(job);
        if (isJobFinished(job)) {
            renderModal();
            return;
        }
        const nextId = job.ids[job.index];
        setTimeout(() => {
            // Chốt lần cuối ngay trước khi điều hướng: user có thể bấm "Dừng lại" trong 700ms này.
            const latest = loadJob();
            if (!latest || latest.stopped || latest.index >= latest.ids.length) {
                renderModal();
                return;
            }
            location.href = getExpectedUrl(nextId);
        }, 700);
    }

    /* =========================================================================
     *  UI: nút nổi + modal
     * ========================================================================= */

    /** Chèn CSS dùng cho modal vào <head>, chỉ chèn 1 lần (idempotent). Nút nổi được đăng ký qua
     *  utils.registerButton nên style của nút do Floating Button Manager trong thư viện
     *  dùng chung tự quản lý, không cần khai báo CSS riêng ở đây nữa. */
    function injectStyles() {
        if (document.getElementById('fpmp-style')) return;
        const style = document.createElement('style');
        style.id = 'fpmp-style';
        style.textContent = `
            /* Hộp thoại nổi (KHÔNG có lớp phủ mờ che nền) - vị trí mặc định giữa phía trên màn hình,
               có thể bị ghi đè bởi style.left/top khi có vị trí đã lưu (xem renderModal). */
            .fpmp-modal {
                position: fixed;
                top: 12vh;
                left: 50%;
                transform: translateX(-50%);
                background: #fff;
                border-radius: 8px;
                width: 820px;
                max-width: 92vw;
                max-height: 80vh;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                font-family: Arial, sans-serif;
                box-shadow: 0 8px 30px rgba(0,0,0,.35);
                z-index: 999999;
            }
            /* Áp dụng trong lúc đang kéo modal, tránh việc bôi đen text khi rê chuột nhanh. */
            .fpmp-modal--dragging { user-select: none; }
            .fpmp-modal__header {
                padding: 14px 18px;
                border-bottom: 1px solid #ebedf2;
                display: flex; align-items: center; justify-content: space-between;
                cursor: move;
            }
            .fpmp-modal__header h3 { margin: 0; font-size: 16px; }
            .fpmp-modal__close { cursor: pointer; border: none; background: none; font-size: 18px; color: #888; }
            .fpmp-modal__body { padding: 18px; overflow-y: auto; flex: 1; }
            .fpmp-modal__footer {
                padding: 12px 18px; border-top: 1px solid #ebedf2;
                display: flex; justify-content: flex-end; gap: 8px;
            }
            .fpmp-textarea {
                width: 100%; min-height: 160px; box-sizing: border-box;
                border: 1px solid #ccc; border-radius: 4px; padding: 8px; font-size: 13px;
            }
            .fpmp-hint { font-size: 12px; color: #888; margin-top: 6px; }
            .fpmp-checkbox-row { display: flex; align-items: flex-start; gap: 8px; margin-top: 14px; }
            .fpmp-checkbox-row input[type="checkbox"] { margin-top: 3px; }
            .fpmp-checkbox-row label { font-size: 13px; color: #333; cursor: pointer; }
            .fpmp-btn {
                border: none; border-radius: 4px; padding: 8px 16px;
                font-size: 13px; font-weight: 600; cursor: pointer;
            }
            .fpmp-btn--primary { background: #636ae8; color: #fff; }
            .fpmp-btn--primary:hover { background: #4f56d4; }
            .fpmp-btn--default { background: #ebedf2; color: #333; }
            .fpmp-btn--danger { background: #e43f3f; color: #fff; }
            .fpmp-preview { font-size: 12px; color: #333; margin-top: 8px; max-height: 90px; overflow-y: auto; }
            .fpmp-stage-msg { font-size: 11px; color: #666; margin-top: 4px; line-height: 1.4; }
            /* Vùng cuộn RIÊNG cho bảng log: trần chiều cao CỐ ĐỊNH để hộp thoại không phình theo số item. */
            .fpmp-log {
                margin-top: 4px; max-height: 340px; overflow: auto;
                overscroll-behavior: contain;
                border: 1px solid #ebedf2; border-radius: 4px;
            }
            .fpmp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
            .fpmp-table th, .fpmp-table td { border-bottom: 1px solid #ebedf2; padding: 6px 8px; text-align: left; vertical-align: top; }
            /* Giữ hàng tiêu đề cột dính khi cuộn danh sách item dài. */
            .fpmp-table thead th {
                position: sticky; top: 0; z-index: 1;
                background: #fff; box-shadow: inset 0 -1px 0 #ebedf2;
            }
            .fpmp-status { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 12px; white-space: nowrap; }
            .fpmp-status--pending { background: rgba(119,119,119,.15); color: #777; }
            .fpmp-status--processing { background: rgba(42,130,254,.15); color: #2a82fe; }
            .fpmp-status--success { background: rgba(51,153,51,.15); color: #393; }
            .fpmp-status--skipped { background: rgba(255,193,7,.2); color: #b98900; }
            .fpmp-status--error { background: rgba(228,63,63,.2); color: #e43f3f; }
            .fpmp-summary { font-size: 13px; margin-bottom: 10px; color: #333; }
        `;
        document.head.appendChild(style);
    }

    /**
     * Xử lý khi user bấm nút nổi (được đăng ký qua utils.registerButton, xem init()):
     * nếu đang có job (dù đang chạy dở hay đã xong) thì mở modal ở chế độ xem tiến trình; nếu
     * chưa có job nào thì mở modal ở chế độ nhập danh sách id mới.
     */
    function onFabClick() {
        const job = loadJob();
        modalMode = job ? 'progress' : 'input';
        renderModal();
    }

    // Tham chiếu tới element modal đang hiển thị trên trang (null nếu modal đang đóng).
    let modalRoot = null;
    // Chế độ hiển thị hiện tại của modal: 'input' (nhập danh sách id) hoặc 'progress' (xem tiến trình).
    let modalMode = 'input';
    // true = tự cuộn bảng log xuống cuối mỗi lần render. Reset về true mỗi lần trang load (module
    // nạp lại) nên sau mỗi lần reload giữa các item, người dùng luôn thấy item mới nhất. Tắt tạm
    // khi user chủ động cuộn lên đọc log cũ, bật lại khi họ cuộn về sát đáy.
    let progressStickToBottom = true;
    // Vị trí modal đã lưu (nếu user từng kéo), đọc 1 lần khi script khởi động.
    let modalPosition = loadModalPosition();

    /** Đọc vị trí modal đã lưu (nếu có) từ localStorage. */
    function loadModalPosition() {
        try {
            const raw = localStorage.getItem(MODAL_POSITION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    /** Lưu vị trí modal (left/top tính theo px so với viewport) vào localStorage. */
    function saveModalPosition(pos) {
        modalPosition = pos;
        try {
            localStorage.setItem(MODAL_POSITION_KEY, JSON.stringify(pos));
        } catch (e) {
            // Bỏ qua nếu không lưu được (ví dụ localStorage đầy) - không ảnh hưởng chức năng chính.
        }
    }

    /* ---- Kéo (drag) hộp thoại bằng vùng header ----
     * Cơ chế: mousedown trên header -> ghi nhận vị trí bắt đầu kéo; mousemove trên toàn document ->
     * tính toán vị trí mới theo độ lệch chuột, có giới hạn (clamp) để modal không bị kéo ra ngoài
     * khung nhìn; mouseup -> kết thúc kéo và lưu vị trí cuối cùng vào localStorage.
     */
    const dragState = { active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 };

    /** Bắt đầu kéo modal khi mousedown trên header (trừ khi bấm đúng vào nút đóng). */
    function onHeaderMouseDown(e) {
        if (e.target.closest('.fpmp-modal__close')) return;
        if (!modalRoot) return;
        const rect = modalRoot.getBoundingClientRect();
        dragState.active = true;
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dragState.startLeft = rect.left;
        dragState.startTop = rect.top;
        // Chuyển từ định vị bằng transform (căn giữa mặc định) sang định vị bằng left/top tuyệt đối,
        // để có thể set trực tiếp toạ độ trong lúc kéo.
        modalRoot.style.left = rect.left + 'px';
        modalRoot.style.top = rect.top + 'px';
        modalRoot.style.transform = 'none';
        modalRoot.classList.add('fpmp-modal--dragging');
        e.preventDefault();
    }

    /** Cập nhật vị trí modal theo vị trí chuột trong lúc đang kéo, giới hạn trong viewport. */
    function onDocumentMouseMove(e) {
        if (!dragState.active || !modalRoot) return;
        const rect = modalRoot.getBoundingClientRect();
        const maxLeft = Math.max(window.innerWidth - rect.width, 0);
        const maxTop = Math.max(window.innerHeight - rect.height, 0);
        let newLeft = dragState.startLeft + (e.clientX - dragState.startX);
        let newTop = dragState.startTop + (e.clientY - dragState.startY);
        newLeft = Math.min(Math.max(newLeft, 0), maxLeft);
        newTop = Math.min(Math.max(newTop, 0), maxTop);
        modalRoot.style.left = newLeft + 'px';
        modalRoot.style.top = newTop + 'px';
    }

    /** Kết thúc kéo modal (mouseup) và lưu lại vị trí cuối cùng. */
    function onDocumentMouseUp() {
        if (!dragState.active) return;
        dragState.active = false;
        if (modalRoot) {
            modalRoot.classList.remove('fpmp-modal--dragging');
            const rect = modalRoot.getBoundingClientRect();
            saveModalPosition({ left: rect.left, top: rect.top });
        }
    }

    // Gắn listener kéo-thả ở cấp document (không phải trên modal) để vẫn nhận được sự kiện mousemove/
    // mouseup ngay cả khi con trỏ chuột di chuyển ra ngoài phạm vi modal trong lúc đang kéo.
    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', onDocumentMouseUp);

    /** Đóng (gỡ khỏi DOM) modal đang hiển thị, nếu có. */
    function closeModal() {
        if (modalRoot) {
            modalRoot.remove();
            modalRoot = null;
        }
    }

    /**
     * Vẽ lại modal từ đầu dựa theo `modalMode` và trạng thái job hiện tại trong localStorage.
     * Được gọi lại mỗi khi cần cập nhật UI (bắt đầu job, sau mỗi bước xử lý item, khi user bấm nút...).
     * Modal là một hộp nổi độc lập (KHÔNG có lớp phủ mờ che toàn trang) để không cản trở việc quan
     * sát/thao tác trên trang bên dưới trong lúc script đang tự động chạy.
     */
    function renderModal() {
        closeModal();

        const job = loadJob();
        const modal = document.createElement('div');
        modal.className = 'fpmp-modal';
        // Áp dụng lại vị trí đã lưu (nếu có) để modal không bị "nhảy" về vị trí mặc định
        // sau mỗi lần trang tự reload giữa các item.
        if (modalPosition) {
            modal.style.left = modalPosition.left + 'px';
            modal.style.top = modalPosition.top + 'px';
            modal.style.transform = 'none';
        }

        // ---- Header: tiêu đề + nút đóng, đồng thời là vùng để kéo modal ----
        const header = document.createElement('div');
        header.className = 'fpmp-modal__header';
        header.addEventListener('mousedown', onHeaderMouseDown);
        const title = document.createElement('h3');
        title.textContent = 'Mark Items Completed';
        header.appendChild(title);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'fpmp-modal__close';
        closeBtn.type = 'button';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', () => {
            const currentJob = loadJob();
            // Nếu job đang chạy dở, xác nhận lại với user trước khi đóng (đóng đồng nghĩa dừng job).
            if (currentJob && !isJobFinished(currentJob)) {
                if (!confirm('Đang xử lý dở danh sách. Dừng lại và đóng?')) return;
                currentJob.stopped = true;
                saveJob(currentJob);
            }
            closeModal();
        });
        header.appendChild(closeBtn);
        modal.appendChild(header);

        // ---- Body + Footer: nội dung tuỳ theo modalMode ----
        const body = document.createElement('div');
        body.className = 'fpmp-modal__body';
        modal.appendChild(body);

        const footer = document.createElement('div');
        footer.className = 'fpmp-modal__footer';
        modal.appendChild(footer);

        if (modalMode === 'input' || !job) {
            renderInputView(body, footer);
        } else {
            renderProgressView(body, footer, job);
        }

        document.body.appendChild(modal);
        modalRoot = modal;

        // Modal đã vào DOM (có layout thật) -> cuộn bảng log xuống item mới nhất để người dùng
        // theo dõi được tiến trình sau mỗi lần trang tự reload. Bỏ qua nếu user đang cuộn lên đọc.
        const logEl = modal.querySelector('.fpmp-log');
        if (logEl && progressStickToBottom) {
            logEl.scrollTop = logEl.scrollHeight;
        }
    }

    /**
     * Vẽ view nhập liệu: textarea free-text để paste danh sách id, preview số lượng id nhận diện
     * được (cập nhật realtime khi gõ), nút "Bắt đầu" để khởi tạo job mới.
     */
    function renderInputView(body, footer) {
        const label = document.createElement('div');
        label.innerHTML = 'Nhập danh sách Payment Item ID, mỗi id dạng <b>#123456</b>, cách nhau bởi khoảng trắng / xuống dòng.';
        body.appendChild(label);

        const textarea = document.createElement('textarea');
        textarea.className = 'fpmp-textarea';
        textarea.placeholder = '#1234 #2345\n"#4746 #789"';
        body.appendChild(textarea);

        const hint = document.createElement('div');
        hint.className = 'fpmp-hint';
        hint.textContent = 'Dấu " thừa sẽ tự động được loại bỏ trước khi xử lý.';
        body.appendChild(hint);

        const preview = document.createElement('div');
        preview.className = 'fpmp-preview';
        body.appendChild(preview);

        // Preview realtime danh sách id nhận diện được, giúp user tự kiểm tra trước khi bấm Bắt đầu.
        textarea.addEventListener('input', () => {
            const ids = parseIds(textarea.value);
            preview.textContent = ids.length
                ? `Đã nhận diện ${ids.length} payment item: ${ids.join(', ')}`
                : '';
        });

        // Checkbox "Auto-Charge Item only" - mặc định CHECK (giữ hành vi gốc: chỉ xử lý item có tag
        // "Ready for Auto Charge"). Bỏ check để công cụ chạy Paid / Post Check Done cho MỌI item
        // trong danh sách, bất kể item đó có tag này hay không.
        const checkboxRow = document.createElement('div');
        checkboxRow.className = 'fpmp-checkbox-row';
        const checkboxId = 'fpmp-auto-charge-only';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = checkboxId;
        checkbox.checked = true;
        const checkboxLabel = document.createElement('label');
        checkboxLabel.htmlFor = checkboxId;
        checkboxLabel.innerHTML = '<b>Auto-Charge Item only</b> — chỉ xử lý item đang có tag '
            + `"${TAG_SOURCE}" (đổi sang "${TAG_TARGET}" trước khi Paid / Post Check Done). `
            + 'Bỏ chọn để vẫn Paid / Post Check Done cho item không có tag này.';
        checkboxRow.appendChild(checkbox);
        checkboxRow.appendChild(checkboxLabel);
        body.appendChild(checkboxRow);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'fpmp-btn fpmp-btn--default';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Đóng';
        cancelBtn.addEventListener('click', closeModal);
        footer.appendChild(cancelBtn);

        const startBtn = document.createElement('button');
        startBtn.className = 'fpmp-btn fpmp-btn--primary';
        startBtn.type = 'button';
        startBtn.textContent = 'Bắt đầu';
        startBtn.addEventListener('click', () => {
            const ids = parseIds(textarea.value);
            if (!ids.length) {
                alert('Không nhận diện được payment item id nào. Vui lòng kiểm tra lại.');
                return;
            }
            startJob(ids, checkbox.checked);
        });
        footer.appendChild(startBtn);
    }

    /**
     * Vẽ view tiến trình: dòng tóm tắt số lượng đã xử lý/kết quả, bảng chi tiết trạng thái từng
     * item, và các nút hành động phù hợp theo trạng thái job (đang chạy: Dừng lại / Ẩn cửa sổ;
     * đã xong: Đóng / Chạy danh sách mới).
     */
    function renderProgressView(body, footer, job) {
        const finished = isJobFinished(job);
        const doneCount = job.log.filter((e) => e.status !== 'pending' && e.status !== 'processing').length;

        const summary = document.createElement('div');
        summary.className = 'fpmp-summary';
        if (finished) {
            const successCount = job.log.filter((e) => e.status === 'success').length;
            const skippedCount = job.log.filter((e) => e.status === 'skipped').length;
            const errorCount = job.log.filter((e) => e.status === 'error').length;
            summary.textContent = job.stopped
                ? `Đã dừng theo yêu cầu. Hoàn tất ${doneCount}/${job.ids.length} item — Thành công: ${successCount}, Bỏ qua: ${skippedCount}, Lỗi: ${errorCount}.`
                : `Hoàn tất ${doneCount}/${job.ids.length} item — Thành công: ${successCount}, Bỏ qua: ${skippedCount}, Lỗi: ${errorCount}.`;
        } else {
            summary.textContent = `Đang xử lý ${doneCount}/${job.ids.length} item... (Trang sẽ tự tải lại giữa các item, vui lòng không đóng tab)`;
        }
        body.appendChild(summary);

        // Bảng chi tiết: mỗi dòng ứng với 1 payment item id, kèm link mở nhanh sang trang edit,
        // và 3 cột riêng cho 3 giai đoạn xử lý (Tag & Save / Paid / Post Check Done), mỗi cột hiển
        // thị badge trạng thái ('Skip'/'Success'/'Lỗi') kèm message cụ thể của giai đoạn đó.
        const table = document.createElement('table');
        table.className = 'fpmp-table';
        table.innerHTML = '<thead><tr>'
            + '<th>Payment Item ID</th>'
            + '<th>1. Tag & Save</th>'
            + '<th>2. Paid</th>'
            + '<th>3. Post Check Done</th>'
            + '</tr></thead>';
        const tbody = document.createElement('tbody');

        // Dựng nội dung 1 cell giai đoạn: badge trạng thái + dòng message nhỏ bên dưới (nếu có).
        const renderStageCell = (td, stage) => {
            const s = stage || { status: 'pending', message: '' };
            const badge = document.createElement('span');
            badge.className = `fpmp-status fpmp-status--${s.status}`;
            badge.textContent = statusLabel(s.status);
            td.appendChild(badge);
            if (s.message) {
                const msg = document.createElement('div');
                msg.className = 'fpmp-stage-msg';
                msg.textContent = s.message;
                td.appendChild(msg);
            }
        };

        job.log.forEach((entry) => {
            const tr = document.createElement('tr');
            const tdId = document.createElement('td');
            tdId.innerHTML = `<a href="${getExpectedUrl(entry.id)}" target="_blank">#${entry.id}</a>`;
            tr.appendChild(tdId);

            const tdTag = document.createElement('td');
            renderStageCell(tdTag, entry.stages && entry.stages.tag);
            tr.appendChild(tdTag);

            const tdPaid = document.createElement('td');
            renderStageCell(tdPaid, entry.stages && entry.stages.paid);
            tr.appendChild(tdPaid);

            const tdPostCheck = document.createElement('td');
            renderStageCell(tdPostCheck, entry.stages && entry.stages.postCheck);
            tr.appendChild(tdPostCheck);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        // Bọc bảng trong vùng cuộn riêng: dòng .fpmp-summary phía trên và footer luôn cố định,
        // chỉ danh sách item cuộn bên trong .fpmp-log.
        const logWrap = document.createElement('div');
        logWrap.className = 'fpmp-log';
        logWrap.appendChild(table);
        // Người dùng cuộn lên đọc log cũ -> tạm ngừng bám đáy; cuộn lại sát đáy -> bật lại.
        logWrap.addEventListener('scroll', () => {
            progressStickToBottom =
                logWrap.scrollHeight - logWrap.scrollTop - logWrap.clientHeight <= 8;
        });
        body.appendChild(logWrap);

        if (!finished) {
            // Job đang chạy: cho phép dừng lại (sau khi item hiện tại xử lý xong) hoặc ẩn modal
            // (job vẫn tiếp tục chạy ngầm, chỉ là không hiển thị UI).
            const stopBtn = document.createElement('button');
            stopBtn.className = 'fpmp-btn fpmp-btn--danger';
            stopBtn.type = 'button';
            stopBtn.textContent = 'Dừng lại';
            stopBtn.addEventListener('click', () => {
                // Chỉ hỏi 1 lần - chọn chế độ dừng. CẢ HAI lựa chọn đều dừng job.
                const stopNow = !confirm(
                    'Hoàn tất item ĐANG xử lý rồi mới dừng?\n\n'
                    + 'OK = chạy nốt item hiện tại rồi dừng (khuyến nghị).\n'
                    + 'Cancel = DỪNG NGAY, item hiện tại có thể còn dở dang.'
                );
                const currentJob = loadJob();
                if (!currentJob) return;
                currentJob.stopped = true;
                currentJob.stopMode = stopNow ? 'now' : 'after-current';
                saveJob(currentJob);
                renderModal();
            });
            footer.appendChild(stopBtn);

            const hideBtn = document.createElement('button');
            hideBtn.className = 'fpmp-btn fpmp-btn--default';
            hideBtn.type = 'button';
            hideBtn.textContent = 'Ẩn cửa sổ (vẫn tiếp tục chạy)';
            hideBtn.addEventListener('click', closeModal);
            footer.appendChild(hideBtn);
        } else {
            // Job đã kết thúc: cho phép đóng hẳn (xoá job khỏi localStorage) hoặc chạy danh sách mới.
            const closeBtn = document.createElement('button');
            closeBtn.className = 'fpmp-btn fpmp-btn--default';
            closeBtn.type = 'button';
            closeBtn.textContent = 'Đóng';
            closeBtn.addEventListener('click', () => {
                clearJob();
                closeModal();
            });
            footer.appendChild(closeBtn);

            const newBtn = document.createElement('button');
            newBtn.className = 'fpmp-btn fpmp-btn--primary';
            newBtn.type = 'button';
            newBtn.textContent = 'Chạy danh sách mới';
            newBtn.addEventListener('click', () => {
                clearJob();
                modalMode = 'input';
                renderModal();
            });
            footer.appendChild(newBtn);
        }
    }

    /**
     * Ánh xạ giá trị status nội bộ sang nhãn hiển thị trên badge của từng giai đoạn trong bảng
     * tiến trình. Theo đúng yêu cầu nghiệp vụ: 'skipped' hiển thị "Skip", 'success' hiển thị
     * "Success"; phần lỗi cụ thể (nếu có) được hiển thị riêng ở dòng message bên dưới badge
     * (xem renderStageCell), badge 'error' chỉ hiển thị "Lỗi" ngắn gọn.
     */
    function statusLabel(status) {
        switch (status) {
            case 'pending': return 'Chờ xử lý';
            case 'processing': return 'Đang xử lý';
            case 'success': return 'Success';
            case 'skipped': return 'Skip';
            case 'error': return 'Lỗi';
            default: return status;
        }
    }

    /**
     * Khởi tạo 1 job mới từ danh sách id đã parse: lưu job vào localStorage, chuyển modal sang
     * chế độ tiến trình, rồi bắt đầu xử lý item đầu tiên - hoặc điều hướng sang trang edit của
     * item đầu tiên nếu trang hiện tại chưa đúng (ví dụ user bấm "Bắt đầu" ngay tại trang chủ).
     * @param {string[]} ids - danh sách payment item id đã parse.
     * @param {boolean} autoChargeOnly - giá trị checkbox "Auto-Charge Item only" lúc bấm "Bắt đầu".
     */
    function startJob(ids, autoChargeOnly) {
        // Xoá job cũ (nếu còn) trước khi dựng job mới, để merge cờ `stopped` trong saveJob()
        // không vô tình khiến job mới bị đánh dấu đã dừng ngay từ đầu.
        clearJob();

        const job = {
            ids,
            index: 0,
            stopped: false,
            stopMode: null,   // null | 'now' | 'after-current' - đặt khi user bấm "Dừng lại"
            autoChargeOnly: autoChargeOnly !== false,
            createdAt: Date.now(),
            log: ids.map((id) => ({
                id,
                status: 'pending',
                stages: {
                    tag: { status: 'pending', message: '' },
                    paid: { status: 'pending', message: '' },
                    postCheck: { status: 'pending', message: '' },
                },
            })),
        };
        saveJob(job);
        modalMode = 'progress';
        renderModal();

        const firstId = ids[0];
        if (getCurrentItemIdFromUrl() === firstId) {
            processCurrentItem();
        } else {
            location.href = getExpectedUrl(firstId);
        }
    }

    /* =========================================================================
     *  Khởi tạo
     * ========================================================================= */

    /**
     * Điểm vào của script, chạy mỗi khi trang được tải (kể cả các lần tự reload giữa các item).
     * Luôn chèn CSS trước, sau đó chờ FinplanUtils sẵn sàng để đăng ký nút nổi qua Floating
     * Button Manager dùng chung (tránh chồng chéo với nút nổi của các Tampermonkey script khác
     * trên cùng trang), rồi kiểm tra xem có job nào đang dang dở trong localStorage hay không để
     * tự động mở lại modal và tiếp tục xử lý đúng chỗ:
     *   - Không có job -> không làm gì thêm, chờ user bấm nút nổi.
     *   - Có job nhưng đã kết thúc -> chỉ hiển thị modal tổng kết, không điều hướng đi đâu.
     *   - Có job đang chạy dở:
     *       + Nếu trang hiện tại đúng là trang edit của item đang mong đợi (job.ids[job.index])
     *         -> gọi processCurrentItem() để xử lý luôn.
     *       + Nếu không đúng (ví dụ do lỗi mạng khi reload, hoặc user tự bấm back/forward)
     *         -> tự điều hướng lại tới đúng URL cần xử lý.
     */
    async function init() {
        injectStyles();

        try {
            utils = await waitForFinplanUtils();
        } catch (e) {
            console.error('[Mark Items Completed]', e.message);
            return;
        }

        // Đăng ký nút nổi qua Floating Button Manager của thư viện dùng chung, để tránh chồng
        // chéo với nút nổi của các Tampermonkey script khác trên cùng trang. Việc gọi lại
        // registerButton với cùng id ở mỗi lần init() (mỗi lần trang tải/tự reload) là an toàn:
        // thư viện coi đây là cập nhật, không tạo nút trùng.
        utils.registerButton('mark-auto-charge-paid', {
            icon: '📋',
            text: 'Mark Items Completed',
            tooltip: 'Mark Items Completed',
            onClick: onFabClick,
        });

        const job = loadJob();
        if (!job) return; // Không có job nào đang chạy - chỉ chờ user tương tác qua nút nổi.

        if (isJobFinished(job)) {
            // Job đã xong từ lần trước (user chưa bấm Đóng) - chỉ hiển thị lại tổng kết.
            modalMode = 'progress';
            renderModal();
            return;
        }

        const expectedId = job.ids[job.index];
        const currentId = getCurrentItemIdFromUrl();

        modalMode = 'progress';
        renderModal();

        if (currentId === expectedId) {
            // Đúng trang cần xử lý -> tiếp tục job ngay.
            processCurrentItem();
        } else {
            // Sai trang (hiếm khi xảy ra) -> tự điều hướng lại cho đúng.
            location.href = getExpectedUrl(expectedId);
        }
    }

    init();
})();